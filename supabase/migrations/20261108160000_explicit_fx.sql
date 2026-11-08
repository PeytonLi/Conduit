-- Explicit FX evidence. No inferred, inverse, cross, or live vendor rates.
alter table public.organizations alter column currency set default 'USD';
alter table public.organizations add column fx_max_age_seconds integer not null default 86400
  check (fx_max_age_seconds between 1 and 2592000);

create table public.fx_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  from_currency text not null check (from_currency ~ '^[A-Z]{3}$'),
  to_currency text not null check (to_currency ~ '^[A-Z]{3}$' and to_currency <> from_currency),
  numerator text not null check (numerator ~ '^[1-9][0-9]{0,17}$'),
  denominator text not null check (denominator ~ '^[1-9][0-9]{0,17}$'),
  source text not null check (length(trim(source)) between 1 and 500),
  as_of timestamptz not null,
  entered_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index on public.fx_rates(org_id, from_currency, to_currency, as_of desc, created_at desc);
alter table public.fx_rates enable row level security;
revoke all on public.fx_rates from anon, authenticated;
grant select, insert on public.fx_rates to service_role;
grant select on public.fx_rates to authenticated;
create policy tenant_member_select on public.fx_rates for select to authenticated using (public.is_member(org_id));

create function private.fx_rate_immutable() returns trigger language plpgsql as $$
begin raise exception 'FX evidence is immutable; append a replacement rate'; end;
$$;
create trigger fx_rate_immutable before update or delete on public.fx_rates
  for each row execute function private.fx_rate_immutable();

create function public.fx_rate_record(p_org_id uuid, p_actor_user_id uuid, p_from_currency text,
  p_numerator bigint, p_denominator bigint, p_as_of timestamptz, p_source text,
  p_now timestamptz default now()) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_id uuid; v_home text;
begin
  if private.member_role(p_org_id, p_actor_user_id) is distinct from 'owner' then
    return private.result_error('forbidden', 'Only an owner can enter FX rates');
  end if;
  select currency into v_home from public.organizations where id = p_org_id;
  if p_as_of is null or p_as_of > p_now or p_source is null or length(trim(p_source)) not between 1 and 500
      or p_from_currency is null or p_from_currency !~ '^[A-Z]{3}$' or p_from_currency = v_home
      or p_numerator is null or p_numerator not between 1 and 999999999999999999
      or p_denominator is null or p_denominator not between 1 and 999999999999999999 then
    return private.result_error('validation_failed', 'Invalid rate, source, currency or as_of timestamp');
  end if;
  insert into public.fx_rates(org_id, from_currency, to_currency, numerator, denominator, source, as_of, entered_by)
  values(p_org_id, p_from_currency, v_home, p_numerator::text, p_denominator::text, p_source, p_as_of, p_actor_user_id)
  returning id into v_id;
  perform private.audit(p_org_id, 'user', p_actor_user_id::text, null, 'fx_rate', v_id,
    'fx_rate.recorded', null, 1, p_source, p_now);
  return jsonb_build_object('ok', true, 'rate_id', v_id);
end;
$$;
revoke all on function public.fx_rate_record(uuid, uuid, text, bigint, bigint, timestamptz, text, timestamptz) from public, anon, authenticated;
grant execute on function public.fx_rate_record(uuid, uuid, text, bigint, bigint, timestamptz, text, timestamptz) to service_role;

create function private.fx_convert(p_org_id uuid, p_amount bigint, p_currency text, p_now timestamptz)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare v_home text; v_age integer; v_rate record; v_result jsonb; v_converted numeric; v_expiry timestamptz;
begin
  select currency, fx_max_age_seconds into v_home, v_age from public.organizations where id = p_org_id;
  v_result := jsonb_build_object('original_minor', p_amount::text, 'original_currency', p_currency,
    'currency', v_home, 'converted_minor', null, 'rate', null, 'reason', null, 'expires_at', null);
  if p_amount is null or abs(p_amount::numeric) > 1000000000000 then
    return v_result || jsonb_build_object('reason', 'fx_amount_out_of_range');
  end if;
  if p_currency = v_home then return v_result || jsonb_build_object('converted_minor', p_amount::text); end if;
  select * into v_rate from public.fx_rates where org_id = p_org_id
    and from_currency = p_currency and to_currency = v_home and as_of <= p_now
    order by as_of desc, created_at desc, id desc limit 1;
  if not found then return v_result || jsonb_build_object('reason', 'fx_rate_missing'); end if;
  v_expiry := v_rate.as_of + make_interval(secs => v_age);
  if v_expiry <= p_now then return v_result || jsonb_build_object('reason', 'fx_rate_stale'); end if;
  v_converted := round(p_amount::numeric * v_rate.numerator::numeric / v_rate.denominator::numeric);
  if abs(v_converted) > 1000000000000 then
    return v_result || jsonb_build_object('reason', 'fx_amount_out_of_range');
  end if;
  return v_result || jsonb_build_object('converted_minor', v_converted::bigint::text, 'expires_at', v_expiry,
    'rate', jsonb_build_object('id', v_rate.id, 'from_currency', v_rate.from_currency,
      'to_currency', v_rate.to_currency, 'numerator', v_rate.numerator::text,
      'denominator', v_rate.denominator::text, 'source', v_rate.source, 'as_of', v_rate.as_of));
end;
$$;

create or replace function public.plan_material_fingerprint(p_org_id uuid, p_plan_id uuid)
returns text language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_plan record;
  v_case record;
  v_doc jsonb;
begin
  select * into v_plan from public.recovery_plans where id = p_plan_id and org_id = p_org_id;
  if not found then return null; end if;
  select * into v_case from public.cases where id = v_plan.case_id and org_id = p_org_id;
  v_doc := jsonb_build_object(
    'plan', jsonb_build_object('id', v_plan.id, 'version', v_plan.version, 'case_id', v_plan.case_id,
      'home_currency', (select currency from public.organizations where id = p_org_id),
      'fx_max_age_seconds', (select fx_max_age_seconds from public.organizations where id = p_org_id),
      'incremental_cost_minor', v_plan.incremental_cost_minor::text,
      'assessment_id', v_plan.assessment_id, 'gross_commitment_minor', v_plan.gross_commitment_minor::text),
    'steps', (select coalesce(jsonb_agg(jsonb_build_object('step_id', s.step_id, 'kind', s.kind,
        'item_id', s.item_id, 'quantity', s.quantity, 'unit', s.unit,
        'destination_location_id', s.destination_location_id, 'depends_on', s.depends_on_step_ids,
        'execution_mode', s.execution_mode, 'payload', s.payload) order by s.step_id), '[]')
      from public.plan_steps s where s.plan_id = v_plan.id and s.org_id = p_org_id),
    'quotes', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'quantity', q.quantity,
        'unit', q.unit, 'unit_price_minor', q.unit_price_minor::text, 'currency', q.currency,
        'freight_minor', q.freight_minor::text, 'fees_minor', q.fees_minor::text,
        'tax_minor', q.nonrecoverable_tax_minor::text, 'destination', q.destination_location_id,
        'arrival_start', q.arrival_start, 'arrival_end', q.arrival_end, 'valid_until', q.valid_until,
        'latest_order_at', q.latest_order_at, 'status', q.status) order by q.id), '[]')
      from public.quotes q where q.org_id = p_org_id and q.id in (
        select (s.payload->>'quote_id')::uuid from public.plan_steps s
        where s.plan_id = v_plan.id and s.org_id = p_org_id and s.payload ? 'quote_id')),
    'inventory', (select coalesce(jsonb_agg(jsonb_build_object('dataset_id', i.dataset_id,
        'physical', i.physical_qty, 'unusable', i.unusable_qty, 'outside', i.outside_allocations_qty,
        'source_as_of', i.source_as_of) order by i.id), '[]')
      from public.inventory_snapshots i join public.datasets d on d.id = i.dataset_id and d.org_id = i.org_id
      where i.org_id = p_org_id and d.status = 'active' and i.item_id = v_case.item_id
        and i.location_id = v_case.location_id),
    'demand', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'qty', r.remaining_qty,
        'required_at', r.required_at, 'certainty', r.certainty, 'reserved', r.included_reserved_qty,
        'status', r.status) order by r.id), '[]')
      from public.demand_requirements r join public.datasets d on d.id = r.dataset_id and d.org_id = r.org_id
      where r.org_id = p_org_id and d.status = 'active' and r.item_id = v_case.item_id
        and r.location_id = v_case.location_id),
    'commitments', (select coalesce(jsonb_agg(jsonb_build_object('line', l.id, 'ordered', l.ordered_qty,
        'received', l.received_qty, 'cancelled', l.cancelled_qty, 'price', l.unit_price_minor::text,
        'schedules', (select coalesce(jsonb_agg(jsonb_build_object('id', rs.id,
            'qty', rs.quantity_remaining, 'earliest', rs.earliest_at, 'latest', rs.latest_at,
            'promise', rs.promise_state) order by rs.id), '[]')
          from public.receipt_schedules rs
          where rs.po_line_id = l.id and rs.org_id = p_org_id and rs.promise_state <> 'superseded'))
        order by l.id), '[]')
      from public.purchase_order_lines l
      where l.org_id = p_org_id and l.item_id = v_case.item_id
        and l.destination_location_id = v_case.location_id),
    'other_claims', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'qty', c.quantity,
        'state', c.state) order by c.id), '[]')
      from public.allocation_claims c
      where c.org_id = p_org_id and c.plan_id <> v_plan.id and c.item_id = v_case.item_id
        and c.location_id = v_case.location_id and c.state in ('active', 'uncertain')),
    'destination', (select jsonb_build_object('id', l.id, 'timezone', l.timezone,
        'address', l.destination_address)
      from public.locations l where l.id = v_case.location_id and l.org_id = p_org_id),
    'policy_version_id', (select current_policy_version_id from public.organizations where id = p_org_id)
  );
  return private.canonical_hash(v_doc);
end;
$$;

create or replace function public.plan_create(
  p_org_id uuid, p_case_id uuid, p_actor_user_id uuid, p_assessment_id uuid, p_steps jsonb,
  p_idempotency_key text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_original_gross bigint;
  v_original_incremental bigint;
  v_gross_conversion jsonb;
  v_incremental_conversion jsonb;
  v_cost_currency text;
  v_home text;
  v_unknown boolean := false;
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
  -- The service planner can propose, but never approve, without impersonating a member.
  if (p_actor_user_id is null and current_user not in ('service_role', 'postgres'))
      or (p_actor_user_id is not null and coalesce(private.member_role(p_org_id, p_actor_user_id)::text, '') not in ('owner', 'operator')) then
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
    v_original_gross := v_gross;
    v_original_incremental := v_incremental;
    select currency into v_home from public.organizations where id = p_org_id;
    v_cost_currency := coalesce(v_step#>>'{payload,currency}', v_home);
    if v_step->>'kind' = 'amend_delivery_schedule' and v_step#>>'{payload,quote_id}' is not null then
      select * into v_quote from public.quotes where org_id = p_org_id and case_id = p_case_id
        and id = (v_step#>>'{payload,quote_id}')::uuid;
      if not found or v_quote.currency is null or v_quote.freight_minor is null
          or v_quote.fees_minor is null or v_quote.nonrecoverable_tax_minor is null then
        v_missing := v_missing || 'verified_quote_terms'::text;
        v_unknown := true;
      else
        v_cost_currency := v_quote.currency;
        v_step := jsonb_set(v_step, '{payload,added_cost_minor}',
          to_jsonb((v_quote.freight_minor + v_quote.fees_minor + v_quote.nonrecoverable_tax_minor)::text));
      end if;
    end if;
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
          or v_quote.currency is null or v_quote.unit_price_minor is null or v_quote.quantity is null or v_quote.freight_minor is null
          or v_quote.fees_minor is null or v_quote.nonrecoverable_tax_minor is null
          or v_quote.destination_location_id is distinct from v_case.location_id then
        v_missing := v_missing || 'verified_quote_terms';
      else
        v_cost_currency := v_quote.currency;
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

    if v_cost_currency is distinct from v_home and v_step->>'execution_mode' <> 'manual' then
      v_missing := v_missing || 'foreign_cost_requires_manual_execution'::text;
    end if;
    v_gross_conversion := private.fx_convert(p_org_id, v_gross - v_original_gross, v_cost_currency, p_now);
    v_incremental_conversion := private.fx_convert(p_org_id, v_incremental - v_original_incremental, v_cost_currency, p_now);
    if v_gross - v_original_gross < 0 then
      v_missing := v_missing || 'negative_recovery_cost'::text;
      v_unknown := true;
    end if;
    if v_gross_conversion->>'reason' is not null or v_incremental_conversion->>'reason' is not null then
      v_missing := v_missing || coalesce(v_gross_conversion->>'reason', v_incremental_conversion->>'reason');
      v_unknown := true;
    end if;
    v_gross := v_original_gross + coalesce((v_gross_conversion->>'converted_minor')::bigint, 0);
    v_incremental := v_original_incremental + coalesce((v_incremental_conversion->>'converted_minor')::bigint, 0);
    v_expires := least(v_expires, (v_gross_conversion->>'expires_at')::timestamptz,
      (v_incremental_conversion->>'expires_at')::timestamptz);
    v_step := jsonb_set(v_step, '{payload}', coalesce(v_step->'payload', '{}') ||
      jsonb_build_object('cost_conversion', jsonb_build_object('gross', v_gross_conversion, 'incremental', v_incremental_conversion)));

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

  if v_gross > 1000000000000 or abs(v_incremental::numeric) > 1000000000000 then
    v_all_missing := v_all_missing || 'fx_amount_out_of_range'::text;
    v_unknown := true;
  end if;
  if v_unknown then v_gross := null; v_incremental := null; end if;
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
  perform private.audit(p_org_id, case when p_actor_user_id is null then 'system' else 'user' end,
    coalesce(p_actor_user_id::text, 'planner'), p_case_id, 'recovery_plan', v_plan_id,
    'plan.created', null, 1, null, p_now);
  return jsonb_build_object('ok', true, 'plan_id', v_plan_id, 'version', v_version, 'status', v_status,
    'input_fingerprint', v_fingerprint, 'gross_commitment_minor', v_gross::text,
    'incremental_cost_minor', v_incremental::text, 'missing_fields', to_jsonb(v_all_missing));
end;
$$;

-- Persist the evidence on the immutable approval terms as well as in its fingerprint.
alter table public.approvals add column conversion_evidence jsonb not null default '[]';
create function private.approval_fx_snapshot() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  select coalesce(jsonb_agg(jsonb_build_object('step_id', step_id, 'cost_conversion', payload->'cost_conversion') order by step_id), '[]')
    into new.conversion_evidence from public.plan_steps where org_id = new.org_id and plan_id = new.plan_id;
  return new;
end;
$$;
create trigger approval_fx_snapshot before insert on public.approvals
  for each row execute function private.approval_fx_snapshot();

create or replace function public.plan_get(p_org_id uuid, p_plan_id uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select case when p.id is null then private.result_error('not_found', 'Plan not found') else
    jsonb_build_object('ok', true, 'plan', jsonb_build_object('id', p.id, 'case_id', p.case_id,
      'version', p.version, 'status', p.status, 'row_version', p.row_version,
      'input_fingerprint', p.input_fingerprint, 'gross_commitment_minor', p.gross_commitment_minor::text,
      'incremental_cost_minor', p.incremental_cost_minor::text, 'expires_at', p.expires_at,
      'currency', coalesce((select payload#>>'{cost_conversion,gross,currency}' from public.plan_steps where org_id = p_org_id and plan_id = p.id order by step_id limit 1), (select currency from public.organizations where id = p_org_id)),
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
