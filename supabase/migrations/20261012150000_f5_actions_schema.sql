-- F5: approval, action ledger, outbox consumers, demo ledger and receipts.

alter table public.actions
  add column episode integer,
  add column contact_id uuid,
  add column approval_id uuid,
  add column plan_step_id text,
  add constraint actions_contact_fk
    foreign key (contact_id, org_id) references public.supplier_contacts(id, org_id),
  add constraint actions_approval_fk
    foreign key (approval_id, org_id) references public.approvals(id, org_id);

-- Two approvals (or two workers) for one plan can never produce two live commitment actions.
create unique index actions_one_live_commitment_per_plan
  on public.actions(org_id, plan_id)
  where plan_id is not null
    and kind in ('demo_ledger_amendment', 'manual_export')
    and state not in ('cancelled', 'failed');

create index actions_reconcile_due
  on public.actions(next_reconcile_at)
  where state in ('dispatching', 'submitted', 'unknown');

create index actions_case_episode on public.actions(org_id, case_id, episode);

create index allocation_claims_group
  on public.allocation_claims(org_id, item_id, location_id)
  where state in ('active', 'uncertain');

alter table public.allocation_claims
  add column action_id uuid,
  add constraint allocation_claims_action_fk
    foreign key (action_id, org_id) references public.actions(id, org_id);

-- Receiving events without a source connection (CSV / demo ledger) still need a stable source id.
create unique index receiving_events_unconnected_source
  on public.receiving_events(org_id, external_receipt_id)
  where source_connection_id is null and external_receipt_id is not null;

create index event_outbox_unpublished
  on public.event_outbox(created_at)
  where published_at is null;

-- DEMO LEDGER: a simulated business system used only for replay/sandbox demonstrations.
create table public.demo_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  change_kind text not null check (change_kind in ('amend_delivery_schedule')),
  po_line_id uuid not null,
  payload_hash text not null,
  payload jsonb not null,
  label text not null default 'DEMO LEDGER - simulated business system, not a live ERP'
    check (label like 'DEMO LEDGER%'),
  applied_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, action_id),
  foreign key (action_id, org_id) references public.actions(id, org_id),
  foreign key (po_line_id, org_id) references public.purchase_order_lines(id, org_id)
);

create table public.outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  contact_id uuid not null,
  channel text not null check (channel in ('email', 'phone')),
  payload jsonb not null,
  payload_hash text not null,
  denial_codes text[] not null default '{}',
  idempotency_key text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, idempotency_key),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (contact_id, org_id) references public.supplier_contacts(id, org_id)
);

create table public.processed_events (
  org_id uuid not null references public.organizations(id) on delete cascade,
  consumer text not null,
  event_id uuid not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, event_id)
);

alter table public.demo_ledger_entries enable row level security;
create policy tenant_member_select on public.demo_ledger_entries
  for select to authenticated using (public.is_member(org_id));
alter table public.outreach_drafts enable row level security;
create policy tenant_member_select on public.outreach_drafts
  for select to authenticated using (public.is_member(org_id, array['owner', 'operator']::public.membership_role[]));
alter table public.processed_events enable row level security;
create policy tenant_member_select on public.processed_events
  for select to authenticated using (public.is_member(org_id));

revoke all on public.demo_ledger_entries, public.outreach_drafts, public.processed_events
  from anon, authenticated;
grant select on public.demo_ledger_entries, public.outreach_drafts, public.processed_events
  to authenticated;
grant all on public.demo_ledger_entries, public.outreach_drafts, public.processed_events
  to service_role;

alter table public.recovery_plans
  add column idempotency_key text,
  add column created_by uuid references auth.users(id),
  add constraint recovery_plans_idempotency unique (org_id, idempotency_key);
