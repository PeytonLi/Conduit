-- Outlook (Microsoft Graph) as a second mailbox provider, and several mailbox
-- connections per organization.
--
-- public.connections already allows many rows per org (unique on
-- org_id + provider + external_account_id). What was single-mailbox was the
-- surrounding code: every RPC filtered on provider = 'gmail', the dispatch
-- claim looked for "any Gmail connection", and disconnect picked the latest
-- Gmail row. This migration adds provider-neutral mailbox RPCs next to the
-- existing gmail_* ones (which keep working), a per-org primary mailbox, and
-- makes the dispatch claim validate the connection the action actually names.

create or replace function private.mailbox_providers()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['gmail', 'outlook']::text[] $$;

-- ---------------------------------------------------------------------------
-- Primary mailbox
-- ---------------------------------------------------------------------------

alter table public.connections
  add column is_primary boolean not null default false;

alter table public.connections
  add constraint connections_primary_is_mailbox
  check (not is_primary or provider in ('gmail', 'outlook'));

-- At most one primary mailbox per organization.
create unique index connections_one_primary_mailbox
  on public.connections (org_id)
  where is_primary;

-- Existing orgs: the oldest active Gmail connection becomes the primary.
update public.connections c
set is_primary = true
where c.id in (
  select distinct on (x.org_id) x.id
  from public.connections x
  where x.provider = 'gmail' and x.status in ('healthy', 'degraded')
  order by x.org_id, x.created_at, x.id
);

-- Makes p_connection_id primary unless the org already has another active
-- primary. A stale (expired/revoked/disconnected) primary is replaced.
create or replace function private.mailbox_ensure_primary(p_org uuid, p_connection uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.connections
    where org_id = p_org and id <> p_connection and is_primary
      and status in ('healthy', 'degraded')
  ) then
    return;
  end if;
  update public.connections set is_primary = false
  where org_id = p_org and is_primary and id <> p_connection;
  update public.connections set is_primary = true
  where id = p_connection and org_id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Provider-neutral mailbox RPCs (service role only)
-- ---------------------------------------------------------------------------

create or replace function public.mailbox_store_connection(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_provider text := p->>'provider';
  v_external text := p->>'external_account_id';
  v_connection_id uuid;
  v_primary boolean;
begin
  if v_provider is null or not (v_provider = any(private.mailbox_providers())) then
    raise exception 'unknown mailbox provider' using errcode = 'P0422';
  end if;
  if coalesce(v_external, '') = '' or coalesce(p->>'encrypted_b64', '') = '' then
    raise exception 'external account and credential are required' using errcode = 'P0422';
  end if;

  insert into public.connections (
    org_id, provider, external_account_id, status, scopes, capabilities,
    last_error_code, sync_cursor
  )
  values (
    v_org, v_provider, v_external, 'healthy',
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'scopes', '[]'::jsonb)) value), '{}'),
    coalesce(p->'capabilities', '{}'::jsonb),
    null, null
  )
  on conflict (org_id, provider, external_account_id)
  do update set status = 'healthy', scopes = excluded.scopes,
    capabilities = excluded.capabilities, last_error_code = null,
    sync_cursor = null, row_version = public.connections.row_version + 1,
    updated_at = now()
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

  perform private.mailbox_ensure_primary(v_org, v_connection_id);
  select is_primary into v_primary from public.connections where id = v_connection_id;

  insert into public.audit_events (
    org_id, actor_type, actor_id, entity_type, entity_id, event_name
  )
  values (
    v_org, 'user', p->>'actor_user_id', 'connection', v_connection_id,
    'connection.' || v_provider || '.connected'
  );

  return jsonb_build_object('connection_id', v_connection_id, 'is_primary', v_primary);
end;
$$;

create or replace function public.mailbox_load_credential(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  select c.provider, c.status, c.external_account_id, c.sync_cursor, c.is_primary,
         encode(ic.encrypted_credential_material, 'base64') as encrypted_b64,
         ic.key_version, ic.expires_at
  into v
  from public.connections c
  left join private.integration_credentials ic
    on ic.connection_id = c.id and ic.org_id = c.org_id
  where c.id = (p->>'connection_id')::uuid and c.org_id = (p->>'org_id')::uuid
    and c.provider = any(private.mailbox_providers());
  if not found then
    raise exception 'mailbox connection not found' using errcode = 'P0404';
  end if;
  return jsonb_build_object(
    'provider', v.provider,
    'status', v.status,
    'external_account_id', v.external_account_id,
    'sync_cursor', v.sync_cursor,
    'is_primary', v.is_primary,
    'encrypted_b64', v.encrypted_b64,
    'key_version', v.key_version,
    'expires_at', v.expires_at
  );
end;
$$;

-- Persists a rotated refresh token (Microsoft rotates them on refresh).
create or replace function public.mailbox_update_credential(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.connections
    where id = (p->>'connection_id')::uuid and org_id = (p->>'org_id')::uuid
      and provider = any(private.mailbox_providers())
      and status in ('healthy', 'degraded')
  ) then
    return jsonb_build_object('updated', false, 'code', 'not_connected');
  end if;
  update private.integration_credentials
  set encrypted_credential_material = decode(p->>'encrypted_b64', 'base64'),
      key_version = p->>'key_version',
      expires_at = nullif(p->>'expires_at', '')::timestamptz
  where connection_id = (p->>'connection_id')::uuid and org_id = (p->>'org_id')::uuid;
  return jsonb_build_object('updated', found);
end;
$$;

create or replace function public.mailbox_set_status(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.connections
  set status = p->>'status', last_error_code = p->>'error_code', updated_at = now()
  where id = (p->>'connection_id')::uuid and org_id = (p->>'org_id')::uuid
    and provider = any(private.mailbox_providers());
  return jsonb_build_object('updated', found);
end;
$$;

create or replace function public.mailbox_advance_cursor(p jsonb)
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
    and provider = any(private.mailbox_providers())
    and sync_cursor is not distinct from p->>'expected_cursor';
  get diagnostics v_advanced = row_count;
  return jsonb_build_object('advanced', v_advanced > 0);
end;
$$;

-- Active mailboxes for the pollers. p.provider optionally narrows to one provider.
create or replace function public.inbox_list_mailbox_connections(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'org_id', c.org_id,
      'connection_id', c.id,
      'provider', c.provider,
      'environment_mode', o.environment_mode
    ) order by c.created_at, c.id)
    from public.connections c
    join public.organizations o on o.id = c.org_id
    where c.provider = any(private.mailbox_providers())
      and c.status in ('healthy', 'degraded')
      and (nullif(p->>'provider', '') is null or c.provider = p->>'provider')
  ), '[]'::jsonb);
end;
$$;

-- Owner action: pick the default mailbox for outbound supplier email.
create or replace function public.mailbox_set_primary(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_id uuid := (p->>'connection_id')::uuid;
  v_connection public.connections%rowtype;
begin
  select * into v_connection
  from public.connections
  where id = v_id and org_id = v_org
    and provider = any(private.mailbox_providers())
    and status in ('healthy', 'degraded')
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_connected');
  end if;
  if v_connection.is_primary then
    return jsonb_build_object('ok', true, 'changed', false, 'connection_id', v_id);
  end if;

  update public.connections set is_primary = false
  where org_id = v_org and is_primary;
  update public.connections
  set is_primary = true, row_version = row_version + 1, updated_at = now()
  where id = v_id and org_id = v_org;

  insert into public.audit_events (
    org_id, actor_type, actor_id, entity_type, entity_id, event_name,
    previous_version, new_version, reason
  )
  values (
    v_org, 'user', p->>'actor_user_id', 'connection', v_id,
    'connection.mailbox.primary_changed',
    v_connection.row_version, v_connection.row_version + 1, 'owner_set_primary'
  );
  return jsonb_build_object('ok', true, 'changed', true, 'connection_id', v_id);
end;
$$;

revoke all on function
  public.mailbox_store_connection(jsonb),
  public.mailbox_load_credential(jsonb),
  public.mailbox_update_credential(jsonb),
  public.mailbox_set_status(jsonb),
  public.mailbox_advance_cursor(jsonb),
  public.inbox_list_mailbox_connections(jsonb),
  public.mailbox_set_primary(jsonb)
from public, anon, authenticated;

grant execute on function
  public.mailbox_store_connection(jsonb),
  public.mailbox_load_credential(jsonb),
  public.mailbox_update_credential(jsonb),
  public.mailbox_set_status(jsonb),
  public.mailbox_advance_cursor(jsonb),
  public.inbox_list_mailbox_connections(jsonb),
  public.mailbox_set_primary(jsonb)
to service_role;

-- The Gmail connect path keeps its own RPC; it now also maintains the primary.
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

  perform private.mailbox_ensure_primary(v_org, v_connection_id);

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

-- ---------------------------------------------------------------------------
-- Disconnect: any mailbox provider, by connection id
-- ---------------------------------------------------------------------------
-- With p.connection_id the named mailbox is disconnected whatever its health
-- (an expired or revoked mailbox must be removable). Without it the previous
-- behavior holds: the latest active mailbox of p.provider (default gmail).
-- The primary flag moves to the oldest remaining active mailbox.

create or replace function public.ui_disconnect_connection(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_actor uuid := (p->>'actor_user_id')::uuid;
  v_requested uuid := nullif(p->>'connection_id', '')::uuid;
  v_provider text := coalesce(nullif(p->>'provider', ''), 'gmail');
  v_connection record;
  v_next uuid;
begin
  if v_requested is not null then
    select * into v_connection
    from public.connections
    where org_id = v_org and id = v_requested
      and provider = any(private.mailbox_providers())
      and status <> 'disconnected'
    for update;
  else
    select * into v_connection
    from public.connections
    where org_id = v_org
      and provider = v_provider
      and provider = any(private.mailbox_providers())
      and status in ('healthy', 'degraded')
    order by updated_at desc, id desc
    limit 1
    for update;
  end if;
  if not found then
    return jsonb_build_object('ok', true, 'disconnected', false);
  end if;

  update public.connections
  set status = 'disconnected',
      is_primary = false,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_connection.id and org_id = v_org;

  delete from private.integration_credentials
  where connection_id = v_connection.id and org_id = v_org;

  if v_connection.is_primary then
    select id into v_next
    from public.connections
    where org_id = v_org
      and provider = any(private.mailbox_providers())
      and status in ('healthy', 'degraded')
      and id <> v_connection.id
    order by created_at, id
    limit 1;
    if v_next is not null then
      update public.connections
      set is_primary = true, row_version = row_version + 1, updated_at = now()
      where id = v_next and org_id = v_org;
    end if;
  end if;

  perform private.audit(
    v_org,
    'user',
    v_actor::text,
    null,
    'connection',
    v_connection.id,
    'connection.' || v_connection.provider || '.disconnected',
    v_connection.row_version,
    v_connection.row_version + 1,
    'owner_disconnect',
    now()
  );

  return jsonb_build_object(
    'ok', true,
    'disconnected', true,
    'connection_id', v_connection.id,
    'provider', v_connection.provider
  );
end;
$$;

revoke all on function public.ui_disconnect_connection(jsonb) from public, anon, authenticated;
grant execute on function public.ui_disconnect_connection(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Cross-mailbox duplicate suppression
-- ---------------------------------------------------------------------------
-- The same supplier email can reach two connected mailboxes (a shared alias,
-- a CC). Each mailbox still records its own source_messages row, but only the
-- first copy of a given RFC Message-ID is processed; later copies from another
-- mailbox are stored as 'ignored' and raise no supplier.message.received
-- event, so one delay notice can never open or split a case twice.

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
  v_duplicate boolean := false;
begin
  if p->>'direction' = 'inbound'
    and nullif(p->>'rfc_message_id', '') is not null
    and exists (
      select 1 from public.connections cur
      where cur.id = (p->>'connection_id')::uuid and cur.org_id = v_org
        and cur.provider = any(private.mailbox_providers())
    )
    and exists (
      select 1
      from public.source_messages sm
      join public.connections other
        on other.id = sm.connection_id and other.org_id = sm.org_id
      where sm.org_id = v_org
        and sm.direction = 'inbound'
        and sm.rfc_message_id = p->>'rfc_message_id'
        and sm.connection_id is distinct from (p->>'connection_id')::uuid
        and other.provider = any(private.mailbox_providers())
    ) then
    v_duplicate := true;
  end if;

  insert into public.source_messages (
    org_id, connection_id, provider_message_id, provider_thread_id,
    rfc_message_id, direction, sender, recipients, sent_at, received_at,
    historical, processing_state
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
    coalesce((p->>'historical')::boolean, false),
    case when v_duplicate then 'ignored' else 'pending' end
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

  if not v_duplicate
    and not coalesce((p->>'historical')::boolean, false)
    and p->>'direction' = 'inbound' then
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
      -- Bare payload: toPublishedEvent adds org_id/event_id/correlation_id.
      jsonb_build_object('message_id', v_message_id)
    );
  end if;

  return jsonb_build_object(
    'source_message_id', v_message_id,
    'created', v_created,
    'processing_state', case when v_duplicate then 'ignored' else 'pending' end
  );
end;
$$;

revoke all on function public.inbox_store_message(jsonb) from public, anon, authenticated;
grant execute on function public.inbox_store_message(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Dispatch claim: validate the mailbox the action names
-- ---------------------------------------------------------------------------
-- Previously any healthy Gmail connection satisfied the check. The action's
-- payload already carries connection_id, so the claim now requires that exact
-- mailbox (any mailbox provider) to be active in the same organization. It
-- never falls back to a different mailbox: sending from another address than
-- the one approved at preparation is not a safe substitution.

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
  select * into v_action from public.actions where id = p_action_id and org_id = p_org_id for update;
  if not found then return private.result_error('not_found', 'Action not found'); end if;
  if v_action.state <> 'prepared' then
    return private.result_error('not_claimable', 'Action is not prepared',
      jsonb_build_object('action', private.action_json(p_org_id, p_action_id)));
  end if;
  select * into v_case from public.cases where id = v_action.case_id and org_id = p_org_id;
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
  if v_action.kind = 'live_business_amendment' and not exists (
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

revoke all on function public.ledger_claim_dispatch(uuid, uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.ledger_claim_dispatch(uuid, uuid, integer, timestamptz) to service_role;
