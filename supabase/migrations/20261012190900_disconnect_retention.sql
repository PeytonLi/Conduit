alter table public.evidence
  add column if not exists tombstoned_at timestamptz;

create or replace function public.ui_disconnect_connection(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_actor uuid := (p->>'actor_user_id')::uuid;
  v_connection record;
begin
  select * into v_connection
  from public.connections
  where org_id = v_org
    and provider = 'gmail'
    and status in ('healthy', 'degraded')
    and (
      p->>'connection_id' is null
      or id = (p->>'connection_id')::uuid
    )
  order by updated_at desc, id desc
  limit 1
  for update;
  if not found then
    return jsonb_build_object('ok', true, 'disconnected', false);
  end if;

  update public.connections
  set status = 'disconnected',
      row_version = row_version + 1,
      updated_at = now()
  where id = v_connection.id and org_id = v_org;

  delete from private.integration_credentials
  where connection_id = v_connection.id and org_id = v_org;

  perform private.audit(
    v_org,
    'user',
    v_actor::text,
    null,
    'connection',
    v_connection.id,
    'connection.gmail.disconnected',
    v_connection.row_version,
    v_connection.row_version + 1,
    'owner_disconnect',
    now()
  );

  return jsonb_build_object(
    'ok', true,
    'disconnected', true,
    'connection_id', v_connection.id
  );
end;
$$;

revoke all on function public.ui_disconnect_connection(jsonb) from public, anon, authenticated;
grant execute on function public.ui_disconnect_connection(jsonb) to service_role;

create or replace function public.expire_evidence_sources(p_now timestamptz)
returns table(storage_path text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select e.id, e.private_object_path
    from public.evidence e
    where e.retention_until is not null
      and e.retention_until <= p_now
      and e.tombstoned_at is null
    order by e.retention_until, e.id
    for update skip locked
  ),
  tombstoned as (
    update public.evidence e
    set tombstoned_at = p_now,
        private_object_path = null
    from due
    where e.id = due.id
    returning due.private_object_path
  )
  select tombstoned.private_object_path
  from tombstoned
  where tombstoned.private_object_path is not null;
end;
$$;

revoke all on function public.expire_evidence_sources(timestamptz) from public, anon, authenticated;
grant execute on function public.expire_evidence_sources(timestamptz) to service_role;

-- CAS prepared -> dispatching. dispatch_started_at is persisted before any provider call.
create or replace function public.ledger_claim_dispatch(
  p_org_id uuid, p_action_id uuid, p_lease_seconds integer default 300, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_action record;
  v_case record;
  v_settings jsonb;
  v_denials text[];
  v_approval record;
begin
  select * into v_action from public.actions where id = p_action_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Action not found'); end if;
  if v_action.state <> 'prepared' then
    return private.result_error('not_claimable', 'Action is not prepared',
      jsonb_build_object('action', private.action_json(p_org_id, p_action_id)));
  end if;
  select * into v_case from public.cases where id = v_action.case_id and org_id = p_org_id;
  if v_action.kind = 'supplier_email' and not exists (
    select 1
    from public.connections c
    where c.org_id = p_org_id
      and c.provider = 'gmail'
      and c.status in ('healthy', 'degraded')
  ) then
    return private.result_error(
      'failed_precondition',
      'Gmail connection is unavailable',
      jsonb_build_object('reason', 'connection_unavailable')
    );
  end if;
  if v_action.permitted_by is not null and not exists (
    select 1
    from public.memberships m
    where m.org_id = p_org_id
      and m.auth_user_id = v_action.permitted_by
      and m.active
  ) then
    return private.result_error(
      'failed_precondition',
      'The action preparer is no longer an active organization member',
      jsonb_build_object('reason', 'preparer_revoked')
    );
  end if;
  select settings into v_settings from private.current_policy(p_org_id);
  if (private.policy_setting(coalesce(v_settings, '{}'), '{dispatch_paused}', 'false'))::boolean then
    return private.result_error('dispatch_paused', 'Dispatch is paused by organization policy');
  end if;
  if v_case.run_control <> 'active' then
    return private.result_error('case_not_active', 'Case is paused or blocked',
      jsonb_build_object('run_control', v_case.run_control));
  end if;
  if v_action.mode <> (select environment_mode from public.organizations where id = p_org_id) then
    update public.actions set state = 'cancelled', error_code = 'mode_changed', updated_at = p_now,
      row_version = row_version + 1 where id = p_action_id;
    perform private.release_claims(p_org_id, p_action_id, 'released', p_now);
    return private.result_error('mode_changed', 'Organization mode changed after preparation');
  end if;
  if v_action.kind in ('supplier_email', 'supplier_call') then
    v_denials := private.outreach_denials(p_org_id, v_action.case_id, v_action.contact_id,
      case v_action.kind when 'supplier_email' then 'email' else 'phone' end, p_now, false);
    if cardinality(v_denials) > 0 then
      return private.result_error('policy_denied', 'Outreach is not currently permitted',
        jsonb_build_object('denials', to_jsonb(v_denials)));
    end if;
  else
    select * into v_approval from public.approvals where id = v_action.approval_id and org_id = p_org_id for update;
    if v_approval.expires_at <= p_now then
      update public.actions set state = 'cancelled', error_code = 'approval_expired', updated_at = p_now,
        row_version = row_version + 1 where id = p_action_id;
      perform private.release_claims(p_org_id, p_action_id, 'released', p_now);
      update public.approvals set status = 'expired' where id = v_approval.id;
      update public.recovery_plans set status = 'ready', row_version = row_version + 1, updated_at = p_now
      where id = v_action.plan_id and org_id = p_org_id;
      update public.cases set phase = 'awaiting_approval', updated_at = p_now, row_version = row_version + 1
      where id = v_action.case_id and org_id = p_org_id;
      perform private.audit(p_org_id, 'system', 'dispatcher', v_action.case_id, 'action', p_action_id,
        'action.cancelled', v_action.row_version, v_action.row_version + 1, 'approval expired before dispatch', p_now);
      perform public.outbox_enqueue(p_org_id, 'action.outcome.recorded', p_action_id,
        jsonb_build_object('action_id', p_action_id, 'outcome_version', v_action.row_version + 1), null, null, p_now);
      return private.result_error('approval_expired', 'Approval expired before dispatch; renewal required');
    end if;
  end if;
  update public.actions set state = 'dispatching', dispatch_started_at = p_now, attempts = attempts + 1,
    next_reconcile_at = p_now + make_interval(secs => p_lease_seconds), updated_at = p_now,
    row_version = row_version + 1
  where id = p_action_id;
  perform private.audit(p_org_id, 'system', 'dispatcher', v_action.case_id, 'action', p_action_id,
    'action.dispatching', v_action.row_version, v_action.row_version + 1, null, p_now);
  return jsonb_build_object('ok', true, 'action', private.action_json(p_org_id, p_action_id));
end;
$$;

revoke all on function public.ledger_claim_dispatch(uuid, uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.ledger_claim_dispatch(uuid, uuid, integer, timestamptz) to service_role;
