create or replace function public.inbox_load_message(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid := (p->>'org_id')::uuid;
  v_message public.source_messages%rowtype;
  v_provider text;
  v_segments jsonb;
  v_extraction jsonb;
begin
  select * into v_message
  from public.source_messages
  where id = (p->>'source_message_id')::uuid and org_id = v_org;
  if not found then
    raise exception 'source message not found' using errcode = 'P0404';
  end if;

  select provider into v_provider
  from public.connections
  where id = v_message.connection_id and org_id = v_org;

  select coalesce(jsonb_agg(jsonb_build_object(
    'evidence_id', c.evidence_id,
    'kind', c.segment_kind,
    'index', c.segment_index,
    'content', c.content,
    'content_hash', c.content_hash
  ) order by c.segment_index), '[]'::jsonb)
  into v_segments
  from private.source_message_content c
  where c.source_message_id = v_message.id and c.org_id = v_org
    and c.segment_kind <> 'attachment_ref';

  select to_jsonb(e.*) into v_extraction
  from public.message_extractions e
  where e.source_message_id = v_message.id and e.org_id = v_org
  order by e.version desc
  limit 1;

  return jsonb_build_object(
    'message', to_jsonb(v_message),
    'provider', v_provider,
    'segments', v_segments,
    'latest_extraction', v_extraction,
    'org_environment_mode', (select o.environment_mode from public.organizations o where o.id = v_org),
    'org_timezone', (select o.timezone from public.organizations o where o.id = v_org)
  );
end;
$$;
