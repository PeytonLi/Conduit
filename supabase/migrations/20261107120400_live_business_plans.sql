-- A live_connector step is executable only for a PO line imported from an active
-- business-system connection with a provider version, outside replay mode.
-- Plans expose action error codes so a provider manual handoff can be shown,
-- and handed-off actions are not polled by reconciliation.

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
      v_step->>'kind' <> 'amend_delivery_schedule'
      or (select environment_mode from public.organizations where id = p_org_id) = 'replay'
      or not exists (
        select 1
        from public.purchase_order_lines l
        join public.purchase_orders po on po.id = l.purchase_order_id and po.org_id = l.org_id
        join public.datasets d on d.id = po.dataset_id and d.org_id = po.org_id
        join public.connections c on c.id = d.source_connection_id and c.org_id = d.org_id
        where l.org_id = p_org_id and l.id = (v_step#>>'{payload,po_line_id}')::uuid
          and po.source_version is not null
          and c.provider = any(private.erp_providers()) and c.status in ('healthy', 'degraded')
      )
    ) then
      v_missing := v_missing || 'live_connector_unavailable';
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

create or replace function public.plan_get(p_org_id uuid, p_plan_id uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select case when p.id is null then private.result_error('not_found', 'Plan not found') else
    jsonb_build_object('ok', true, 'plan', jsonb_build_object('id', p.id, 'case_id', p.case_id,
      'version', p.version, 'status', p.status, 'row_version', p.row_version,
      'input_fingerprint', p.input_fingerprint, 'gross_commitment_minor', p.gross_commitment_minor::text,
      'incremental_cost_minor', p.incremental_cost_minor::text, 'expires_at', p.expires_at,
      'currency', (select currency from public.organizations where id = p_org_id),
      'mode', (select environment_mode from public.organizations where id = p_org_id),
      'steps', (select coalesce(jsonb_agg(jsonb_build_object('step_id', s.step_id, 'kind', s.kind,
          'item_id', s.item_id, 'quantity', s.quantity, 'unit', s.unit,
          'destination_location_id', s.destination_location_id, 'depends_on_step_ids', s.depends_on_step_ids,
          'execution_mode', s.execution_mode, 'payload', s.payload, 'missing_fields', s.missing_fields)
          order by s.step_id), '[]') from public.plan_steps s where s.plan_id = p.id and s.org_id = p_org_id),
      'approvals', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'status', a.status,
          'expires_at', a.expires_at, 'consumed_by_action_id', a.consumed_by_action_id) order by a.created_at), '[]')
        from public.approvals a where a.plan_id = p.id and a.org_id = p_org_id),
      'actions', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'state', x.state,
          'plan_step_id', x.plan_step_id, 'error_code', x.error_code) order by x.created_at), '[]')
        from public.actions x where x.plan_id = p.id and x.org_id = p_org_id)))
  end
  from (select 1) one left join public.recovery_plans p on p.id = p_plan_id and p.org_id = p_org_id;
$$;

create or replace function public.ledger_due_reconciliations(p_limit integer default 50, p_now timestamptz default now())
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', org_id, 'action_id', id)), '[]')
  from (select org_id, id from public.actions
        where state in ('dispatching', 'submitted', 'unknown') and kind <> 'manual_export'
          and not (kind = 'live_business_amendment' and error_code = 'not_supported_by_provider')
          and next_reconcile_at <= p_now
        order by next_reconcile_at limit greatest(1, least(p_limit, 500))) due;
$$;
