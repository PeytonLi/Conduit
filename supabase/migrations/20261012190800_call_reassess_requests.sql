create table public.call_reassess_requests (
  source_event_id uuid primary key,
  org_id uuid not null,
  case_id uuid not null,
  action_id uuid not null,
  outcome text not null,
  created_at timestamptz not null default now()
);

alter table public.call_reassess_requests enable row level security;
revoke all on table public.call_reassess_requests from public, anon, authenticated;
grant all on table public.call_reassess_requests to service_role;

create or replace function public.request_reassess_after_call(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_event_id uuid := (p ->> 'source_event_id')::uuid;
  v_org_id uuid := (p ->> 'org_id')::uuid;
  v_case_id uuid := (p ->> 'case_id')::uuid;
  v_action_id uuid := (p ->> 'action_id')::uuid;
  v_outcome text := p ->> 'outcome';
  current_case public.cases%rowtype;
  source_version integer;
  new_version integer;
begin
  insert into public.call_reassess_requests (
    source_event_id, org_id, case_id, action_id, outcome
  ) values (
    v_source_event_id, v_org_id, v_case_id, v_action_id, v_outcome
  )
  on conflict (source_event_id) do nothing;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'duplicate');
  end if;

  select *
    into current_case
    from public.cases
   where id = v_case_id
     and org_id = v_org_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  if current_case.phase = 'closed' then
    return pg_catalog.jsonb_build_object('status', 'skipped_closed');
  end if;

  select a.version
    into source_version
    from public.assessments a
   where a.id = current_case.current_assessment_id
     and a.org_id = v_org_id;

  update public.cases
     set row_version = current_case.row_version + 1,
         updated_at = pg_catalog.now()
   where id = v_case_id
     and org_id = v_org_id
   returning row_version into new_version;

  insert into public.audit_events (
    org_id, actor_type, actor_id, case_id, entity_type, entity_id,
    event_name, previous_version, new_version, reason, request_id
  ) values (
    v_org_id, 'system', 'Conduit', v_case_id, 'case', v_case_id,
    'case.reassess_after_supplier_offer.requested',
    current_case.row_version, new_version, 'supplier_offer_received', v_source_event_id
  );

  insert into public.event_outbox (
    org_id, aggregate_id, correlation_id, causation_id, event_type, payload
  ) values (
    v_org_id, v_case_id, v_source_event_id, v_source_event_id,
    'case.assessment.requested',
    pg_catalog.jsonb_build_object(
      'case_id', v_case_id,
      'source_version', coalesce(source_version, 0)
    )
  );

  return pg_catalog.jsonb_build_object('status', 'requested');
end;
$$;

revoke all on function public.request_reassess_after_call(jsonb) from public, anon, authenticated;
grant execute on function public.request_reassess_after_call(jsonb) to service_role;
