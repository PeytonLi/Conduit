-- Gmail push (Cloud Pub/Sub) watch state. Push is additive: the 10-minute
-- Inngest poll remains the fallback and keeps owning sync_cursor.

alter table public.connections
  add column watch_topic text,
  add column watch_expires_at timestamptz,
  add column watch_registered_at timestamptz;

-- Service-role only. All filters are optional; every returned row carries its
-- own org_id so callers never act outside the owning organization.
create or replace function public.gmail_list_watch_state(p jsonb default '{}'::jsonb)
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
      'environment_mode', o.environment_mode,
      'external_account_id', c.external_account_id,
      'watch_topic', c.watch_topic,
      'watch_expires_at', c.watch_expires_at
    ) order by c.created_at, c.id)
    from public.connections c
    join public.organizations o on o.id = c.org_id
    where c.provider = 'gmail'
      and c.status in ('healthy', 'degraded')
      and (nullif(p->>'org_id', '') is null
           or c.org_id = (p->>'org_id')::uuid)
      and (nullif(p->>'connection_id', '') is null
           or c.id = (p->>'connection_id')::uuid)
      and (nullif(p->>'email', '') is null
           or lower(c.external_account_id) = lower(p->>'email'))
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gmail_record_watch(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.connections
  set watch_topic = p->>'topic',
      watch_expires_at = (p->>'expires_at')::timestamptz,
      watch_registered_at = now(),
      updated_at = now()
  where id = (p->>'connection_id')::uuid
    and org_id = (p->>'org_id')::uuid
    and provider = 'gmail';
  return jsonb_build_object('updated', found);
end;
$$;

revoke all on function
  public.gmail_list_watch_state(jsonb),
  public.gmail_record_watch(jsonb)
from public, anon, authenticated;

grant execute on function
  public.gmail_list_watch_state(jsonb),
  public.gmail_record_watch(jsonb)
to service_role;
