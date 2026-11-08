-- Supplier onboarding workflow and optional delegated low-value purchasing (PRD 01 section 3, D-023).
--
-- Part 1 - supplier onboarding. A research candidate becomes contactable only after an owner
-- approves a specific contact, and purchasing-eligible only after an owner separately approves
-- the supplier (which itself requires an approved contact and onboarding evidence). Every owner
-- decision is appended to supplier_onboarding_events with the actor, evidence and stage change.
-- Plans that buy from a supplier that is not purchasing-eligible cannot be approved, and no
-- commitment action can be prepared for them.
--
-- Part 2 - delegated purchasing. Default policy keeps the v1 invariant: every commitment needs a
-- fresh owner approval. An owner may opt in to a bounded delegation (amount ceiling, currency,
-- optional supplier allowlist, hours, daily count). A delegated approval is an ordinary approvals
-- row labelled approval_mode = 'delegated' that points at the policy version and records its basis;
-- the delegating owner (the policy version's author) stays the accountable approver. Disabling
-- delegation, or any policy change away from it, revokes outstanding delegated approvals and
-- cancels prepared-but-undispatched actions they authorized.

-- ---------------------------------------------------------------- onboarding events
create table public.supplier_onboarding_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  supplier_id uuid not null,
  contact_id uuid,
  scope text not null check (scope in ('contact', 'purchasing')),
  decision text not null check (decision in ('approve', 'block', 'revoke')),
  from_stage text not null check (from_stage in ('candidate', 'contact_approved', 'purchasing_eligible', 'blocked')),
  to_stage text not null check (to_stage in ('candidate', 'contact_approved', 'purchasing_eligible', 'blocked')),
  actor_user_id uuid not null references auth.users(id),
  evidence_ids uuid[] not null default '{}',
  evidence_note text,
  reason text not null,
  request_id uuid,
  occurred_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (supplier_id, org_id) references public.suppliers(id, org_id),
  foreign key (contact_id, org_id) references public.supplier_contacts(id, org_id)
);
create index supplier_onboarding_events_supplier
  on public.supplier_onboarding_events (org_id, supplier_id, occurred_at desc);

create trigger supplier_onboarding_events_append_only
  before update or delete on public.supplier_onboarding_events
  for each row execute function public.reject_immutable_change();

alter table public.supplier_onboarding_events enable row level security;
create policy tenant_member_select on public.supplier_onboarding_events
  for select to authenticated using (public.is_member(org_id));
grant select on public.supplier_onboarding_events to authenticated;
grant all on public.supplier_onboarding_events to service_role;

-- candidate -> contact_approved -> purchasing_eligible, or blocked. Derived, so imports and any
-- other writer of purchasing_status can never leave a stored stage out of step.
create or replace function private.supplier_onboarding_stage(p_org_id uuid, p_supplier_id uuid)
returns text language sql stable set search_path = public, pg_temp as $$
  select case
    when s.purchasing_status = 'blocked' then 'blocked'
    when s.purchasing_status = 'approved' then 'purchasing_eligible'
    when exists (
      select 1 from public.supplier_contacts c
      where c.org_id = s.org_id and c.supplier_id = s.id and c.outreach_approved_at is not null
    ) then 'contact_approved'
    else 'candidate' end
  from public.suppliers s where s.id = p_supplier_id and s.org_id = p_org_id;
$$;

drop function public.ui_supplier_approval(uuid, uuid, uuid, text, uuid, text, integer, text, uuid);

create or replace function public.ui_supplier_approval(
  p_org uuid,
  p_supplier uuid,
  p_actor uuid,
  p_scope text,
  p_contact uuid,
  p_decision text,
  p_expected_version integer,
  p_reason text,
  p_request_id uuid,
  p_evidence_ids uuid[] default '{}',
  p_evidence_note text default null
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current_version integer;
  new_version integer;
  supplier_status text;
  supplier_row public.suppliers%rowtype;
  current_contact public.supplier_contacts%rowtype;
  v_from text;
  v_to text;
  v_evidence uuid[] := coalesce(p_evidence_ids, '{}');
  v_note text := nullif(btrim(coalesce(p_evidence_note, '')), '');
begin
  if private.member_role(p_org, p_actor) is distinct from 'owner' then
    raise exception using errcode = 'P0403', message = 'owner_required';
  end if;
  perform 1 from public.organizations where id = p_org for update;
  if nullif(btrim(p_reason), '') is null then
    raise exception using errcode = 'P0422', message = 'reason_required';
  end if;
  if p_decision is null or p_decision not in ('approve', 'block', 'revoke') then
    raise exception using errcode = 'P0422', message = 'invalid_decision';
  end if;
  if p_scope is null or p_scope not in ('purchasing', 'contact') then
    raise exception using errcode = 'P0422', message = 'invalid_scope';
  end if;
  if cardinality(v_evidence) > 0 and (
    select count(*) from public.evidence e where e.org_id = p_org and e.id = any(v_evidence)
  ) <> (select count(distinct x) from unnest(v_evidence) x) then
    raise exception using errcode = 'P0422', message = 'evidence_not_found';
  end if;

  -- Lock the supplier first in both scopes so stage reads and writes are consistent.
  select * into supplier_row from public.suppliers where id = p_supplier and org_id = p_org for update;
  if not found then
    raise exception using errcode = 'P0404', message = 'supplier_not_found';
  end if;
  v_from := private.supplier_onboarding_stage(p_org, p_supplier);

  if p_scope = 'purchasing' then
    current_version := supplier_row.row_version;
    if current_version <> p_expected_version then
      raise exception using errcode = 'P0409', message = 'stale_version';
    end if;
    if p_decision = 'approve' then
      if supplier_row.purchasing_status = 'blocked' then
        raise exception using errcode = 'P0422', message = 'supplier_blocked';
      end if;
      if not exists (
        select 1 from public.supplier_contacts c
        where c.org_id = p_org and c.supplier_id = p_supplier and c.outreach_approved_at is not null
      ) then
        raise exception using errcode = 'P0422', message = 'contact_approval_required';
      end if;
      if cardinality(v_evidence) = 0 and v_note is null then
        raise exception using errcode = 'P0422', message = 'onboarding_evidence_required';
      end if;
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
  else
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
    current_version := current_contact.row_version;
    if p_decision = 'approve' and supplier_row.purchasing_status = 'blocked' then
      raise exception using errcode = 'P0422', message = 'supplier_blocked';
    end if;
    if p_decision = 'approve' and not exists (
      select 1 from public.evidence e where e.id = current_contact.identity_evidence_id
        and e.org_id = p_org and e.verified_at is not null
    ) then
      raise exception using errcode = 'P0422', message = 'identity_evidence_required';
    end if;
    if p_decision = 'approve' and not (current_contact.channel = any(current_contact.permitted_channels)) then
      raise exception using errcode = 'P0422', message = 'channel_not_permitted';
    end if;
    if p_decision = 'approve' and current_contact.identity_evidence_id is not null then
      v_evidence := array(select distinct x from unnest(v_evidence || current_contact.identity_evidence_id) x);
    end if;

    update public.supplier_contacts
    set outreach_approved_at = case when p_decision = 'approve' then now() else null end,
        outreach_approved_by = case when p_decision = 'approve' then p_actor else null end,
        row_version = current_contact.row_version + 1,
        updated_at = now()
    where id = p_contact and supplier_id = p_supplier and org_id = p_org
    returning row_version into new_version;
    if p_decision <> 'approve' and supplier_row.purchasing_status = 'approved'
        and not exists (select 1 from public.supplier_contacts c
          where c.org_id = p_org and c.supplier_id = p_supplier and c.outreach_approved_at is not null) then
      update public.suppliers set purchasing_status = 'candidate', row_version = row_version + 1,
        updated_at = now() where id = p_supplier and org_id = p_org;
    end if;
  end if;

  v_to := private.supplier_onboarding_stage(p_org, p_supplier);
  insert into public.supplier_onboarding_events (
    org_id, supplier_id, contact_id, scope, decision, from_stage, to_stage,
    actor_user_id, evidence_ids, evidence_note, reason, request_id
  ) values (
    p_org, p_supplier, case when p_scope = 'contact' then p_contact end, p_scope, p_decision, v_from, v_to,
    p_actor, v_evidence, v_note, btrim(p_reason), p_request_id
  );

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
    'purchasing_status', supplier_status,
    'stage', v_to
  );
end;
$$;

revoke all on function public.ui_supplier_approval(
  uuid, uuid, uuid, text, uuid, text, integer, text, uuid, uuid[], text
) from public, anon, authenticated;
grant execute on function public.ui_supplier_approval(
  uuid, uuid, uuid, text, uuid, text, integer, text, uuid, uuid[], text
) to service_role;

-- ---------------------------------------------------------------- purchasing eligibility guards
-- Suppliers named by a plan's purchase quotes that are not purchasing-eligible (candidate or blocked).
create or replace function private.plan_unpurchasable_suppliers(p_org_id uuid, p_plan_id uuid)
returns uuid[] language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct coalesce(sp.id, s.id)), '{}')
  from public.plan_steps s
  left join public.quotes q on q.org_id = s.org_id and q.id = (s.payload->>'quote_id')::uuid
  left join public.purchase_order_lines l on l.org_id = s.org_id and l.id = (s.payload->>'po_line_id')::uuid
  left join public.purchase_orders po on po.org_id = l.org_id and po.id = l.purchase_order_id
  left join public.suppliers sp on sp.org_id = s.org_id and sp.id = coalesce(q.supplier_id, po.supplier_id)
  where s.org_id = p_org_id and s.plan_id = p_plan_id
    and s.kind in ('purchase_bridge', 'amend_delivery_schedule', 'cancel_original_quantity')
    and (sp.id is null or sp.purchasing_status <> 'approved');
$$;

-- Backstop at the ledger: no commitment action can be inserted for a plan that buys from a
-- supplier that is not purchasing-eligible, whichever path approved the plan.
create or replace function private.reject_unpurchasable_commitment()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.plan_id is not null
      and new.kind in ('demo_ledger_amendment', 'manual_export', 'live_business_amendment', 'live_business_transfer')
      and cardinality(private.plan_unpurchasable_suppliers(new.org_id, new.plan_id)) > 0 then
    raise exception using errcode = 'P0422', message = 'supplier_not_purchasable';
  end if;
  return new;
end;
$$;

create trigger actions_supplier_purchasable
  before insert on public.actions
  for each row execute function private.reject_unpurchasable_commitment();

-- ---------------------------------------------------------------- approval modes
alter table public.approvals
  add column approval_mode text not null default 'owner' check (approval_mode in ('owner', 'delegated')),
  add column delegated_policy_version_id uuid,
  add column delegation_basis jsonb,
  add constraint approvals_delegated_policy_fk
    foreign key (delegated_policy_version_id, org_id) references public.policies(id, org_id),
  add constraint approvals_delegated_basis check (
    approval_mode = 'owner'
    or (delegated_policy_version_id is not null and delegation_basis is not null)
  );
create index approvals_delegated_by_day on public.approvals (org_id, created_at)
  where approval_mode = 'delegated';

-- Owner approval path unchanged from F5 except that a plan buying from a supplier that is not
-- purchasing-eligible cannot be approved.
create or replace function public.approve_plan(
  p_org_id uuid, p_plan_id uuid, p_actor_user_id uuid, p_plan_version integer,
  p_input_fingerprint text, p_approved_ceiling_minor bigint, p_expected_version integer,
  p_idempotency_key text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_plan record;
  v_existing record;
  v_current_fp text;
  v_validity integer;
  v_expires timestamptz;
  v_id uuid;
  v_currency text;
begin
  select * into v_existing from public.approvals where org_id = p_org_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.plan_id = p_plan_id and v_existing.plan_version = p_plan_version
        and v_existing.input_fingerprint = p_input_fingerprint
        and v_existing.approved_ceiling_minor = p_approved_ceiling_minor
        and v_existing.approving_user_id = p_actor_user_id then
      return jsonb_build_object('ok', true, 'replayed', true, 'approval_id', v_existing.id,
        'expires_at', v_existing.expires_at, 'status', v_existing.status);
    end if;
    return private.result_error('idempotency_conflict', 'Idempotency key was used for different approval terms');
  end if;
  -- Authority is re-derived from the database; client-asserted roles are never trusted.
  if private.member_role(p_org_id, p_actor_user_id) is distinct from 'owner' then
    return private.result_error('forbidden', 'Only an owner can approve financial commitments');
  end if;
  select * into v_plan from public.recovery_plans where id = p_plan_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Plan not found'); end if;
  perform 1 from public.cases where id = v_plan.case_id and org_id = p_org_id for update;
  if v_plan.row_version <> p_expected_version or v_plan.version <> p_plan_version then
    return private.result_error('stale_version', 'Plan changed since it was reviewed',
      jsonb_build_object('current_version', v_plan.row_version));
  end if;
  if v_plan.status <> 'ready' then
    return private.result_error('invalid_state', 'Plan is not ready for approval',
      jsonb_build_object('status', v_plan.status));
  end if;
  if cardinality(private.plan_unpurchasable_suppliers(p_org_id, p_plan_id)) > 0 then
    return private.result_error('supplier_not_purchasable',
      'A supplier in this plan is not approved for purchasing; complete supplier onboarding first',
      jsonb_build_object('supplier_ids', to_jsonb(private.plan_unpurchasable_suppliers(p_org_id, p_plan_id))));
  end if;
  v_current_fp := public.plan_material_fingerprint(p_org_id, p_plan_id);
  if p_input_fingerprint <> v_plan.input_fingerprint or v_current_fp <> v_plan.input_fingerprint then
    return private.result_error('stale_fingerprint', 'Material inputs changed; review the updated plan');
  end if;
  if p_approved_ceiling_minor < coalesce(v_plan.gross_commitment_minor, 0) then
    return private.result_error('ceiling_too_low', 'Approved ceiling is below the plan commitment');
  end if;
  if v_plan.expires_at is not null and v_plan.expires_at <= p_now then
    return private.result_error('plan_expired', 'Quote terms or ordering cutoff expired');
  end if;
  select (private.policy_setting(settings, '{approval,validity_seconds}', '1800'))::integer
    into v_validity from private.current_policy(p_org_id);
  v_validity := least(coalesce(v_validity, 1800), 1800);
  v_expires := least(p_now + make_interval(secs => v_validity), coalesce(v_plan.expires_at, 'infinity'));
  select currency into v_currency from public.organizations where id = p_org_id;

  insert into public.approvals (org_id, plan_id, plan_version, approving_user_id, authority_role,
    input_fingerprint, approved_ceiling_minor, currency, expires_at, status, idempotency_key, created_at,
    approval_mode)
  values (p_org_id, p_plan_id, p_plan_version, p_actor_user_id, 'owner', v_plan.input_fingerprint,
    p_approved_ceiling_minor, v_currency, v_expires, 'active', p_idempotency_key, p_now, 'owner')
  returning id into v_id;
  update public.recovery_plans set status = 'approved', row_version = row_version + 1, updated_at = p_now
  where id = p_plan_id;
  update public.cases set phase = 'executing', updated_at = p_now, row_version = row_version + 1
  where id = v_plan.case_id and org_id = p_org_id;
  perform private.audit(p_org_id, 'user', p_actor_user_id::text, v_plan.case_id, 'approval', v_id,
    'plan.approved', v_plan.row_version, v_plan.row_version + 1, null, p_now);
  perform public.outbox_enqueue(p_org_id, 'plan.approved', v_plan.case_id,
    jsonb_build_object('case_id', v_plan.case_id, 'plan_id', p_plan_id, 'approval_id', v_id), null, null, p_now);
  return jsonb_build_object('ok', true, 'approval_id', v_id, 'expires_at', v_expires, 'status', 'active');
end;
$$;

-- plan_get exposes how each approval was granted so the owner and operators can see the label.
create or replace function public.plan_get(p_org_id uuid, p_plan_id uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select case when p.id is null then private.result_error('not_found', 'Plan not found') else
    jsonb_build_object('ok', true, 'plan', jsonb_build_object('id', p.id, 'case_id', p.case_id,
      'version', p.version, 'status', p.status, 'row_version', p.row_version,
      'input_fingerprint', p.input_fingerprint, 'gross_commitment_minor', p.gross_commitment_minor::text,
      'incremental_cost_minor', p.incremental_cost_minor::text, 'expires_at', p.expires_at,
      'currency', (select currency from public.organizations where id = p_org_id),
      'mode', (select environment_mode from public.organizations where id = p_org_id),
      'steps', (select coalesce(jsonb_agg(jsonb_build_object('step_id', s.step_id, 'kind', s.kind,
          'item_id', s.item_id, 'quantity', s.quantity, 'unit', s.unit,
          'destination_location_id', s.destination_location_id, 'depends_on_step_ids', s.depends_on_step_ids,
          'execution_mode', s.execution_mode, 'payload', s.payload, 'missing_fields', s.missing_fields)
          order by s.step_id), '[]') from public.plan_steps s where s.plan_id = p.id and s.org_id = p_org_id),
      'approvals', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'status', a.status,
          'expires_at', a.expires_at, 'consumed_by_action_id', a.consumed_by_action_id,
          'approval_mode', a.approval_mode) order by a.created_at), '[]')
        from public.approvals a where a.plan_id = p.id and a.org_id = p_org_id),
      'actions', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'state', x.state,
          'plan_step_id', x.plan_step_id, 'error_code', x.error_code) order by x.created_at), '[]')
        from public.actions x where x.plan_id = p.id and x.org_id = p_org_id)))
  end
  from (select 1) one left join public.recovery_plans p on p.id = p_plan_id and p.org_id = p_org_id;
$$;

-- ---------------------------------------------------------------- policy validation
-- Server-side check of the settings that carry authority. Everything else keeps its F5 behaviour.
create or replace function private.validate_policy_settings(p_org_id uuid, p_settings jsonb)
returns text language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_cfg jsonb;
  v_currency text;
  v_day jsonb;
  v_allow jsonb;
  v_max jsonb;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    return 'Policy settings must be an object';
  end if;
  if p_settings ? 'commitment_authority' and p_settings->>'commitment_authority' is distinct from 'owner' then
    return 'commitment_authority must remain owner';
  end if;
  if (p_settings #>> '{budgets,autonomous_commitment_minor}') is not null
      and (p_settings #>> '{budgets,autonomous_commitment_minor}') <> '0' then
    return 'autonomous_commitment_minor must remain 0; use delegated_purchasing for a bounded delegation';
  end if;
  v_cfg := p_settings -> 'delegated_purchasing';
  if v_cfg is null then return null; end if;
  if jsonb_typeof(v_cfg) <> 'object' then return 'delegated_purchasing must be an object'; end if;
  if v_cfg ? 'enabled' and jsonb_typeof(v_cfg->'enabled') <> 'boolean' then
    return 'delegated_purchasing.enabled must be a boolean';
  end if;
  if coalesce((v_cfg->>'enabled')::boolean, false) is not true then return null; end if;

  if coalesce(v_cfg->>'ceiling_minor', '') !~ '^[1-9][0-9]{0,14}$' then
    return 'Delegated purchasing needs a positive ceiling in minor units';
  end if;
  select currency into v_currency from public.organizations where id = p_org_id;
  if v_cfg->>'currency' is distinct from v_currency then
    return 'Delegated purchasing currency must match the business currency (' || coalesce(v_currency, '?') || ')';
  end if;
  v_allow := coalesce(v_cfg->'supplier_allowlist', '[]'::jsonb);
  if jsonb_typeof(v_allow) <> 'array' then return 'supplier_allowlist must be a list'; end if;
  if exists (select 1 from jsonb_array_elements(v_allow) e where jsonb_typeof(e) <> 'string'
      or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return 'supplier_allowlist must contain supplier ids';
  end if;
  if (select count(distinct e #>> '{}') from jsonb_array_elements(v_allow) e)
      <> (select count(*) from public.suppliers s
          where s.org_id = p_org_id and s.id::text in (select lower(e #>> '{}') from jsonb_array_elements(v_allow) e)) then
    return 'supplier_allowlist names a supplier that does not exist in this organization';
  end if;
  if v_cfg ? 'hours' then
    if jsonb_typeof(v_cfg->'hours') <> 'object' then return 'hours must be an object'; end if;
    if (v_cfg #> '{hours,start}') is not null and (v_cfg #>> '{hours,start}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      return 'hours.start must be HH:MM';
    end if;
    if (v_cfg #> '{hours,end}') is not null and (v_cfg #>> '{hours,end}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      return 'hours.end must be HH:MM';
    end if;
    if coalesce(v_cfg #>> '{hours,start}', '09:00') >= coalesce(v_cfg #>> '{hours,end}', '17:00') then
      return 'hours.start must be before hours.end';
    end if;
    if (v_cfg #> '{hours,weekdays}') is not null then
      if jsonb_typeof(v_cfg #> '{hours,weekdays}') <> 'array' or jsonb_array_length(v_cfg #> '{hours,weekdays}') = 0 then
        return 'hours.weekdays must list at least one weekday';
      end if;
      for v_day in select * from jsonb_array_elements(v_cfg #> '{hours,weekdays}') loop
        if jsonb_typeof(v_day) <> 'number' or (v_day #>> '{}') !~ '^[1-7]$' then
          return 'hours.weekdays must be ISO weekdays 1-7';
        end if;
      end loop;
    end if;
  end if;
  v_max := v_cfg -> 'max_auto_approvals_per_day';
  if v_max is not null and (jsonb_typeof(v_max) <> 'number' or (v_max #>> '{}') !~ '^([1-9]|1[0-9]|20)$') then
    return 'max_auto_approvals_per_day must be between 1 and 20';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------- revoking delegated commitments
-- Revokes active delegated approvals and cancels prepared (not yet dispatching) actions they
-- authorized. Work already dispatched cannot be retracted and is left untouched.
create or replace function private.revoke_delegated_commitments(p_org_id uuid, p_reason text, p_now timestamptz)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare
  r record;
  v_count integer := 0;
  v_state public.action_state;
begin
  for r in
    select a.id as approval_id, a.plan_id, a.status as approval_status, a.consumed_by_action_id,
           p.case_id, act.id as action_id, act.row_version as action_version
    from public.approvals a
    join public.recovery_plans p on p.id = a.plan_id and p.org_id = a.org_id
    left join public.actions act on act.id = a.consumed_by_action_id and act.org_id = a.org_id
    where a.org_id = p_org_id and a.approval_mode = 'delegated'
      and (a.status = 'active' or (a.status = 'consumed' and act.state = 'prepared'))
    order by a.created_at
    for update of a
  loop
    if r.approval_status = 'active' then
      update public.approvals set status = 'revoked' where id = r.approval_id;
    else
      select state into v_state from public.actions where id = r.action_id for update;
      if v_state is distinct from 'prepared' then continue; end if;
      update public.actions set state = 'cancelled', error_code = 'delegation_disabled', updated_at = p_now,
        row_version = row_version + 1 where id = r.action_id and state = 'prepared';
      update public.approvals set status = 'revoked' where id = r.approval_id;
      perform private.release_claims(p_org_id, r.action_id, 'released', p_now);
      perform private.audit(p_org_id, 'system', 'delegation', r.case_id, 'action', r.action_id,
        'action.cancelled', r.action_version, r.action_version + 1, 'delegated purchasing disabled: ' || p_reason, p_now);
    end if;
    update public.recovery_plans set status = 'expired', row_version = row_version + 1, updated_at = p_now
    where id = r.plan_id and org_id = p_org_id and status in ('approved', 'executing');
    update public.cases set phase = 'recovering', updated_at = p_now, row_version = row_version + 1
    where id = r.case_id and org_id = p_org_id and phase in ('executing', 'awaiting_approval');
    perform public.outbox_enqueue(p_org_id, 'case.recovery.requested', r.case_id,
      jsonb_build_object('case_id', r.case_id, 'assessment_version', 0), null, null, p_now);
    perform private.audit(p_org_id, 'system', 'delegation', r.case_id, 'approval', r.approval_id,
      'approval.delegated_revoked', null, null, p_reason, p_now);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.policy_create_version(
  p_org_id uuid, p_actor_user_id uuid, p_expected_version integer, p_settings jsonb,
  p_reason text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_current integer;
  v_id uuid;
  v_invalid text;
  v_revoked integer := 0;
begin
  if private.member_role(p_org_id, p_actor_user_id) is distinct from 'owner' then
    return private.result_error('forbidden', 'Only an owner can change policy');
  end if;
  perform 1 from public.organizations where id = p_org_id for update;
  select coalesce(max(version), 0) into v_current from public.policies where org_id = p_org_id;
  if v_current <> p_expected_version then
    return private.result_error('stale_version', 'Policy changed since it was loaded',
      jsonb_build_object('current_version', v_current));
  end if;
  if coalesce(trim(p_reason), '') = '' then
    return private.result_error('validation_failed', 'A reason is required');
  end if;
  v_invalid := private.validate_policy_settings(p_org_id, p_settings);
  if v_invalid is not null then
    return private.result_error('validation_failed', v_invalid);
  end if;
  insert into public.policies (org_id, version, settings, author_user_id, reason, effective_at, created_at)
  values (p_org_id, v_current + 1, p_settings, p_actor_user_id, p_reason, p_now, p_now)
  returning id into v_id;
  update public.organizations
    set current_policy_version_id = v_id, row_version = row_version + 1, updated_at = p_now
    where id = p_org_id;
  perform private.audit(p_org_id, 'user', p_actor_user_id::text, null, 'policy', v_id,
    'policy.version_created', v_current, v_current + 1, p_reason, p_now);
  -- Any new policy invalidates the snapshot that authorized outstanding delegated work.
  v_revoked := private.revoke_delegated_commitments(p_org_id, 'policy version ' || (v_current + 1) || ': ' || p_reason, p_now);
  perform public.outbox_enqueue(p_org_id, 'policy.changed', v_id,
    jsonb_build_object('policy_version_id', v_id), null, null, p_now);
  return jsonb_build_object('ok', true, 'policy_version_id', v_id, 'version', v_current + 1,
    'delegated_commitments_revoked', v_revoked);
end;
$$;

-- One call that turns delegation off for good measure: new policy version with the delegation
-- disabled, outstanding delegated approvals revoked, prepared actions cancelled. Owner only.
create or replace function public.delegation_kill_switch(
  p_org_id uuid, p_actor_user_id uuid, p_reason text, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_policy record;
  v_current integer;
  v_result jsonb;
  v_revoked integer;
begin
  if private.member_role(p_org_id, p_actor_user_id) is distinct from 'owner' then
    return private.result_error('forbidden', 'Only an owner can disable delegated purchasing');
  end if;
  if coalesce(trim(p_reason), '') = '' then
    return private.result_error('validation_failed', 'A reason is required');
  end if;
  perform 1 from public.organizations where id = p_org_id for update;
  select * into v_policy from private.current_policy(p_org_id);
  select coalesce(max(version), 0) into v_current from public.policies where org_id = p_org_id;
  if coalesce((v_policy.settings #>> '{delegated_purchasing,enabled}')::boolean, false) is true then
    v_result := public.policy_create_version(
      p_org_id, p_actor_user_id, v_current,
      jsonb_set(v_policy.settings, '{delegated_purchasing,enabled}', 'false'::jsonb),
      'Delegated purchasing disabled (kill switch): ' || trim(p_reason), p_now);
    if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
    v_revoked := (v_result->>'delegated_commitments_revoked')::integer;
  else
    v_revoked := private.revoke_delegated_commitments(p_org_id, 'kill switch: ' || trim(p_reason), p_now);
  end if;
  perform private.audit(p_org_id, 'user', p_actor_user_id::text, null, 'policy',
    v_policy.policy_id, 'delegation.kill_switch', null, null, trim(p_reason), p_now);
  return jsonb_build_object('ok', true, 'delegated_commitments_revoked', v_revoked,
    'version', coalesce((v_result->>'version')::integer, v_current));
end;
$$;

-- ---------------------------------------------------------------- delegated approval
-- Evaluated for a plan that has just become ready. Returns ok with an approval, or a
-- delegation_not_permitted failure listing every reason; the plan then simply waits for the owner.
-- All limits are re-derived here from the current policy, never taken from the caller.
create or replace function public.approve_plan_delegated(
  p_org_id uuid, p_plan_id uuid, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_policy record;
  v_cfg jsonb;
  v_org record;
  v_plan record;
  v_case record;
  v_denials text[] := '{}';
  v_ceiling bigint;
  v_gross bigint;
  v_suppliers uuid[];
  v_allow uuid[];
  v_local timestamp;
  v_day_start timestamptz;
  v_max integer;
  v_today integer;
  v_start time;
  v_end time;
  v_days jsonb;
  v_validity integer;
  v_expires timestamptz;
  v_delegator uuid;
  v_id uuid;
  v_key text;
  v_existing record;
  v_basis jsonb;
begin
  -- Serialize with policy changes, the kill switch, and other delegated approvals (daily budget).
  perform 1 from public.organizations where id = p_org_id for update;
  select * into v_policy from private.current_policy(p_org_id);
  v_cfg := v_policy.settings -> 'delegated_purchasing';
  if coalesce((v_cfg->>'enabled')::boolean, false) is not true then
    return private.result_error('delegation_disabled', 'Delegated purchasing is not enabled');
  end if;
  select * into v_org from public.organizations where id = p_org_id;
  select * into v_plan from public.recovery_plans where id = p_plan_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Plan not found'); end if;
  select * into v_case from public.cases where id = v_plan.case_id and org_id = p_org_id for update;

  v_key := 'delegated:' || p_plan_id::text || ':v' || v_plan.version::text;
  select * into v_existing from public.approvals where org_id = p_org_id and idempotency_key = v_key;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'approval_id', v_existing.id,
      'expires_at', v_existing.expires_at, 'status', v_existing.status);
  end if;
  if v_plan.status <> 'ready' then
    return private.result_error('invalid_state', 'Plan is not ready for approval',
      jsonb_build_object('status', v_plan.status));
  end if;

  v_ceiling := (v_cfg->>'ceiling_minor')::bigint;
  v_gross := v_plan.gross_commitment_minor;
  v_max := coalesce((v_cfg->>'max_auto_approvals_per_day')::integer, 3);
  v_start := coalesce(v_cfg #>> '{hours,start}', '09:00')::time;
  v_end := coalesce(v_cfg #>> '{hours,end}', '17:00')::time;
  v_days := coalesce(v_cfg #> '{hours,weekdays}', '[1,2,3,4,5]'::jsonb);
  v_allow := array(select (e #>> '{}')::uuid from jsonb_array_elements(coalesce(v_cfg->'supplier_allowlist', '[]')) e);

  if coalesce((v_policy.settings->>'dispatch_paused')::boolean, false) then
    v_denials := v_denials || 'dispatch_paused'::text;
  end if;
  if v_case.run_control <> 'active' or v_case.phase = 'closed' then
    v_denials := v_denials || 'case_not_active'::text;
  end if;
  if not exists (select 1 from public.plan_steps s where s.plan_id = p_plan_id and s.org_id = p_org_id)
      or exists (select 1 from public.plan_steps s where s.plan_id = p_plan_id and s.org_id = p_org_id
        and s.kind <> 'purchase_bridge') then
    v_denials := v_denials || 'step_kind_not_delegable'::text;
  end if;
  if v_gross is null then
    v_denials := v_denials || 'amount_unknown'::text;
  elsif v_gross < 0 or v_gross > v_ceiling then
    v_denials := v_denials || 'over_ceiling'::text;
  end if;
  -- Do not trust a planner's ready label or amount: every bridge must match verified DB terms.
  if exists (
    select 1 from public.plan_steps s
    left join public.quotes q on q.org_id = s.org_id and q.id = (s.payload->>'quote_id')::uuid
    where s.org_id = p_org_id and s.plan_id = p_plan_id and (
      q.id is null or q.case_id <> v_plan.case_id or q.status <> 'verified'
      or q.item_id <> v_case.item_id or q.destination_location_id is distinct from v_case.location_id
      or q.quantity is distinct from s.quantity or q.unit is distinct from s.unit
      or q.unit_price_minor is null or q.freight_minor is null or q.fees_minor is null
      or q.nonrecoverable_tax_minor is null or q.arrival_end is null
      or q.valid_until is null or q.valid_until <= p_now or q.latest_order_at <= p_now
    )
  ) or v_gross is distinct from (
    select sum(q.quantity::bigint * q.unit_price_minor + q.freight_minor + q.fees_minor + q.nonrecoverable_tax_minor)
    from public.plan_steps s join public.quotes q on q.org_id = s.org_id and q.id = (s.payload->>'quote_id')::uuid
    where s.org_id = p_org_id and s.plan_id = p_plan_id
  ) then
    v_denials := v_denials || 'unverified_purchase_terms'::text;
  end if;
  if v_cfg->>'currency' is distinct from v_org.currency or exists (
    select 1 from public.plan_steps s join public.quotes q on q.org_id = s.org_id and q.id = (s.payload->>'quote_id')::uuid
    where s.plan_id = p_plan_id and s.org_id = p_org_id and s.payload ? 'quote_id'
      and q.currency is distinct from v_cfg->>'currency'
  ) then
    v_denials := v_denials || 'currency_mismatch'::text;
  end if;
  v_suppliers := array(
    select distinct q.supplier_id from public.plan_steps s
    join public.quotes q on q.org_id = s.org_id and q.id = (s.payload->>'quote_id')::uuid
    where s.plan_id = p_plan_id and s.org_id = p_org_id and s.kind = 'purchase_bridge');
  if cardinality(v_suppliers) = 0 or cardinality(private.plan_unpurchasable_suppliers(p_org_id, p_plan_id)) > 0 then
    v_denials := v_denials || 'supplier_not_purchasable'::text;
  end if;
  if cardinality(v_allow) > 0 and exists (select 1 from unnest(v_suppliers) sid where sid <> all(v_allow)) then
    v_denials := v_denials || 'supplier_not_allowlisted'::text;
  end if;
  if v_org.timezone is null or not exists (select 1 from pg_timezone_names where name = v_org.timezone) then
    v_denials := v_denials || 'outside_delegated_hours'::text;
  else
    v_local := p_now at time zone v_org.timezone;
    if not (v_days @> to_jsonb(extract(isodow from v_local)::integer)
        and v_local::time >= v_start and v_local::time < v_end) then
      v_denials := v_denials || 'outside_delegated_hours'::text;
    end if;
    v_day_start := date_trunc('day', v_local) at time zone v_org.timezone;
    select count(*) into v_today from public.approvals a
    where a.org_id = p_org_id and a.approval_mode = 'delegated' and a.created_at >= v_day_start;
    if v_today >= v_max then
      v_denials := v_denials || 'daily_limit_reached'::text;
    end if;
  end if;
  v_delegator := (select p.author_user_id from public.policies p where p.id = v_policy.policy_id);
  if v_delegator is null or private.member_role(p_org_id, v_delegator) is distinct from 'owner' then
    v_denials := v_denials || 'delegator_not_owner'::text;
  end if;
  if v_plan.expires_at is not null and v_plan.expires_at <= p_now then
    v_denials := v_denials || 'plan_expired'::text;
  end if;
  if public.plan_material_fingerprint(p_org_id, p_plan_id) is distinct from v_plan.input_fingerprint then
    v_denials := v_denials || 'stale_fingerprint'::text;
  end if;

  if cardinality(v_denials) > 0 then
    perform private.audit(p_org_id, 'delegated_policy', v_policy.policy_id::text, v_plan.case_id, 'recovery_plan',
      p_plan_id, 'plan.delegated_approval_declined', null, null,
      'Owner approval required: ' || array_to_string(v_denials, ', '), p_now);
    return private.result_error('delegation_not_permitted',
      'Delegated purchasing does not cover this plan; an owner must approve it',
      jsonb_build_object('denials', to_jsonb(v_denials)));
  end if;

  select (private.policy_setting(settings, '{approval,validity_seconds}', '1800'))::integer
    into v_validity from private.current_policy(p_org_id);
  v_validity := least(coalesce(v_validity, 1800), 1800);
  v_expires := least(p_now + make_interval(secs => v_validity), coalesce(v_plan.expires_at, 'infinity'));
  v_basis := jsonb_build_object(
    'policy_version', v_policy.version,
    'ceiling_minor', v_ceiling::text,
    'currency', v_cfg->>'currency',
    'plan_gross_minor', v_gross::text,
    'supplier_ids', to_jsonb(v_suppliers),
    'supplier_allowlist', to_jsonb(v_allow),
    'hours', jsonb_build_object('timezone', v_org.timezone, 'weekdays', v_days,
      'start', to_char(v_start, 'HH24:MI'), 'end', to_char(v_end, 'HH24:MI')),
    'max_auto_approvals_per_day', v_max,
    'delegated_by_user_id', v_delegator);

  -- The approval authorizes exactly this plan's gross commitment, never the wider ceiling.
  insert into public.approvals (org_id, plan_id, plan_version, approving_user_id, authority_role,
    input_fingerprint, approved_ceiling_minor, currency, expires_at, status, idempotency_key, created_at,
    approval_mode, delegated_policy_version_id, delegation_basis)
  values (p_org_id, p_plan_id, v_plan.version, v_delegator, 'owner', v_plan.input_fingerprint,
    v_gross, v_org.currency, v_expires, 'active', v_key, p_now,
    'delegated', v_policy.policy_id, v_basis)
  returning id into v_id;
  update public.recovery_plans set status = 'approved', row_version = row_version + 1, updated_at = p_now
  where id = p_plan_id;
  update public.cases set phase = 'executing', updated_at = p_now, row_version = row_version + 1
  where id = v_plan.case_id and org_id = p_org_id;
  perform private.audit(p_org_id, 'delegated_policy', v_policy.policy_id::text, v_plan.case_id, 'approval', v_id,
    'plan.approved.delegated', v_plan.row_version, v_plan.row_version + 1,
    format('Delegated purchasing (policy v%s): %s %s within ceiling %s, delegated by owner %s',
      v_policy.version, v_gross, v_cfg->>'currency', v_ceiling, v_delegator), p_now);
  perform public.outbox_enqueue(p_org_id, 'plan.approved', v_plan.case_id,
    jsonb_build_object('case_id', v_plan.case_id, 'plan_id', p_plan_id, 'approval_id', v_id), null, null, p_now);
  return jsonb_build_object('ok', true, 'approval_id', v_id, 'expires_at', v_expires, 'status', 'active',
    'approval_mode', 'delegated');
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.approve_plan(uuid, uuid, uuid, integer, text, bigint, integer, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.approve_plan(uuid, uuid, uuid, integer, text, bigint, integer, text, timestamptz)
  to service_role;
revoke all on function public.plan_get(uuid, uuid) from public, anon, authenticated;
grant execute on function public.plan_get(uuid, uuid) to service_role;
revoke all on function public.policy_create_version(uuid, uuid, integer, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.policy_create_version(uuid, uuid, integer, jsonb, text, timestamptz)
  to service_role;
revoke all on function public.delegation_kill_switch(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.delegation_kill_switch(uuid, uuid, text, timestamptz) to service_role;
revoke all on function public.approve_plan_delegated(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.approve_plan_delegated(uuid, uuid, timestamptz) to service_role;
grant execute on all functions in schema private to service_role;

-- Planner writes steps before finalization. Capture their material snapshot and try the same
-- delegated gate used by API-created plans; denials leave a ready plan waiting for its owner.
create or replace function public.plan_finalize(p_org_id uuid, p_plan_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_plan public.recovery_plans%rowtype;
  v_result jsonb;
begin
  perform 1 from public.organizations where id = p_org_id for update;
  select * into v_plan from public.recovery_plans where id = p_plan_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Plan not found'); end if;
  perform 1 from public.cases where id = v_plan.case_id and org_id = p_org_id for update;
  if v_plan.status = 'ready' then
    if v_plan.input_fingerprint = '' then
      update public.recovery_plans set
        input_fingerprint = public.plan_material_fingerprint(p_org_id, p_plan_id),
        policy_version_id = (select current_policy_version_id from public.organizations where id = p_org_id),
        expires_at = (select min(least(q.valid_until, coalesce(q.latest_order_at, q.valid_until)))
          from public.plan_steps s join public.quotes q on q.org_id = s.org_id and q.id = (s.payload->>'quote_id')::uuid
          where s.org_id = p_org_id and s.plan_id = p_plan_id)
      where id = p_plan_id;
    end if;
    v_result := public.approve_plan_delegated(p_org_id, p_plan_id, p_now);
    if not coalesce((v_result->>'ok')::boolean, false) then
      update public.cases set phase = 'awaiting_approval', updated_at = p_now, row_version = row_version + 1
      where id = v_plan.case_id and org_id = p_org_id and run_control = 'active' and phase <> 'closed';
    end if;
  end if;
  select * into v_plan from public.recovery_plans where id = p_plan_id and org_id = p_org_id;
  return jsonb_build_object('ok', true, 'plan', to_jsonb(v_plan));
end;
$$;
revoke all on function public.plan_finalize(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.plan_finalize(uuid, uuid, timestamptz) to service_role;

-- Recheck supplier eligibility at dispatch, serialized with the delegation kill switch.
create or replace function public.ledger_claim_dispatch(
  p_org_id uuid, p_action_id uuid, p_lease_seconds integer default 300, p_now timestamptz default now()
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_action record;
  v_case record;
  v_settings jsonb;
  v_denials text[];
  v_approval record;
begin
  perform 1 from public.organizations where id = p_org_id for update;
  select * into v_action from public.actions where id = p_action_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Action not found'); end if;
  if v_action.state <> 'prepared' then
    return private.result_error('not_claimable', 'Action is not prepared',
      jsonb_build_object('action', private.action_json(p_org_id, p_action_id)));
  end if;
  if v_action.plan_id is not null and cardinality(private.plan_unpurchasable_suppliers(p_org_id, v_action.plan_id)) > 0 then
    update public.actions set state = 'cancelled', error_code = 'supplier_not_purchasable', updated_at = p_now,
      row_version = row_version + 1 where id = p_action_id;
    perform private.release_claims(p_org_id, p_action_id, 'released', p_now);
    return private.result_error('supplier_not_purchasable', 'Supplier purchasing approval was revoked before dispatch');
  end if;
  select * into v_case from public.cases where id = v_action.case_id and org_id = p_org_id;
  -- Preserve mailbox-aware claim rules from 20261108130000_outlook_multi_mailbox.sql:
  -- require the named mailbox (or any healthy mailbox when unset), not "any Gmail".
  if v_action.kind = 'supplier_email'
    and v_action.mode <> 'replay'
    and not exists (
    select 1
    from public.connections c
    where c.org_id = p_org_id
      and c.provider = any(private.mailbox_providers())
      and c.status in ('healthy', 'degraded')
      and (
        nullif(v_action.payload->>'connection_id', '') is null
        or c.id = (v_action.payload->>'connection_id')::uuid
      )
  ) then
    return private.result_error(
      'failed_precondition',
      'Mailbox connection is unavailable',
      jsonb_build_object('reason', 'connection_unavailable')
    );
  end if;
  if v_action.kind in ('live_business_amendment', 'live_business_transfer') and not exists (
    select 1 from public.connections c
    where c.org_id = p_org_id and c.id = (v_action.payload->'erp'->>'connection_id')::uuid
      and c.status in ('healthy', 'degraded')
  ) then
    return private.result_error('failed_precondition', 'Business system connection is unavailable',
      jsonb_build_object('reason', 'connection_unavailable'));
  end if;
  if v_action.permitted_by is not null and not exists (
    select 1
    from public.memberships m
    where m.org_id = p_org_id
      and m.auth_user_id = v_action.permitted_by
      and m.active
  ) then
    return private.result_error(
      'failed_precondition',
      'The action preparer is no longer an active organization member',
      jsonb_build_object('reason', 'preparer_revoked')
    );
  end if;
  select settings into v_settings from private.current_policy(p_org_id);
  if (private.policy_setting(coalesce(v_settings, '{}'), '{dispatch_paused}', 'false'))::boolean then
    return private.result_error('dispatch_paused', 'Dispatch is paused by organization policy');
  end if;
  if v_case.run_control <> 'active' then
    return private.result_error('case_not_active', 'Case is paused or blocked',
      jsonb_build_object('run_control', v_case.run_control));
  end if;
  if v_action.mode <> (select environment_mode from public.organizations where id = p_org_id) then
    update public.actions set state = 'cancelled', error_code = 'mode_changed', updated_at = p_now,
      row_version = row_version + 1 where id = p_action_id;
    perform private.release_claims(p_org_id, p_action_id, 'released', p_now);
    return private.result_error('mode_changed', 'Organization mode changed after preparation');
  end if;
  if v_action.kind in ('supplier_email', 'supplier_call') then
    v_denials := private.outreach_denials(p_org_id, v_action.case_id, v_action.contact_id,
      case v_action.kind when 'supplier_email' then 'email' else 'phone' end, p_now, false);
    if cardinality(v_denials) > 0 then
      return private.result_error('policy_denied', 'Outreach is not currently permitted',
        jsonb_build_object('denials', to_jsonb(v_denials)));
    end if;
  else
    select * into v_approval from public.approvals where id = v_action.approval_id and org_id = p_org_id for update;
    if v_approval.expires_at <= p_now then
      update public.actions set state = 'cancelled', error_code = 'approval_expired', updated_at = p_now,
        row_version = row_version + 1 where id = p_action_id;
      perform private.release_claims(p_org_id, p_action_id, 'released', p_now);
      update public.approvals set status = 'expired' where id = v_approval.id;
      update public.recovery_plans set status = 'ready', row_version = row_version + 1, updated_at = p_now
      where id = v_action.plan_id and org_id = p_org_id;
      update public.cases set phase = 'awaiting_approval', updated_at = p_now, row_version = row_version + 1
      where id = v_action.case_id and org_id = p_org_id;
      perform private.audit(p_org_id, 'system', 'dispatcher', v_action.case_id, 'action', p_action_id,
        'action.cancelled', v_action.row_version, v_action.row_version + 1, 'approval expired before dispatch', p_now);
      perform public.outbox_enqueue(p_org_id, 'action.outcome.recorded', p_action_id,
        jsonb_build_object('action_id', p_action_id, 'outcome_version', v_action.row_version + 1), null, null, p_now);
      return private.result_error('approval_expired', 'Approval expired before dispatch; renewal required');
    end if;
  end if;
  update public.actions set state = 'dispatching', dispatch_started_at = p_now, attempts = attempts + 1,
    next_reconcile_at = p_now + make_interval(secs => p_lease_seconds), updated_at = p_now,
    row_version = row_version + 1
  where id = p_action_id;
  perform private.audit(p_org_id, 'system', 'dispatcher', v_action.case_id, 'action', p_action_id,
    'action.dispatching', v_action.row_version, v_action.row_version + 1, null, p_now);
  return jsonb_build_object('ok', true, 'action', private.action_json(p_org_id, p_action_id));
end;
$$;
