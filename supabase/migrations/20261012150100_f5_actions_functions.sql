-- F5 transactional commands. Every function takes an explicit org id and a caller-supplied
-- clock (p_now) so tests can use a fake clock. Called only by the server with the service role.

create or replace function private.canonical_hash(p_value jsonb)
returns text language sql immutable set search_path = public, pg_temp as $$
  select 'sha256:' || encode(sha256(convert_to(coalesce(p_value, 'null'::jsonb)::text, 'UTF8')), 'hex');
$$;

create or replace function private.result_error(p_code text, p_message text, p_extra jsonb default '{}'::jsonb)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'message', p_message) || coalesce(p_extra, '{}'::jsonb);
$$;

create or replace function private.audit(
  p_org_id uuid, p_actor_type text, p_actor_id text, p_case_id uuid, p_entity_type text,
  p_entity_id uuid, p_event_name text, p_prev integer, p_new integer, p_reason text, p_now timestamptz
) returns void language sql set search_path = public, pg_temp as $$
  insert into public.audit_events (org_id, actor_type, actor_id, case_id, entity_type, entity_id,
    event_name, previous_version, new_version, reason, occurred_at)
  values (p_org_id, p_actor_type, p_actor_id, p_case_id, p_entity_type, p_entity_id,
    p_event_name, p_prev, p_new, p_reason, p_now);
$$;

-- ---------------------------------------------------------------- outbox
create or replace function public.outbox_enqueue(
  p_org_id uuid, p_event_type text, p_aggregate_id uuid, p_payload jsonb,
  p_correlation_id uuid default null, p_causation_id uuid default null, p_now timestamptz default now()
) returns uuid language plpgsql set search_path = public, pg_temp as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.event_outbox (event_id, org_id, aggregate_id, correlation_id, causation_id,
    event_type, schema_version, payload, created_at)
  values (v_id, p_org_id, p_aggregate_id, coalesce(p_correlation_id, v_id), p_causation_id,
    p_event_type, 1, p_payload, p_now);
  return v_id;
end;
$$;

create or replace function public.outbox_claim_batch(p_limit integer default 100, p_event_ids uuid[] default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_rows jsonb;
begin
  with picked as (
    select event_id from public.event_outbox
    where published_at is null and (p_event_ids is null or event_id = any(p_event_ids))
    order by created_at, event_id
    limit greatest(1, least(p_limit, 500))
    for update skip locked
  ), bumped as (
    update public.event_outbox o set attempts = o.attempts + 1
    from picked where o.event_id = picked.event_id
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'event_id', event_id, 'org_id', org_id, 'aggregate_id', aggregate_id,
    'correlation_id', correlation_id, 'causation_id', causation_id, 'event_type', event_type,
    'schema_version', schema_version, 'payload', payload, 'created_at', created_at,
    'attempts', attempts) order by created_at, event_id), '[]'::jsonb)
  into v_rows from bumped;
  return v_rows;
end;
$$;

create or replace function public.outbox_mark_published(p_event_ids uuid[], p_now timestamptz default now())
returns integer language plpgsql set search_path = public, pg_temp as $$
declare v_count integer;
begin
  update public.event_outbox set published_at = p_now
  where event_id = any(p_event_ids) and published_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Returns true only the first time a consumer sees an event id.
create or replace function public.consumer_dedupe(p_org_id uuid, p_consumer text, p_event_id uuid)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare v_count integer;
begin
  insert into public.processed_events (org_id, consumer, event_id)
  values (p_org_id, p_consumer, p_event_id)
  on conflict (consumer, event_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ---------------------------------------------------------------- membership / policy
create or replace function private.member_role(p_org_id uuid, p_user_id uuid)
returns public.membership_role language sql stable set search_path = public, pg_temp as $$
  select role from public.memberships
  where org_id = p_org_id and auth_user_id = p_user_id and active;
$$;

create or replace function private.current_policy(p_org_id uuid)
returns table (policy_id uuid, version integer, settings jsonb)
language sql stable set search_path = public, pg_temp as $$
  select p.id, p.version, p.settings
  from public.organizations o
  left join public.policies p on p.id = o.current_policy_version_id and p.org_id = o.id
  where o.id = p_org_id;
$$;

create or replace function private.policy_setting(p_settings jsonb, p_path text[], p_default jsonb)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_settings #> p_path, p_default);
$$;

create or replace function public.policy_create_version(
  p_org_id uuid, p_actor_user_id uuid, p_expected_version integer, p_settings jsonb,
  p_reason text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_current integer;
  v_id uuid;
begin
  if private.member_role(p_org_id, p_actor_user_id) is distinct from 'owner' then
    return private.result_error('forbidden', 'Only an owner can change policy');
  end if;
  perform 1 from public.organizations where id = p_org_id for update;
  select coalesce(max(version), 0) into v_current from public.policies where org_id = p_org_id;
  if v_current <> p_expected_version then
    return private.result_error('stale_version', 'Policy changed since it was loaded',
      jsonb_build_object('current_version', v_current));
  end if;
  if coalesce(trim(p_reason), '') = '' then
    return private.result_error('validation_failed', 'A reason is required');
  end if;
  insert into public.policies (org_id, version, settings, author_user_id, reason, effective_at, created_at)
  values (p_org_id, v_current + 1, p_settings, p_actor_user_id, p_reason, p_now, p_now)
  returning id into v_id;
  update public.organizations
    set current_policy_version_id = v_id, row_version = row_version + 1, updated_at = p_now
    where id = p_org_id;
  perform private.audit(p_org_id, 'user', p_actor_user_id::text, null, 'policy', v_id,
    'policy.version_created', v_current, v_current + 1, p_reason, p_now);
  perform public.outbox_enqueue(p_org_id, 'policy.changed', v_id,
    jsonb_build_object('policy_version_id', v_id), null, null, p_now);
  return jsonb_build_object('ok', true, 'policy_version_id', v_id, 'version', v_current + 1);
end;
$$;

-- Contact hours are evaluated in the contact's own IANA timezone.
create or replace function private.within_contact_hours(p_settings jsonb, p_timezone text, p_now timestamptz)
returns boolean language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_local timestamp;
  v_days jsonb := private.policy_setting(p_settings, '{outreach,contact_hours,weekdays}', '[1,2,3,4,5]');
  v_start time := (private.policy_setting(p_settings, '{outreach,contact_hours,start}', '"09:00"') #>> '{}')::time;
  v_end time := (private.policy_setting(p_settings, '{outreach,contact_hours,end}', '"17:00"') #>> '{}')::time;
begin
  if p_timezone is null or not exists (select 1 from pg_timezone_names where name = p_timezone) then
    return false;
  end if;
  v_local := p_now at time zone p_timezone;
  return v_days @> to_jsonb(extract(isodow from v_local)::integer)
    and v_local::time >= v_start and v_local::time < v_end;
end;
$$;

-- Returns the list of policy denials for contacting one supplier contact. Empty means allowed.
create or replace function private.outreach_denials(
  p_org_id uuid, p_case_id uuid, p_contact_id uuid, p_channel text, p_now timestamptz,
  p_check_counts boolean
) returns text[] language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_denials text[] := '{}';
  v_settings jsonb;
  v_contact record;
  v_case record;
  v_kind public.action_kind := case p_channel when 'email' then 'supplier_email' else 'supplier_call' end;
  v_suppliers integer;
  v_same_supplier integer;
  v_total integer;
begin
  select settings into v_settings from private.current_policy(p_org_id);
  v_settings := coalesce(v_settings, '{}'::jsonb);
  select c.*, s.purchasing_status into v_contact
  from public.supplier_contacts c join public.suppliers s on s.id = c.supplier_id and s.org_id = c.org_id
  where c.id = p_contact_id and c.org_id = p_org_id;
  if not found then
    return array['contact_not_found'];
  end if;
  select * into v_case from public.cases where id = p_case_id and org_id = p_org_id;
  if (private.policy_setting(v_settings, '{dispatch_paused}', 'false'))::boolean then
    v_denials := v_denials || 'dispatch_paused'::text;
  end if;
  if v_case.run_control <> 'active' then
    v_denials := v_denials || 'case_not_active'::text;
  end if;
  if v_contact.outreach_approved_at is null then
    v_denials := v_denials || 'contact_not_approved'::text;
  end if;
  if v_contact.channel <> p_channel then
    v_denials := v_denials || 'channel_mismatch'::text;
  end if;
  if not (v_contact.permitted_channels @> array[p_channel]) then
    v_denials := v_denials || 'channel_not_permitted'::text;
  end if;
  if v_contact.purchasing_status = 'blocked' then
    v_denials := v_denials || 'supplier_blocked'::text;
  end if;
  if not (private.policy_setting(v_settings,
      case p_channel when 'email' then '{outreach,email_enabled}'::text[] else '{outreach,call_enabled}'::text[] end,
      'false'))::boolean then
    v_denials := v_denials || 'channel_disabled'::text;
  end if;
  if not private.within_contact_hours(v_settings, v_contact.timezone, p_now) then
    v_denials := v_denials || 'outside_contact_hours'::text;
  end if;
  if p_check_counts then
    select count(distinct c.supplier_id) filter (where c.supplier_id <> v_contact.supplier_id),
           count(*) filter (where c.supplier_id = v_contact.supplier_id and a.kind = v_kind),
           count(*) filter (where a.kind = v_kind)
      into v_suppliers, v_same_supplier, v_total
    from public.actions a join public.supplier_contacts c on c.id = a.contact_id and c.org_id = a.org_id
    where a.org_id = p_org_id and a.case_id = p_case_id and a.episode = v_case.episode
      and a.kind in ('supplier_email', 'supplier_call') and a.state <> 'cancelled';
    if v_suppliers + 1 > (private.policy_setting(v_settings, '{outreach,max_suppliers_per_episode}', '3'))::integer then
      v_denials := v_denials || 'supplier_limit'::text;
    end if;
    if p_channel = 'phone' then
      if v_same_supplier + 1 > (private.policy_setting(v_settings, '{outreach,max_calls_per_supplier_per_episode}', '1'))::integer then
        v_denials := v_denials || 'call_limit_supplier'::text;
      end if;
      if v_total + 1 > (private.policy_setting(v_settings, '{outreach,max_calls_per_episode}', '3'))::integer then
        v_denials := v_denials || 'call_limit_case'::text;
      end if;
    elsif v_same_supplier + 1 > (private.policy_setting(v_settings, '{outreach,max_emails_per_supplier_per_episode}', '2'))::integer then
      v_denials := v_denials || 'email_limit_supplier'::text;
    end if;
  end if;
  return v_denials;
end;
$$;

-- Material input fingerprint for a plan: stock, demand, commitments, quote terms, destination,
-- policy and plan version. Presentation-only fields (descriptions, row versions) are excluded.
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

-- ---------------------------------------------------------------- plans
-- Steps arrive already shape-validated (Zod). This function owns all money arithmetic and
-- reference checks so the model never decides quantities, money or authority.
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
    if v_step->>'execution_mode' = 'live_connector' then
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

-- ---------------------------------------------------------------- approvals
create or replace function public.approve_plan(
  p_org_id uuid, p_plan_id uuid, p_actor_user_id uuid, p_plan_version integer,
  p_input_fingerprint text, p_approved_ceiling_minor bigint, p_expected_version integer,
  p_idempotency_key text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_plan record;
  v_existing record;
  v_current_fp text;
  v_validity integer;
  v_expires timestamptz;
  v_id uuid;
  v_currency text;
begin
  select * into v_existing from public.approvals where org_id = p_org_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.plan_id = p_plan_id and v_existing.plan_version = p_plan_version
        and v_existing.input_fingerprint = p_input_fingerprint
        and v_existing.approved_ceiling_minor = p_approved_ceiling_minor
        and v_existing.approving_user_id = p_actor_user_id then
      return jsonb_build_object('ok', true, 'replayed', true, 'approval_id', v_existing.id,
        'expires_at', v_existing.expires_at, 'status', v_existing.status);
    end if;
    return private.result_error('idempotency_conflict', 'Idempotency key was used for different approval terms');
  end if;
  -- Authority is re-derived from the database; client-asserted roles are never trusted.
  if private.member_role(p_org_id, p_actor_user_id) is distinct from 'owner' then
    return private.result_error('forbidden', 'Only an owner can approve financial commitments');
  end if;
  select * into v_plan from public.recovery_plans where id = p_plan_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Plan not found'); end if;
  perform 1 from public.cases where id = v_plan.case_id and org_id = p_org_id for update;
  if v_plan.row_version <> p_expected_version or v_plan.version <> p_plan_version then
    return private.result_error('stale_version', 'Plan changed since it was reviewed',
      jsonb_build_object('current_version', v_plan.row_version));
  end if;
  if v_plan.status <> 'ready' then
    return private.result_error('invalid_state', 'Plan is not ready for approval',
      jsonb_build_object('status', v_plan.status));
  end if;
  v_current_fp := public.plan_material_fingerprint(p_org_id, p_plan_id);
  if p_input_fingerprint <> v_plan.input_fingerprint or v_current_fp <> v_plan.input_fingerprint then
    return private.result_error('stale_fingerprint', 'Material inputs changed; review the updated plan');
  end if;
  if p_approved_ceiling_minor < coalesce(v_plan.gross_commitment_minor, 0) then
    return private.result_error('ceiling_too_low', 'Approved ceiling is below the plan commitment');
  end if;
  if v_plan.expires_at is not null and v_plan.expires_at <= p_now then
    return private.result_error('plan_expired', 'Quote terms or ordering cutoff expired');
  end if;
  select (private.policy_setting(settings, '{approval,validity_seconds}', '1800'))::integer
    into v_validity from private.current_policy(p_org_id);
  v_validity := least(coalesce(v_validity, 1800), 1800);
  v_expires := least(p_now + make_interval(secs => v_validity), coalesce(v_plan.expires_at, 'infinity'));
  select currency into v_currency from public.organizations where id = p_org_id;

  insert into public.approvals (org_id, plan_id, plan_version, approving_user_id, authority_role,
    input_fingerprint, approved_ceiling_minor, currency, expires_at, status, idempotency_key, created_at)
  values (p_org_id, p_plan_id, p_plan_version, p_actor_user_id, 'owner', v_plan.input_fingerprint,
    p_approved_ceiling_minor, v_currency, v_expires, 'active', p_idempotency_key, p_now)
  returning id into v_id;
  update public.recovery_plans set status = 'approved', row_version = row_version + 1, updated_at = p_now
  where id = p_plan_id;
  update public.cases set phase = 'executing', updated_at = p_now, row_version = row_version + 1
  where id = v_plan.case_id and org_id = p_org_id;
  perform private.audit(p_org_id, 'user', p_actor_user_id::text, v_plan.case_id, 'approval', v_id,
    'plan.approved', v_plan.row_version, v_plan.row_version + 1, null, p_now);
  perform public.outbox_enqueue(p_org_id, 'plan.approved', v_plan.case_id,
    jsonb_build_object('case_id', v_plan.case_id, 'plan_id', p_plan_id, 'approval_id', v_id), null, null, p_now);
  return jsonb_build_object('ok', true, 'approval_id', v_id, 'expires_at', v_expires, 'status', 'active');
end;
$$;

create or replace function public.reject_plan(
  p_org_id uuid, p_plan_id uuid, p_actor_user_id uuid, p_expected_version integer, p_reason text,
  p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_plan record;
begin
  if private.member_role(p_org_id, p_actor_user_id) is distinct from 'owner' then
    return private.result_error('forbidden', 'Only an owner can reject plans');
  end if;
  select * into v_plan from public.recovery_plans where id = p_plan_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Plan not found'); end if;
  if v_plan.row_version <> p_expected_version then
    return private.result_error('stale_version', 'Plan changed since it was reviewed');
  end if;
  if v_plan.status not in ('draft', 'ready', 'approved') then
    return private.result_error('invalid_state', 'Plan can no longer be rejected');
  end if;
  update public.recovery_plans set status = 'rejected', row_version = row_version + 1, updated_at = p_now
  where id = p_plan_id;
  update public.approvals set status = 'revoked' where org_id = p_org_id and plan_id = p_plan_id and status = 'active';
  update public.cases set phase = 'recovering', updated_at = p_now, row_version = row_version + 1
  where id = v_plan.case_id and org_id = p_org_id and phase in ('awaiting_approval', 'executing');
  perform private.audit(p_org_id, 'user', p_actor_user_id::text, v_plan.case_id, 'recovery_plan', p_plan_id,
    'plan.rejected', v_plan.row_version, v_plan.row_version + 1, p_reason, p_now);
  perform public.outbox_enqueue(p_org_id, 'case.recovery.requested', v_plan.case_id,
    jsonb_build_object('case_id', v_plan.case_id, 'assessment_version', 0), null, null, p_now);
  return jsonb_build_object('ok', true, 'plan_id', p_plan_id, 'status', 'rejected');
end;
$$;

-- ---------------------------------------------------------------- action ledger
create or replace function private.action_json(p_org_id uuid, p_action_id uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', a.id, 'org_id', a.org_id, 'case_id', a.case_id, 'plan_id', a.plan_id,
    'plan_step_id', a.plan_step_id, 'approval_id', a.approval_id, 'contact_id', a.contact_id,
    'kind', a.kind, 'state', a.state, 'payload_hash', a.payload_hash, 'payload', a.payload,
    'idempotency_key', a.idempotency_key, 'provider', a.provider, 'provider_ref', a.provider_ref,
    'attempts', a.attempts, 'dispatch_started_at', a.dispatch_started_at,
    'next_reconcile_at', a.next_reconcile_at, 'outcome', a.outcome, 'error_code', a.error_code,
    'mode', a.mode, 'episode', a.episode, 'row_version', a.row_version,
    'created_at', a.created_at, 'updated_at', a.updated_at)
  from public.actions a where a.id = p_action_id and a.org_id = p_org_id;
$$;

create or replace function private.release_claims(p_org_id uuid, p_action_id uuid, p_state public.allocation_claim_state, p_now timestamptz)
returns void language sql set search_path = public, pg_temp as $$
  update public.allocation_claims set state = p_state, updated_at = p_now, row_version = row_version + 1
  where org_id = p_org_id and action_id = p_action_id and state in ('active', 'uncertain');
$$;

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
  v_financial boolean := p_kind in ('demo_ledger_amendment', 'manual_export');
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
    if v_org.environment_mode = 'live' then
      v_freshness := (private.policy_setting(v_settings, '{freshness,live_business_data_seconds}', '900'))::integer;
      select min(source_as_of) into v_oldest from public.datasets where org_id = p_org_id and status = 'active';
      if v_oldest is null or v_oldest < p_now - make_interval(secs => v_freshness) then
        return private.result_error('stale_data', 'Business data is older than the freshness policy');
      end if;
    end if;
    v_provider := case p_kind when 'demo_ledger_amendment' then 'demo_ledger' else 'manual_export' end;
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
  v_financial := v_action.kind in ('demo_ledger_amendment', 'manual_export');
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
  if v_action.kind = 'manual_export' and p_outcome = 'confirmed' and (p_source <> 'owner' or p_evidence_id is null) then
    return private.result_error('evidence_required', 'Manual execution must be confirmed by an owner with evidence');
  end if;

  update public.actions set state = p_outcome,
    provider_ref = coalesce(p_provider_ref, provider_ref),
    outcome = jsonb_build_object('safe_summary', left(coalesce(p_safe_summary, ''), 500), 'source', p_source,
      'evidence_id', p_evidence_id, 'recorded_at', p_now),
    error_code = p_error_code,
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
  elsif p_outcome = 'submitted' and v_action.kind = 'manual_export' then
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

create or replace function public.ledger_get_action(p_org_id uuid, p_action_id uuid)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare v_action jsonb := private.action_json(p_org_id, p_action_id);
begin
  if v_action is null then return private.result_error('not_found', 'Action not found'); end if;
  return jsonb_build_object('ok', true, 'action', v_action,
    'claims', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'state', c.state, 'quantity', c.quantity,
        'receipt_schedule_ids', c.receipt_schedule_ids, 'demand_ids', c.demand_ids) order by c.id), '[]')
      from public.allocation_claims c where c.org_id = p_org_id and c.action_id = p_action_id),
    'approval', (select jsonb_build_object('id', ap.id, 'status', ap.status, 'expires_at', ap.expires_at,
        'approved_ceiling_minor', ap.approved_ceiling_minor::text, 'consumed_by_action_id', ap.consumed_by_action_id)
      from public.approvals ap join public.actions a on a.approval_id = ap.id and a.org_id = ap.org_id
      where a.id = p_action_id and a.org_id = p_org_id));
end;
$$;

create or replace function public.ledger_resolve_action(
  p_org_id uuid, p_action_id uuid, p_actor_user_id uuid, p_outcome public.action_state,
  p_evidence_id uuid, p_note text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_state public.action_state;
begin
  if private.member_role(p_org_id, p_actor_user_id) is distinct from 'owner' then
    return private.result_error('forbidden', 'Only an owner can resolve an action outcome');
  end if;
  if p_outcome not in ('confirmed', 'failed') then
    return private.result_error('validation_failed', 'Resolution must be confirmed or failed');
  end if;
  if p_evidence_id is null or not exists (select 1 from public.evidence where id = p_evidence_id and org_id = p_org_id) then
    return private.result_error('evidence_required', 'Owner resolution requires evidence from this organization');
  end if;
  select state into v_state from public.actions where id = p_action_id and org_id = p_org_id;
  if v_state is null then return private.result_error('not_found', 'Action not found'); end if;
  if v_state not in ('unknown', 'submitted') then
    return private.result_error('invalid_state', 'Only unknown or submitted actions can be resolved');
  end if;
  return public.ledger_record_outcome(p_org_id, p_action_id, p_outcome, null,
    coalesce(p_note, 'Resolved by owner with evidence'), null, 'owner', p_actor_user_id::text, p_evidence_id, p_now);
end;
$$;

-- ---------------------------------------------------------------- demo ledger (simulated business system)
create or replace function public.demo_ledger_apply(
  p_org_id uuid, p_action_id uuid, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_action record;
  v_entry record;
  v_old record;
  v_sched jsonb;
  v_new_id uuid;
  v_line uuid;
begin
  select * into v_action from public.actions where id = p_action_id and org_id = p_org_id for update;
  if not found or v_action.kind <> 'demo_ledger_amendment' then
    return private.result_error('not_found', 'Demo ledger action not found');
  end if;
  if v_action.mode = 'live' then
    return private.result_error('mode_not_allowed', 'The demo ledger is never written in live mode');
  end if;
  select * into v_entry from public.demo_ledger_entries where org_id = p_org_id and action_id = p_action_id;
  if found then
    if v_entry.payload_hash <> v_action.payload_hash then
      return private.result_error('idempotency_conflict', 'Demo ledger already holds a different change');
    end if;
    return jsonb_build_object('ok', true, 'replayed', true, 'entry_id', v_entry.id, 'label', v_entry.label);
  end if;
  if v_action.state not in ('dispatching', 'unknown', 'submitted') then
    return private.result_error('invalid_state', 'Action is not being dispatched');
  end if;
  v_line := (v_action.payload->>'po_line_id')::uuid;
  select * into v_old from public.receipt_schedules
  where id = (v_action.payload->>'receipt_schedule_id')::uuid and org_id = p_org_id and po_line_id = v_line
  for update;
  if not found or v_old.promise_state = 'superseded' then
    return private.result_error('precondition_failed', 'Receipt schedule changed since approval');
  end if;
  update public.receipt_schedules set promise_state = 'superseded', updated_at = p_now, row_version = row_version + 1
  where id = v_old.id;
  for v_sched in select * from jsonb_array_elements(v_action.payload->'schedules') order by value->>'earliest_at' loop
    insert into public.receipt_schedules (org_id, po_line_id, quantity_remaining, earliest_at, latest_at,
      evidence_id, promise_state, supersedes_id, source_as_of, created_at, updated_at)
    values (p_org_id, v_line, (v_sched->>'quantity')::integer, (v_sched->>'earliest_at')::timestamptz,
      (v_sched->>'latest_at')::timestamptz, (v_action.payload->>'supplier_confirmation_evidence_id')::uuid,
      'confirmed', v_old.id, p_now, p_now, p_now)
    returning id into v_new_id;
    insert into public.commitment_events (org_id, po_line_id, kind, previous_schedule_id, new_schedule_id,
      affected_qty, evidence_id, created_at)
    values (p_org_id, v_line, 'split', v_old.id, v_new_id, (v_sched->>'quantity')::integer,
      (v_action.payload->>'supplier_confirmation_evidence_id')::uuid, p_now);
  end loop;
  insert into public.demo_ledger_entries (org_id, action_id, change_kind, po_line_id, payload_hash, payload, applied_at)
  values (p_org_id, p_action_id, 'amend_delivery_schedule', v_line, v_action.payload_hash, v_action.payload, p_now)
  returning * into v_entry;
  return jsonb_build_object('ok', true, 'replayed', false, 'entry_id', v_entry.id, 'label', v_entry.label);
end;
$$;

create or replace function public.demo_ledger_find(p_org_id uuid, p_action_id uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'found', e.id is not null, 'entry_id', e.id, 'label', e.label,
    'payload_hash', e.payload_hash, 'applied_at', e.applied_at,
    'schedules', (select coalesce(jsonb_agg(jsonb_build_object('id', rs.id, 'quantity', rs.quantity_remaining,
        'earliest_at', rs.earliest_at, 'latest_at', rs.latest_at) order by rs.earliest_at), '[]')
      from public.receipt_schedules rs where rs.org_id = p_org_id and rs.po_line_id = e.po_line_id
        and rs.promise_state <> 'superseded'))
  from (select 1) one
  left join public.demo_ledger_entries e on e.org_id = p_org_id and e.action_id = p_action_id;
$$;

-- ---------------------------------------------------------------- receipts and delivery
create or replace function public.record_receipt(
  p_org_id uuid, p_actor_id text, p_po_line_id uuid, p_external_receipt_id text, p_quantity integer,
  p_received_at timestamptz, p_kind text, p_reverses_external_id text default null,
  p_evidence_id uuid default null, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_line record;
  v_existing record;
  v_reversed record;
  v_reversed_id uuid;
  v_event_id uuid;
  v_left integer := p_quantity;
  v_sched record;
  v_take integer;
  v_case record;
  v_reopened uuid[] := '{}';
  v_cases uuid[] := '{}';
begin
  if coalesce(trim(p_external_receipt_id), '') = '' then
    return private.result_error('validation_failed', 'A stable source receipt id is required');
  end if;
  if p_quantity <= 0 or p_kind not in ('received', 'reversal') then
    return private.result_error('validation_failed', 'Receipt quantity and kind are invalid');
  end if;
  select * into v_line from public.purchase_order_lines where id = p_po_line_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Purchase order line not found'); end if;
  select * into v_existing from public.receiving_events
  where org_id = p_org_id and source_connection_id is null and external_receipt_id = p_external_receipt_id;
  if found then
    if v_existing.po_line_id <> p_po_line_id or v_existing.quantity <> p_quantity or v_existing.kind <> p_kind then
      return private.result_error('idempotency_conflict', 'Receipt id was already recorded with different values');
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'receipt_event_id', v_existing.id);
  end if;

  if p_kind = 'received' then
    if v_line.received_qty + v_line.cancelled_qty + p_quantity > v_line.ordered_qty then
      return private.result_error('over_receipt', 'Receipt exceeds the open ordered quantity');
    end if;
  else
    select * into v_reversed from public.receiving_events
    where org_id = p_org_id and po_line_id = p_po_line_id and external_receipt_id = p_reverses_external_id
      and kind = 'received';
    if not found or p_quantity > v_reversed.quantity or p_quantity > v_line.received_qty then
      return private.result_error('validation_failed', 'Reversal must reference a recorded receipt on this line');
    end if;
    v_reversed_id := v_reversed.id;
  end if;

  insert into public.receiving_events (org_id, external_receipt_id, po_line_id, item_id, location_id, quantity,
    received_at, kind, reverses_event_id, evidence_id, created_at)
  values (p_org_id, p_external_receipt_id, p_po_line_id, v_line.item_id, v_line.destination_location_id, p_quantity,
    p_received_at, p_kind, v_reversed_id, p_evidence_id, p_now)
  returning id into v_event_id;

  if p_kind = 'received' then
    update public.purchase_order_lines set received_qty = received_qty + p_quantity, updated_at = p_now,
      row_version = row_version + 1 where id = p_po_line_id;
    for v_sched in select * from public.receipt_schedules
        where org_id = p_org_id and po_line_id = p_po_line_id and promise_state <> 'superseded'
          and quantity_remaining > 0
        order by earliest_at nulls last, id for update loop
      exit when v_left = 0;
      v_take := least(v_left, v_sched.quantity_remaining);
      update public.receipt_schedules set quantity_remaining = quantity_remaining - v_take, updated_at = p_now,
        row_version = row_version + 1 where id = v_sched.id;
      v_left := v_left - v_take;
    end loop;
  else
    update public.purchase_order_lines set received_qty = received_qty - p_quantity, updated_at = p_now,
      row_version = row_version + 1 where id = p_po_line_id;
  end if;
  insert into public.commitment_events (org_id, po_line_id, kind, affected_qty, evidence_id, created_at)
  values (p_org_id, p_po_line_id, case p_kind when 'received' then 'receive' else 'correction' end,
    p_quantity, p_evidence_id, p_now);

  for v_case in select * from public.cases where org_id = p_org_id and item_id = v_line.item_id
      and location_id = v_line.destination_location_id and phase <> 'closed' for update loop
    v_cases := v_cases || v_case.id;
    if p_kind = 'reversal' and v_case.phase = 'monitoring' then
      update public.cases set phase = 'recovering', updated_at = p_now, row_version = row_version + 1
      where id = v_case.id;
      v_reopened := v_reopened || v_case.id;
      perform public.outbox_enqueue(p_org_id, 'case.recovery.requested', v_case.id,
        jsonb_build_object('case_id', v_case.id, 'assessment_version', 0), null, null, p_now);
    end if;
    perform public.outbox_enqueue(p_org_id, 'case.assessment.requested', v_case.id,
      jsonb_build_object('case_id', v_case.id, 'source_version', 0), null, null, p_now);
  end loop;
  perform private.audit(p_org_id, 'system', coalesce(p_actor_id, 'receiving'), null, 'receiving_event', v_event_id,
    'receipt.' || p_kind, null, 1, null, p_now);
  perform public.outbox_enqueue(p_org_id, 'receipt.recorded', p_po_line_id,
    jsonb_build_object('po_line_id', p_po_line_id, 'receipt_event_id', v_event_id), null, null, p_now);
  return jsonb_build_object('ok', true, 'duplicate', false, 'receipt_event_id', v_event_id,
    'affected_case_ids', to_jsonb(v_cases), 'reopened_case_ids', to_jsonb(v_reopened));
end;
$$;

-- Delivery is complete only when receiving events (not plan or action state) cover every amended line.
create or replace function public.case_delivery_status(p_org_id uuid, p_case_id uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with c as (select * from public.cases where id = p_case_id and org_id = p_org_id),
  lines as (
    select distinct l.* from public.purchase_order_lines l, c
    where l.org_id = p_org_id and l.item_id = c.item_id and l.destination_location_id = c.location_id
      and exists (select 1 from public.receipt_schedules rs where rs.po_line_id = l.id and rs.org_id = p_org_id)
  ),
  rx as (
    select l.id, l.ordered_qty - l.cancelled_qty as open_qty,
      coalesce(sum(case e.kind when 'received' then e.quantity else -e.quantity end), 0) as evidenced_qty
    from lines l left join public.receiving_events e on e.po_line_id = l.id and e.org_id = p_org_id
    group by l.id, l.ordered_qty, l.cancelled_qty
  )
  select jsonb_build_object('ok', true,
    'delivered', (select count(*) > 0 and bool_and(evidenced_qty >= open_qty) from rx),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('po_line_id', id, 'open_qty', open_qty,
      'evidenced_received_qty', evidenced_qty) order by id), '[]') from rx));
$$;

-- ---------------------------------------------------------------- case control effects (called by F6)
create or replace function public.case_control_effects(
  p_org_id uuid, p_case_id uuid, p_command text, p_actor_id text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_held uuid[];
  v_cancelled uuid[] := '{}';
  v_reconcile uuid[];
  v_action record;
begin
  if p_command not in ('pause', 'resume', 'cancel') then
    return private.result_error('validation_failed', 'Unknown control command');
  end if;
  perform 1 from public.cases where id = p_case_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Case not found'); end if;
  select coalesce(array_agg(id order by created_at), '{}') into v_held from public.actions
  where org_id = p_org_id and case_id = p_case_id and state = 'prepared';
  select coalesce(array_agg(id order by created_at), '{}') into v_reconcile from public.actions
  where org_id = p_org_id and case_id = p_case_id and state in ('dispatching', 'submitted', 'unknown');
  if p_command = 'cancel' then
    for v_action in select * from public.actions where id = any(v_held) for update loop
      perform public.ledger_record_outcome(p_org_id, v_action.id, 'cancelled', null, 'Cancelled by case control',
        'case_cancelled', 'control', p_actor_id, null, p_now);
      if v_action.approval_id is not null then
        update public.approvals set status = 'revoked' where id = v_action.approval_id and org_id = p_org_id;
      end if;
      v_cancelled := v_cancelled || v_action.id;
    end loop;
    update public.approvals set status = 'revoked' where org_id = p_org_id and status = 'active'
      and plan_id in (select id from public.recovery_plans where org_id = p_org_id and case_id = p_case_id);
    v_held := '{}';
  elsif p_command = 'resume' then
    perform public.outbox_enqueue(p_org_id, 'action.prepared', a, jsonb_build_object('action_id', a), null, null, p_now)
    from unnest(v_held) a;
  end if;
  perform private.audit(p_org_id, 'user', p_actor_id, p_case_id, 'case', p_case_id,
    'case.control.' || p_command || '.dispatch_effects', null, null, null, p_now);
  return jsonb_build_object('ok', true, 'command', p_command, 'held_action_ids', to_jsonb(v_held),
    'cancelled_action_ids', to_jsonb(v_cancelled), 'requeued', p_command = 'resume',
    'requires_reconciliation_action_ids', to_jsonb(v_reconcile));
end;
$$;

-- ---------------------------------------------------------------- outreach
create or replace function public.prepare_outreach(
  p_org_id uuid, p_case_id uuid, p_actor_user_id uuid, p_contact_id uuid, p_channel text, p_payload jsonb,
  p_idempotency_key text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_denials text[];
  v_draft record;
  v_result jsonb;
  v_hash text := private.canonical_hash(jsonb_build_object('contact_id', p_contact_id, 'channel', p_channel, 'payload', p_payload));
begin
  if private.member_role(p_org_id, p_actor_user_id) not in ('owner', 'operator') then
    return private.result_error('forbidden', 'Only an owner or operator can request outreach');
  end if;
  if p_channel not in ('email', 'phone') then
    return private.result_error('validation_failed', 'Channel must be email or phone');
  end if;
  if not exists (select 1 from public.cases where id = p_case_id and org_id = p_org_id) then
    return private.result_error('not_found', 'Case not found');
  end if;
  select * into v_draft from public.outreach_drafts where org_id = p_org_id and idempotency_key = p_idempotency_key;
  if found then
    if v_draft.payload_hash <> v_hash then
      return private.result_error('idempotency_conflict', 'Idempotency key was used for a different request');
    end if;
    return jsonb_build_object('ok', true, 'result', 'draft', 'draft_id', v_draft.id,
      'denials', to_jsonb(v_draft.denial_codes), 'replayed', true);
  end if;
  if exists (select 1 from public.actions where org_id = p_org_id and idempotency_key = p_idempotency_key) then
    v_denials := '{}';
  else
    v_denials := private.outreach_denials(p_org_id, p_case_id, p_contact_id, p_channel, p_now, true);
    if (select run_control from public.cases where id = p_case_id) = 'active'
        and not exists (select 1 from public.supplier_contacts where id = p_contact_id and org_id = p_org_id) then
      return private.result_error('not_found', 'Supplier contact not found');
    end if;
  end if;
  if cardinality(v_denials) = 0 then
    v_result := public.ledger_prepare_action(p_org_id, 'user', p_actor_user_id::text, p_case_id,
      case p_channel when 'email' then 'supplier_email'::public.action_kind else 'supplier_call'::public.action_kind end,
      p_payload, p_idempotency_key, p_contact_id, null, null, null, p_now);
    if (v_result->>'ok')::boolean then
      return jsonb_build_object('ok', true, 'result', 'prepared_action', 'action', v_result->'action',
        'replayed', v_result->'replayed');
    end if;
    return v_result;
  end if;
  if 'contact_not_found' = any(v_denials) then
    return private.result_error('not_found', 'Supplier contact not found');
  end if;
  insert into public.outreach_drafts (org_id, case_id, contact_id, channel, payload, payload_hash, denial_codes,
    idempotency_key, created_by, created_at)
  values (p_org_id, p_case_id, p_contact_id, p_channel, p_payload, v_hash, v_denials, p_idempotency_key,
    p_actor_user_id, p_now)
  returning * into v_draft;
  perform private.audit(p_org_id, 'user', p_actor_user_id::text, p_case_id, 'outreach_draft', v_draft.id,
    'outreach.drafted', null, 1, array_to_string(v_denials, ','), p_now);
  return jsonb_build_object('ok', true, 'result', 'draft', 'draft_id', v_draft.id,
    'denials', to_jsonb(v_denials), 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------- reads used by workflows
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
          'plan_step_id', x.plan_step_id) order by x.created_at), '[]')
        from public.actions x where x.plan_id = p.id and x.org_id = p_org_id)))
  end
  from (select 1) one left join public.recovery_plans p on p.id = p_plan_id and p.org_id = p_org_id;
$$;

create or replace function public.ledger_due_reconciliations(p_limit integer default 50, p_now timestamptz default now())
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', org_id, 'action_id', id)), '[]')
  from (select org_id, id from public.actions
        where state in ('dispatching', 'submitted', 'unknown') and kind <> 'manual_export'
          and next_reconcile_at <= p_now
        order by next_reconcile_at limit greatest(1, least(p_limit, 500))) due;
$$;

create or replace function public.case_mark_delivered(p_org_id uuid, p_case_id uuid, p_actor_id text, p_now timestamptz default now())
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_status jsonb := public.case_delivery_status(p_org_id, p_case_id);
begin
  if not coalesce((v_status->>'delivered')::boolean, false) then
    return private.result_error('receiving_evidence_missing', 'Delivery requires receiving evidence for every open line',
      jsonb_build_object('lines', v_status->'lines'));
  end if;
  update public.cases set phase = 'closed', closed_outcome = 'delivered', closed_reason = 'Receiving evidence recorded',
    updated_at = p_now, row_version = row_version + 1
  where id = p_case_id and org_id = p_org_id and phase = 'monitoring';
  if not found then
    return private.result_error('invalid_state', 'Case is not being monitored');
  end if;
  perform private.audit(p_org_id, 'system', coalesce(p_actor_id, 'monitoring'), p_case_id, 'case', p_case_id,
    'case.delivered', null, null, null, p_now);
  return jsonb_build_object('ok', true, 'case_id', p_case_id, 'closed_outcome', 'delivered');
end;
$$;

create or replace function public.monitor_po_line_delivery(p_org_id uuid, p_po_line_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_case record;
  v_done uuid[] := '{}';
begin
  for v_case in select c.id from public.cases c join public.purchase_order_lines l
      on l.org_id = c.org_id and l.item_id = c.item_id and l.destination_location_id = c.location_id
      where c.org_id = p_org_id and l.id = p_po_line_id and c.phase = 'monitoring' loop
    if (public.case_mark_delivered(p_org_id, v_case.id, 'monitoring', p_now)->>'ok')::boolean then
      v_done := v_done || v_case.id;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'delivered_case_ids', to_jsonb(v_done));
end;
$$;

-- ---------------------------------------------------------------- grants
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('outbox_enqueue', 'outbox_claim_batch', 'outbox_mark_published',
      'consumer_dedupe', 'policy_create_version', 'plan_material_fingerprint', 'plan_create', 'approve_plan',
      'reject_plan', 'ledger_prepare_action', 'ledger_claim_dispatch', 'ledger_record_outcome', 'ledger_get_action',
      'ledger_resolve_action', 'demo_ledger_apply', 'demo_ledger_find', 'record_receipt', 'case_delivery_status',
      'case_control_effects', 'prepare_outreach', 'plan_get', 'ledger_due_reconciliations',
      'case_mark_delivered', 'monitor_po_line_delivery')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end;
$$;
grant usage on schema private to service_role;
grant execute on all functions in schema private to service_role;
