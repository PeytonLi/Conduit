-- Durably records a verified provider callback. Idempotent on (provider, external_event_key).
-- Unknown conversations are quarantined and never create cases.
create or replace function public.voice_record_callback(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_provider text := p ->> 'provider';
  v_key text := p ->> 'external_event_key';
  v_conversation text := p ->> 'conversation_id';
  v_at timestamptz := (p ->> 'received_at')::timestamptz;
  v_existing record;
  v_session record;
  v_case uuid;
  v_receipt uuid;
  v_evidence uuid;
  v_outcome jsonb := p -> 'outcome';
begin
  select id, org_id, payload_hash into v_existing
    from public.callback_receipts where provider = v_provider and external_event_key = v_key;
  if found then
    update public.callback_receipts set retry_count = retry_count + 1, updated_at = v_at where id = v_existing.id;
    return jsonb_build_object('status', 'duplicate', 'receipt_id', v_existing.id,
                              'payload_matches', v_existing.payload_hash = p ->> 'payload_hash');
  end if;

  select cs.* into v_session from public.call_sessions cs
   where cs.provider_conversation_id = v_conversation
   for update;
  if not found and (p ->> 'action_hint') is not null then
    select cs.* into v_session from public.call_sessions cs
     where cs.action_id = (p ->> 'action_hint')::uuid and cs.provider_conversation_id is null
     for update;
  end if;

  if v_session.id is null then
    insert into private.voice_callback_quarantine
      (provider, external_event_key, conversation_id, event_type, payload_hash, payload, reason, received_at)
    values (v_provider, v_key, v_conversation, p ->> 'event_type', p ->> 'payload_hash', p -> 'payload',
            'unknown_conversation', v_at)
    on conflict (provider, external_event_key)
      do update set delivery_count = private.voice_callback_quarantine.delivery_count + 1;
    return jsonb_build_object('status', 'quarantined');
  end if;

  select case_id into v_case from public.actions where id = v_session.action_id and org_id = v_session.org_id;

  insert into public.evidence (org_id, source_type, external_id, source_time, captured_at, content_hash, locator, supported_excerpt)
  values (v_session.org_id, 'voice_call_callback', v_conversation, v_at, v_at, p ->> 'payload_hash',
          'private.voice_callback_payloads', p ->> 'excerpt')
  returning id into v_evidence;

  insert into public.callback_receipts
    (org_id, provider, external_event_key, verified_at, payload_hash, private_evidence_id, processing_state, related_action_id, created_at, updated_at)
  values (v_session.org_id, v_provider, v_key, v_at, p ->> 'payload_hash', v_evidence, 'recorded', v_session.action_id, v_at, v_at)
  returning id into v_receipt;

  insert into private.voice_callback_payloads (org_id, callback_receipt_id, payload, received_at)
  values (v_session.org_id, v_receipt, p -> 'payload', v_at);

  insert into public.case_evidence (org_id, case_id, evidence_id, purpose)
  values (v_session.org_id, v_case, v_evidence, 'voice_call_result');

  insert into public.voice_call_outcomes (
    org_id, action_id, case_id, conversation_id, outcome, provider_event_type, provider_status,
    transport_completed, procurement_result, detail, callback_receipt_id, recorded_at
  ) values (
    v_session.org_id, v_session.action_id, v_case, v_conversation, v_outcome ->> 'outcome',
    p ->> 'event_type', v_outcome ->> 'provider_status', (v_outcome ->> 'transport_completed')::boolean,
    v_outcome ->> 'procurement_result', coalesce(v_outcome -> 'detail', '{}'::jsonb), v_receipt, v_at
  ) on conflict (org_id, action_id) do nothing;

  update public.call_sessions
     set provider_conversation_id = case when v_provider = 'voice_bridge' then provider_conversation_id else coalesce(provider_conversation_id, v_conversation) end,
         provider_call_id = coalesce(provider_call_id, p ->> 'provider_call_id'),
         ended_at = coalesce(ended_at, v_at),
         duration_seconds = coalesce(duration_seconds, (p ->> 'duration_seconds')::integer),
         disposition = coalesce(disposition, v_outcome ->> 'outcome'),
         transcript_evidence_id = coalesce(transcript_evidence_id, v_evidence)
   where id = v_session.id;

  -- Transport outcome is now known; the call action is confirmed (not necessarily favorable).
  update public.actions
     set state = 'confirmed',
         provider_ref = coalesce(provider_ref, v_conversation),
         outcome = v_outcome,
         updated_at = v_at,
         row_version = row_version + 1
   where id = v_session.action_id and org_id = v_session.org_id
     and state in ('dispatching', 'submitted', 'unknown');

  update private.voice_grants set revoked_at = coalesce(revoked_at, v_at)
   where org_id = v_session.org_id and action_id = v_session.action_id;

  insert into public.audit_events (org_id, actor_type, actor_id, case_id, entity_type, entity_id, event_name, reason, occurred_at)
  values (v_session.org_id, 'provider', v_provider, v_case, 'action', v_session.action_id,
          'voice.callback.recorded', v_outcome ->> 'outcome', v_at);

  insert into public.event_outbox (org_id, aggregate_id, correlation_id, causation_id, event_type, payload, created_at)
  values (v_session.org_id, v_case, v_session.action_id, v_receipt, 'supplier.call.finished',
          jsonb_build_object('case_id', v_case, 'action_id', v_session.action_id, 'conversation_id', v_conversation),
          v_at);

  return jsonb_build_object('status', 'recorded', 'receipt_id', v_receipt, 'org_id', v_session.org_id,
                            'action_id', v_session.action_id, 'case_id', v_case);
end;
$$;
