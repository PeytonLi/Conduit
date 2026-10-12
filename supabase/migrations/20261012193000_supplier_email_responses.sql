-- Supplier email responses: record a reply to an availability request as
-- evidence + offer + provisional quote(s), link it to the waiting case and
-- wake the durable supplier_response wait. Mirrors voice_record_provisional_offer.
--
-- A reply is only attached when the sender is an existing supplier contact AND
-- a case is pending a supplier_response wait tied to that supplier — either the
-- wait's action targeted the supplier (or this exact contact), or the case has
-- an open PO line from the supplier. Replies never create or re-target cases.

create or replace function public.inbox_record_supplier_response(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid;
  v_message_id uuid := (p ->> 'source_message_id')::uuid;
  v_message public.source_messages%rowtype;
  v_locator text := 'inbox:supplier_response:' || (p ->> 'source_message_id');
  v_existing_evidence uuid;
  v_existing_case uuid;
  v_contact_id uuid;
  v_supplier_id uuid;
  v_case uuid;
  v_wait uuid;
  v_item uuid;
  v_location uuid;
  v_base_unit text;
  v_currency text;
  v_evidence uuid;
  v_offer uuid;
  v_quote uuid;
  v_quote_ids uuid[] := '{}';
  v_q jsonb;
  v_sent timestamptz;
  v_excerpt text := left(coalesce(p ->> 'excerpt', ''), 280);
begin
  select * into v_message
    from public.source_messages
   where id = v_message_id and org_id = v_org
   for update;
  if not found then
    raise exception 'source message not found' using errcode = 'P0404';
  end if;

  -- Idempotent per source message: a recorded response replays its ids and
  -- never writes a second offer/quote set.
  select e.id, ce.case_id into v_existing_evidence, v_existing_case
    from public.evidence e
    join public.case_evidence ce
      on ce.evidence_id = e.id and ce.org_id = e.org_id
   where e.org_id = v_org and e.locator = v_locator
     and ce.purpose = 'supplier_response'
   limit 1;
  if v_existing_evidence is not null then
    select o.id into v_offer
      from public.offers o
     where o.org_id = v_org and o.case_id = v_existing_case
       and v_existing_evidence = any(o.evidence_ids)
     limit 1;
    select coalesce(array_agg(q.id), '{}') into v_quote_ids
      from public.quotes q
     where q.org_id = v_org and q.offer_id = v_offer;
    return jsonb_build_object(
      'status', 'replayed', 'case_id', v_existing_case,
      'offer_id', v_offer, 'quote_ids', v_quote_ids,
      'evidence_id', v_existing_evidence
    );
  end if;

  -- Only a pending inbound message can be newly routed as a response.
  if v_message.processing_state <> 'pending'
     or v_message.direction <> 'inbound'
     or v_message.sender is null then
    return jsonb_build_object('status', 'none');
  end if;

  -- Sender must be a supplier email contact (address is org+channel unique).
  select c.id, c.supplier_id into v_contact_id, v_supplier_id
    from public.supplier_contacts c
   where c.org_id = v_org and c.channel = 'email'
     and c.normalized_address = lower(v_message.sender);
  if v_contact_id is null then
    return jsonb_build_object('status', 'none');
  end if;

  -- A pending supplier_response wait tied to this supplier. Preference order:
  -- wait whose action names this contact, then this supplier, then earliest.
  select w.id, w.case_id into v_wait, v_case
    from public.planner_waits w
    join public.cases cs on cs.id = w.case_id and cs.org_id = w.org_id
    left join public.actions a on a.id = w.action_id and a.org_id = w.org_id
   where w.org_id = v_org
     and w.expected_kind = 'supplier_response'
     and w.status = 'pending'
     and cs.phase <> 'closed'
     and (
       a.payload ->> 'supplier_id' = v_supplier_id::text
       or a.payload ->> 'contact_id' = v_contact_id::text
       or exists (
         select 1
           from public.case_order_lines col
           join public.purchase_order_lines pol
             on pol.id = col.po_line_id and pol.org_id = col.org_id
           join public.purchase_orders po
             on po.id = pol.purchase_order_id and po.org_id = pol.org_id
          where col.org_id = v_org and col.case_id = w.case_id
            and po.supplier_id = v_supplier_id
            and po.status = 'open'
       )
     )
   order by
     (a.payload ->> 'contact_id' = v_contact_id::text) desc nulls last,
     (a.payload ->> 'supplier_id' = v_supplier_id::text) desc nulls last,
     w.created_at asc
   limit 1;
  if v_wait is null then
    return jsonb_build_object('status', 'none');
  end if;

  select cs.item_id, cs.location_id, i.base_unit, o.currency
    into v_item, v_location, v_base_unit, v_currency
    from public.cases cs
    join public.items i on i.id = cs.item_id and i.org_id = cs.org_id
    join public.organizations o on o.id = cs.org_id
   where cs.id = v_case and cs.org_id = v_org;

  v_sent := coalesce(v_message.sent_at, v_message.received_at, now());

  insert into public.evidence (
    org_id, source_type, external_id, source_time, captured_at,
    content_hash, locator, supported_excerpt
  ) values (
    v_org, 'email_reply',
    coalesce(v_message.rfc_message_id, v_message.provider_message_id),
    v_sent, now(),
    coalesce(p ->> 'content_hash', md5(v_locator)), v_locator, v_excerpt
  ) returning id into v_evidence;

  insert into public.offers (
    org_id, case_id, supplier_id, contact_id, evidence_ids,
    received_at, source_type, source_summary
  ) values (
    v_org, v_case, v_supplier_id, v_contact_id, array[v_evidence],
    v_sent, 'email', v_excerpt
  ) returning id into v_offer;

  for v_q in select * from jsonb_array_elements(coalesce(p -> 'quotes', '[]'::jsonb)) loop
    insert into public.quotes (
      org_id, case_id, offer_id, supplier_id, contact_id, item_id,
      quantity, unit, unit_price_minor, currency, freight_minor, fees_minor,
      destination_location_id, arrival_start, arrival_end, valid_until,
      latest_order_at, status, evidence_ids
    ) values (
      v_org, v_case, v_offer, v_supplier_id, v_contact_id, v_item,
      nullif(v_q ->> 'quantity', '')::integer,
      coalesce(v_q ->> 'unit', v_base_unit),
      nullif(v_q ->> 'unit_price_minor', '')::bigint,
      coalesce(v_q ->> 'currency', v_currency),
      nullif(v_q ->> 'freight_minor', '')::bigint,
      nullif(v_q ->> 'fees_minor', '')::bigint,
      v_location,
      nullif(v_q ->> 'arrival_start', '')::timestamptz,
      nullif(v_q ->> 'arrival_end', '')::timestamptz,
      nullif(v_q ->> 'valid_until', '')::timestamptz,
      nullif(v_q ->> 'latest_order_at', '')::timestamptz,
      'provisional', array[v_evidence]
    ) returning id into v_quote;
    v_quote_ids := array_append(v_quote_ids, v_quote);
  end loop;

  insert into public.case_evidence (org_id, case_id, evidence_id, purpose)
  values (v_org, v_case, v_evidence, 'supplier_response')
  on conflict do nothing;

  insert into public.audit_events (
    org_id, actor_type, case_id, entity_type, entity_id, event_name
  ) values (
    v_org, 'system', v_case, 'source_message', v_message_id,
    'supplier.response.recorded'
  );

  insert into public.event_outbox (
    org_id, aggregate_id, correlation_id, causation_id,
    event_type, schema_version, payload
  ) values (
    v_org, v_case, gen_random_uuid(), v_message_id,
    'supplier.response.recorded', 1,
    jsonb_build_object('case_id', v_case, 'evidence_id', v_evidence)
  );

  update public.source_messages
     set processing_state = 'processed',
         updated_at = now(),
         row_version = row_version + 1
   where id = v_message_id and org_id = v_org;

  return jsonb_build_object(
    'status', 'recorded', 'case_id', v_case, 'wait_id', v_wait,
    'offer_id', v_offer, 'quote_ids', v_quote_ids, 'evidence_id', v_evidence
  );
end;
$$;

revoke all on function public.inbox_record_supplier_response(jsonb)
  from public, anon, authenticated;
grant execute on function public.inbox_record_supplier_response(jsonb)
  to service_role;
