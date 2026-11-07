-- Activates a business-system snapshot (already validated and normalized by
-- lib/integrations/business/live/sync.ts) as the org's active connector
-- dataset. Mirrors activate_import, plus: locations are upserted from the
-- provider, and each PO keeps its provider version in source_version so a
-- later write can detect a conflicting edit.

create or replace function public.erp_activate_snapshot(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_connection_id uuid := (p->>'connection_id')::uuid;
  v_hash text := p->>'content_hash';
  v_snapshot jsonb := p->'snapshot';
  v_as_of timestamptz := (p->'snapshot'->>'as_of')::timestamptz;
  v_timezone text;
  v_connection public.connections%rowtype;
  v_active record;
  v_dataset_id uuid;
  v_row jsonb;
  v_line jsonb;
  v_id uuid;
  v_supplier_id uuid;
  v_item_id uuid;
  v_location_id uuid;
  v_order_id uuid;
  v_line_id uuid;
  v_previous_schedule uuid;
  v_open integer;
  v_counts jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('conduit.import.' || v_org::text, 0));

  select * into v_connection from public.connections
  where id = v_connection_id and org_id = v_org
    and provider = any(private.erp_providers())
    and status in ('healthy', 'degraded')
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_connected');
  end if;

  select id, content_hash, source_connection_id into v_active
  from public.datasets where org_id = v_org and status = 'active' limit 1;
  if v_active.id is not null and v_active.content_hash = v_hash
     and v_active.source_connection_id = v_connection_id then
    -- Unchanged content: the data is verified current, so only its freshness moves.
    update public.datasets set source_as_of = greatest(source_as_of, v_as_of), updated_at = now()
    where id = v_active.id and org_id = v_org;
    update public.connections set status = 'healthy', last_error_code = null, last_success_at = now(),
      updated_at = now()
    where id = v_connection_id;
    return jsonb_build_object('outcome', 'noop_same_content', 'dataset_id', v_active.id);
  end if;

  select timezone into v_timezone from public.organizations where id = v_org;

  insert into public.datasets (
    org_id, source_connection_id, source_type, source_as_of, content_hash, status, validation_summary
  )
  values (v_org, v_connection_id, 'connector', v_as_of, v_hash, 'staged',
    jsonb_build_object('provider', v_connection.provider))
  returning id into v_dataset_id;

  for v_row in select value from jsonb_array_elements(coalesce(v_snapshot->'locations', '[]'::jsonb)) loop
    select id into v_id from public.locations
    where org_id = v_org and external_id = v_row->>'external_id'
    order by active desc, created_at limit 1;
    if v_id is null then
      insert into public.locations (org_id, name, external_id, timezone)
      values (v_org, v_row->>'name', v_row->>'external_id', v_timezone)
      on conflict (org_id, name) do update
        set external_id = excluded.external_id, active = true, updated_at = now(),
            row_version = public.locations.row_version + 1;
    else
      update public.locations set name = v_row->>'name', active = true, updated_at = now(),
        row_version = row_version + 1
      where id = v_id and (name is distinct from v_row->>'name' or not active);
    end if;
  end loop;

  for v_row in select value from jsonb_array_elements(coalesce(v_snapshot->'suppliers', '[]'::jsonb)) loop
    select id into v_id from public.suppliers where org_id = v_org and external_id = v_row->>'external_id';
    if found then
      update public.suppliers set name = v_row->>'name', updated_at = now(), row_version = row_version + 1
      where id = v_id and name is distinct from v_row->>'name';
    else
      insert into public.suppliers (org_id, name, external_id)
      values (v_org, v_row->>'name', v_row->>'external_id')
      on conflict (org_id, name) do update
        set external_id = excluded.external_id, updated_at = now(),
            row_version = public.suppliers.row_version + 1;
    end if;
  end loop;

  for v_row in select value from jsonb_array_elements(coalesce(v_snapshot->'items', '[]'::jsonb)) loop
    select id into v_id from public.items where org_id = v_org and external_id = v_row->>'external_id';
    if found then
      update public.items set sku = v_row->>'sku', description = v_row->>'name',
        base_unit = v_row->>'unit', updated_at = now(), row_version = row_version + 1
      where id = v_id;
    else
      insert into public.items (org_id, sku, external_id, description, base_unit)
      values (v_org, v_row->>'sku', v_row->>'external_id', v_row->>'name', v_row->>'unit')
      on conflict (org_id, sku) do update
        set external_id = excluded.external_id, description = excluded.description,
            base_unit = excluded.base_unit, updated_at = now(),
            row_version = public.items.row_version + 1;
    end if;
  end loop;

  update public.receipt_schedules
  set promise_state = 'superseded', updated_at = now(), row_version = row_version + 1
  where org_id = v_org and promise_state <> 'superseded';

  for v_row in select value from jsonb_array_elements(coalesce(v_snapshot->'purchase_orders', '[]'::jsonb)) loop
    select id into v_supplier_id from public.suppliers
    where org_id = v_org and external_id = v_row->>'supplier_external_id';
    if v_supplier_id is null then
      raise exception 'supplier % not in snapshot', v_row->>'supplier_external_id' using errcode = 'P0422';
    end if;
    insert into public.purchase_orders (org_id, external_id, supplier_id, currency, status, source_version, dataset_id)
    values (v_org, v_row->>'external_id', v_supplier_id, v_row->>'currency', v_row->>'status',
      v_row->>'version', v_dataset_id)
    on conflict (org_id, external_id) do update
      set supplier_id = excluded.supplier_id, currency = excluded.currency, status = excluded.status,
          source_version = excluded.source_version, dataset_id = excluded.dataset_id,
          updated_at = now(), row_version = public.purchase_orders.row_version + 1
    returning id into v_order_id;

    for v_line in select value from jsonb_array_elements(coalesce(v_row->'lines', '[]'::jsonb)) loop
      select id into v_item_id from public.items where org_id = v_org and external_id = v_line->>'item_external_id';
      select id into v_location_id from public.locations
      where org_id = v_org and external_id = v_line->>'destination_external_id' and active limit 1;
      if v_item_id is null or v_location_id is null then
        raise exception 'line % references an unknown item or location', v_line->>'external_line_id'
          using errcode = 'P0422';
      end if;
      insert into public.purchase_order_lines (
        org_id, purchase_order_id, external_line_id, item_id, destination_location_id,
        ordered_qty, received_qty, cancelled_qty, unit_price_minor, original_due_at, dataset_id
      )
      values (
        v_org, v_order_id, v_line->>'external_line_id', v_item_id, v_location_id,
        (v_line->>'ordered_qty')::integer, (v_line->>'received_qty')::integer, 0,
        (v_line->>'unit_price_minor')::bigint, nullif(v_line->>'due_at', '')::timestamptz, v_dataset_id
      )
      on conflict (org_id, purchase_order_id, external_line_id) do update
        set item_id = excluded.item_id, destination_location_id = excluded.destination_location_id,
            ordered_qty = excluded.ordered_qty, received_qty = excluded.received_qty,
            unit_price_minor = excluded.unit_price_minor, original_due_at = excluded.original_due_at,
            dataset_id = excluded.dataset_id, updated_at = now(),
            row_version = public.purchase_order_lines.row_version + 1
      returning id into v_line_id;

      v_open := (v_line->>'ordered_qty')::integer - (v_line->>'received_qty')::integer;
      if v_open > 0 and lower(v_row->>'status') not in ('cancelled', 'canceled', 'closed', 'done') then
        select id into v_previous_schedule from public.receipt_schedules
        where org_id = v_org and po_line_id = v_line_id
        order by created_at desc, id desc limit 1;
        insert into public.receipt_schedules (
          org_id, po_line_id, external_id, dataset_id, quantity_remaining,
          earliest_at, latest_at, promise_state, supersedes_id, source_as_of
        )
        values (
          v_org, v_line_id, (v_row->>'external_id') || ':' || (v_line->>'external_line_id'), v_dataset_id, v_open,
          nullif(v_line->>'due_at', '')::timestamptz, nullif(v_line->>'due_at', '')::timestamptz,
          case when nullif(v_line->>'due_at', '') is null then 'unknown' else 'estimated' end::public.promise_state,
          v_previous_schedule, v_as_of
        );
      end if;
    end loop;
  end loop;

  for v_row in select value from jsonb_array_elements(coalesce(v_snapshot->'stock', '[]'::jsonb)) loop
    select id into v_item_id from public.items where org_id = v_org and external_id = v_row->>'item_external_id';
    select id into v_location_id from public.locations
    where org_id = v_org and external_id = v_row->>'location_external_id' and active limit 1;
    if v_item_id is null or v_location_id is null then
      raise exception 'stock row references an unknown item or location' using errcode = 'P0422';
    end if;
    insert into public.inventory_snapshots (
      org_id, dataset_id, item_id, location_id, physical_qty, unusable_qty, source_as_of
    )
    values (
      v_org, v_dataset_id, v_item_id, v_location_id, (v_row->>'on_hand_qty')::integer,
      coalesce((v_row->>'unusable_qty')::integer, 0), v_as_of
    );
  end loop;

  for v_row in select value from jsonb_array_elements(coalesce(v_snapshot->'demand', '[]'::jsonb)) loop
    select id into v_item_id from public.items where org_id = v_org and external_id = v_row->>'item_external_id';
    select id into v_location_id from public.locations
    where org_id = v_org and external_id = v_row->>'location_external_id' and active limit 1;
    if v_item_id is null or v_location_id is null then
      raise exception 'demand % references an unknown item or location', v_row->>'external_id'
        using errcode = 'P0422';
    end if;
    insert into public.demand_requirements (
      org_id, dataset_id, external_id, item_id, location_id, remaining_qty, required_at,
      certainty, status, source_as_of
    )
    values (
      v_org, v_dataset_id, v_row->>'external_id', v_item_id, v_location_id,
      (v_row->>'quantity')::integer, (v_row->>'required_at')::timestamptz,
      v_row->>'certainty', 'open', v_as_of
    );
  end loop;

  if v_active.id is not null then
    update public.datasets set status = 'superseded', updated_at = now(), row_version = row_version + 1
    where id = v_active.id and org_id = v_org;
    update public.import_sessions set status = 'superseded', updated_at = now(), row_version = row_version + 1
    where org_id = v_org and dataset_id = v_active.id and status = 'active';
  end if;
  update public.datasets set status = 'active', updated_at = now(), row_version = row_version + 1
  where id = v_dataset_id and org_id = v_org;

  update public.connections
  set status = 'healthy', last_error_code = null, last_success_at = now(), updated_at = now()
  where id = v_connection_id;

  insert into public.event_outbox (org_id, aggregate_id, correlation_id, causation_id, event_type, schema_version, payload)
  values (v_org, v_dataset_id, v_dataset_id, null, 'business.snapshot.activated', 1,
    jsonb_build_object('dataset_id', v_dataset_id));

  v_counts := jsonb_build_object(
    'purchase_orders', jsonb_array_length(coalesce(v_snapshot->'purchase_orders', '[]'::jsonb)),
    'stock', jsonb_array_length(coalesce(v_snapshot->'stock', '[]'::jsonb)),
    'demand', jsonb_array_length(coalesce(v_snapshot->'demand', '[]'::jsonb))
  );
  insert into public.audit_events (org_id, actor_type, actor_id, entity_type, entity_id, event_name, reason)
  values (v_org, 'system', 'business_sync', 'dataset', v_dataset_id, 'import.activated',
    v_connection.provider || ' snapshot sync');

  return jsonb_build_object(
    'outcome', 'activated',
    'dataset_id', v_dataset_id,
    'superseded_dataset_id', v_active.id,
    'counts', v_counts
  );
end;
$$;

revoke all on function public.erp_activate_snapshot(jsonb) from public, anon, authenticated;
grant execute on function public.erp_activate_snapshot(jsonb) to service_role;

-- Maps provider (po external id, line external id) pairs to Conduit PO line ids,
-- keyed "<po>\u001f<line>" for lookups in receipt sync.
create or replace function public.erp_resolve_po_lines(p jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(po.external_id || chr(31) || pol.external_line_id, pol.id), '{}'::jsonb)
  from jsonb_array_elements(coalesce(p->'refs', '[]'::jsonb)) r
  join public.purchase_orders po
    on po.org_id = (p->>'org_id')::uuid and po.external_id = r->>'po_external_id'
  join public.purchase_order_lines pol
    on pol.org_id = po.org_id and pol.purchase_order_id = po.id
   and pol.external_line_id = r->>'line_external_id'
$$;

revoke all on function public.erp_resolve_po_lines(jsonb) from public, anon, authenticated;
grant execute on function public.erp_resolve_po_lines(jsonb) to service_role;

-- Provider identity of a Conduit PO line, for preparing a live write.
create or replace function public.erp_po_line_ref(p jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'po_external_id', po.external_id,
    'line_external_id', pol.external_line_id,
    'source_version', po.source_version,
    'connection_id', d.source_connection_id
  )
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id and po.org_id = pol.org_id
  left join public.datasets d on d.id = po.dataset_id and d.org_id = po.org_id
  where pol.org_id = (p->>'org_id')::uuid and pol.id = (p->>'po_line_id')::uuid
$$;

revoke all on function public.erp_po_line_ref(jsonb) from public, anon, authenticated;
grant execute on function public.erp_po_line_ref(jsonb) to service_role;
