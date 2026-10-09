create or replace function public.voice_offer_context(p_org_id uuid, p_case_id uuid, p_contact_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'org_currency', o.currency,
    'negotiation_ceiling_minor', p.settings #>> '{negotiation,ceiling_minor}',
    'timezone', coalesce(l.timezone, o.timezone),
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
  left join public.locations l on l.id = c.location_id and l.org_id = c.org_id
  join public.items i on i.id = c.item_id and i.org_id = c.org_id
  join public.supplier_contacts sc on sc.id = p_contact_id and sc.org_id = c.org_id
  left join public.policies p on p.id = o.current_policy_version_id and p.org_id = o.id
  left join public.assessments asm on asm.id = c.current_assessment_id and asm.org_id = c.org_id
  where c.id = p_case_id and c.org_id = p_org_id;
$$;

revoke all on function public.voice_offer_context(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.voice_offer_context(uuid, uuid, uuid) to service_role;
