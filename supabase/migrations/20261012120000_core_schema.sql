create type public.environment_mode as enum ('replay', 'sandbox', 'live');
create type public.membership_role as enum ('owner', 'operator', 'viewer');
create type public.case_phase as enum (
  'new', 'needs_review', 'assessing', 'recovering', 'awaiting_supplier',
  'awaiting_approval', 'executing', 'monitoring', 'closed'
);
create type public.run_control as enum ('active', 'paused', 'blocked');
create type public.block_reason as enum (
  'stale_data', 'missing_data', 'connection_unavailable', 'provider_unavailable',
  'budget_exhausted', 'outcome_unknown', 'policy_denied', 'no_feasible_plan',
  'manual_execution_required'
);
create type public.assessment_quality as enum ('sufficient', 'insufficient');
create type public.action_state as enum (
  'prepared', 'dispatching', 'submitted', 'confirmed', 'failed', 'unknown', 'cancelled'
);
create type public.action_kind as enum (
  'supplier_email', 'supplier_call', 'demo_ledger_amendment', 'manual_export'
);
create type public.plan_step_kind as enum (
  'amend_delivery_schedule', 'purchase_bridge', 'transfer_stock', 'cancel_original_quantity'
);
create type public.dataset_status as enum ('staged', 'active', 'superseded', 'invalid');
create type public.promise_state as enum ('confirmed', 'estimated', 'unknown', 'superseded');
create type public.quote_status as enum ('provisional', 'verified', 'expired', 'rejected', 'superseded');
create type public.plan_status as enum (
  'draft', 'ready', 'approved', 'rejected', 'expired', 'superseded',
  'executing', 'executed', 'execution_uncertain', 'failed'
);
create type public.approval_status as enum ('active', 'revoked', 'expired', 'consumed');
create type public.allocation_claim_state as enum ('active', 'consumed', 'released', 'uncertain');

create schema if not exists private;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  environment_mode public.environment_mode not null default 'replay',
  current_policy_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  role public.membership_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (org_id, auth_user_id),
  unique (id, org_id)
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  external_id text,
  timezone text not null,
  destination_address jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, name)
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  sku text not null,
  description text not null,
  base_unit text not null,
  specification jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, sku)
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  external_id text,
  purchasing_status text not null default 'candidate'
    check (purchasing_status in ('candidate', 'approved', 'blocked')),
  approval_actor uuid references auth.users(id),
  approval_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, name)
);

create table public.supplier_contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  supplier_id uuid not null,
  channel text not null check (channel in ('email', 'phone')),
  normalized_address text not null,
  display_name text,
  timezone text,
  permitted_channels text[] not null default '{}',
  outreach_approved_at timestamptz,
  outreach_approved_by uuid references auth.users(id),
  identity_evidence_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, channel, normalized_address),
  foreign key (supplier_id, org_id) references public.suppliers(id, org_id)
);

create table public.supplier_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  supplier_id uuid not null,
  item_id uuid not null,
  supplier_sku text,
  pack_size integer not null default 1 check (pack_size between 1 and 1000000000),
  minimum_qty integer not null default 1 check (minimum_qty between 1 and 1000000000),
  verified_specification_evidence_id uuid,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, supplier_id, item_id),
  foreign key (supplier_id, org_id) references public.suppliers(id, org_id),
  foreign key (item_id, org_id) references public.items(id, org_id)
);

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  external_account_id text,
  status text not null default 'disconnected'
    check (status in ('disconnected', 'configuring', 'healthy', 'degraded', 'expired', 'revoked')),
  scopes text[] not null default '{}',
  capabilities jsonb not null default '{}'::jsonb,
  last_success_at timestamptz,
  last_error_code text,
  sync_cursor text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, provider, external_account_id)
);

create table public.policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  version integer not null check (version > 0),
  settings jsonb not null,
  author_user_id uuid references auth.users(id),
  reason text not null,
  effective_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, version)
);

alter table public.organizations
  add constraint organizations_current_policy_fk
  foreign key (current_policy_version_id, id) references public.policies(id, org_id);

create table public.datasets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_connection_id uuid,
  source_type text not null check (source_type in ('csv', 'connector', 'fixture')),
  schema_version integer not null default 1,
  source_as_of timestamptz not null,
  imported_at timestamptz not null default now(),
  content_hash text not null,
  status public.dataset_status not null default 'staged',
  validation_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  foreign key (source_connection_id, org_id) references public.connections(id, org_id)
);

create table public.import_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  dataset_id uuid,
  status public.dataset_status not null default 'staged',
  content_hash text not null,
  source_as_of timestamptz not null,
  validation_summary jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  foreign key (dataset_id, org_id) references public.datasets(id, org_id)
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  external_id text not null,
  supplier_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'open',
  source_version text,
  dataset_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, external_id),
  foreign key (supplier_id, org_id) references public.suppliers(id, org_id),
  foreign key (dataset_id, org_id) references public.datasets(id, org_id)
);

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null,
  external_line_id text,
  item_id uuid not null,
  destination_location_id uuid not null,
  ordered_qty integer not null check (ordered_qty between 0 and 1000000000),
  received_qty integer not null default 0 check (received_qty between 0 and 1000000000),
  cancelled_qty integer not null default 0 check (cancelled_qty between 0 and 1000000000),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  original_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, purchase_order_id, external_line_id),
  check (received_qty + cancelled_qty <= ordered_qty),
  foreign key (purchase_order_id, org_id) references public.purchase_orders(id, org_id),
  foreign key (item_id, org_id) references public.items(id, org_id),
  foreign key (destination_location_id, org_id) references public.locations(id, org_id)
);

create table public.receipt_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  po_line_id uuid not null,
  quantity_remaining integer not null check (quantity_remaining between 0 and 1000000000),
  earliest_at timestamptz,
  latest_at timestamptz,
  evidence_id uuid,
  promise_state public.promise_state not null default 'unknown',
  supersedes_id uuid,
  source_as_of timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  check (earliest_at is null or latest_at is null or earliest_at <= latest_at),
  foreign key (po_line_id, org_id) references public.purchase_order_lines(id, org_id),
  foreign key (supersedes_id, org_id) references public.receipt_schedules(id, org_id)
);

create table public.inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  dataset_id uuid not null,
  item_id uuid not null,
  location_id uuid not null,
  physical_qty integer not null check (physical_qty between 0 and 1000000000),
  unusable_qty integer not null default 0 check (unusable_qty between 0 and 1000000000),
  outside_allocations_qty integer not null default 0 check (outside_allocations_qty between 0 and 1000000000),
  source_as_of timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, dataset_id, item_id, location_id),
  check (unusable_qty + outside_allocations_qty <= physical_qty),
  foreign key (dataset_id, org_id) references public.datasets(id, org_id),
  foreign key (item_id, org_id) references public.items(id, org_id),
  foreign key (location_id, org_id) references public.locations(id, org_id)
);

create table public.demand_requirements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  dataset_id uuid not null,
  external_id text,
  item_id uuid not null,
  location_id uuid not null,
  remaining_qty integer not null check (remaining_qty between 0 and 1000000000),
  required_at timestamptz not null,
  certainty text not null check (certainty in ('confirmed', 'forecast')),
  included_reserved_qty integer not null default 0 check (included_reserved_qty between 0 and 1000000000),
  status text not null default 'open',
  source_as_of timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  foreign key (dataset_id, org_id) references public.datasets(id, org_id),
  foreign key (item_id, org_id) references public.items(id, org_id),
  foreign key (location_id, org_id) references public.locations(id, org_id)
);

create table public.source_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid,
  provider_message_id text not null,
  provider_thread_id text,
  rfc_message_id text,
  direction text not null check (direction in ('inbound', 'outbound')),
  sender text,
  recipients text[] not null default '{}',
  sent_at timestamptz,
  received_at timestamptz,
  body_evidence_id uuid,
  processing_state text not null default 'pending'
    check (processing_state in ('pending', 'processed', 'needs_review', 'ignored', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (connection_id, provider_message_id),
  foreign key (connection_id, org_id) references public.connections(id, org_id)
);

create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_type text not null,
  external_id text,
  source_url text,
  private_object_path text,
  source_time timestamptz,
  captured_at timestamptz not null default now(),
  content_hash text not null,
  locator text,
  supported_excerpt text,
  verification_actor uuid references auth.users(id),
  verified_at timestamptz,
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  check (private_object_path is null or private_object_path !~ '^https?://')
);

alter table public.supplier_contacts
  add constraint supplier_contacts_identity_evidence_fk
  foreign key (identity_evidence_id, org_id) references public.evidence(id, org_id);
alter table public.supplier_items
  add constraint supplier_items_spec_evidence_fk
  foreign key (verified_specification_evidence_id, org_id) references public.evidence(id, org_id);
alter table public.receipt_schedules
  add constraint receipt_schedules_evidence_fk
  foreign key (evidence_id, org_id) references public.evidence(id, org_id);
alter table public.source_messages
  add constraint source_messages_body_evidence_fk
  foreign key (body_evidence_id, org_id) references public.evidence(id, org_id);

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  item_id uuid not null,
  location_id uuid not null,
  phase public.case_phase not null default 'new',
  run_control public.run_control not null default 'active',
  block_reason public.block_reason,
  severity text not null default 'info',
  assignee_user_id uuid references auth.users(id),
  current_assessment_id uuid,
  current_plan_id uuid,
  episode integer not null default 1 check (episode > 0),
  next_check_at timestamptz,
  closed_outcome text
    check (closed_outcome is null or closed_outcome in ('delivered', 'no_impact', 'accepted_risk', 'cancelled', 'unresolved')),
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  foreign key (item_id, org_id) references public.items(id, org_id),
  foreign key (location_id, org_id) references public.locations(id, org_id)
);

create unique index cases_one_active_per_item_location
  on public.cases(org_id, item_id, location_id)
  where phase <> 'closed';

create table public.case_order_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  po_line_id uuid not null,
  affected_qty integer not null check (affected_qty between 0 and 1000000000),
  triggering_message_id uuid,
  created_at timestamptz not null default now(),
  unique (org_id, case_id, po_line_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (po_line_id, org_id) references public.purchase_order_lines(id, org_id),
  foreign key (triggering_message_id, org_id) references public.source_messages(id, org_id)
);

create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  version integer not null check (version > 0),
  input_fingerprint text not null,
  policy_version_id uuid,
  source_versions jsonb not null default '{}'::jsonb,
  horizon_start timestamptz,
  horizon_end timestamptz,
  quality public.assessment_quality not null,
  first_shortage_at timestamptz,
  bridge_qty integer check (bridge_qty is null or bridge_qty between 0 and 1000000000),
  projection jsonb not null default '{}'::jsonb,
  dated_requirements jsonb not null default '[]'::jsonb,
  evidence_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, case_id, version),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (policy_version_id, org_id) references public.policies(id, org_id)
);

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  supplier_id uuid not null,
  contact_id uuid,
  evidence_ids uuid[] not null default '{}',
  received_at timestamptz,
  source_type text not null,
  source_summary text,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (supplier_id, org_id) references public.suppliers(id, org_id),
  foreign key (contact_id, org_id) references public.supplier_contacts(id, org_id)
);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  offer_id uuid,
  supplier_id uuid not null,
  contact_id uuid,
  item_id uuid not null,
  quantity integer check (quantity is null or quantity between 0 and 1000000000),
  unit text,
  unit_price_minor bigint check (unit_price_minor is null or unit_price_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  freight_minor bigint check (freight_minor is null or freight_minor >= 0),
  fees_minor bigint check (fees_minor is null or fees_minor >= 0),
  nonrecoverable_tax_minor bigint check (nonrecoverable_tax_minor is null or nonrecoverable_tax_minor >= 0),
  destination_location_id uuid,
  arrival_start timestamptz,
  arrival_end timestamptz,
  valid_until timestamptz,
  latest_order_at timestamptz,
  status public.quote_status not null default 'provisional',
  original_order_terms jsonb not null default '{}'::jsonb,
  evidence_ids uuid[] not null default '{}',
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (offer_id, org_id) references public.offers(id, org_id),
  foreign key (supplier_id, org_id) references public.suppliers(id, org_id),
  foreign key (contact_id, org_id) references public.supplier_contacts(id, org_id),
  foreign key (item_id, org_id) references public.items(id, org_id),
  foreign key (destination_location_id, org_id) references public.locations(id, org_id)
);

create table public.recovery_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  version integer not null check (version > 0),
  assessment_id uuid not null,
  input_fingerprint text not null,
  policy_version_id uuid,
  status public.plan_status not null default 'draft',
  gross_commitment_minor bigint check (gross_commitment_minor is null or gross_commitment_minor >= 0),
  incremental_cost_minor bigint,
  expires_at timestamptz,
  dependencies jsonb not null default '[]'::jsonb,
  evidence_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, case_id, version),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (assessment_id, org_id) references public.assessments(id, org_id),
  foreign key (policy_version_id, org_id) references public.policies(id, org_id)
);

create table public.plan_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid not null,
  step_id text not null,
  kind public.plan_step_kind not null,
  item_id uuid not null,
  quantity integer check (quantity is null or quantity between 0 and 1000000000),
  unit text not null,
  destination_location_id uuid,
  depends_on_step_ids text[] not null default '{}',
  evidence_ids uuid[] not null default '{}',
  execution_mode text not null check (execution_mode in ('demo_ledger', 'live_connector', 'manual')),
  payload jsonb not null default '{}'::jsonb,
  missing_fields text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, plan_id, step_id),
  foreign key (plan_id, org_id) references public.recovery_plans(id, org_id),
  foreign key (item_id, org_id) references public.items(id, org_id),
  foreign key (destination_location_id, org_id) references public.locations(id, org_id)
);

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  plan_id uuid,
  kind public.action_kind not null,
  state public.action_state not null default 'prepared',
  payload_version integer not null default 1,
  payload_hash text not null,
  payload jsonb not null,
  idempotency_key text not null,
  provider text,
  provider_ref text,
  permitted_by uuid references auth.users(id),
  attempts integer not null default 0 check (attempts >= 0),
  dispatch_started_at timestamptz,
  next_reconcile_at timestamptz,
  outcome jsonb,
  error_code text,
  mode public.environment_mode not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (org_id, idempotency_key),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (plan_id, org_id) references public.recovery_plans(id, org_id)
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid not null,
  plan_version integer not null,
  approving_user_id uuid not null references auth.users(id),
  authority_role public.membership_role not null,
  input_fingerprint text not null,
  approved_ceiling_minor bigint not null check (approved_ceiling_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  expires_at timestamptz not null,
  status public.approval_status not null default 'active',
  consumed_by_action_id uuid,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, idempotency_key),
  foreign key (plan_id, org_id) references public.recovery_plans(id, org_id),
  foreign key (consumed_by_action_id, org_id) references public.actions(id, org_id)
);

alter table public.cases
  add constraint cases_current_assessment_fk
  foreign key (current_assessment_id, org_id) references public.assessments(id, org_id),
  add constraint cases_current_plan_fk
  foreign key (current_plan_id, org_id) references public.recovery_plans(id, org_id);

create table public.allocation_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid not null,
  item_id uuid not null,
  location_id uuid not null,
  demand_ids uuid[] not null default '{}',
  receipt_schedule_ids uuid[] not null default '{}',
  quantity integer not null check (quantity between 0 and 1000000000),
  state public.allocation_claim_state not null default 'active',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  foreign key (plan_id, org_id) references public.recovery_plans(id, org_id),
  foreign key (item_id, org_id) references public.items(id, org_id),
  foreign key (location_id, org_id) references public.locations(id, org_id)
);

create table public.callback_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  external_event_key text not null,
  verified_at timestamptz not null,
  payload_hash text not null,
  private_evidence_id uuid,
  processing_state text not null default 'pending',
  related_action_id uuid,
  retry_count integer not null default 0 check (retry_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  unique (id, org_id),
  unique (provider, external_event_key),
  foreign key (private_evidence_id, org_id) references public.evidence(id, org_id),
  foreign key (related_action_id, org_id) references public.actions(id, org_id)
);

create table public.event_outbox (
  event_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  aggregate_id uuid not null,
  correlation_id uuid not null,
  causation_id uuid,
  event_type text not null,
  schema_version integer not null default 1 check (schema_version > 0),
  payload jsonb not null,
  published_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_type text not null,
  actor_id text,
  case_id uuid,
  entity_type text not null,
  entity_id uuid,
  event_name text not null,
  previous_version integer,
  new_version integer,
  reason text,
  request_id uuid,
  occurred_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id)
);

create table public.case_evidence (
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  evidence_id uuid not null,
  purpose text not null,
  created_at timestamptz not null default now(),
  primary key (org_id, case_id, evidence_id, purpose),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (evidence_id, org_id) references public.evidence(id, org_id)
);

create table public.commitment_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  po_line_id uuid not null,
  kind text not null check (kind in ('delay', 'split', 'expedite', 'cancel', 'accept', 'receive', 'correction')),
  previous_schedule_id uuid,
  new_schedule_id uuid,
  affected_qty integer check (affected_qty is null or affected_qty between 0 and 1000000000),
  evidence_id uuid,
  actor_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (po_line_id, org_id) references public.purchase_order_lines(id, org_id),
  foreign key (previous_schedule_id, org_id) references public.receipt_schedules(id, org_id),
  foreign key (new_schedule_id, org_id) references public.receipt_schedules(id, org_id),
  foreign key (evidence_id, org_id) references public.evidence(id, org_id)
);

create table public.receiving_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_connection_id uuid,
  external_receipt_id text,
  po_line_id uuid not null,
  item_id uuid not null,
  location_id uuid not null,
  quantity integer not null check (quantity between 0 and 1000000000),
  received_at timestamptz not null,
  kind text not null check (kind in ('received', 'reversal')),
  reverses_event_id uuid,
  evidence_id uuid,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (source_connection_id, external_receipt_id),
  foreign key (source_connection_id, org_id) references public.connections(id, org_id),
  foreign key (po_line_id, org_id) references public.purchase_order_lines(id, org_id),
  foreign key (item_id, org_id) references public.items(id, org_id),
  foreign key (location_id, org_id) references public.locations(id, org_id),
  foreign key (reverses_event_id, org_id) references public.receiving_events(id, org_id),
  foreign key (evidence_id, org_id) references public.evidence(id, org_id)
);

create table public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  provider_conversation_id text,
  provider_call_id text,
  contact_id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  disposition text,
  transcript_evidence_id uuid,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, action_id),
  unique (provider_conversation_id),
  foreign key (action_id, org_id) references public.actions(id, org_id),
  foreign key (contact_id, org_id) references public.supplier_contacts(id, org_id),
  foreign key (transcript_evidence_id, org_id) references public.evidence(id, org_id)
);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  request_id text not null,
  charge_type text not null,
  case_id uuid,
  action_id uuid,
  model text,
  raw_units jsonb not null default '{}'::jsonb,
  estimated_cost numeric(24, 12),
  actual_cost numeric(24, 12),
  billing_currency text,
  rate_version text,
  recorded_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, provider, request_id, charge_type),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (action_id, org_id) references public.actions(id, org_id)
);

create table private.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  encrypted_credential_material bytea not null,
  key_version text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (connection_id),
  foreign key (connection_id, org_id) references public.connections(id, org_id)
);

create table private.voice_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  token_hash text not null unique,
  allowed_tool_names text[] not null,
  case_id uuid not null,
  contact_id uuid not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (action_id, org_id) references public.actions(id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (contact_id, org_id) references public.supplier_contacts(id, org_id)
);

create or replace function public.reject_immutable_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Records in % are immutable', tg_table_name using errcode = '55000';
  return null;
end;
$$;

create trigger policies_immutable
  before update or delete on public.policies
  for each row execute function public.reject_immutable_change();
create trigger assessments_immutable
  before update or delete on public.assessments
  for each row execute function public.reject_immutable_change();
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function public.reject_immutable_change();
create trigger commitment_events_append_only
  before update or delete on public.commitment_events
  for each row execute function public.reject_immutable_change();
create trigger receiving_events_append_only
  before update or delete on public.receiving_events
  for each row execute function public.reject_immutable_change();

create or replace function public.is_member(
  target_org_id uuid,
  allowed_roles public.membership_role[] default array['owner', 'operator', 'viewer']::public.membership_role[]
) returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = target_org_id
      and m.auth_user_id = auth.uid()
      and m.active
      and m.role = any (allowed_roles)
  );
$$;

alter table public.organizations enable row level security;
create policy organizations_member_select on public.organizations
  for select to authenticated using (public.is_member(id));

alter table public.memberships enable row level security;
create policy memberships_self_select on public.memberships
  for select to authenticated using (auth_user_id = auth.uid());

do $$
declare
  table_name text;
begin
  for table_name in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname not in ('organizations', 'memberships')
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy tenant_member_select on public.%I for select to authenticated using (public.is_member(org_id))',
      table_name
    );
  end loop;
end;
$$;

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to authenticated;
grant execute on function public.is_member(uuid, public.membership_role[]) to authenticated;
grant select on table
  public.organizations,
  public.memberships,
  public.locations,
  public.items,
  public.suppliers,
  public.supplier_contacts,
  public.supplier_items,
  public.connections,
  public.policies,
  public.datasets,
  public.import_sessions,
  public.purchase_orders,
  public.purchase_order_lines,
  public.receipt_schedules,
  public.inventory_snapshots,
  public.demand_requirements,
  public.source_messages,
  public.evidence,
  public.cases,
  public.case_order_lines,
  public.assessments,
  public.offers,
  public.quotes,
  public.recovery_plans,
  public.plan_steps,
  public.actions,
  public.approvals,
  public.allocation_claims,
  public.callback_receipts,
  public.event_outbox,
  public.audit_events,
  public.case_evidence,
  public.commitment_events,
  public.receiving_events,
  public.call_sessions,
  public.usage_events
to authenticated;

revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

grant usage on schema public, private to service_role;
grant all on all tables in schema public, private to service_role;
grant all on all sequences in schema public, private to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema private grant all on tables to service_role;
alter default privileges in schema private grant all on sequences to service_role;
