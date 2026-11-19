-- Turn-by-turn supplier call transcripts (text only; audio is never retained).
alter table public.call_sessions
  add column transcript jsonb,
  add column transcript_summary text;

comment on column public.call_sessions.transcript is
  'Provider transcript as [{role: agent|supplier, message, at_seconds}]. Untrusted supplier speech; cleared when the call''s evidence expires.';

-- Retention: when the call's evidence is tombstoned under the org's retention policy, the transcript goes with it.
create or replace function private.clear_call_transcript_on_tombstone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tombstoned_at is not null and old.tombstoned_at is null then
    update public.call_sessions
    set transcript = null, transcript_summary = null
    where org_id = new.org_id and transcript_evidence_id = new.id;
  end if;
  return new;
end;
$$;

create trigger evidence_tombstone_clears_call_transcript
  after update of tombstoned_at on public.evidence
  for each row execute function private.clear_call_transcript_on_tombstone();
