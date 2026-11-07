-- Business-system (ERP) connections. Credentials are encrypted by the app
-- (AES-GCM, CREDENTIAL_ENCRYPTION_KEY) exactly like Gmail and stored in
-- private.integration_credentials. An org has at most one active business
-- system: connecting a provider retires any other ERP connection.

create or replace function private.erp_providers()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['odoo', 'zoho_inventory', 'quickbooks', 'shopify']::text[] $$;

create or replace function public.erp_store_connection(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_provider text := p->>'provider';
  v_connection_id uuid;
begin
  if v_provider is null or not (v_provider = any(private.erp_providers())) then
    raise exception 'unknown business provider' using errcode = 'P0422';
  end if;
  if coalesce(p->>'external_account_id', '') = '' or coalesce(p->>'encrypted_b64', '') = '' then
    raise exception 'external account and credential are required' using errcode = 'P0422';
  end if;

  delete from private.integration_credentials ic
  using public.connections c
  where ic.connection_id = c.id and c.org_id = v_org
    and c.provider = any(private.erp_providers())
    and not (c.provider = v_provider and c.external_account_id = p->>'external_account_id');
  update public.connections
  set status = 'disconnected', row_version = row_version + 1, updated_at = now()
  where org_id = v_org and provider = any(private.erp_providers())
    and status <> 'disconnected'
    and not (provider = v_provider and external_account_id = p->>'external_account_id');

  insert into public.connections (
    org_id, provider, external_account_id, status, scopes, last_error_code, sync_cursor
  )
  values (
    v_org, v_provider, p->>'external_account_id', 'healthy',
    coalesce((select array_agg(value) from jsonb_array_elements_text(coalesce(p->'scopes', '[]'::jsonb)) value), '{}'),
    null, null
  )
  on conflict (org_id, provider, external_account_id)
  do update set status = 'healthy', scopes = excluded.scopes, last_error_code = null,
    row_version = public.connections.row_version + 1, updated_at = now()
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

  insert into public.audit_events (org_id, actor_type, actor_id, entity_type, entity_id, event_name)
  values (v_org, 'user', p->>'actor_user_id', 'connection', v_connection_id,
    'connection.business.connected');

  return jsonb_build_object('connection_id', v_connection_id);
end;
$$;

-- Returns the org's active business connection (healthy/degraded) with its
-- encrypted credential, or null when none is connected.
create or replace function public.erp_load_connection(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select c.id, c.provider, c.status, c.external_account_id, c.sync_cursor, c.last_success_at,
         encode(ic.encrypted_credential_material, 'base64') as encrypted_b64,
         ic.key_version, ic.expires_at
  into v
  from public.connections c
  left join private.integration_credentials ic
    on ic.connection_id = c.id and ic.org_id = c.org_id
  where c.org_id = (p->>'org_id')::uuid
    and c.provider = any(private.erp_providers())
    and c.status in ('healthy', 'degraded')
    and (p->>'connection_id' is null or c.id = (p->>'connection_id')::uuid)
  order by c.updated_at desc, c.id desc
  limit 1;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'connection_id', v.id,
    'provider', v.provider,
    'status', v.status,
    'external_account_id', v.external_account_id,
    'sync_cursor', v.sync_cursor,
    'last_success_at', v.last_success_at,
    'encrypted_b64', v.encrypted_b64,
    'key_version', v.key_version,
    'expires_at', v.expires_at
  );
end;
$$;

create or replace function public.erp_record_sync(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.connections
  set status = case when p->>'error_code' is null then 'healthy' else 'degraded' end,
      last_error_code = p->>'error_code',
      last_success_at = case when p->>'error_code' is null then (p->>'now')::timestamptz else last_success_at end,
      sync_cursor = coalesce(p->>'sync_cursor', sync_cursor),
      updated_at = now()
  where id = (p->>'connection_id')::uuid and org_id = (p->>'org_id')::uuid
    and provider = any(private.erp_providers())
    and status in ('healthy', 'degraded');
  return jsonb_build_object('updated', found);
end;
$$;

create or replace function public.erp_disconnect(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids
  from public.connections
  where org_id = v_org and provider = any(private.erp_providers())
    and (p->>'provider' is null or provider = p->>'provider')
    and status <> 'disconnected';
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('ok', true, 'disconnected', false);
  end if;
  update public.connections
  set status = 'disconnected', row_version = row_version + 1, updated_at = now()
  where id = any(v_ids);
  delete from private.integration_credentials where connection_id = any(v_ids) and org_id = v_org;
  insert into public.audit_events (org_id, actor_type, actor_id, entity_type, entity_id, event_name)
  select v_org, 'user', p->>'actor_user_id', 'connection', id, 'connection.business.disconnected'
  from unnest(v_ids) id;
  return jsonb_build_object('ok', true, 'disconnected', true);
end;
$$;

create or replace function public.erp_list_active_connections()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'org_id', c.org_id, 'connection_id', c.id, 'provider', c.provider,
    'environment_mode', o.environment_mode
  )), '[]'::jsonb)
  from public.connections c
  join public.organizations o on o.id = c.org_id
  where c.provider = any(private.erp_providers())
    and c.status in ('healthy', 'degraded')
    and o.environment_mode <> 'replay'
$$;

revoke all on function
  private.erp_providers(),
  public.erp_store_connection(jsonb),
  public.erp_load_connection(jsonb),
  public.erp_record_sync(jsonb),
  public.erp_disconnect(jsonb),
  public.erp_list_active_connections()
from public, anon, authenticated;

grant execute on function
  public.erp_store_connection(jsonb),
  public.erp_load_connection(jsonb),
  public.erp_record_sync(jsonb),
  public.erp_disconnect(jsonb),
  public.erp_list_active_connections()
to service_role;
