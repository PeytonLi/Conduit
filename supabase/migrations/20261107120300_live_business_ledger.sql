-- Live business amendments join the commitment ledger: they need an approved
-- plan step with execution_mode live_connector and an active business-system
-- connection, are never prepared in replay mode, and follow the same
-- confirmed/failed/unknown rules as other commitment actions. A provider that
-- cannot write purchase orders (error_code not_supported_by_provider) is
-- handled like manual_export: the case waits for owner-confirmed evidence.

drop index if exists public.actions_one_live_commitment_per_plan;
create unique index actions_one_live_commitment_per_plan
  on public.actions(org_id, plan_id)
  where plan_id is not null
    and kind in ('demo_ledger_amendment', 'manual_export', 'live_business_amendment')
    and state not in ('cancelled', 'failed');

create or replace function public.ledger_prepare_action(
  p_org_id uuid, p_actor_type text, p_actor_id text, p_case_id uuid, p_kind public.action_kind,
  p_payload jsonb, p_idempotency_key text, p_contact_id uuid default null, p_plan_id uuid default null,
  p_plan_step_id text default null, p_approval_id uuid default null, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_case record;
  v_org record;
  v_settings jsonb;
  v_hash text;
  v_existing record;
  v_denials text[];
  v_plan record;
  v_approval record;
  v_fp text;
  v_action_id uuid;
  v_provider text;
  v_permitted_by uuid;
  v_step record;
  v_freshness integer;
  v_oldest timestamptz;
  v_financial boolean := p_kind in ('demo_ledger_amendment', 'manual_export', 'live_business_amendment');
begin
  select * into v_case from public.cases where id = p_case_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Case not found'); end if;
  if coalesce(trim(p_idempotency_key), '') = '' then
    return private.result_error('idempotency_key_required', 'Idempotency-Key is required');
  end if;
  v_hash := private.canonical_hash(jsonb_build_object('kind', p_kind, 'payload', p_payload,
    'contact_id', p_contact_id, 'plan_id', p_plan_id, 'plan_step_id', p_plan_step_id, 'case_id', p_case_id));

  select * into v_existing from public.actions where org_id = p_org_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.payload_hash <> v_hash then
      return private.result_error('idempotency_conflict', 'Idempotency key was used for a different action');
    end if;
    return jsonb_build_object('ok', true, 'replayed', true, 'action', private.action_json(p_org_id, v_existing.id));
  end if;

  select * into v_org from public.organizations where id = p_org_id;
  select settings into v_settings from private.current_policy(p_org_id);
  v_settings := coalesce(v_settings, '{}'::jsonb);
  if (private.policy_setting(v_settings, '{dispatch_paused}', 'false'))::boolean then
    return private.result_error('dispatch_paused', 'Dispatch is paused by organization policy');
  end if;
  if v_case.run_control <> 'active' or v_case.phase = 'closed' then
    return private.result_error('case_not_active', 'Case is paused, blocked or closed');
  end if;

  if p_kind in ('supplier_email', 'supplier_call') then
    if p_contact_id is null then
      return private.result_error('validation_failed', 'A supplier contact is required');
    end if;
    v_denials := private.outreach_denials(p_org_id, p_case_id, p_contact_id,
      case p_kind when 'supplier_email' then 'email' else 'phone' end, p_now, true);
    if cardinality(v_denials) > 0 then
      return private.result_error('policy_denied', 'Outreach is not permitted by policy',
        jsonb_build_object('denials', to_jsonb(v_denials)));
    end if;
    v_provider := case p_kind when 'supplier_email' then 'email' else 'voice' end;
    v_permitted_by := case when p_actor_type = 'user' then p_actor_id::uuid end;
  else
    if p_kind = 'demo_ledger_amendment' and v_org.environment_mode = 'live' then
      return private.result_error('mode_not_allowed', 'The demo ledger cannot be written in live mode');
    end if;
    if p_plan_id is null or p_approval_id is null then
      return private.result_error('approval_required', 'A financial action requires an approved plan');
    end if;
    select * into v_plan from public.recovery_plans where id = p_plan_id and org_id = p_org_id and case_id = p_case_id for update;
    if not found then return private.result_error('not_found', 'Plan not found'); end if;
    select * into v_approval from public.approvals where id = p_approval_id and org_id = p_org_id and plan_id = p_plan_id for update;
    if not found then return private.result_error('approval_required', 'Approval not found for this plan'); end if;
    if v_approval.status <> 'active' then
      return private.result_error('approval_not_active', 'Approval is no longer active',
        jsonb_build_object('approval_status', v_approval.status));
    end if;
    if v_approval.authority_role <> 'owner'
        or private.member_role(p_org_id, v_approval.approving_user_id) is distinct from 'owner' then
      update public.approvals set status = 'revoked' where id = v_approval.id;
      return private.result_error('approval_authority_revoked', 'Approver no longer holds commitment authority');
    end if;
    if v_approval.expires_at <= p_now then
      update public.approvals set status = 'expired' where id = v_approval.id;
      update public.recovery_plans set status = 'ready', row_version = row_version + 1, updated_at = p_now
      where id = v_plan.id and status = 'approved';
      update public.cases set phase = 'awaiting_approval', updated_at = p_now, row_version = row_version + 1
      where id = p_case_id and org_id = p_org_id;
      perform private.audit(p_org_id, 'system', 'ledger', p_case_id, 'approval', v_approval.id,
        'approval.expired_before_prepare', null, null, 'renewal required', p_now);
      return private.result_error('approval_expired', 'Approval expired before execution; renewal required');
    end if;
    if v_plan.status <> 'approved' or v_plan.version <> v_approval.plan_version then
      return private.result_error('invalid_state', 'Plan is not in an approved state',
        jsonb_build_object('status', v_plan.status));
    end if;
    v_fp := public.plan_material_fingerprint(p_org_id, p_plan_id);
    if v_fp <> v_approval.input_fingerprint then
      update public.approvals set status = 'revoked' where id = v_approval.id;
      update public.recovery_plans set status = 'expired', row_version = row_version + 1, updated_at = p_now
      where id = v_plan.id;
      update public.cases set phase = 'recovering', updated_at = p_now, row_version = row_version + 1
      where id = p_case_id and org_id = p_org_id;
      perform private.audit(p_org_id, 'system', 'ledger', p_case_id, 'approval', v_approval.id,
        'approval.stale_fingerprint', null, null, 'material inputs changed', p_now);
      perform public.outbox_enqueue(p_org_id, 'case.recovery.requested', p_case_id,
        jsonb_build_object('case_id', p_case_id, 'assessment_version', 0), null, null, p_now);
      return private.result_error('stale_fingerprint', 'Material inputs changed after approval; re-approval required');
    end if;
    if v_approval.approved_ceiling_minor < coalesce(v_plan.gross_commitment_minor, 0) then
      return private.result_error('ceiling_exceeded', 'Plan commitment exceeds the approved ceiling');
    end if;
    if p_kind = 'demo_ledger_amendment' then
      select * into v_step from public.plan_steps
      where org_id = p_org_id and plan_id = p_plan_id and step_id = p_plan_step_id;
      if not found or v_step.execution_mode <> 'demo_ledger' or v_step.kind <> 'amend_delivery_schedule' then
        return private.result_error('validation_failed', 'Plan step is not a demo ledger amendment');
      end if;
    end if;
    if p_kind = 'live_business_amendment' then
      if v_org.environment_mode = 'replay' then
        return private.result_error('mode_not_allowed', 'Replay mode cannot write to a business system');
      end if;
      select * into v_step from public.plan_steps
      where org_id = p_org_id and plan_id = p_plan_id and step_id = p_plan_step_id;
      if not found or v_step.execution_mode <> 'live_connector' or v_step.kind <> 'amend_delivery_schedule' then
        return private.result_error('validation_failed', 'Plan step is not a live business amendment');
      end if;
      if not exists (
        select 1 from public.connections c
        where c.org_id = p_org_id and c.id = (p_payload->'erp'->>'connection_id')::uuid
          and c.provider = p_payload->'erp'->>'provider'
          and c.provider = any(private.erp_providers()) and c.status in ('healthy', 'degraded')
      ) then
        return private.result_error('failed_precondition', 'No business system is connected',
          jsonb_build_object('reason', 'connection_unavailable'));
      end if;
    end if;
    if v_org.environment_mode = 'live' then
      v_freshness := (private.policy_setting(v_settings, '{freshness,live_business_data_seconds}', '900'))::integer;
      select min(source_as_of) into v_oldest from public.datasets where org_id = p_org_id and status = 'active';
      if v_oldest is null or v_oldest < p_now - make_interval(secs => v_freshness) then
        return private.result_error('stale_data', 'Business data is older than the freshness policy');
      end if;
    end if;
    v_provider := case p_kind
      when 'demo_ledger_amendment' then 'demo_ledger'
      when 'live_business_amendment' then p_payload->'erp'->>'provider'
      else 'manual_export' end;
    v_permitted_by := v_approval.approving_user_id;
  end if;

  begin
    insert into public.actions (org_id, case_id, plan_id, kind, state, payload_hash, payload, idempotency_key,
      provider, permitted_by, mode, episode, contact_id, approval_id, plan_step_id, created_at, updated_at)
    values (p_org_id, p_case_id, p_plan_id, p_kind, 'prepared', v_hash, p_payload, p_idempotency_key,
      v_provider, v_permitted_by, v_org.environment_mode, v_case.episode, p_contact_id, p_approval_id,
      p_plan_step_id, p_now, p_now)
    returning id into v_action_id;
  exception when unique_violation then
    return private.result_error('plan_already_executing', 'A commitment action already exists for this plan');
  end;

  if v_financial then
    update public.approvals set status = 'consumed', consumed_by_action_id = v_action_id
    where id = v_approval.id and status = 'active';
    if not found then
      raise exception 'approval consumed concurrently' using errcode = '40001';
    end if;
    update public.recovery_plans set status = 'executing', row_version = row_version + 1, updated_at = p_now
    where id = v_plan.id;
    -- Consistent lock ordering: lock every (item, location) group in sorted order before claiming.
    perform pg_advisory_xact_lock(hashtextextended(g.k, 0))
    from (select distinct p_org_id::text || ':' || s.item_id::text || ':' || s.destination_location_id::text as k
          from public.plan_steps s where s.org_id = p_org_id and s.plan_id = p_plan_id
          order by 1) g;
    if exists (
      select 1 from public.plan_steps s
      join public.allocation_claims c on c.org_id = s.org_id and c.item_id = s.item_id
        and c.location_id = s.destination_location_id and c.state in ('active', 'uncertain')
        and c.plan_id <> p_plan_id
      where s.org_id = p_org_id and s.plan_id = p_plan_id
        and (c.receipt_schedule_ids && coalesce(array(select jsonb_array_elements_text(s.payload->'receipt_schedule_ids'))::uuid[], '{}')
          or c.receipt_schedule_ids && array[(s.payload->>'receipt_schedule_id')::uuid]
          or c.demand_ids && coalesce(array(select jsonb_array_elements_text(s.payload->'demand_ids'))::uuid[], '{}'))
    ) then
      raise exception 'allocation_conflict' using errcode = 'P0001', hint = 'allocation_conflict';
    end if;
    insert into public.allocation_claims (org_id, plan_id, action_id, item_id, location_id, demand_ids,
      receipt_schedule_ids, quantity, state, created_at, updated_at)
    select p_org_id, p_plan_id, v_action_id, s.item_id, s.destination_location_id,
      coalesce(array(select jsonb_array_elements_text(s.payload->'demand_ids'))::uuid[], '{}'),
      array_remove(array[(s.payload->>'receipt_schedule_id')::uuid], null),
      coalesce(s.quantity, 0), 'active', p_now, p_now
    from public.plan_steps s where s.org_id = p_org_id and s.plan_id = p_plan_id
    order by s.item_id, s.destination_location_id, s.step_id;
  end if;

  perform private.audit(p_org_id, p_actor_type, p_actor_id, p_case_id, 'action', v_action_id,
    'action.prepared', null, 1, null, p_now);
  perform public.outbox_enqueue(p_org_id, 'action.prepared', v_action_id,
    jsonb_build_object('action_id', v_action_id), null, null, p_now);
  return jsonb_build_object('ok', true, 'replayed', false, 'action', private.action_json(p_org_id, v_action_id));
exception when raise_exception then
  if sqlerrm = 'allocation_conflict' then
    return private.result_error('allocation_conflict', 'Required supply is already claimed by another plan');
  end if;
  raise;
end;
$$;

create or replace function public.ledger_record_outcome(
  p_org_id uuid, p_action_id uuid, p_outcome public.action_state, p_provider_ref text,
  p_safe_summary text, p_error_code text, p_source text, p_actor_id text,
  p_evidence_id uuid default null, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_action record;
  v_allowed boolean;
  v_financial boolean;
begin
  select * into v_action from public.actions where id = p_action_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Action not found'); end if;
  v_financial := v_action.kind in ('demo_ledger_amendment', 'manual_export', 'live_business_amendment');
  if v_action.state = p_outcome and p_outcome <> 'unknown'
      and v_action.provider_ref is not distinct from coalesce(p_provider_ref, v_action.provider_ref) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'action', private.action_json(p_org_id, p_action_id));
  end if;
  v_allowed := case v_action.state
    when 'prepared' then p_outcome = 'cancelled'
    when 'dispatching' then p_outcome in ('submitted', 'confirmed', 'failed', 'unknown')
    when 'submitted' then p_outcome in ('confirmed', 'failed', 'unknown')
    when 'unknown' then p_outcome in ('confirmed', 'failed', 'unknown', 'submitted')
    else false end;
  if not v_allowed then
    perform private.audit(p_org_id, 'system', coalesce(p_actor_id, p_source), v_action.case_id, 'action',
      p_action_id, 'action.outcome_conflict', v_action.row_version, v_action.row_version,
      format('%s -> %s rejected', v_action.state, p_outcome), p_now);
    return private.result_error('outcome_conflict', 'Outcome conflicts with the recorded action state',
      jsonb_build_object('action', private.action_json(p_org_id, p_action_id)));
  end if;
  -- A manual export is a handoff, never an applied change; only an owner with evidence confirms it.
  if (v_action.kind = 'manual_export'
      or (v_action.kind = 'live_business_amendment' and v_action.error_code = 'not_supported_by_provider'))
     and p_outcome = 'confirmed' and (p_source <> 'owner' or p_evidence_id is null) then
    return private.result_error('evidence_required', 'Manual execution must be confirmed by an owner with evidence');
  end if;

  update public.actions set state = p_outcome,
    provider_ref = coalesce(p_provider_ref, provider_ref),
    outcome = jsonb_build_object('safe_summary', left(coalesce(p_safe_summary, ''), 500), 'source', p_source,
      'evidence_id', p_evidence_id, 'recorded_at', p_now),
    error_code = case
      when v_action.error_code = 'not_supported_by_provider' and p_outcome in ('submitted', 'unknown')
        then v_action.error_code
      else p_error_code end,
    next_reconcile_at = case when p_outcome in ('submitted', 'unknown') then p_now + interval '60 seconds' end,
    updated_at = p_now, row_version = row_version + 1
  where id = p_action_id;

  if p_outcome = 'confirmed' then
    perform private.release_claims(p_org_id, p_action_id, 'consumed', p_now);
    if v_financial then
      update public.recovery_plans set status = 'executed', row_version = row_version + 1, updated_at = p_now
      where id = v_action.plan_id and org_id = p_org_id;
      update public.cases set phase = 'monitoring', run_control = case when run_control = 'paused' then run_control else 'active' end, block_reason = null,
        updated_at = p_now, row_version = row_version + 1
      where id = v_action.case_id and org_id = p_org_id;
    else
      update public.cases set run_control = case when run_control = 'paused' then run_control else 'active' end, block_reason = null, updated_at = p_now,
        phase = case when phase in ('recovering', 'assessing') then 'awaiting_supplier'::public.case_phase else phase end,
        row_version = row_version + 1
      where id = v_action.case_id and org_id = p_org_id and (block_reason = 'outcome_unknown' or block_reason is null);
    end if;
  elsif p_outcome in ('failed', 'cancelled') then
    perform private.release_claims(p_org_id, p_action_id, 'released', p_now);
    if v_financial then
      update public.recovery_plans set status = 'failed', row_version = row_version + 1, updated_at = p_now
      where id = v_action.plan_id and org_id = p_org_id and p_outcome = 'failed';
      update public.cases set phase = 'recovering', run_control = case when run_control = 'paused' then run_control else 'active' end, block_reason = null,
        updated_at = p_now, row_version = row_version + 1
      where id = v_action.case_id and org_id = p_org_id and phase <> 'closed';
      perform public.outbox_enqueue(p_org_id, 'case.recovery.requested', v_action.case_id,
        jsonb_build_object('case_id', v_action.case_id, 'assessment_version', 0), null, null, p_now);
    elsif exists (select 1 from public.cases where id = v_action.case_id and block_reason = 'outcome_unknown') then
      update public.cases set run_control = case when run_control = 'paused' then run_control else 'active' end, block_reason = null, updated_at = p_now,
        row_version = row_version + 1 where id = v_action.case_id and org_id = p_org_id;
    end if;
  elsif p_outcome = 'unknown' then
    -- Unknown actions keep their claims held so supply cannot be double-committed.
    update public.allocation_claims set state = 'uncertain', updated_at = p_now, row_version = row_version + 1
    where org_id = p_org_id and action_id = p_action_id and state = 'active';
    if v_financial then
      update public.recovery_plans set status = 'execution_uncertain', row_version = row_version + 1, updated_at = p_now
      where id = v_action.plan_id and org_id = p_org_id;
    end if;
    update public.cases set run_control = 'blocked', block_reason = 'outcome_unknown', updated_at = p_now,
      row_version = row_version + 1 where id = v_action.case_id and org_id = p_org_id;
  elsif p_outcome = 'submitted' and (v_action.kind = 'manual_export'
      or (v_action.kind = 'live_business_amendment' and p_error_code = 'not_supported_by_provider')) then
    update public.cases set run_control = 'blocked', block_reason = 'manual_execution_required',
      updated_at = p_now, row_version = row_version + 1 where id = v_action.case_id and org_id = p_org_id;
  end if;

  perform private.audit(p_org_id, case when p_source = 'owner' then 'user' else 'system' end,
    coalesce(p_actor_id, p_source), v_action.case_id, 'action', p_action_id, 'action.' || p_outcome::text,
    v_action.row_version, v_action.row_version + 1, left(p_safe_summary, 500), p_now);
  perform public.outbox_enqueue(p_org_id, 'action.outcome.recorded', p_action_id,
    jsonb_build_object('action_id', p_action_id, 'outcome_version', v_action.row_version + 1), null, null, p_now);
  return jsonb_build_object('ok', true, 'duplicate', false, 'action', private.action_json(p_org_id, p_action_id));
end;
$$;

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
  if v_action.kind = 'supplier_email'
    and v_action.mode <> 'replay'
    and not exists (
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
  if v_action.kind = 'live_business_amendment' and not exists (
    select 1 from public.connections c
    where c.org_id = p_org_id and c.id = (v_action.payload->'erp'->>'connection_id')::uuid
      and c.status in ('healthy', 'degraded')
  ) then
    return private.result_error('failed_precondition', 'Business system connection is unavailable',
      jsonb_build_object('reason', 'connection_unavailable'));
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
