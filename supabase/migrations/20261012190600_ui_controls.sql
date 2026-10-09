create table public.request_idempotency (
  org_id uuid not null references public.organizations(id) on delete cascade,
  idempotency_key text not null,
  route text not null,
  request_hash text not null,
  response_status integer not null,
  response_body jsonb not null,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (org_id, idempotency_key)
);

alter table public.request_idempotency enable row level security;
create policy tenant_member_select on public.request_idempotency
  for select to authenticated using (public.is_member(org_id));
revoke all on table public.request_idempotency from public, anon, authenticated;
grant select on table public.request_idempotency to authenticated;
grant all on table public.request_idempotency to service_role;

create or replace function public.ui_case_control(
  p_org uuid,
  p_case uuid,
  p_actor uuid,
  p_actor_role public.membership_role,
  p_command text,
  p_expected_version integer,
  p_reason text,
  p_assignee uuid,
  p_outcome text,
  p_request_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current_case public.cases%rowtype;
  next_phase public.case_phase;
  next_control public.run_control;
  next_episode integer;
  next_outcome text;
  next_reason text;
  new_version integer;
begin
  if p_actor_role is null or p_actor_role = 'viewer' then
    raise exception using errcode = 'P0403', message = 'role_denied';
  end if;

  select * into current_case
  from public.cases
  where id = p_case and org_id = p_org
  for update;

  if not found then
    raise exception using errcode = 'P0404', message = 'case_not_found';
  end if;
  if current_case.row_version <> p_expected_version then
    raise exception using errcode = 'P0409', message = 'stale_version';
  end if;

  next_phase := current_case.phase;
  next_control := current_case.run_control;
  next_episode := current_case.episode;
  next_outcome := current_case.closed_outcome;
  next_reason := current_case.closed_reason;

  case p_command
    when 'pause' then
      if nullif(btrim(p_reason), '') is null then
        raise exception using errcode = 'P0422', message = 'reason_required';
      end if;
      if current_case.run_control <> 'active' then
        raise exception using errcode = 'P0409', message = 'invalid_transition';
      end if;
      next_control := 'paused';
    when 'resume' then
      if current_case.run_control <> 'paused' then
        raise exception using errcode = 'P0409', message = 'invalid_transition';
      end if;
      if current_case.block_reason = 'outcome_unknown' then
        raise exception using errcode = 'P0409', message = 'outcome_unknown';
      end if;
      next_control := 'active';
    when 'assign' then
      if p_assignee is not null and not exists (
        select 1 from public.memberships m
        where m.org_id = p_org and m.auth_user_id = p_assignee and m.active
      ) then
        raise exception using errcode = 'P0422', message = 'invalid_assignee';
      end if;
      update public.cases
      set assignee_user_id = p_assignee
      where id = p_case and org_id = p_org;
    when 'close' then
      if current_case.phase = 'closed' then
        raise exception using errcode = 'P0409', message = 'invalid_transition';
      end if;
      if nullif(btrim(p_reason), '') is null then
        raise exception using errcode = 'P0422', message = 'reason_required';
      end if;
      if p_outcome is null or p_outcome not in ('no_impact', 'accepted_risk', 'cancelled', 'unresolved', 'delivered') then
        raise exception using errcode = 'P0422', message = 'invalid_outcome';
      end if;
      if p_outcome = 'delivered' then
        raise exception using errcode = 'P0422', message = 'delivered_requires_receipt';
      end if;
      if p_outcome = 'accepted_risk' and p_actor_role is distinct from 'owner' then
        raise exception using errcode = 'P0403', message = 'owner_required';
      end if;
      if exists (
        select 1 from public.actions a
        where a.org_id = p_org
          and a.case_id = p_case
          and a.state in ('unknown', 'dispatching', 'submitted')
      ) then
        raise exception using errcode = 'P0409', message = 'uncertain_action';
      end if;
      next_phase := 'closed';
      next_outcome := p_outcome;
      next_reason := btrim(p_reason);
    when 'reopen' then
      if current_case.phase <> 'closed' then
        raise exception using errcode = 'P0409', message = 'invalid_transition';
      end if;
      next_phase := 'assessing';
      next_episode := current_case.episode + 1;
      next_outcome := null;
      next_reason := null;
    else
      raise exception using errcode = 'P0422', message = 'invalid_command';
  end case;

  update public.cases
  set phase = next_phase,
      run_control = next_control,
      episode = next_episode,
      closed_outcome = next_outcome,
      closed_reason = next_reason,
      row_version = current_case.row_version + 1,
      updated_at = now()
  where id = p_case and org_id = p_org
  returning row_version into new_version;

  insert into public.audit_events (
    org_id, actor_type, actor_id, case_id, entity_type, entity_id,
    event_name, previous_version, new_version, reason, request_id
  ) values (
    p_org, 'user', p_actor::text, p_case, 'case', p_case,
    'case.control.' || p_command, current_case.row_version, new_version,
    nullif(btrim(p_reason), ''), p_request_id
  );

  insert into public.event_outbox (
    org_id, aggregate_id, correlation_id, event_type, payload
  ) values (
    p_org, p_case, p_request_id, 'case.control.changed',
    jsonb_build_object('case_id', p_case, 'version', new_version)
  );

  return jsonb_build_object(
    'case_id', p_case,
    'row_version', new_version,
    'phase', next_phase,
    'run_control', next_control
  );
exception
  when unique_violation then
    raise exception using errcode = 'P0409', message = 'active_case_exists';
end;
$$;

create or replace function public.ui_request_reassess(
  p_org uuid,
  p_case uuid,
  p_actor uuid,
  p_expected_version integer,
  p_reason text,
  p_request_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current_case public.cases%rowtype;
  source_version integer;
  new_version integer;
  new_event_id uuid;
begin
  select * into current_case
  from public.cases
  where id = p_case and org_id = p_org
  for update;

  if not found then
    raise exception using errcode = 'P0404', message = 'case_not_found';
  end if;
  if current_case.row_version <> p_expected_version then
    raise exception using errcode = 'P0409', message = 'stale_version';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception using errcode = 'P0422', message = 'reason_required';
  end if;

  select a.version into source_version
  from public.assessments a
  where a.id = current_case.current_assessment_id and a.org_id = p_org;

  update public.cases
  set row_version = current_case.row_version + 1,
      updated_at = now()
  where id = p_case and org_id = p_org
  returning row_version into new_version;

  insert into public.audit_events (
    org_id, actor_type, actor_id, case_id, entity_type, entity_id,
    event_name, previous_version, new_version, reason, request_id
  ) values (
    p_org, 'user', p_actor::text, p_case, 'case', p_case,
    'case.reassess.requested', current_case.row_version, new_version,
    btrim(p_reason), p_request_id
  );

  insert into public.event_outbox (
    org_id, aggregate_id, correlation_id, event_type, payload
  ) values (
    p_org, p_case, p_request_id, 'case.assessment.requested',
    jsonb_build_object('case_id', p_case, 'source_version', coalesce(source_version, 0))
  ) returning event_id into new_event_id;

  return jsonb_build_object('event_id', new_event_id);
end;
$$;

create or replace function public.ui_set_membership_role(
  p_org uuid,
  p_membership uuid,
  p_actor uuid,
  p_expected_version integer,
  p_role public.membership_role,
  p_active boolean,
  p_reason text,
  p_request_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current_membership public.memberships%rowtype;
  active_owner_count integer;
  new_version integer;
begin
  perform 1
  from public.memberships
  where org_id = p_org and role = 'owner' and active
  order by id
  for update;

  select * into current_membership
  from public.memberships
  where id = p_membership and org_id = p_org
  for update;

  if not found then
    raise exception using errcode = 'P0404', message = 'membership_not_found';
  end if;
  if current_membership.row_version <> p_expected_version then
    raise exception using errcode = 'P0409', message = 'stale_version';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception using errcode = 'P0422', message = 'reason_required';
  end if;

  if current_membership.role = 'owner' and current_membership.active
    and (p_role <> 'owner' or not p_active) then
    select count(*) into active_owner_count
    from public.memberships
    where org_id = p_org and role = 'owner' and active;
    if active_owner_count <= 1 then
      raise exception using errcode = 'P0409', message = 'last_owner';
    end if;
  end if;

  update public.memberships
  set role = p_role,
      active = p_active,
      row_version = current_membership.row_version + 1,
      updated_at = now()
  where id = p_membership and org_id = p_org
  returning row_version into new_version;

  insert into public.audit_events (
    org_id, actor_type, actor_id, entity_type, entity_id,
    event_name, previous_version, new_version, reason, request_id
  ) values (
    p_org, 'user', p_actor::text, 'membership', p_membership,
    'membership.role.changed', current_membership.row_version, new_version,
    btrim(p_reason), p_request_id
  );

  return jsonb_build_object(
    'membership_id', p_membership,
    'row_version', new_version,
    'role', p_role,
    'active', p_active
  );
end;
$$;

create or replace function public.ui_supplier_approval(
  p_org uuid,
  p_supplier uuid,
  p_actor uuid,
  p_scope text,
  p_contact uuid,
  p_decision text,
  p_expected_version integer,
  p_reason text,
  p_request_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current_version integer;
  new_version integer;
  supplier_status text;
  current_contact public.supplier_contacts%rowtype;
begin
  if nullif(btrim(p_reason), '') is null then
    raise exception using errcode = 'P0422', message = 'reason_required';
  end if;
  if p_decision is null or p_decision not in ('approve', 'block', 'revoke') then
    raise exception using errcode = 'P0422', message = 'invalid_decision';
  end if;

  if p_scope = 'purchasing' then
    select row_version into current_version
    from public.suppliers
    where id = p_supplier and org_id = p_org
    for update;
    if not found then
      raise exception using errcode = 'P0404', message = 'supplier_not_found';
    end if;
    if current_version <> p_expected_version then
      raise exception using errcode = 'P0409', message = 'stale_version';
    end if;

    supplier_status := case p_decision
      when 'approve' then 'approved'
      when 'block' then 'blocked'
      else 'candidate'
    end;
    update public.suppliers
    set purchasing_status = supplier_status,
        approval_actor = p_actor,
        approval_at = now(),
        row_version = current_version + 1,
        updated_at = now()
    where id = p_supplier and org_id = p_org
    returning row_version into new_version;
  elsif p_scope = 'contact' then
    select * into current_contact
    from public.supplier_contacts
    where id = p_contact and supplier_id = p_supplier and org_id = p_org
    for update;
    if not found then
      raise exception using errcode = 'P0404', message = 'contact_not_found';
    end if;
    if current_contact.row_version <> p_expected_version then
      raise exception using errcode = 'P0409', message = 'stale_version';
    end if;
    if p_decision = 'approve' and current_contact.identity_evidence_id is null then
      raise exception using errcode = 'P0422', message = 'identity_evidence_required';
    end if;
    if p_decision = 'approve' and not (current_contact.channel = any(current_contact.permitted_channels)) then
      raise exception using errcode = 'P0422', message = 'channel_not_permitted';
    end if;

    update public.supplier_contacts
    set outreach_approved_at = case when p_decision = 'approve' then now() else null end,
        outreach_approved_by = case when p_decision = 'approve' then p_actor else null end,
        row_version = current_contact.row_version + 1,
        updated_at = now()
    where id = p_contact and supplier_id = p_supplier and org_id = p_org
    returning row_version into new_version;
  else
    raise exception using errcode = 'P0422', message = 'invalid_scope';
  end if;

  insert into public.audit_events (
    org_id, actor_type, actor_id, entity_type, entity_id,
    event_name, previous_version, new_version, reason, request_id
  ) values (
    p_org, 'user', p_actor::text,
    case when p_scope = 'contact' then 'supplier_contact' else 'supplier' end,
    case when p_scope = 'contact' then p_contact else p_supplier end,
    'supplier.approval.' || p_scope, p_expected_version, new_version,
    btrim(p_reason), p_request_id
  );

  return jsonb_build_object(
    'supplier_id', p_supplier,
    'contact_id', p_contact,
    'scope', p_scope,
    'decision', p_decision,
    'row_version', new_version,
    'purchasing_status', supplier_status
  );
end;
$$;

revoke all on function public.ui_case_control(
  uuid, uuid, uuid, public.membership_role, text, integer, text, uuid, text, uuid
) from public, anon, authenticated;
revoke all on function public.ui_request_reassess(
  uuid, uuid, uuid, integer, text, uuid
) from public, anon, authenticated;
revoke all on function public.ui_set_membership_role(
  uuid, uuid, uuid, integer, public.membership_role, boolean, text, uuid
) from public, anon, authenticated;
revoke all on function public.ui_supplier_approval(
  uuid, uuid, uuid, text, uuid, text, integer, text, uuid
) from public, anon, authenticated;
grant execute on function public.ui_case_control(
  uuid, uuid, uuid, public.membership_role, text, integer, text, uuid, text, uuid
) to service_role;
grant execute on function public.ui_request_reassess(
  uuid, uuid, uuid, integer, text, uuid
) to service_role;
grant execute on function public.ui_set_membership_role(
  uuid, uuid, uuid, integer, public.membership_role, boolean, text, uuid
) to service_role;
grant execute on function public.ui_supplier_approval(
  uuid, uuid, uuid, text, uuid, text, integer, text, uuid
) to service_role;

insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', false)
on conflict (id) do nothing;

create policy evidence_member_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'evidence'
    and public.is_member(((storage.foldername(name))[1])::uuid)
  );
