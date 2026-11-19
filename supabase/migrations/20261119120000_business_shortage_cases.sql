-- Opens a case when synced business data alone projects a shortage (no supplier email needed).
-- Mirrors inbox_open_cases: one open case per item and location, the same advisory lock,
-- an audit row and a case.assessment.requested event so the normal assessment runs.
create or replace function public.business_open_shortage_case(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_item uuid := (p->>'item_id')::uuid;
  v_location uuid := (p->>'location_id')::uuid;
  v_case public.cases%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || v_item::text || v_location::text, 0));

  select * into v_case
  from public.cases
  where org_id = v_org and item_id = v_item and location_id = v_location and phase <> 'closed';
  if found then
    return jsonb_build_object('status', 'exists', 'case_id', v_case.id);
  end if;

  insert into public.cases (org_id, item_id, location_id, phase, severity)
  values (v_org, v_item, v_location, 'new', 'info')
  returning * into v_case;

  insert into public.case_order_lines (org_id, case_id, po_line_id, affected_qty)
  select v_org, v_case.id, l.id, greatest(l.ordered_qty - l.received_qty - l.cancelled_qty, 0)
  from public.purchase_order_lines l
  join public.purchase_orders po on po.id = l.purchase_order_id and po.org_id = l.org_id
  where l.org_id = v_org and l.item_id = v_item and l.destination_location_id = v_location
    and l.ordered_qty - l.received_qty - l.cancelled_qty > 0
    and po.status not in ('cancelled', 'closed', 'received', 'completed')
  on conflict (org_id, case_id, po_line_id) do nothing;

  insert into public.audit_events (
    org_id, actor_type, actor_id, case_id, entity_type, entity_id,
    event_name, previous_version, new_version, reason
  )
  values (
    v_org, 'system', 'business-shortage-scan', v_case.id, 'case', v_case.id,
    'case.opened', null, v_case.row_version,
    coalesce(p->>'reason', 'Business data projects a shortage')
  );

  insert into public.event_outbox (
    event_id, org_id, aggregate_id, correlation_id, event_type, schema_version, payload
  )
  values (
    gen_random_uuid(), v_org, v_case.id, gen_random_uuid(), 'case.assessment.requested', 1,
    jsonb_build_object('case_id', v_case.id, 'source_version', v_case.row_version)
  );

  return jsonb_build_object('status', 'opened', 'case_id', v_case.id);
end;
$$;

-- Item/location pairs with open demand in a dataset, for the shortage scan.
create or replace function public.business_demand_pairs(p jsonb)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(distinct jsonb_build_object('item_id', d.item_id, 'location_id', d.location_id)), '[]'::jsonb)
  from public.demand_requirements d
  join public.datasets ds on ds.id = d.dataset_id and ds.org_id = d.org_id
  join public.organizations o on o.id = d.org_id
  where d.org_id = (p->>'org_id')::uuid
    and d.dataset_id = (p->>'dataset_id')::uuid
    and ds.status = 'active'
    and d.status = 'open'
    and o.environment_mode <> 'replay'
$$;

revoke all on function
  public.business_open_shortage_case(jsonb),
  public.business_demand_pairs(jsonb)
from public, anon, authenticated;

grant execute on function
  public.business_open_shortage_case(jsonb),
  public.business_demand_pairs(jsonb)
to service_role;
