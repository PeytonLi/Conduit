-- F4 voice: per-call grants, tool audit, owner tasks, call outcomes and signed callbacks.
-- All functions are server-only (service_role); clients only get RLS-scoped SELECT on tenant tables.

create table public.voice_tool_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  action_id uuid not null,
  tool_name text not null,
  result_code text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (action_id, org_id) references public.actions(id, org_id)
);

create table public.voice_owner_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  action_id uuid,
  kind text not null check (kind in ('above_ceiling', 'human_review', 'ceiling_not_configured', 'written_confirmation')),
  reason text not null,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (action_id, org_id) references public.actions(id, org_id)
);

create table public.voice_call_outcomes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  case_id uuid not null,
  conversation_id text not null,
  outcome text not null check (outcome in (
    'answered_with_offer', 'answered_no_solution', 'needs_human', 'voicemail',
    'no_answer', 'busy', 'initiation_failed', 'interrupted'
  )),
  provider_event_type text not null,
  provider_status text,
  transport_completed boolean not null,
  procurement_result text not null check (procurement_result in ('provisional_offer', 'no_offer', 'not_reached')),
  detail jsonb not null default '{}'::jsonb,
  callback_receipt_id uuid not null,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, action_id),
  foreign key (action_id, org_id) references public.actions(id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (callback_receipt_id, org_id) references public.callback_receipts(id, org_id)
);

create table private.voice_callback_payloads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  callback_receipt_id uuid not null unique,
  payload jsonb not null,
  received_at timestamptz not null
);

create table private.voice_callback_quarantine (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_event_key text not null,
  conversation_id text,
  event_type text not null,
  payload_hash text not null,
  payload jsonb not null,
  reason text not null,
  received_at timestamptz not null,
  delivery_count integer not null default 1,
  resolved_at timestamptz,
  unique (provider, external_event_key)
);

alter table public.voice_tool_events enable row level security;
create policy tenant_member_select on public.voice_tool_events
  for select to authenticated using (public.is_member(org_id));
alter table public.voice_owner_tasks enable row level security;
create policy tenant_member_select on public.voice_owner_tasks
  for select to authenticated using (public.is_member(org_id));
alter table public.voice_call_outcomes enable row level security;
create policy tenant_member_select on public.voice_call_outcomes
  for select to authenticated using (public.is_member(org_id));

revoke all on public.voice_tool_events, public.voice_owner_tasks, public.voice_call_outcomes
  from anon, authenticated;
grant select on public.voice_tool_events, public.voice_owner_tasks, public.voice_call_outcomes
  to authenticated;
revoke all on private.voice_callback_payloads, private.voice_callback_quarantine
  from public, anon, authenticated;
grant all on public.voice_tool_events, public.voice_owner_tasks, public.voice_call_outcomes,
  private.voice_callback_payloads, private.voice_callback_quarantine to service_role;

-- Facts the voice agent may read for one case/contact. No prices, ceilings or other suppliers' data.
create or replace function public.voice_case_facts(p_org_id uuid, p_case_id uuid, p_contact_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'org_name', o.name,
    'org_timezone', o.timezone,
    'item_sku', i.sku,
    'item_description', i.description,
    'unit', i.base_unit,
    'destination', l.name,
    'supplier_name', s.name,
    'contact_name', sc.display_name,
    'bridge_qty', asm.bridge_qty,
    'first_shortage_at', asm.first_shortage_at,
    'dated_requirements', coalesce(asm.dated_requirements, '[]'::jsonb),
    'assessment_version', asm.version,
    'order_lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'po_ref', po.external_id,
        'line_ref', pol.external_line_id,
        'remaining_qty', pol.ordered_qty - pol.received_qty - pol.cancelled_qty,
        'original_due_at', pol.original_due_at
      ) order by po.external_id, pol.external_line_id)
      from public.case_order_lines col
      join public.purchase_order_lines pol on pol.id = col.po_line_id and pol.org_id = col.org_id
      join public.purchase_orders po on po.id = pol.purchase_order_id and po.org_id = pol.org_id
      where col.org_id = p_org_id and col.case_id = c.id and po.supplier_id = s.id
    ), '[]'::jsonb)
  )
  from public.cases c
  join public.organizations o on o.id = c.org_id
  join public.items i on i.id = c.item_id and i.org_id = c.org_id
  join public.locations l on l.id = c.location_id and l.org_id = c.org_id
  join public.supplier_contacts sc on sc.id = p_contact_id and sc.org_id = c.org_id
  join public.suppliers s on s.id = sc.supplier_id and s.org_id = c.org_id
  left join public.assessments asm on asm.id = c.current_assessment_id and asm.org_id = c.org_id
  where c.id = p_case_id and c.org_id = p_org_id;
$$;

-- Dispatch context for one supplier_call action. Returns null when the action/contact are not in the org.
create or replace function public.voice_call_context(p_org_id uuid, p_action_id uuid, p_contact_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'org_name', o.name,
    'org_timezone', o.timezone,
    'org_currency', o.currency,
    'org_mode', o.environment_mode,
    'case_id', c.id,
    'case_phase', c.phase,
    'run_control', c.run_control,
    'action_state', a.state,
    'contact_id', sc.id,
    'contact_channel', sc.channel,
    'contact_phone', sc.normalized_address,
    'contact_name', sc.display_name,
    'contact_timezone', sc.timezone,
    'contact_phone_permitted', ('phone' = any (sc.permitted_channels)) and sc.outreach_approved_at is not null,
    'supplier_id', s.id,
    'supplier_name', s.name,
    'existing_call_session', exists (
      select 1 from public.call_sessions cs where cs.org_id = p_org_id and cs.action_id = a.id
    ),
    'other_calls_in_flight', (
      select count(*) from public.call_sessions cs
      join public.actions oa on oa.id = cs.action_id and oa.org_id = cs.org_id
      where cs.org_id = p_org_id
        and cs.action_id <> a.id
        and cs.ended_at is null
        and oa.state in ('dispatching', 'submitted', 'unknown')
        and not exists (select 1 from public.voice_call_outcomes vo where vo.org_id = p_org_id and vo.action_id = cs.action_id)
    ),
    'facts', public.voice_case_facts(p_org_id, c.id, sc.id)
  )
  from public.actions a
  join public.organizations o on o.id = a.org_id
  join public.cases c on c.id = a.case_id and c.org_id = a.org_id
  join public.supplier_contacts sc on sc.id = p_contact_id and sc.org_id = a.org_id
  join public.suppliers s on s.id = sc.supplier_id and s.org_id = a.org_id
  where a.id = p_action_id and a.org_id = p_org_id and a.kind = 'supplier_call';
$$;

-- Creates the hashed grant and the call session row before the provider is contacted.
-- A second attempt for the same action never creates a new grant (no second call).
create or replace function public.voice_prepare_call(
  p_org_id uuid, p_action_id uuid, p_case_id uuid, p_contact_id uuid,
  p_token_hash text, p_allowed_tools text[], p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_session_id uuid;
  v_grant_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'token hash must be sha256 hex' using errcode = '22023';
  end if;
  perform 1 from public.actions
    where id = p_action_id and org_id = p_org_id and case_id = p_case_id and kind = 'supplier_call'
    for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select id into v_session_id from public.call_sessions where org_id = p_org_id and action_id = p_action_id;
  if v_session_id is not null then
    return jsonb_build_object('status', 'already_attempted', 'call_session_id', v_session_id);
  end if;
  insert into private.voice_grants (org_id, action_id, token_hash, allowed_tool_names, case_id, contact_id, expires_at)
    values (p_org_id, p_action_id, p_token_hash, p_allowed_tools, p_case_id, p_contact_id, p_expires_at)
    returning id into v_grant_id;
  insert into public.call_sessions (org_id, action_id, contact_id)
    values (p_org_id, p_action_id, p_contact_id)
    returning id into v_session_id;
  return jsonb_build_object('status', 'prepared', 'call_session_id', v_session_id, 'grant_id', v_grant_id);
end;
$$;

create or replace function public.voice_mark_call_started(
  p_org_id uuid, p_action_id uuid, p_conversation_id text, p_sip_call_id text, p_started_at timestamptz
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.call_sessions
     set provider_conversation_id = coalesce(provider_conversation_id, p_conversation_id),
         provider_call_id = coalesce(provider_call_id, p_sip_call_id),
         started_at = coalesce(started_at, p_started_at)
   where org_id = p_org_id and action_id = p_action_id;
$$;

create or replace function public.voice_revoke_grants(p_org_id uuid, p_action_id uuid, p_at timestamptz)
returns void
language sql
security definer
set search_path = public, private, pg_temp
as $$
  update private.voice_grants set revoked_at = coalesce(revoked_at, p_at)
   where org_id = p_org_id and action_id = p_action_id;
$$;

-- Resolves a hashed capability to its grant plus the case's current control state.
create or replace function public.voice_resolve_grant(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'grant_id', g.id,
    'org_id', g.org_id,
    'action_id', g.action_id,
    'case_id', g.case_id,
    'contact_id', g.contact_id,
    'allowed_tools', to_jsonb(g.allowed_tool_names),
    'expires_at', g.expires_at,
    'revoked_at', g.revoked_at,
    'run_control', c.run_control,
    'case_phase', c.phase,
    'action_state', a.state,
    'conversation_id', cs.provider_conversation_id
  )
  from private.voice_grants g
  join public.cases c on c.id = g.case_id and c.org_id = g.org_id
  join public.actions a on a.id = g.action_id and a.org_id = g.org_id
  left join public.call_sessions cs on cs.action_id = g.action_id and cs.org_id = g.org_id
  where g.token_hash = p_token_hash;
$$;

create or replace function public.voice_record_tool_event(
  p_org_id uuid, p_case_id uuid, p_action_id uuid, p_tool text, p_result_code text,
  p_payload jsonb, p_at timestamptz
) returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.voice_tool_events (org_id, case_id, action_id, tool_name, result_code, payload, created_at)
  values (p_org_id, p_case_id, p_action_id, p_tool, p_result_code, p_payload, p_at)
  returning id;
$$;

create or replace function public.voice_create_owner_task(
  p_org_id uuid, p_case_id uuid, p_action_id uuid, p_kind text, p_reason text, p_detail jsonb, p_at timestamptz
) returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.voice_owner_tasks (org_id, case_id, action_id, kind, reason, detail, created_at, updated_at)
  values (p_org_id, p_case_id, p_action_id, p_kind, p_reason, p_detail, p_at, p_at)
  returning id;
$$;

-- Negotiation context for deterministic offer checks: ceiling from current policy and original line price.
create or replace function public.voice_offer_context(p_org_id uuid, p_case_id uuid, p_contact_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'org_currency', o.currency,
    'negotiation_ceiling_minor', p.settings ->> 'negotiation_ceiling_minor',
    'supplier_id', sc.supplier_id,
    'item_id', c.item_id,
    'location_id', c.location_id,
    'unit', i.base_unit,
    'bridge_qty', asm.bridge_qty,
    'first_shortage_at', asm.first_shortage_at,
    'original_unit_price_minor', (
      select max(pol.unit_price_minor)::text
      from public.case_order_lines col
      join public.purchase_order_lines pol on pol.id = col.po_line_id and pol.org_id = col.org_id
      join public.purchase_orders po on po.id = pol.purchase_order_id and po.org_id = pol.org_id
      where col.org_id = p_org_id and col.case_id = c.id and po.supplier_id = sc.supplier_id
    )
  )
  from public.cases c
  join public.organizations o on o.id = c.org_id
  join public.items i on i.id = c.item_id and i.org_id = c.org_id
  join public.supplier_contacts sc on sc.id = p_contact_id and sc.org_id = c.org_id
  left join public.policies p on p.id = o.current_policy_version_id and p.org_id = o.id
  left join public.assessments asm on asm.id = c.current_assessment_id and asm.org_id = c.org_id
  where c.id = p_case_id and c.org_id = p_org_id;
$$;

-- Records a verbal offer as provisional evidence + quote. Never verifies, approves or readies a plan.
create or replace function public.voice_record_provisional_offer(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid;
  v_case uuid := (p ->> 'case_id')::uuid;
  v_action uuid := (p ->> 'action_id')::uuid;
  v_contact uuid := (p ->> 'contact_id')::uuid;
  v_at timestamptz := (p ->> 'recorded_at')::timestamptz;
  v_supplier uuid;
  v_item uuid;
  v_location uuid;
  v_evidence uuid;
  v_offer uuid;
  v_quote uuid;
  v_task uuid;
begin
  select sc.supplier_id, c.item_id, c.location_id into v_supplier, v_item, v_location
    from public.cases c
    join public.supplier_contacts sc on sc.id = v_contact and sc.org_id = c.org_id
   where c.id = v_case and c.org_id = v_org;
  if v_supplier is null then
    raise exception 'case/contact not in organization' using errcode = '42501';
  end if;

  insert into public.evidence (org_id, source_type, external_id, source_time, captured_at, content_hash, locator, supported_excerpt)
  values (v_org, 'voice_tool_call', p ->> 'conversation_id', v_at, v_at, p ->> 'content_hash',
          'voice_tool_events:record_provisional_offer', p ->> 'excerpt')
  returning id into v_evidence;

  insert into public.offers (org_id, case_id, supplier_id, contact_id, evidence_ids, received_at, source_type, source_summary)
  values (v_org, v_case, v_supplier, v_contact, array[v_evidence], v_at, 'voice_call', p ->> 'excerpt')
  returning id into v_offer;

  insert into public.quotes (
    org_id, case_id, offer_id, supplier_id, contact_id, item_id, quantity, unit, unit_price_minor, currency,
    freight_minor, fees_minor, destination_location_id, arrival_end, valid_until, latest_order_at,
    status, evidence_ids
  ) values (
    v_org, v_case, v_offer, v_supplier, v_contact, v_item,
    (p ->> 'quantity')::integer, p ->> 'unit', (p ->> 'unit_price_minor')::bigint, p ->> 'currency',
    (p ->> 'freight_minor')::bigint, (p ->> 'fees_minor')::bigint, v_location,
    (p ->> 'arrival_by')::timestamptz, (p ->> 'valid_until')::timestamptz, (p ->> 'order_cutoff')::timestamptz,
    'provisional', array[v_evidence]
  ) returning id into v_quote;

  insert into public.case_evidence (org_id, case_id, evidence_id, purpose)
  values (v_org, v_case, v_evidence, 'voice_provisional_offer');

  if p ? 'owner_task_kind' and p ->> 'owner_task_kind' is not null then
    insert into public.voice_owner_tasks (org_id, case_id, action_id, kind, reason, detail, created_at, updated_at)
    values (v_org, v_case, v_action, p ->> 'owner_task_kind', p ->> 'owner_task_reason',
            jsonb_build_object('quote_id', v_quote, 'added_cost_minor', p ->> 'added_cost_minor'), v_at, v_at)
    returning id into v_task;
  end if;

  insert into public.voice_tool_events (org_id, case_id, action_id, tool_name, result_code, payload, created_at)
  values (v_org, v_case, v_action, 'record_provisional_offer', 'recorded',
          jsonb_build_object('quote_id', v_quote, 'offer_id', v_offer, 'evidence_id', v_evidence, 'owner_task_id', v_task),
          v_at);

  return jsonb_build_object('offer_id', v_offer, 'quote_id', v_quote, 'evidence_id', v_evidence, 'owner_task_id', v_task);
end;
$$;

-- Resolves the call for a callback and summarizes tool activity recorded during it.
create or replace function public.voice_callback_link(p_conversation_id text, p_action_hint uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with session as (
    select cs.* from public.call_sessions cs
     where cs.provider_conversation_id = p_conversation_id
    union all
    select cs.* from public.call_sessions cs
     where p_action_hint is not null
       and cs.action_id = p_action_hint
       and cs.provider_conversation_id is null
       and not exists (select 1 from public.call_sessions x where x.provider_conversation_id = p_conversation_id)
    limit 1
  )
  select jsonb_build_object(
    'org_id', s.org_id,
    'action_id', s.action_id,
    'case_id', a.case_id,
    'offer_recorded', exists (select 1 from public.voice_tool_events e where e.org_id = s.org_id and e.action_id = s.action_id and e.tool_name = 'record_provisional_offer' and e.result_code = 'recorded'),
    'human_review_requested', exists (select 1 from public.voice_tool_events e where e.org_id = s.org_id and e.action_id = s.action_id and e.tool_name = 'request_human_review'),
    'end_call_logged', exists (select 1 from public.voice_tool_events e where e.org_id = s.org_id and e.action_id = s.action_id and e.tool_name = 'end_call')
  )
  from session s
  join public.actions a on a.id = s.action_id and a.org_id = s.org_id;
$$;

-- Durably records a verified provider callback. Idempotent on (provider, external_event_key).
-- Unknown conversations are quarantined and never create cases.
create or replace function public.voice_record_callback(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_provider text := p ->> 'provider';
  v_key text := p ->> 'external_event_key';
  v_conversation text := p ->> 'conversation_id';
  v_at timestamptz := (p ->> 'received_at')::timestamptz;
  v_existing record;
  v_session record;
  v_case uuid;
  v_receipt uuid;
  v_evidence uuid;
  v_outcome jsonb := p -> 'outcome';
begin
  select id, org_id, payload_hash into v_existing
    from public.callback_receipts where provider = v_provider and external_event_key = v_key;
  if found then
    update public.callback_receipts set retry_count = retry_count + 1, updated_at = v_at where id = v_existing.id;
    return jsonb_build_object('status', 'duplicate', 'receipt_id', v_existing.id,
                              'payload_matches', v_existing.payload_hash = p ->> 'payload_hash');
  end if;

  select cs.* into v_session from public.call_sessions cs
   where cs.provider_conversation_id = v_conversation
   for update;
  if not found and (p ->> 'action_hint') is not null then
    select cs.* into v_session from public.call_sessions cs
     where cs.action_id = (p ->> 'action_hint')::uuid and cs.provider_conversation_id is null
     for update;
  end if;

  if v_session.id is null then
    insert into private.voice_callback_quarantine
      (provider, external_event_key, conversation_id, event_type, payload_hash, payload, reason, received_at)
    values (v_provider, v_key, v_conversation, p ->> 'event_type', p ->> 'payload_hash', p -> 'payload',
            'unknown_conversation', v_at)
    on conflict (provider, external_event_key)
      do update set delivery_count = private.voice_callback_quarantine.delivery_count + 1;
    return jsonb_build_object('status', 'quarantined');
  end if;

  select case_id into v_case from public.actions where id = v_session.action_id and org_id = v_session.org_id;

  insert into public.evidence (org_id, source_type, external_id, source_time, captured_at, content_hash, locator, supported_excerpt)
  values (v_session.org_id, 'voice_call_callback', v_conversation, v_at, v_at, p ->> 'payload_hash',
          'private.voice_callback_payloads', p ->> 'excerpt')
  returning id into v_evidence;

  insert into public.callback_receipts
    (org_id, provider, external_event_key, verified_at, payload_hash, private_evidence_id, processing_state, related_action_id, created_at, updated_at)
  values (v_session.org_id, v_provider, v_key, v_at, p ->> 'payload_hash', v_evidence, 'recorded', v_session.action_id, v_at, v_at)
  returning id into v_receipt;

  insert into private.voice_callback_payloads (org_id, callback_receipt_id, payload, received_at)
  values (v_session.org_id, v_receipt, p -> 'payload', v_at);

  insert into public.case_evidence (org_id, case_id, evidence_id, purpose)
  values (v_session.org_id, v_case, v_evidence, 'voice_call_result');

  insert into public.voice_call_outcomes (
    org_id, action_id, case_id, conversation_id, outcome, provider_event_type, provider_status,
    transport_completed, procurement_result, detail, callback_receipt_id, recorded_at
  ) values (
    v_session.org_id, v_session.action_id, v_case, v_conversation, v_outcome ->> 'outcome',
    p ->> 'event_type', v_outcome ->> 'provider_status', (v_outcome ->> 'transport_completed')::boolean,
    v_outcome ->> 'procurement_result', coalesce(v_outcome -> 'detail', '{}'::jsonb), v_receipt, v_at
  ) on conflict (org_id, action_id) do nothing;

  update public.call_sessions
     set provider_conversation_id = coalesce(provider_conversation_id, v_conversation),
         provider_call_id = coalesce(provider_call_id, p ->> 'provider_call_id'),
         ended_at = coalesce(ended_at, v_at),
         duration_seconds = coalesce(duration_seconds, (p ->> 'duration_seconds')::integer),
         disposition = coalesce(disposition, v_outcome ->> 'outcome'),
         transcript_evidence_id = coalesce(transcript_evidence_id, v_evidence)
   where id = v_session.id;

  -- Transport outcome is now known; the call action is confirmed (not necessarily favorable).
  update public.actions
     set state = 'confirmed',
         provider_ref = coalesce(provider_ref, v_conversation),
         outcome = v_outcome,
         updated_at = v_at,
         row_version = row_version + 1
   where id = v_session.action_id and org_id = v_session.org_id
     and state in ('dispatching', 'submitted', 'unknown');

  update private.voice_grants set revoked_at = coalesce(revoked_at, v_at)
   where org_id = v_session.org_id and action_id = v_session.action_id;

  insert into public.audit_events (org_id, actor_type, actor_id, case_id, entity_type, entity_id, event_name, reason, occurred_at)
  values (v_session.org_id, 'provider', v_provider, v_case, 'action', v_session.action_id,
          'voice.callback.recorded', v_outcome ->> 'outcome', v_at);

  insert into public.event_outbox (org_id, aggregate_id, correlation_id, causation_id, event_type, payload, created_at)
  values (v_session.org_id, v_case, v_session.action_id, v_receipt, 'supplier.call.finished',
          jsonb_build_object('case_id', v_case, 'action_id', v_session.action_id, 'conversation_id', v_conversation),
          v_at);

  return jsonb_build_object('status', 'recorded', 'receipt_id', v_receipt, 'org_id', v_session.org_id,
                            'action_id', v_session.action_id, 'case_id', v_case);
end;
$$;

create or replace function public.voice_call_outcome(p_org_id uuid, p_action_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'outcome', vo.outcome, 'conversation_id', vo.conversation_id, 'provider_status', vo.provider_status,
    'transport_completed', vo.transport_completed, 'procurement_result', vo.procurement_result,
    'recorded_at', vo.recorded_at
  )
  from public.voice_call_outcomes vo where vo.org_id = p_org_id and vo.action_id = p_action_id;
$$;

create or replace function public.voice_call_session(p_org_id uuid, p_action_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'conversation_id', cs.provider_conversation_id, 'provider_call_id', cs.provider_call_id,
    'started_at', cs.started_at, 'ended_at', cs.ended_at, 'created_at', cs.created_at
  )
  from public.call_sessions cs where cs.org_id = p_org_id and cs.action_id = p_action_id;
$$;

-- Queues reconciliation for calls whose callback has not arrived in time. Never redials.
create or replace function public.voice_flag_stale_calls(p_now timestamptz, p_grace_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with stale as (
    select cs.org_id, cs.action_id, a.case_id
      from public.call_sessions cs
      join public.actions a on a.id = cs.action_id and a.org_id = cs.org_id
     where cs.ended_at is null
       and a.state in ('dispatching', 'submitted', 'unknown')
       and cs.created_at < p_now - make_interval(secs => p_grace_seconds)
       and not exists (
         select 1 from public.event_outbox eo
          where eo.org_id = cs.org_id
            and eo.event_type = 'action.reconcile.requested'
            and eo.payload ->> 'action_id' = cs.action_id::text
            and eo.created_at > p_now - make_interval(secs => p_grace_seconds)
       )
  ), inserted as (
    insert into public.event_outbox (org_id, aggregate_id, correlation_id, event_type, payload, created_at)
    select org_id, case_id, action_id, 'action.reconcile.requested',
           jsonb_build_object('action_id', action_id), p_now
      from stale
    returning 1
  )
  select count(*) into v_count from inserted;
  return v_count;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'voice_call_context(uuid, uuid, uuid)',
    'voice_case_facts(uuid, uuid, uuid)',
    'voice_prepare_call(uuid, uuid, uuid, uuid, text, text[], timestamptz)',
    'voice_mark_call_started(uuid, uuid, text, text, timestamptz)',
    'voice_revoke_grants(uuid, uuid, timestamptz)',
    'voice_resolve_grant(text)',
    'voice_record_tool_event(uuid, uuid, uuid, text, text, jsonb, timestamptz)',
    'voice_create_owner_task(uuid, uuid, uuid, text, text, jsonb, timestamptz)',
    'voice_offer_context(uuid, uuid, uuid)',
    'voice_record_provisional_offer(jsonb)',
    'voice_callback_link(text, uuid)',
    'voice_record_callback(jsonb)',
    'voice_call_outcome(uuid, uuid)',
    'voice_call_session(uuid, uuid)',
    'voice_flag_stale_calls(timestamptz, integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;
