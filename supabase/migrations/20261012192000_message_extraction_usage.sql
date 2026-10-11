create function public.inbox_record_extraction_usage(p jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.usage_events (
    org_id,
    provider,
    request_id,
    charge_type,
    case_id,
    model,
    raw_units,
    estimated_cost,
    actual_cost,
    billing_currency,
    rate_version
  ) values (
    (p->>'org_id')::uuid,
    'deepseek',
    p->>'request_id',
    'message_extraction',
    null,
    p->>'model',
    coalesce(p->'raw_units', '{}'::jsonb),
    null,
    null,
    null,
    null
  )
  on conflict (org_id, provider, request_id, charge_type) do nothing;
end;
$$;

revoke all on function public.inbox_record_extraction_usage(jsonb)
from public, anon, authenticated;
grant execute on function public.inbox_record_extraction_usage(jsonb)
to service_role;
