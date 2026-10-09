create table public.planner_cycles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  episode integer not null check (episode > 0),
  assessment_version integer not null check (assessment_version > 0),
  status text not null default 'running'
    check (status in ('running', 'waiting', 'needs_review', 'plan_proposed', 'no_action', 'blocked')),
  block_reason public.block_reason,
  model_requests integer not null default 0 check (model_requests >= 0),
  prompt_version text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id)
);

create table public.planner_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  cycle_id uuid not null,
  episode integer not null check (episode > 0),
  kind text not null check (kind in ('inference', 'repair', 'retry')),
  outcome text not null check (outcome in (
    'ok', 'invalid_output', 'rate_limited', 'quota_exceeded',
    'timeout', 'server_error', 'bad_request'
  )),
  provider text,
  provider_request_id text,
  model text,
  prompt_version text,
  estimated_cost numeric(24, 12),
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (cycle_id, org_id) references public.planner_cycles(id, org_id)
);

create table public.research_queries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  episode integer not null check (episode > 0),
  query text not null,
  provider text not null,
  mode public.environment_mode not null,
  provider_request_id text,
  result_count integer not null default 0 check (result_count >= 0),
  cost_usd numeric(24, 12),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id)
);

create table public.supplier_candidates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  research_query_id uuid not null,
  name text,
  domain text,
  source_evidence_id uuid,
  compatibility text not null default 'unknown'
    check (compatibility in ('compatible', 'incompatible', 'unknown')),
  status text not null default 'unapproved'
    check (status in ('unapproved', 'dismissed')),
  missing_facts text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (research_query_id, org_id) references public.research_queries(id, org_id),
  foreign key (source_evidence_id, org_id) references public.evidence(id, org_id)
);

create table public.planner_waits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  episode integer not null check (episode > 0),
  expected_kind text not null
    check (expected_kind in ('supplier_response', 'call_result', 'action_outcome')),
  action_id uuid,
  deadline_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'satisfied', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (action_id, org_id) references public.actions(id, org_id)
);

create table public.planner_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  reason text not null,
  missing_fields text[] not null default '{}',
  object_ids uuid[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_by text not null default 'planner',
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (case_id, org_id) references public.cases(id, org_id)
);

create table public.research_page_reads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  episode integer not null check (episode > 0),
  evidence_id uuid not null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, case_id, episode, evidence_id),
  foreign key (case_id, org_id) references public.cases(id, org_id),
  foreign key (evidence_id, org_id) references public.evidence(id, org_id)
);

do $$
declare
  table_name text;
begin
  for table_name in
    select unnest(array[
      'planner_cycles', 'planner_requests', 'research_queries',
      'supplier_candidates', 'planner_waits', 'planner_reviews',
      'research_page_reads'
    ])
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I_member_select on public.%I for select to authenticated using (public.is_member(org_id))',
      table_name,
      table_name
    );
    execute format('grant select on public.%I to authenticated', table_name);
  end loop;
end;
$$;
