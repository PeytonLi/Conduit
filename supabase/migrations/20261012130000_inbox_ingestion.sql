-- F2: inbox ingestion, extraction, matching, and case opening.

create table private.source_message_content (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_message_id uuid not null,
  evidence_id uuid not null,
  segment_kind text not null
    check (segment_kind in ('body', 'quoted', 'forwarded', 'attachment_ref')),
  segment_index integer not null,
  content text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  foreign key (source_message_id, org_id) references public.source_messages(id, org_id),
  foreign key (evidence_id, org_id) references public.evidence(id, org_id)
);

create table public.message_extractions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_message_id uuid not null,
  version integer not null check (version > 0),
  extractor text not null check (extractor in ('deepseek', 'replay_fixture', 'operator_correction')),
  model text,
  prompt_version text,
  status text not null check (status in ('valid', 'invalid', 'unavailable')),
  facts jsonb not null,
  unresolved jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id),
  reason text,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, source_message_id, version),
  foreign key (source_message_id, org_id) references public.source_messages(id, org_id)
);

create trigger message_extractions_append_only
  before update or delete on public.message_extractions
  for each row execute function public.reject_immutable_change();

create table public.message_match_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_message_id uuid not null,
  extraction_version integer,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  candidates jsonb not null default '[]'::jsonb,
  unresolved jsonb not null default '[]'::jsonb,
  case_ids uuid[] not null default '{}'::uuid[],
  resolution jsonb,
  resolved_by uuid references auth.users(id),
  resolved_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  foreign key (source_message_id, org_id) references public.source_messages(id, org_id)
);

create unique index message_match_reviews_one_open_per_message
  on public.message_match_reviews(org_id, source_message_id)
  where status = 'open';

create table public.inbox_request_keys (
  org_id uuid not null references public.organizations(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null,
  source_message_id uuid,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (org_id, idempotency_key),
  foreign key (source_message_id, org_id) references public.source_messages(id, org_id)
);

alter table public.source_messages
  add column historical boolean not null default false;

alter table private.source_message_content enable row level security;
alter table public.message_extractions enable row level security;
alter table public.message_match_reviews enable row level security;
alter table public.inbox_request_keys enable row level security;

create policy tenant_member_select on public.message_extractions
  for select to authenticated using (public.is_member(org_id));
create policy tenant_member_select on public.message_match_reviews
  for select to authenticated using (public.is_member(org_id));
create policy tenant_member_select on public.inbox_request_keys
  for select to authenticated using (public.is_member(org_id));

grant select on table
  public.message_extractions,
  public.message_match_reviews,
  public.inbox_request_keys
to authenticated;

grant all on table private.source_message_content to service_role;
grant all on table
  public.message_extractions,
  public.message_match_reviews,
  public.inbox_request_keys
to service_role;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

create or replace function public.inbox_ensure_connection(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_provider text := p->>'provider';
  v_external text := coalesce(p->>'external_account_id', 'default');
  v_id uuid;
begin
  if v_provider not in ('replay_inbox', 'manual_paste') then
    raise exception 'inbox_ensure_connection only supports replay_inbox/manual_paste'
      using errcode = '22023';
  end if;
  insert into public.connections (org_id, provider, external_account_id, status)
  values (v_org, v_provider, v_external, 'healthy')
  on conflict (org_id, provider, external_account_id)
  do update set status = 'healthy', updated_at = now()
  returning id into v_id;
  return jsonb_build_object('connection_id', v_id);
end;
$$;

create or replace function public.inbox_store_message(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_message_id uuid;
  v_created boolean := false;
  v_state text;
  v_seg jsonb;
  v_att jsonb;
  v_evidence_id uuid;
  v_body_evidence_id uuid;
  v_external_id text := coalesce(p->>'rfc_message_id', p->>'provider_message_id');
  v_event_id uuid := gen_random_uuid();
  v_correlation uuid := gen_random_uuid();
begin
  insert into public.source_messages (
    org_id, connection_id, provider_message_id, provider_thread_id,
    rfc_message_id, direction, sender, recipients, sent_at, received_at,
    historical
  )
  values (
    v_org,
    (p->>'connection_id')::uuid,
    p->>'provider_message_id',
    p->>'provider_thread_id',
    p->>'rfc_message_id',
    p->>'direction',
    p->>'sender',
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p->'recipients') value), '{}'),
    nullif(p->>'sent_at', '')::timestamptz,
    nullif(p->>'received_at', '')::timestamptz,
    coalesce((p->>'historical')::boolean, false)
  )
  on conflict (connection_id, provider_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select id, processing_state into v_message_id, v_state
    from public.source_messages
    where connection_id = (p->>'connection_id')::uuid
      and provider_message_id = p->>'provider_message_id'
      and org_id = v_org;
    return jsonb_build_object(
      'source_message_id', v_message_id,
      'created', false,
      'processing_state', v_state
    );
  end if;

  v_created := true;

  for v_seg in select * from jsonb_array_elements(p->'segments') loop
    insert into public.evidence (
      org_id, source_type, external_id, source_time, content_hash, locator, supported_excerpt
    )
    values (
      v_org,
      'email',
      v_external_id,
      nullif(p->>'sent_at', '')::timestamptz,
      v_seg->>'content_hash',
      coalesce(v_seg->>'locator', 'segment:' || (v_seg->>'index') || ':' || (v_seg->>'kind')),
      left(v_seg->>'content', 280)
    )
    returning id into v_evidence_id;

    insert into private.source_message_content (
      org_id, source_message_id, evidence_id, segment_kind, segment_index, content, content_hash
    )
    values (
      v_org, v_message_id, v_evidence_id, v_seg->>'kind',
      (v_seg->>'index')::integer, v_seg->>'content', v_seg->>'content_hash'
    );

    if v_seg->>'kind' = 'body' and v_body_evidence_id is null then
      v_body_evidence_id := v_evidence_id;
    end if;
  end loop;

  for v_att in select * from jsonb_array_elements(coalesce(p->'attachments', '[]'::jsonb)) loop
    insert into public.evidence (
      org_id, source_type, external_id, source_time, content_hash, locator
    )
    values (
      v_org,
      'email_attachment',
      v_external_id,
      nullif(p->>'sent_at', '')::timestamptz,
      v_att->>'sha256',
      'attachment:' || (v_att->>'filename')
    )
    returning id into v_evidence_id;

    insert into private.source_message_content (
      org_id, source_message_id, evidence_id, segment_kind, segment_index,
      content, content_hash
    )
    values (
      v_org, v_message_id, v_evidence_id, 'attachment_ref', -1,
      jsonb_build_object(
        'filename', v_att->>'filename',
        'mime_type', v_att->>'mime_type',
        'size', (v_att->>'size')::integer,
        'sha256', v_att->>'sha256',
        'provider_attachment_id', v_att->>'provider_attachment_id'
      )::text,
      v_att->>'sha256'
    );
  end loop;

  update public.source_messages
  set body_evidence_id = v_body_evidence_id
  where id = v_message_id and org_id = v_org;

  if not coalesce((p->>'historical')::boolean, false) and p->>'direction' = 'inbound' then
    insert into public.event_outbox (
      event_id, org_id, aggregate_id, correlation_id, event_type, schema_version, payload
    )
    values (
      v_event_id,
      v_org,
      v_message_id,
      v_correlation,
      'supplier.message.received',
      1,
      jsonb_build_object(
        'schema_version', 1,
        'event_id', v_event_id,
        'org_id', v_org,
        'aggregate_id', v_message_id,
        'occurred_at', now(),
        'correlation_id', v_correlation,
        'causation_id', null,
        'name', 'supplier.message.received',
        'data', jsonb_build_object('message_id', v_message_id)
      )
    );
  end if;

  return jsonb_build_object(
    'source_message_id', v_message_id,
    'created', v_created,
    'processing_state', 'pending'
  );
end;
$$;

create or replace function public.inbox_load_message(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_message public.source_messages%rowtype;
  v_provider text;
  v_segments jsonb;
  v_extraction jsonb;
begin
  select * into v_message
  from public.source_messages
  where id = (p->>'source_message_id')::uuid and org_id = v_org;
  if not found then
    raise exception 'source message not found' using errcode = 'P0404';
  end if;

  select provider into v_provider
  from public.connections
  where id = v_message.connection_id and org_id = v_org;

  select coalesce(jsonb_agg(jsonb_build_object(
    'evidence_id', c.evidence_id,
    'kind', c.segment_kind,
    'index', c.segment_index,
    'content', c.content,
    'content_hash', c.content_hash
  ) order by c.segment_index), '[]'::jsonb)
  into v_segments
  from private.source_message_content c
  where c.source_message_id = v_message.id and c.org_id = v_org
    and c.segment_kind <> 'attachment_ref';

  select to_jsonb(e.*) into v_extraction
  from public.message_extractions e
  where e.source_message_id = v_message.id and e.org_id = v_org
  order by e.version desc
  limit 1;

  return jsonb_build_object(
    'message', to_jsonb(v_message),
    'provider', v_provider,
    'segments', v_segments,
    'latest_extraction', v_extraction,
    'org_environment_mode', (select o.environment_mode from public.organizations o where o.id = v_org)
  );
end;
$$;

create or replace function public.inbox_match_context(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_sender text := lower(p->>'sender');
  v_contacts jsonb;
  v_lines jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'contact_id', c.id,
    'supplier_id', c.supplier_id,
    'supplier_name', s.name,
    'normalized_address', c.normalized_address,
    'channel', c.channel,
    'outreach_approved_at', c.outreach_approved_at,
    'permitted_channels', c.permitted_channels
  )), '[]'::jsonb)
  into v_contacts
  from public.supplier_contacts c
  join public.suppliers s on s.id = c.supplier_id and s.org_id = c.org_id
  where c.org_id = v_org and c.normalized_address = v_sender;

  select coalesce(jsonb_agg(line_obj order by line_obj->>'po_external_id', line_obj->>'external_line_id'), '[]'::jsonb)
  into v_lines
  from (
    select jsonb_build_object(
      'po_line_id', l.id,
      'po_id', l.purchase_order_id,
      'po_external_id', o.external_id,
      'external_line_id', l.external_line_id,
      'supplier_id', o.supplier_id,
      'item_id', l.item_id,
      'sku', i.sku,
      'base_unit', i.base_unit,
      'supplier_skus', coalesce((
        select jsonb_agg(si.supplier_sku)
        from public.supplier_items si
        where si.org_id = l.org_id and si.item_id = l.item_id and si.supplier_id = o.supplier_id
      ), '[]'::jsonb),
      'location_id', l.destination_location_id,
      'location_timezone', loc.timezone,
      'ordered_qty', l.ordered_qty,
      'received_qty', l.received_qty,
      'cancelled_qty', l.cancelled_qty,
      'active_schedules', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', rs.id,
          'quantity_remaining', rs.quantity_remaining,
          'earliest_at', rs.earliest_at,
          'latest_at', rs.latest_at,
          'promise_state', rs.promise_state
        ) order by rs.earliest_at)
        from public.receipt_schedules rs
        where rs.org_id = l.org_id and rs.po_line_id = l.id
          and rs.promise_state <> 'superseded'
      ), '[]'::jsonb)
    ) as line_obj
    from public.purchase_order_lines l
    join public.purchase_orders o on o.id = l.purchase_order_id and o.org_id = l.org_id
    join public.items i on i.id = l.item_id and i.org_id = l.org_id
    join public.locations loc on loc.id = l.destination_location_id and loc.org_id = l.org_id
    where l.org_id = v_org and o.status = 'open'
  ) lines;
  -- keep only lines with at least one active schedule surfaced; empty schedules
  -- still returned so TS can flag schedule_conflict deterministically.

  return jsonb_build_object('sender_contacts', v_contacts, 'lines', v_lines);
end;
$$;

create or replace function public.inbox_record_extraction(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_message_id uuid := (p->>'source_message_id')::uuid;
  v_version integer;
  v_row public.message_extractions%rowtype;
begin
  perform 1 from public.source_messages
  where id = v_message_id and org_id = v_org
  for update;
  if not found then
    raise exception 'source message not found' using errcode = 'P0404';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.message_extractions
  where source_message_id = v_message_id and org_id = v_org;

  insert into public.message_extractions (
    org_id, source_message_id, version, extractor, model, prompt_version,
    status, facts, unresolved, created_by, reason
  )
  values (
    v_org, v_message_id, v_version, p->>'extractor', p->>'model',
    p->>'prompt_version', coalesce(p->>'status', 'valid'),
    coalesce(p->'facts', '{}'::jsonb), coalesce(p->'unresolved', '[]'::jsonb),
    nullif(p->>'created_by', '')::uuid, p->>'reason'
  )
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.inbox_open_cases(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_message_id uuid := (p->>'source_message_id')::uuid;
  v_actor uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_mode text := coalesce(p->>'mode', 'auto');
  v_status text := p->'outcome'->>'status';
  v_message public.source_messages%rowtype;
  v_line jsonb;
  v_sched public.receipt_schedules%rowtype;
  v_new_sched uuid;
  v_remainder_sched uuid;
  v_case_id uuid;
  v_case public.cases%rowtype;
  v_prev_version integer;
  v_case_ids uuid[] := '{}';
  v_review_id uuid;
  v_group record;
  v_event_id uuid;
  v_correlation uuid;
  v_actor_type text := case when v_actor is null then 'system' else 'user' end;
begin
  select * into v_message
  from public.source_messages
  where id = v_message_id and org_id = v_org
  for update;
  if not found then
    raise exception 'source message not found' using errcode = 'P0404';
  end if;

  if v_mode = 'auto' and v_message.processing_state <> 'pending' then
    select coalesce(array_agg(distinct col.case_id), '{}') into v_case_ids
    from public.case_order_lines col
    where col.org_id = v_org and col.triggering_message_id = v_message_id;
    select id into v_review_id
    from public.message_match_reviews
    where org_id = v_org and source_message_id = v_message_id and status = 'open';
    return jsonb_build_object(
      'status', case v_message.processing_state
        when 'processed' then 'matched'
        when 'needs_review' then 'needs_review'
        when 'ignored' then 'not_delay'
        else v_message.processing_state end,
      'case_ids', to_jsonb(v_case_ids),
      'review_id', v_review_id,
      'replayed', true
    );
  end if;

  if v_mode = 'resolution' then
    if v_message.processing_state <> 'needs_review' then
      raise exception 'message is not awaiting review' using errcode = 'P0409';
    end if;
    select id into v_review_id
    from public.message_match_reviews
    where org_id = v_org and source_message_id = v_message_id and status = 'open';
    if v_review_id is null then
      raise exception 'no open review for message' using errcode = 'P0409';
    end if;
  end if;

  if v_status = 'not_delay' then
    update public.source_messages
    set processing_state = 'ignored', updated_at = now(), row_version = row_version + 1
    where id = v_message_id and org_id = v_org;
    if v_mode = 'resolution' then
      update public.message_match_reviews
      set status = 'dismissed', resolution = p->'resolution', resolved_by = v_actor,
          resolved_reason = p->>'review_reason', updated_at = now(), row_version = row_version + 1
      where id = v_review_id and org_id = v_org;
    end if;
    return jsonb_build_object('status', 'not_delay', 'case_ids', '[]'::jsonb,
      'review_id', v_review_id, 'replayed', false);
  end if;

  if v_status = 'matched' then
    for v_line in select * from jsonb_array_elements(p->'outcome'->'lines') loop
      select * into v_sched
      from public.receipt_schedules
      where id = (v_line->>'schedule_id')::uuid and org_id = v_org
      for update;
      if not found
        or v_sched.promise_state = 'superseded'
        or v_sched.quantity_remaining <> (v_line->>'remaining_qty')::integer then
        raise exception 'stale schedule for matched line' using errcode = 'P0409';
      end if;

      update public.receipt_schedules
      set promise_state = 'superseded', row_version = row_version + 1, updated_at = now()
      where id = v_sched.id and org_id = v_org;

      if (v_line->>'full')::boolean then
        insert into public.receipt_schedules (
          org_id, po_line_id, quantity_remaining, earliest_at, latest_at,
          evidence_id, promise_state, supersedes_id, source_as_of
        )
        values (
          v_org, v_sched.po_line_id, (v_line->>'affected_qty')::integer,
          nullif(v_line->>'new_earliest_at', '')::timestamptz,
          nullif(v_line->>'new_latest_at', '')::timestamptz,
          nullif(v_line->>'evidence_id', '')::uuid,
          (v_line->>'new_promise_state')::public.promise_state, v_sched.id, v_message.sent_at
        )
        returning id into v_new_sched;

        insert into public.commitment_events (
          org_id, po_line_id, kind, previous_schedule_id, new_schedule_id,
          affected_qty, evidence_id, actor_id
        )
        values (
          v_org, v_sched.po_line_id, 'delay', v_sched.id, v_new_sched,
          (v_line->>'affected_qty')::integer,
          nullif(v_line->>'evidence_id', '')::uuid, v_actor
        );
      else
        insert into public.receipt_schedules (
          org_id, po_line_id, quantity_remaining, earliest_at, latest_at,
          evidence_id, promise_state, supersedes_id, source_as_of
        )
        values (
          v_org, v_sched.po_line_id,
          v_sched.quantity_remaining - (v_line->>'affected_qty')::integer,
          v_sched.earliest_at, v_sched.latest_at,
          nullif(v_line->>'evidence_id', '')::uuid,
          v_sched.promise_state, v_sched.id, v_message.sent_at
        )
        returning id into v_remainder_sched;

        insert into public.commitment_events (
          org_id, po_line_id, kind, previous_schedule_id, new_schedule_id,
          affected_qty, evidence_id, actor_id
        )
        values (
          v_org, v_sched.po_line_id, 'split', v_sched.id, v_remainder_sched,
          v_sched.quantity_remaining - (v_line->>'affected_qty')::integer,
          nullif(v_line->>'evidence_id', '')::uuid, v_actor
        );

        insert into public.receipt_schedules (
          org_id, po_line_id, quantity_remaining, earliest_at, latest_at,
          evidence_id, promise_state, supersedes_id, source_as_of
        )
        values (
          v_org, v_sched.po_line_id, (v_line->>'affected_qty')::integer,
          nullif(v_line->>'new_earliest_at', '')::timestamptz,
          nullif(v_line->>'new_latest_at', '')::timestamptz,
          nullif(v_line->>'evidence_id', '')::uuid,
          (v_line->>'new_promise_state')::public.promise_state, v_sched.id, v_message.sent_at
        )
        returning id into v_new_sched;

        insert into public.commitment_events (
          org_id, po_line_id, kind, previous_schedule_id, new_schedule_id,
          affected_qty, evidence_id, actor_id
        )
        values (
          v_org, v_sched.po_line_id, 'delay', v_sched.id, v_new_sched,
          (v_line->>'affected_qty')::integer,
          nullif(v_line->>'evidence_id', '')::uuid, v_actor
        );
      end if;
    end loop;

    for v_group in
      select (l->>'item_id')::uuid as item_id, (l->>'location_id')::uuid as location_id
      from jsonb_array_elements(p->'outcome'->'lines') l
      group by 1, 2
      order by 1, 2
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_org::text || v_group.item_id::text || v_group.location_id::text, 0));

      select * into v_case
      from public.cases
      where org_id = v_org and item_id = v_group.item_id and location_id = v_group.location_id
        and phase <> 'closed'
      for update;

      if not found then
        insert into public.cases (org_id, item_id, location_id, phase, severity)
        values (v_org, v_group.item_id, v_group.location_id, 'new', 'info')
        returning * into v_case;
        v_prev_version := null;
      else
        v_prev_version := v_case.row_version;
        update public.cases
        set row_version = row_version + 1, updated_at = now()
        where id = v_case.id and org_id = v_org
        returning * into v_case;
      end if;

      v_case_ids := array_append(v_case_ids, v_case.id);

      insert into public.case_order_lines (org_id, case_id, po_line_id, affected_qty, triggering_message_id)
      select v_org, v_case.id, (l->>'po_line_id')::uuid, (l->>'affected_qty')::integer, v_message_id
      from jsonb_array_elements(p->'outcome'->'lines') l
      where (l->>'item_id')::uuid = v_group.item_id and (l->>'location_id')::uuid = v_group.location_id
      on conflict (org_id, case_id, po_line_id)
      do update set affected_qty = excluded.affected_qty,
                    triggering_message_id = excluded.triggering_message_id;

      insert into public.case_evidence (org_id, case_id, evidence_id, purpose)
      select distinct v_org, v_case.id, eid, 'delay_notice'
      from (
        select (l->>'evidence_id')::uuid as eid
        from jsonb_array_elements(p->'outcome'->'lines') l
        where l->>'evidence_id' is not null
        union select v_message.body_evidence_id
      ) e
      where eid is not null
      on conflict do nothing;

      insert into public.audit_events (
        org_id, actor_type, actor_id, case_id, entity_type, entity_id,
        event_name, previous_version, new_version, reason
      )
      values (
        v_org, v_actor_type, v_actor::text, v_case.id, 'case', v_case.id,
        case when v_prev_version is null then 'case.opened' else 'case.updated_from_message' end,
        v_prev_version, v_case.row_version, p->>'review_reason'
      );

      v_event_id := gen_random_uuid();
      v_correlation := gen_random_uuid();
      insert into public.event_outbox (
        event_id, org_id, aggregate_id, correlation_id, event_type, schema_version, payload
      )
      values (
        v_event_id, v_org, v_case.id, v_correlation, 'case.assessment.requested', 1,
        jsonb_build_object(
          'schema_version', 1,
          'event_id', v_event_id,
          'org_id', v_org,
          'aggregate_id', v_case.id,
          'occurred_at', now(),
          'correlation_id', v_correlation,
          'causation_id', null,
          'name', 'case.assessment.requested',
          'data', jsonb_build_object('case_id', v_case.id, 'source_version', v_case.row_version)
        )
      );
    end loop;

    update public.source_messages
    set processing_state = 'processed', updated_at = now(), row_version = row_version + 1
    where id = v_message_id and org_id = v_org;

    if v_mode = 'resolution' then
      update public.message_match_reviews
      set status = 'resolved', resolution = p->'resolution', resolved_by = v_actor,
          resolved_reason = p->>'review_reason', updated_at = now(), row_version = row_version + 1
      where id = v_review_id and org_id = v_org;
    end if;

    return jsonb_build_object('status', 'matched', 'case_ids', to_jsonb(v_case_ids),
      'review_id', v_review_id, 'replayed', false);
  end if;

  -- needs_review
  insert into public.message_match_reviews (
    org_id, source_message_id, extraction_version, status, candidates, unresolved
  )
  values (
    v_org, v_message_id, (p->>'extraction_version')::integer, 'open',
    coalesce(p->'outcome'->'review'->'candidates', '[]'::jsonb),
    coalesce(p->'outcome'->'review'->'unresolved', '[]'::jsonb)
  )
  on conflict (org_id, source_message_id) where status = 'open'
  do update set
    candidates = excluded.candidates,
    unresolved = excluded.unresolved,
    extraction_version = excluded.extraction_version,
    updated_at = now(),
    row_version = public.message_match_reviews.row_version + 1
  returning id into v_review_id;

  for v_group in
    select (g->>'item_id')::uuid as item_id, (g->>'location_id')::uuid as location_id
    from jsonb_array_elements(coalesce(p->'outcome'->'review'->'case_groups', '[]'::jsonb)) g
    group by 1, 2
    order by 1, 2
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || v_group.item_id::text || v_group.location_id::text, 0));

    select * into v_case
    from public.cases
    where org_id = v_org and item_id = v_group.item_id and location_id = v_group.location_id
      and phase <> 'closed'
    for update;

    if not found then
      insert into public.cases (org_id, item_id, location_id, phase, severity)
      values (v_org, v_group.item_id, v_group.location_id, 'needs_review', 'info')
      returning * into v_case;
      v_prev_version := null;
    else
      v_prev_version := v_case.row_version;
      update public.cases
      set row_version = row_version + 1, updated_at = now(),
          phase = case
            when phase in ('new', 'assessing', 'recovering', 'awaiting_supplier', 'executing')
              then 'needs_review'::public.case_phase
            else phase
          end
      where id = v_case.id and org_id = v_org
      returning * into v_case;
    end if;

    v_case_ids := array_append(v_case_ids, v_case.id);

    insert into public.case_evidence (org_id, case_id, evidence_id, purpose)
    values (v_org, v_case.id, v_message.body_evidence_id, 'unmatched_delay_notice')
    on conflict do nothing;

    insert into public.audit_events (
      org_id, actor_type, actor_id, case_id, entity_type, entity_id,
      event_name, previous_version, new_version, reason
    )
    values (
      v_org, v_actor_type, v_actor::text, v_case.id, 'case', v_case.id,
      'case.match_review_required', v_prev_version, v_case.row_version, p->>'review_reason'
    );
  end loop;

  update public.message_match_reviews
  set case_ids = v_case_ids, updated_at = now()
  where id = v_review_id and org_id = v_org;

  update public.source_messages
  set processing_state = 'needs_review', updated_at = now(), row_version = row_version + 1
  where id = v_message_id and org_id = v_org;

  return jsonb_build_object('status', 'needs_review', 'case_ids', to_jsonb(v_case_ids),
    'review_id', v_review_id, 'replayed', false);
end;
$$;

create or replace function public.inbox_dismiss_message(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_message_id uuid := (p->>'source_message_id')::uuid;
  v_actor uuid := nullif(p->>'actor_user_id', '')::uuid;
begin
  update public.message_match_reviews
  set status = 'dismissed', resolved_by = v_actor, resolved_reason = p->>'reason',
      updated_at = now(), row_version = row_version + 1
  where org_id = v_org and source_message_id = v_message_id and status = 'open';

  update public.source_messages
  set processing_state = 'ignored', updated_at = now(), row_version = row_version + 1
  where id = v_message_id and org_id = v_org;

  insert into public.audit_events (
    org_id, actor_type, actor_id, entity_type, entity_id, event_name, reason
  )
  values (
    v_org, case when v_actor is null then 'system' else 'user' end, v_actor::text,
    'source_message', v_message_id, 'source_message.dismissed', p->>'reason'
  );

  return jsonb_build_object('status', 'dismissed');
end;
$$;

create or replace function public.inbox_request_key_store(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_key text := p->>'idempotency_key';
  v_hash text := p->>'request_hash';
  v_existing record;
begin
  select * into v_existing
  from public.inbox_request_keys
  where org_id = v_org and idempotency_key = v_key;

  if found then
    if v_existing.request_hash <> v_hash then
      raise exception 'idempotency key reused with a different request' using errcode = 'P0409';
    end if;
    return jsonb_build_object(
      'replayed', true,
      'source_message_id', v_existing.source_message_id,
      'response', v_existing.response
    );
  end if;

  insert into public.inbox_request_keys (org_id, idempotency_key, request_hash, source_message_id, response)
  values (v_org, v_key, v_hash, nullif(p->>'source_message_id', '')::uuid, p->'response')
  on conflict (org_id, idempotency_key) do nothing;

  select * into v_existing
  from public.inbox_request_keys
  where org_id = v_org and idempotency_key = v_key;
  if v_existing.request_hash <> v_hash then
    raise exception 'idempotency key reused with a different request' using errcode = 'P0409';
  end if;

  return jsonb_build_object(
    'replayed', v_existing.source_message_id is not null or v_existing.response is not null,
    'source_message_id', v_existing.source_message_id,
    'response', v_existing.response
  );
end;
$$;

create or replace function public.inbox_request_key_complete(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.inbox_request_keys
  set source_message_id = nullif(p->>'source_message_id', '')::uuid,
      response = p->'response'
  where org_id = (p->>'org_id')::uuid and idempotency_key = p->>'idempotency_key';
  return jsonb_build_object('stored', found);
end;
$$;

create or replace function public.inbox_case_review_lookup(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_case_id uuid := (p->>'case_id')::uuid;
  v_case public.cases%rowtype;
  v_review record;
begin
  select * into v_case
  from public.cases where id = v_case_id and org_id = v_org;
  if not found then
    raise exception 'case not found' using errcode = 'P0404';
  end if;

  select * into v_review
  from public.message_match_reviews
  where org_id = v_org and status = 'open' and v_case_id = any(case_ids)
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'case_row_version', v_case.row_version,
    'case_phase', v_case.phase,
    'org_environment_mode', (select o.environment_mode from public.organizations o where o.id = v_org),
    'review', case when v_review.id is null then null else jsonb_build_object(
      'id', v_review.id,
      'source_message_id', v_review.source_message_id,
      'extraction_version', v_review.extraction_version,
      'candidates', v_review.candidates,
      'unresolved', v_review.unresolved,
      'case_ids', v_review.case_ids
    ) end
  );
end;
$$;

create or replace function public.gmail_store_connection(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_connection_id uuid;
begin
  insert into public.connections (
    org_id, provider, external_account_id, status, scopes, last_error_code, sync_cursor
  )
  values (
    v_org, 'gmail', p->>'external_account_id', 'healthy',
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p->'scopes') value), '{}'),
    null, null
  )
  on conflict (org_id, provider, external_account_id)
  do update set status = 'healthy', scopes = excluded.scopes,
    last_error_code = null, sync_cursor = null, updated_at = now()
  returning id into v_connection_id;

  insert into private.integration_credentials (
    org_id, connection_id, encrypted_credential_material, key_version, expires_at
  )
  values (
    v_org, v_connection_id, decode(p->>'encrypted_b64', 'base64'),
    p->>'key_version', nullif(p->>'expires_at', '')::timestamptz
  )
  on conflict (connection_id)
  do update set encrypted_credential_material = excluded.encrypted_credential_material,
    key_version = excluded.key_version, expires_at = excluded.expires_at;

  insert into public.audit_events (
    org_id, actor_type, actor_id, entity_type, entity_id, event_name
  )
  values (
    v_org, 'user', p->>'actor_user_id', 'connection', v_connection_id,
    'connection.gmail.connected'
  );

  return jsonb_build_object('connection_id', v_connection_id);
end;
$$;

create or replace function public.gmail_load_credential(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  select c.status, c.external_account_id, c.sync_cursor,
         encode(ic.encrypted_credential_material, 'base64') as encrypted_b64,
         ic.key_version, ic.expires_at
  into v
  from public.connections c
  left join private.integration_credentials ic
    on ic.connection_id = c.id and ic.org_id = c.org_id
  where c.id = (p->>'connection_id')::uuid and c.org_id = (p->>'org_id')::uuid
    and c.provider = 'gmail';
  if not found then
    raise exception 'gmail connection not found' using errcode = 'P0404';
  end if;
  return jsonb_build_object(
    'status', v.status,
    'external_account_id', v.external_account_id,
    'sync_cursor', v.sync_cursor,
    'encrypted_b64', v.encrypted_b64,
    'key_version', v.key_version,
    'expires_at', v.expires_at
  );
end;
$$;

create or replace function public.gmail_set_status(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.connections
  set status = p->>'status', last_error_code = p->>'error_code', updated_at = now()
  where id = (p->>'connection_id')::uuid and org_id = (p->>'org_id')::uuid
    and provider = 'gmail';
  return jsonb_build_object('updated', found);
end;
$$;

create or replace function public.gmail_advance_cursor(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_advanced integer;
begin
  update public.connections
  set sync_cursor = p->>'new_cursor', last_success_at = now(),
      status = 'healthy', last_error_code = null, updated_at = now()
  where id = (p->>'connection_id')::uuid and org_id = (p->>'org_id')::uuid
    and provider = 'gmail'
    and sync_cursor is not distinct from p->>'expected_cursor';
  get diagnostics v_advanced = row_count;
  return jsonb_build_object('advanced', v_advanced > 0);
end;
$$;

create or replace function public.inbox_list_gmail_connections()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'org_id', c.org_id, 'connection_id', c.id,
      'environment_mode', o.environment_mode
    ))
    from public.connections c
    join public.organizations o on o.id = c.org_id
    where c.provider = 'gmail' and c.status in ('healthy', 'degraded')
  ), '[]'::jsonb);
end;
$$;

revoke all on function
  public.inbox_ensure_connection(jsonb),
  public.inbox_store_message(jsonb),
  public.inbox_load_message(jsonb),
  public.inbox_match_context(jsonb),
  public.inbox_record_extraction(jsonb),
  public.inbox_open_cases(jsonb),
  public.inbox_dismiss_message(jsonb),
  public.inbox_case_review_lookup(jsonb),
  public.inbox_request_key_store(jsonb),
  public.inbox_request_key_complete(jsonb),
  public.gmail_store_connection(jsonb),
  public.gmail_load_credential(jsonb),
  public.gmail_set_status(jsonb),
  public.gmail_advance_cursor(jsonb),
  public.inbox_list_gmail_connections()
from public, anon, authenticated;

grant execute on function
  public.inbox_ensure_connection(jsonb),
  public.inbox_store_message(jsonb),
  public.inbox_load_message(jsonb),
  public.inbox_match_context(jsonb),
  public.inbox_record_extraction(jsonb),
  public.inbox_open_cases(jsonb),
  public.inbox_dismiss_message(jsonb),
  public.inbox_case_review_lookup(jsonb),
  public.inbox_request_key_store(jsonb),
  public.inbox_request_key_complete(jsonb),
  public.gmail_store_connection(jsonb),
  public.gmail_load_credential(jsonb),
  public.gmail_set_status(jsonb),
  public.gmail_advance_cursor(jsonb),
  public.inbox_list_gmail_connections()
to service_role;
