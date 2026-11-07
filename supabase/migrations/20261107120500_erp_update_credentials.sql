-- Lets a provider persist rotated credentials (e.g. QuickBooks refresh tokens)
-- for an active business-system connection.

create or replace function public.erp_update_credentials(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_connection_id uuid := (p->>'connection_id')::uuid;
begin
  if not exists (
    select 1 from public.connections
    where id = v_connection_id and org_id = v_org
      and provider = any(private.erp_providers())
      and status in ('healthy', 'degraded')
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_connected');
  end if;

  update private.integration_credentials
  set encrypted_credential_material = decode(p->>'encrypted_b64', 'base64'),
    key_version = p->>'key_version',
    expires_at = nullif(p->>'expires_at', '')::timestamptz
  where connection_id = v_connection_id and org_id = v_org;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'credential_missing');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.erp_update_credentials(jsonb) from public, anon, authenticated;
grant execute on function public.erp_update_credentials(jsonb) to service_role;
