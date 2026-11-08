-- Internal stock transfers become an executable, owner-approved recovery step.
--
-- A live_business_transfer action reserves stock at a source location and dispatches it to the
-- case's location in the connected business system. It follows the same rules as every other
-- commitment: it needs an active approval on the approved plan version, an action row exists
-- before dispatch, the approval is consumed in the same transaction, an unknown outcome blocks
-- the case until it is reconciled, and the source quantity is held as an allocation claim so the
-- same stock cannot be promised twice. Functions below are replaced from their previous bodies;
-- only the transfer additions differ.

drop index if exists public.actions_one_live_commitment_per_plan;
create unique index actions_one_live_commitment_per_plan
  on public.actions(org_id, plan_id)
  where plan_id is not null
    and kind in ('demo_ledger_amendment', 'manual_export', 'live_business_amendment', 'live_business_transfer')
    and state not in ('cancelled', 'failed');

-- Provider identities for a transfer's item and two locations, plus the connection whose
-- dataset is active, so a live write can be prepared against the system that owns them.
create or replace function public.erp_transfer_ref(p jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'item_external_id', i.external_id,
    'source_location_external_id', s.external_id,
    'destination_location_external_id', d.external_id,
    'connection_id', (select ds.source_connection_id from public.datasets ds
                      where ds.org_id = i.org_id and ds.status = 'active' limit 1)
  )
  from public.items i
  join public.locations s on s.org_id = i.org_id and s.id = (p->>'source_location_id')::uuid
  join public.locations d on d.org_id = i.org_id and d.id = (p->>'destination_location_id')::uuid
  where i.org_id = (p->>'org_id')::uuid and i.id = (p->>'item_id')::uuid
    and i.external_id is not null and s.external_id is not null and d.external_id is not null
$$;

revoke all on function public.erp_transfer_ref(jsonb) from public, anon, authenticated;
grant execute on function public.erp_transfer_ref(jsonb) to service_role;

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
  v_financial boolean := p_kind in ('demo_ledger_amendment', 'manual_export', 'live_business_amendment', 'live_business_transfer');
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
    if p_kind = 'live_business_transfer' then
      if v_org.environment_mode = 'replay' then
        return private.result_error('mode_not_allowed', 'Replay mode cannot write to a business system');
      end if;
      -- The action must carry exactly the terms the owner approved on this plan version.
      select * into v_step from public.plan_steps
      where org_id = p_org_id and plan_id = p_plan_id and step_id = p_plan_step_id;
      if not found or v_step.execution_mode <> 'live_connector' or v_step.kind <> 'transfer_stock'
          or v_step.payload->>'source_location_id' is distinct from p_payload->>'source_location_id'
          or v_step.payload->>'arrival_end' is distinct from p_payload->>'arrival_end'
          or v_step.payload->>'transfer_cost_minor' is distinct from p_payload->>'transfer_cost_minor'
          or v_step.quantity is distinct from (p_payload->>'quantity')::integer
          or v_step.item_id is distinct from (p_payload->>'item_id')::uuid
          or v_step.destination_location_id is distinct from (p_payload->>'destination_location_id')::uuid then
        return private.result_error('validation_failed', 'Plan step is not the approved live stock transfer');
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
      when 'live_business_transfer' then p_payload->'erp'->>'provider'
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
    from (select u.k from (
            select p_org_id::text || ':' || s.item_id::text || ':' || s.destination_location_id::text as k
            from public.plan_steps s where s.org_id = p_org_id and s.plan_id = p_plan_id
            union
            select p_org_id::text || ':' || s.item_id::text || ':' || (s.payload->>'source_location_id') as k
            from public.plan_steps s where s.org_id = p_org_id and s.plan_id = p_plan_id
              and s.kind = 'transfer_stock' and s.payload->>'source_location_id' is not null
          ) u order by u.k) g;
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
    -- A transfer also holds its quantity at the source so that stock cannot be promised twice.
    insert into public.allocation_claims (org_id, plan_id, action_id, item_id, location_id, demand_ids,
      receipt_schedule_ids, quantity, state, created_at, updated_at)
    select p_org_id, p_plan_id, v_action_id, s.item_id, (s.payload->>'source_location_id')::uuid,
      '{}', '{}', coalesce(s.quantity, 0), 'active', p_now, p_now
    from public.plan_steps s where s.org_id = p_org_id and s.plan_id = p_plan_id
      and s.kind = 'transfer_stock' and s.payload->>'source_location_id' is not null
    order by s.item_id, s.step_id;
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
  v_financial := v_action.kind in ('demo_ledger_amendment', 'manual_export', 'live_business_amendment', 'live_business_transfer');
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
  -- Preserve mailbox-aware claim rules from 20261108130000_outlook_multi_mailbox.sql:
  -- require the named mailbox (or any healthy mailbox when unset), not "any Gmail".
  if v_action.kind = 'supplier_email'
    and v_action.mode <> 'replay'
    and not exists (
    select 1
    from public.connections c
    where c.org_id = p_org_id
      and c.provider = any(private.mailbox_providers())
      and c.status in ('healthy', 'degraded')
      and (
        nullif(v_action.payload->>'connection_id', '') is null
        or c.id = (v_action.payload->>'connection_id')::uuid
      )
  ) then
    return private.result_error(
      'failed_precondition',
      'Mailbox connection is unavailable',
      jsonb_build_object('reason', 'connection_unavailable')
    );
  end if;
  if v_action.kind in ('live_business_amendment', 'live_business_transfer') and not exists (
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

create or replace function public.plan_create(
  p_org_id uuid, p_case_id uuid, p_actor_user_id uuid, p_assessment_id uuid, p_steps jsonb,
  p_idempotency_key text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_case record;
  v_existing record;
  v_plan_id uuid;
  v_version integer;
  v_step jsonb;
  v_missing text[];
  v_all_missing text[] := '{}';
  v_gross bigint := 0;
  v_incremental bigint := 0;
  v_expires timestamptz;
  v_writes integer := 0;
  v_quote record;
  v_line record;
  v_sum integer;
  v_status public.plan_status;
  v_fingerprint text;
  v_hash text := private.canonical_hash(jsonb_build_object('assessment_id', p_assessment_id, 'steps', p_steps));
begin
  if private.member_role(p_org_id, p_actor_user_id) not in ('owner', 'operator') then
    return private.result_error('forbidden', 'Only an owner or operator can create plans');
  end if;
  select * into v_case from public.cases where id = p_case_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Case not found'); end if;

  select * into v_existing from public.recovery_plans
  where org_id = p_org_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.case_id <> p_case_id or (v_existing.dependencies->>'request_hash') is distinct from v_hash then
      return private.result_error('idempotency_conflict', 'Idempotency key was used for a different plan');
    end if;
    return jsonb_build_object('ok', true, 'replayed', true, 'plan_id', v_existing.id,
      'version', v_existing.version, 'status', v_existing.status);
  end if;

  if not exists (select 1 from public.assessments where id = p_assessment_id and org_id = p_org_id
      and case_id = p_case_id) then
    return private.result_error('not_found', 'Assessment not found for this case');
  end if;
  if v_case.phase = 'closed' then
    return private.result_error('invalid_state', 'Case is closed');
  end if;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    if v_step->>'execution_mode' in ('demo_ledger', 'live_connector') then
      v_writes := v_writes + 1;
    end if;
    if v_step->>'execution_mode' = 'demo_ledger' and v_step->>'kind' <> 'amend_delivery_schedule' then
      return private.result_error('unsupported_step', 'Demo ledger only supports amend_delivery_schedule');
    end if;
  end loop;
  if v_writes > 1 then
    return private.result_error('multi_write_not_supported',
      'Plans with more than one automated business write are not supported in B0');
  end if;

  select coalesce(max(version), 0) + 1 into v_version from public.recovery_plans
  where org_id = p_org_id and case_id = p_case_id;
  update public.recovery_plans set status = 'superseded', updated_at = p_now, row_version = row_version + 1
  where org_id = p_org_id and case_id = p_case_id and status in ('draft', 'ready', 'approved');
  update public.approvals set status = 'revoked'
  where org_id = p_org_id and status = 'active'
    and plan_id in (select id from public.recovery_plans where org_id = p_org_id and case_id = p_case_id);

  insert into public.recovery_plans (org_id, case_id, version, assessment_id, input_fingerprint,
    policy_version_id, status, dependencies, idempotency_key, created_by, created_at, updated_at)
  values (p_org_id, p_case_id, v_version, p_assessment_id, 'pending',
    (select current_policy_version_id from public.organizations where id = p_org_id), 'draft',
    jsonb_build_object('request_hash', v_hash), p_idempotency_key, p_actor_user_id, p_now, p_now)
  returning id into v_plan_id;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    v_missing := '{}';
    if v_step->>'execution_mode' = 'live_connector' and (
      v_step->>'kind' not in ('amend_delivery_schedule', 'transfer_stock')
      or (select environment_mode from public.organizations where id = p_org_id) = 'replay'
      or (v_step->>'kind' = 'transfer_stock' and not exists (
        select 1 from public.connections c
        join public.datasets d on d.source_connection_id = c.id and d.org_id = c.org_id and d.status = 'active'
        where c.org_id = p_org_id and c.provider = any(private.erp_providers()) and c.status in ('healthy', 'degraded')
      ))
      or (v_step->>'kind' = 'amend_delivery_schedule' and not exists (
        select 1
        from public.purchase_order_lines l
        join public.purchase_orders po on po.id = l.purchase_order_id and po.org_id = l.org_id
        join public.datasets d on d.id = po.dataset_id and d.org_id = po.org_id
        join public.connections c on c.id = d.source_connection_id and c.org_id = d.org_id
        where l.org_id = p_org_id and l.id = (v_step#>>'{payload,po_line_id}')::uuid
          and po.source_version is not null
          and c.provider = any(private.erp_providers()) and c.status in ('healthy', 'degraded')
      ))
    ) then
      v_missing := v_missing || 'live_connector_unavailable'::text;
    end if;
    case v_step->>'kind'
    when 'amend_delivery_schedule' then
      select l.* into v_line from public.purchase_order_lines l
      where l.id = (v_step#>>'{payload,po_line_id}')::uuid and l.org_id = p_org_id;
      if not found or v_line.item_id <> v_case.item_id then
        v_missing := v_missing || 'po_line_id';
      else
        if not exists (select 1 from public.receipt_schedules where org_id = p_org_id
            and id = (v_step#>>'{payload,receipt_schedule_id}')::uuid and po_line_id = v_line.id
            and promise_state <> 'superseded') then
          v_missing := v_missing || 'receipt_schedule_id';
        end if;
        select coalesce(sum((s->>'quantity')::integer), 0) into v_sum
        from jsonb_array_elements(coalesce(v_step#>'{payload,schedules}', '[]')) s;
        if v_sum <> v_line.ordered_qty - v_line.received_qty - v_line.cancelled_qty then
          v_missing := v_missing || 'schedules_total';
        end if;
      end if;
      if not exists (select 1 from public.evidence where org_id = p_org_id
          and id = (v_step#>>'{payload,supplier_confirmation_evidence_id}')::uuid) then
        v_missing := v_missing || 'supplier_confirmation_evidence_id';
      end if;
      v_gross := v_gross + coalesce((v_step#>>'{payload,added_cost_minor}')::bigint, 0);
      v_incremental := v_incremental + coalesce((v_step#>>'{payload,added_cost_minor}')::bigint, 0);
    when 'purchase_bridge' then
      select q.* into v_quote from public.quotes q
      where q.id = (v_step#>>'{payload,quote_id}')::uuid and q.org_id = p_org_id and q.case_id = p_case_id;
      if not found then
        v_missing := v_missing || 'quote_id';
      elsif v_quote.status <> 'verified' or v_quote.valid_until is null or v_quote.valid_until <= p_now
          or v_quote.unit_price_minor is null or v_quote.quantity is null or v_quote.freight_minor is null
          or v_quote.fees_minor is null or v_quote.nonrecoverable_tax_minor is null
          or v_quote.destination_location_id is distinct from v_case.location_id then
        v_missing := v_missing || 'verified_quote_terms';
      else
        v_gross := v_gross + v_quote.quantity::bigint * v_quote.unit_price_minor
          + v_quote.freight_minor + v_quote.fees_minor + v_quote.nonrecoverable_tax_minor;
        v_incremental := v_incremental + v_quote.quantity::bigint * v_quote.unit_price_minor
          + v_quote.freight_minor + v_quote.fees_minor + v_quote.nonrecoverable_tax_minor;
        v_expires := least(coalesce(v_expires, v_quote.valid_until), v_quote.valid_until,
          coalesce(v_quote.latest_order_at, v_quote.valid_until));
      end if;
    when 'cancel_original_quantity' then
      v_gross := v_gross + coalesce((v_step#>>'{payload,cancellation_fee_minor}')::bigint, 0);
      v_incremental := v_incremental + coalesce((v_step#>>'{payload,cancellation_fee_minor}')::bigint, 0);
      if (v_step#>>'{payload,supplier_acceptance_evidence_id}') is not null and exists (
          select 1 from public.evidence where org_id = p_org_id
          and id = (v_step#>>'{payload,supplier_acceptance_evidence_id}')::uuid) then
        v_incremental := v_incremental - coalesce((v_step#>>'{payload,confirmed_credit_minor}')::bigint, 0);
      elsif coalesce((v_step#>>'{payload,confirmed_credit_minor}')::bigint, 0) > 0 then
        v_missing := v_missing || 'supplier_acceptance_evidence_id';
      end if;
    when 'transfer_stock' then
      if (v_step#>>'{payload,source_location_id}') is null or not exists (
          select 1 from public.locations where org_id = p_org_id and active
          and id = (v_step#>>'{payload,source_location_id}')::uuid)
        or (v_step#>>'{payload,source_location_id}')::uuid
          = coalesce((v_step->>'destination_location_id')::uuid, v_case.location_id) then
        v_missing := v_missing || 'source_location_id'::text;
      end if;
      if coalesce((v_step->>'item_id')::uuid, v_case.item_id) <> v_case.item_id
          or coalesce((v_step->>'destination_location_id')::uuid, v_case.location_id) <> v_case.location_id then
        v_missing := v_missing || 'case_mismatch'::text;
      end if;
      if (v_step#>>'{payload,arrival_end}') is null then v_missing := v_missing || 'arrival_window'::text; end if;
      if (v_step#>>'{payload,transfer_cost_minor}') is null then v_missing := v_missing || 'transfer_cost'::text; end if;
      v_gross := v_gross + coalesce((v_step#>>'{payload,transfer_cost_minor}')::bigint, 0);
      v_incremental := v_incremental + coalesce((v_step#>>'{payload,transfer_cost_minor}')::bigint, 0);
    end case;

    insert into public.plan_steps (org_id, plan_id, step_id, kind, item_id, quantity, unit,
      destination_location_id, depends_on_step_ids, evidence_ids, execution_mode, payload, missing_fields)
    values (p_org_id, v_plan_id, v_step->>'step_id', (v_step->>'kind')::public.plan_step_kind,
      coalesce((v_step->>'item_id')::uuid, v_case.item_id), (v_step->>'quantity')::integer,
      coalesce(v_step->>'unit', 'each'), coalesce((v_step->>'destination_location_id')::uuid, v_case.location_id),
      coalesce(array(select jsonb_array_elements_text(v_step->'depends_on_step_ids')), '{}'),
      coalesce(array(select jsonb_array_elements_text(v_step->'evidence_ids'))::uuid[], '{}'),
      v_step->>'execution_mode', coalesce(v_step->'payload', '{}'), v_missing);
    v_all_missing := v_all_missing || v_missing;
  end loop;

  v_status := case when cardinality(v_all_missing) = 0 and jsonb_array_length(p_steps) > 0
    then 'ready' else 'draft' end;
  update public.recovery_plans set status = v_status, gross_commitment_minor = v_gross,
    incremental_cost_minor = v_incremental, expires_at = v_expires
  where id = v_plan_id;
  v_fingerprint := public.plan_material_fingerprint(p_org_id, v_plan_id);
  update public.recovery_plans set input_fingerprint = v_fingerprint where id = v_plan_id;
  update public.cases set current_plan_id = v_plan_id,
    phase = case when v_status = 'ready' and phase in ('assessing', 'recovering', 'awaiting_supplier', 'awaiting_approval')
      then 'awaiting_approval'::public.case_phase else phase end,
    updated_at = p_now, row_version = row_version + 1
  where id = p_case_id and org_id = p_org_id;
  perform private.audit(p_org_id, 'user', p_actor_user_id::text, p_case_id, 'recovery_plan', v_plan_id,
    'plan.created', null, 1, null, p_now);
  return jsonb_build_object('ok', true, 'plan_id', v_plan_id, 'version', v_version, 'status', v_status,
    'input_fingerprint', v_fingerprint, 'gross_commitment_minor', v_gross::text,
    'incremental_cost_minor', v_incremental::text, 'missing_fields', to_jsonb(v_all_missing));
end;
$$;
