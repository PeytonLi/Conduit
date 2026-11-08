-- load_projection_facts: expose item.quantity_scale

create or replace function public.load_projection_facts(
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

