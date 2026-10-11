drop function public.inbox_list_gmail_connections();

create function public.inbox_list_gmail_connections(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'org_id', c.org_id, 'connection_id', c.id,
      'environment_mode', o.environment_mode
    ))
    from public.connections c
    join public.organizations o on o.id = c.org_id
    where c.provider = 'gmail' and c.status in ('healthy', 'degraded')
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.inbox_list_gmail_connections(jsonb)
from public, anon, authenticated;
grant execute on function public.inbox_list_gmail_connections(jsonb)
to service_role;
