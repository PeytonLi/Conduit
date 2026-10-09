alter table public.items
  add column external_id text;

create unique index items_org_external_id_unique
  on public.items (org_id, external_id)
  where external_id is not null;

create unique index suppliers_org_external_id_unique
  on public.suppliers (org_id, external_id)
  where external_id is not null;

alter table public.purchase_order_lines
  add column dataset_id uuid,
  add constraint purchase_order_lines_dataset_fk
    foreign key (dataset_id, org_id) references public.datasets(id, org_id);

alter table public.receipt_schedules
  add column external_id text,
  add column dataset_id uuid,
  add constraint receipt_schedules_dataset_fk
    foreign key (dataset_id, org_id) references public.datasets(id, org_id);

create index receipt_schedules_org_dataset_idx
  on public.receipt_schedules (org_id, dataset_id);

alter table public.import_sessions
  add column idempotency_key text,
  add column request_hash text,
  add column activation_idempotency_key text,
  add column activated_at timestamptz,
  add column activated_by uuid references auth.users(id),
  add column contact_permissions_confirmed boolean not null default false,
  add constraint import_sessions_org_idempotency_key_unique unique (org_id, idempotency_key);

create unique index datasets_one_active_per_org
  on public.datasets (org_id)
  where status = 'active';

create table public.import_payloads (
  org_id uuid not null references public.organizations(id) on delete cascade,
  import_session_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (import_session_id),
  foreign key (import_session_id, org_id) references public.import_sessions(id, org_id)
);

alter table public.import_payloads enable row level security;

create policy tenant_member_select on public.import_payloads
  for select to authenticated
  using (public.is_member(org_id, array['owner', 'operator']::public.membership_role[]));

revoke all on table public.import_payloads from anon, authenticated;
grant select on table public.import_payloads to authenticated;
grant all on table public.import_payloads to service_role;

create function public.stage_import(
  p_org_id uuid,
  p_actor uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_content_hash text,
  p_source_as_of timestamptz,
  p_valid boolean,
  p_validation_summary jsonb,
  p_payload jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_session public.import_sessions%rowtype;
  v_active_dataset_id uuid;
  v_active_import_id uuid;
  v_dataset_id uuid;
begin
  select *
    into v_session
    from public.import_sessions
   where org_id = p_org_id
     and idempotency_key = p_idempotency_key
   for update;

  if found then
    if v_session.request_hash = p_request_hash then
      return jsonb_build_object(
        'outcome', 'replayed',
        'import_id', v_session.id,
        'dataset_id', v_session.dataset_id,
        'status', v_session.status,
        'row_version', v_session.row_version,
        'content_hash', v_session.content_hash,
        'source_as_of', v_session.source_as_of,
        'validation_summary', v_session.validation_summary
      );
    end if;
    return jsonb_build_object('outcome', 'idempotency_conflict');
  end if;

  if p_valid then
    select id
      into v_active_dataset_id
      from public.datasets
     where org_id = p_org_id
       and status = 'active'
       and content_hash = p_content_hash
     limit 1;

    if found then
      select id
        into v_active_import_id
        from public.import_sessions
       where org_id = p_org_id
         and dataset_id = v_active_dataset_id
         and status = 'active'
       order by activated_at desc nulls last, created_at desc
       limit 1;
      return jsonb_build_object(
        'outcome', 'noop_same_content',
        'dataset_id', v_active_dataset_id,
        'import_id', v_active_import_id
      );
    end if;
  end if;

  insert into public.import_sessions (
    org_id,
    status,
    content_hash,
    source_as_of,
    validation_summary,
    created_by,
    idempotency_key,
    request_hash
  )
  values (
    p_org_id,
    case when p_valid then 'staged'::public.dataset_status else 'invalid'::public.dataset_status end,
    p_content_hash,
    p_source_as_of,
    coalesce(p_validation_summary, '{}'::jsonb),
    p_actor,
    p_idempotency_key,
    p_request_hash
  )
  on conflict (org_id, idempotency_key) do nothing
  returning * into v_session;

  if not found then
    select *
      into v_session
      from public.import_sessions
     where org_id = p_org_id
       and idempotency_key = p_idempotency_key
     for update;
    if v_session.request_hash = p_request_hash then
      return jsonb_build_object(
        'outcome', 'replayed',
        'import_id', v_session.id,
        'dataset_id', v_session.dataset_id,
        'status', v_session.status,
        'row_version', v_session.row_version,
        'content_hash', v_session.content_hash,
        'source_as_of', v_session.source_as_of,
        'validation_summary', v_session.validation_summary
      );
    end if;
    return jsonb_build_object('outcome', 'idempotency_conflict');
  end if;

  if not p_valid then
    return jsonb_build_object(
      'outcome', 'invalid',
      'import_id', v_session.id,
      'dataset_id', null,
      'status', v_session.status,
      'row_version', v_session.row_version,
      'validation_summary', v_session.validation_summary
    );
  end if;

  insert into public.datasets (
    org_id,
    source_type,
    schema_version,
    source_as_of,
    content_hash,
    status,
    validation_summary
  )
  values (
    p_org_id,
    'csv',
    1,
    p_source_as_of,
    p_content_hash,
    'staged',
    coalesce(p_validation_summary, '{}'::jsonb)
  )
  returning id into v_dataset_id;

  insert into public.import_payloads (org_id, import_session_id, payload)
  values (p_org_id, v_session.id, p_payload);

  update public.import_sessions
     set dataset_id = v_dataset_id,
         updated_at = now()
   where id = v_session.id
     and org_id = p_org_id;

  return jsonb_build_object(
    'outcome', 'staged',
    'import_id', v_session.id,
    'dataset_id', v_dataset_id,
    'status', 'staged',
    'row_version', v_session.row_version,
    'validation_summary', coalesce(p_validation_summary, '{}'::jsonb)
  );
end;
$$;

create function public.activate_import(
  p_org_id uuid,
  p_import_id uuid,
  p_expected_version integer,
  p_actor uuid,
  p_actor_role public.membership_role,
  p_contact_permissions_confirmed boolean,
  p_idempotency_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_session public.import_sessions%rowtype;
  v_dataset public.datasets%rowtype;
  v_active_dataset_id uuid;
  v_active_content_hash text;
  v_previous_dataset_id uuid;
  v_payload jsonb;
  v_metadata jsonb;
  v_source_as_of timestamptz;
  v_supplier jsonb;
  v_contact jsonb;
  v_item jsonb;
  v_order jsonb;
  v_line jsonb;
  v_receipt jsonb;
  v_inventory jsonb;
  v_demand jsonb;
  v_external_id text;
  v_supplier_id uuid;
  v_item_id uuid;
  v_order_id uuid;
  v_line_id uuid;
  v_location_id uuid;
  v_receipt_id uuid;
  v_previous_schedule_id uuid;
  v_evidence_id uuid;
  v_contact_authorized boolean;
  v_outreach_approved boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('conduit.import.' || p_org_id::text, 0));

  select *
    into v_session
    from public.import_sessions
   where id = p_import_id
     and org_id = p_org_id
   for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_session.status = 'active' then
    if v_session.activation_idempotency_key = p_idempotency_key then
      return jsonb_build_object(
        'outcome', 'already_active',
        'dataset_id', v_session.dataset_id,
        'row_version', v_session.row_version
      );
    end if;
    return jsonb_build_object('outcome', 'invalid_state', 'status', v_session.status);
  end if;

  if v_session.status in ('superseded', 'invalid') then
    return jsonb_build_object('outcome', 'invalid_state', 'status', v_session.status);
  end if;

  if v_session.row_version <> p_expected_version then
    return jsonb_build_object('outcome', 'version_conflict', 'row_version', v_session.row_version);
  end if;

  if coalesce(p_contact_permissions_confirmed, false)
     and p_actor_role <> 'owner'::public.membership_role then
    return jsonb_build_object('outcome', 'forbidden_contact_confirmation');
  end if;

  if v_session.dataset_id is null then
    return jsonb_build_object('outcome', 'invalid_state', 'status', v_session.status);
  end if;

  select *
    into v_dataset
    from public.datasets
   where id = v_session.dataset_id
     and org_id = p_org_id
   for update;

  if not found or v_dataset.status <> 'staged' then
    return jsonb_build_object('outcome', 'invalid_state', 'status', v_session.status);
  end if;

  select id, content_hash
    into v_active_dataset_id, v_active_content_hash
    from public.datasets
   where org_id = p_org_id
     and status = 'active'
   limit 1;

  if v_active_dataset_id is not null and v_active_content_hash = v_dataset.content_hash then
    return jsonb_build_object(
      'outcome', 'noop_same_content',
      'dataset_id', v_active_dataset_id,
      'row_version', v_session.row_version
    );
  end if;

  select payload
    into v_payload
    from public.import_payloads
   where org_id = p_org_id
     and import_session_id = p_import_id;

  if not found then
    raise exception 'valid import session has no payload';
  end if;

  v_metadata := coalesce(v_payload->'metadata', '{}'::jsonb);
  v_source_as_of := coalesce(
    nullif(v_metadata->>'source_as_of', '')::timestamptz,
    v_dataset.source_as_of
  );

  for v_supplier in
    select value from jsonb_array_elements(coalesce(v_payload->'suppliers', '[]'::jsonb))
  loop
    v_external_id := v_supplier->>'external_id';
    select id
      into v_supplier_id
      from public.suppliers
     where org_id = p_org_id
       and external_id = v_external_id;

    if found then
      update public.suppliers
         set name = v_supplier->>'name',
             purchasing_status = v_supplier->>'purchasing_status',
             updated_at = now(),
             row_version = row_version + 1
       where id = v_supplier_id
         and org_id = p_org_id;
    else
      insert into public.suppliers (org_id, name, external_id, purchasing_status)
      values (
        p_org_id,
        v_supplier->>'name',
        v_external_id,
        v_supplier->>'purchasing_status'
      )
      on conflict (org_id, name) do update
        set external_id = excluded.external_id,
            purchasing_status = excluded.purchasing_status,
            updated_at = now(),
            row_version = public.suppliers.row_version + 1
      returning id into v_supplier_id;
    end if;

    for v_contact in
      select value from jsonb_array_elements(coalesce(v_supplier->'contacts', '[]'::jsonb))
    loop
      v_outreach_approved := coalesce((v_contact->>'outreach_approved')::boolean, false);
      v_contact_authorized := v_outreach_approved
        and coalesce(p_contact_permissions_confirmed, false)
        and p_actor_role = 'owner'::public.membership_role;
      insert into public.supplier_contacts (
        org_id,
        supplier_id,
        channel,
        normalized_address,
        display_name,
        timezone,
        permitted_channels,
        outreach_approved_at,
        outreach_approved_by
      )
      values (
        p_org_id,
        v_supplier_id,
        v_contact->>'channel',
        v_contact->>'normalized_address',
        nullif(v_contact->>'display_name', ''),
        nullif(v_contact->>'timezone', ''),
        case
          when v_contact_authorized then array[v_contact->>'channel']
          else '{}'::text[]
        end,
        case when v_contact_authorized then now() else null end,
        case when v_contact_authorized then p_actor else null end
      )
      on conflict (org_id, channel, normalized_address) do update
        set supplier_id = excluded.supplier_id,
            display_name = excluded.display_name,
            timezone = excluded.timezone,
            permitted_channels = case
              when v_contact_authorized then excluded.permitted_channels
              else public.supplier_contacts.permitted_channels
            end,
            outreach_approved_at = case
              when v_contact_authorized then now()
              else public.supplier_contacts.outreach_approved_at
            end,
            outreach_approved_by = case
              when v_contact_authorized then p_actor
              else public.supplier_contacts.outreach_approved_by
            end,
            updated_at = now(),
            row_version = public.supplier_contacts.row_version + 1;
    end loop;
  end loop;

  for v_item in
    select value from jsonb_array_elements(coalesce(v_payload->'items', '[]'::jsonb))
  loop
    v_external_id := v_item->>'external_id';
    select id
      into v_item_id
      from public.items
     where org_id = p_org_id
       and external_id = v_external_id;

    if found then
      update public.items
         set sku = v_item->>'sku',
             description = v_item->>'description',
             base_unit = v_item->>'base_unit',
             specification = coalesce(v_item->'specification', '{}'::jsonb),
             updated_at = now(),
             row_version = row_version + 1
       where id = v_item_id
         and org_id = p_org_id;
    else
      insert into public.items (org_id, sku, external_id, description, base_unit, specification)
      values (
        p_org_id,
        v_item->>'sku',
        v_external_id,
        v_item->>'description',
        v_item->>'base_unit',
        coalesce(v_item->'specification', '{}'::jsonb)
      )
      on conflict (org_id, sku) do update
        set external_id = excluded.external_id,
            description = excluded.description,
            base_unit = excluded.base_unit,
            specification = excluded.specification,
            updated_at = now(),
            row_version = public.items.row_version + 1
      returning id into v_item_id;
    end if;
  end loop;

  for v_order in
    select value from jsonb_array_elements(coalesce(v_payload->'purchase_orders', '[]'::jsonb))
  loop
    select id
      into v_supplier_id
      from public.suppliers
     where org_id = p_org_id
       and external_id = v_order->>'supplier_external_id';

    insert into public.purchase_orders (
      org_id,
      external_id,
      supplier_id,
      currency,
      status,
      dataset_id
    )
    values (
      p_org_id,
      v_order->>'external_id',
      v_supplier_id,
      v_order->>'currency',
      v_order->>'status',
      v_dataset.id
    )
    on conflict (org_id, external_id) do update
      set supplier_id = excluded.supplier_id,
          currency = excluded.currency,
          status = excluded.status,
          dataset_id = excluded.dataset_id,
          updated_at = now(),
          row_version = public.purchase_orders.row_version + 1
    returning id into v_order_id;
  end loop;

  for v_line in
    select value from jsonb_array_elements(coalesce(v_payload->'purchase_order_lines', '[]'::jsonb))
  loop
    select id
      into v_order_id
      from public.purchase_orders
     where org_id = p_org_id
       and external_id = v_line->>'po_external_id';
    select id
      into v_item_id
      from public.items
     where org_id = p_org_id
       and external_id = v_line->>'item_external_id';
    select id
      into v_location_id
      from public.locations
     where org_id = p_org_id
       and external_id = v_line->>'location_external_id'
       and active
     limit 1;

    if v_location_id is null then
      raise exception 'active location not found for external id %', v_line->>'location_external_id';
    end if;

    insert into public.purchase_order_lines (
      org_id,
      purchase_order_id,
      external_line_id,
      item_id,
      destination_location_id,
      ordered_qty,
      received_qty,
      cancelled_qty,
      unit_price_minor,
      original_due_at,
      dataset_id
    )
    values (
      p_org_id,
      v_order_id,
      v_line->>'external_line_id',
      v_item_id,
      v_location_id,
      (v_line->>'ordered_qty')::integer,
      (v_line->>'received_qty')::integer,
      (v_line->>'cancelled_qty')::integer,
      (v_line->>'unit_price_minor')::bigint,
      nullif(v_line->>'original_due_at', '')::timestamptz,
      v_dataset.id
    )
    on conflict (org_id, purchase_order_id, external_line_id) do update
      set item_id = excluded.item_id,
          destination_location_id = excluded.destination_location_id,
          ordered_qty = excluded.ordered_qty,
          received_qty = excluded.received_qty,
          cancelled_qty = excluded.cancelled_qty,
          unit_price_minor = excluded.unit_price_minor,
          original_due_at = excluded.original_due_at,
          dataset_id = excluded.dataset_id,
          updated_at = now(),
          row_version = public.purchase_order_lines.row_version + 1
    returning id into v_line_id;
  end loop;

  update public.receipt_schedules
     set promise_state = 'superseded',
         updated_at = now(),
         row_version = row_version + 1
   where org_id = p_org_id
     and promise_state <> 'superseded';

  for v_receipt in
    select value from jsonb_array_elements(coalesce(v_payload->'receipt_schedules', '[]'::jsonb))
  loop
    select pol.id
      into v_line_id
      from public.purchase_order_lines pol
      join public.purchase_orders po
        on po.id = pol.purchase_order_id
       and po.org_id = pol.org_id
     where pol.org_id = p_org_id
       and po.external_id = v_receipt->>'po_external_id'
       and pol.external_line_id = v_receipt->>'external_line_id';

    select id
      into v_previous_schedule_id
      from public.receipt_schedules
     where org_id = p_org_id
       and external_id = v_receipt->>'external_id'
     order by created_at desc
     limit 1;

    insert into public.evidence (
      org_id,
      source_type,
      external_id,
      captured_at,
      content_hash,
      locator,
      supported_excerpt
    )
    values (
      p_org_id,
      'import_row',
      nullif(v_receipt->>'source_reference', ''),
      now(),
      v_receipt->>'row_hash',
      v_receipt->>'locator',
      nullif(v_receipt->>'source_reference', '')
    )
    returning id into v_evidence_id;

    insert into public.receipt_schedules (
      org_id,
      po_line_id,
      external_id,
      dataset_id,
      quantity_remaining,
      earliest_at,
      latest_at,
      evidence_id,
      promise_state,
      supersedes_id,
      source_as_of
    )
    values (
      p_org_id,
      v_line_id,
      v_receipt->>'external_id',
      v_dataset.id,
      (v_receipt->>'quantity_remaining')::integer,
      nullif(v_receipt->>'earliest_at', '')::timestamptz,
      nullif(v_receipt->>'latest_at', '')::timestamptz,
      v_evidence_id,
      (v_receipt->>'promise_state')::public.promise_state,
      v_previous_schedule_id,
      v_source_as_of
    )
    returning id into v_receipt_id;
  end loop;

  for v_inventory in
    select value from jsonb_array_elements(coalesce(v_payload->'inventory', '[]'::jsonb))
  loop
    select id
      into v_item_id
      from public.items
     where org_id = p_org_id
       and external_id = v_inventory->>'item_external_id';
    select id
      into v_location_id
      from public.locations
     where org_id = p_org_id
       and external_id = v_inventory->>'location_external_id'
       and active
     limit 1;

    if v_location_id is null then
      raise exception 'active location not found for external id %', v_inventory->>'location_external_id';
    end if;

    insert into public.inventory_snapshots (
      org_id,
      dataset_id,
      item_id,
      location_id,
      physical_qty,
      unusable_qty,
      outside_allocations_qty,
      source_as_of
    )
    values (
      p_org_id,
      v_dataset.id,
      v_item_id,
      v_location_id,
      (v_inventory->>'physical_qty')::integer,
      (v_inventory->>'unusable_qty')::integer,
      (v_inventory->>'outside_allocations_qty')::integer,
      (v_inventory->>'source_as_of')::timestamptz
    );
  end loop;

  for v_demand in
    select value from jsonb_array_elements(coalesce(v_payload->'demand', '[]'::jsonb))
  loop
    select id
      into v_item_id
      from public.items
     where org_id = p_org_id
       and external_id = v_demand->>'item_external_id';
    select id
      into v_location_id
      from public.locations
     where org_id = p_org_id
       and external_id = v_demand->>'location_external_id'
       and active
     limit 1;

    if v_location_id is null then
      raise exception 'active location not found for external id %', v_demand->>'location_external_id';
    end if;

    insert into public.demand_requirements (
      org_id,
      dataset_id,
      external_id,
      item_id,
      location_id,
      remaining_qty,
      required_at,
      certainty,
      included_reserved_qty,
      status,
      source_as_of
    )
    values (
      p_org_id,
      v_dataset.id,
      v_demand->>'external_id',
      v_item_id,
      v_location_id,
      (v_demand->>'remaining_qty')::integer,
      (v_demand->>'required_at')::timestamptz,
      v_demand->>'certainty',
      (v_demand->>'included_reserved_qty')::integer,
      'open',
      (v_demand->>'source_as_of')::timestamptz
    );
  end loop;

  select id
    into v_previous_dataset_id
    from public.datasets
   where org_id = p_org_id
     and status = 'active'
   limit 1;

  if v_previous_dataset_id is not null then
    update public.datasets
       set status = 'superseded',
           updated_at = now(),
           row_version = row_version + 1
     where id = v_previous_dataset_id
       and org_id = p_org_id;
    update public.import_sessions
       set status = 'superseded',
           updated_at = now(),
           row_version = row_version + 1
     where org_id = p_org_id
       and dataset_id = v_previous_dataset_id
       and status = 'active';
  end if;

  update public.datasets
     set status = 'active',
         updated_at = now(),
         row_version = row_version + 1
   where id = v_dataset.id
     and org_id = p_org_id;

  update public.import_sessions
     set status = 'active',
         row_version = row_version + 1,
         activated_at = now(),
         activated_by = p_actor,
         activation_idempotency_key = p_idempotency_key,
         contact_permissions_confirmed = coalesce(p_contact_permissions_confirmed, false),
         updated_at = now()
   where id = p_import_id
     and org_id = p_org_id
  returning row_version into v_session.row_version;

  insert into public.event_outbox (
    org_id,
    aggregate_id,
    correlation_id,
    causation_id,
    event_type,
    schema_version,
    payload
  )
  values (
    p_org_id,
    v_dataset.id,
    p_import_id,
    null,
    'business.snapshot.activated',
    1,
    jsonb_build_object('dataset_id', v_dataset.id)
  );

  insert into public.audit_events (
    org_id,
    actor_type,
    actor_id,
    entity_type,
    entity_id,
    event_name,
    reason
  )
  values (
    p_org_id,
    'user',
    p_actor::text,
    'dataset',
    v_dataset.id,
    'import.activated',
    'csv import activation'
  );

  return jsonb_build_object(
    'outcome', 'activated',
    'dataset_id', v_dataset.id,
    'superseded_dataset_id', v_previous_dataset_id,
    'row_version', v_session.row_version
  );
end;
$$;

create function public.load_projection_facts(
  p_org_id uuid,
  p_item_id uuid,
  p_location_id uuid
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_dataset public.datasets%rowtype;
  v_dataset_json jsonb;
  v_item_json jsonb;
  v_location_json jsonb;
  v_inventory_json jsonb;
  v_demand_json jsonb;
  v_receipts_json jsonb;
  v_lines_json jsonb;
  v_claims_json jsonb;
begin
  select *
    into v_dataset
    from public.datasets
   where org_id = p_org_id
     and status = 'active'
   limit 1;

  if found then
    v_dataset_json := jsonb_build_object(
      'id', v_dataset.id,
      'source_type', v_dataset.source_type,
      'source_as_of', v_dataset.source_as_of,
      'content_hash', v_dataset.content_hash
    );

    select jsonb_build_object(
      'id', i.id,
      'base_unit', i.base_unit,
      'specification', i.specification
    )
      into v_item_json
      from public.items i
     where i.org_id = p_org_id
       and i.id = p_item_id;

    select jsonb_build_object('id', l.id, 'timezone', l.timezone)
      into v_location_json
      from public.locations l
     where l.org_id = p_org_id
       and l.id = p_location_id;

    select jsonb_build_object(
      'id', s.id,
      'physical_qty', s.physical_qty,
      'unusable_qty', s.unusable_qty,
      'outside_allocations_qty', s.outside_allocations_qty,
      'source_as_of', s.source_as_of
    )
      into v_inventory_json
      from public.inventory_snapshots s
     where s.org_id = p_org_id
       and s.dataset_id = v_dataset.id
       and s.item_id = p_item_id
       and s.location_id = p_location_id;

    select coalesce(
      jsonb_agg(jsonb_build_object(
        'id', d.id,
        'external_id', coalesce(d.external_id, ''),
        'remaining_qty', d.remaining_qty,
        'required_at', d.required_at,
        'certainty', d.certainty,
        'included_reserved_qty', d.included_reserved_qty,
        'source_as_of', d.source_as_of
      ) order by d.required_at, d.id),
      '[]'::jsonb
    )
      into v_demand_json
      from public.demand_requirements d
     where d.org_id = p_org_id
       and d.dataset_id = v_dataset.id
       and d.item_id = p_item_id
       and d.location_id = p_location_id
       and d.status = 'open';

    select coalesce(
      jsonb_agg(jsonb_build_object(
        'id', r.id,
        'po_line_id', r.po_line_id,
        'quantity_remaining', r.quantity_remaining,
        'earliest_at', r.earliest_at,
        'latest_at', r.latest_at,
        'promise_state', r.promise_state,
        'evidence_id', r.evidence_id,
        'source_as_of', coalesce(r.source_as_of, v_dataset.source_as_of)
      ) order by r.id),
      '[]'::jsonb
    )
      into v_receipts_json
      from public.receipt_schedules r
      join public.purchase_order_lines pol
        on pol.id = r.po_line_id
       and pol.org_id = r.org_id
     where r.org_id = p_org_id
       and r.dataset_id = v_dataset.id
       and r.promise_state <> 'superseded'
       and pol.item_id = p_item_id
       and pol.destination_location_id = p_location_id;

    select coalesce(
      jsonb_agg(jsonb_build_object(
        'id', pol.id,
        'ordered_qty', pol.ordered_qty,
        'received_qty', pol.received_qty,
        'cancelled_qty', pol.cancelled_qty,
        'unit_price_minor', pol.unit_price_minor::text
      ) order by pol.id),
      '[]'::jsonb
    )
      into v_lines_json
      from public.purchase_order_lines pol
     where pol.org_id = p_org_id
       and pol.dataset_id = v_dataset.id
       and pol.item_id = p_item_id
       and pol.destination_location_id = p_location_id
       and exists (
         select 1
           from public.receipt_schedules r
          where r.org_id = pol.org_id
            and r.po_line_id = pol.id
            and r.dataset_id = v_dataset.id
            and r.promise_state <> 'superseded'
       );
  end if;

  select coalesce(
    jsonb_agg(jsonb_build_object('id', c.id, 'quantity', c.quantity) order by c.id),
    '[]'::jsonb
  )
    into v_claims_json
    from public.allocation_claims c
   where c.org_id = p_org_id
     and c.item_id = p_item_id
     and c.location_id = p_location_id
     and c.state in ('active', 'uncertain');

  return jsonb_build_object(
    'dataset', v_dataset_json,
    'item', v_item_json,
    'location', v_location_json,
    'inventory', v_inventory_json,
    'demand', coalesce(v_demand_json, '[]'::jsonb),
    'receipts', coalesce(v_receipts_json, '[]'::jsonb),
    'lines', coalesce(v_lines_json, '[]'::jsonb),
    'claims', coalesce(v_claims_json, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.stage_import(uuid, uuid, text, text, text, timestamptz, boolean, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.stage_import(uuid, uuid, text, text, text, timestamptz, boolean, jsonb, jsonb)
  to service_role;

revoke all on function public.activate_import(uuid, uuid, integer, uuid, public.membership_role, boolean, text)
  from public, anon, authenticated;
grant execute on function public.activate_import(uuid, uuid, integer, uuid, public.membership_role, boolean, text)
  to service_role;

revoke all on function public.load_projection_facts(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.load_projection_facts(uuid, uuid, uuid)
  to service_role;
