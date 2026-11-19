import "server-only";
import { createServiceClient } from "@/lib/db/service";
import { extractTranscript, type CallTranscriptTurn } from "@/lib/integrations/elevenlabs/transcript";

export interface CallDetail {
  duration_seconds: number | null;
  started_at: string | null;
  contact_name: string | null;
  supplier_name: string | null;
  summary: string | null;
  transcript: CallTranscriptTurn[] | null;
}

type Client = ReturnType<typeof createServiceClient>;

async function fetchFromElevenLabs(conversationId: string, apiKey: string) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
    { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(5000) },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { status?: string };
  // Only finished conversations have a final transcript.
  if (body.status && !["done", "failed"].includes(body.status)) return null;
  return extractTranscript(body);
}

/**
 * Call details for a case's supplier calls. Calls recorded before transcripts were stored are
 * fetched once from ElevenLabs (if it still retains them) and saved, so later views read locally.
 */
export async function loadCallDetails(
  orgId: string,
  actionIds: string[],
  client: Client = createServiceClient(),
): Promise<Map<string, CallDetail>> {
  const details = new Map<string, CallDetail>();
  if (actionIds.length === 0) return details;
  const { data: sessions, error } = await client.from("call_sessions")
    .select("action_id,contact_id,provider_conversation_id,started_at,duration_seconds,transcript,transcript_summary,transcript_evidence_id")
    .eq("org_id", orgId).in("action_id", actionIds);
  if (error || !sessions) return details;

  const contactIds = [...new Set(sessions.map((s) => s.contact_id).filter(Boolean))];
  const { data: contacts } = contactIds.length
    ? await client.from("supplier_contacts").select("id,display_name,supplier_id").eq("org_id", orgId).in("id", contactIds)
    : { data: [] };
  const supplierIds = [...new Set((contacts ?? []).map((c) => c.supplier_id).filter(Boolean))];
  const { data: suppliers } = supplierIds.length
    ? await client.from("suppliers").select("id,name").eq("org_id", orgId).in("id", supplierIds)
    : { data: [] };
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));
  const supplierName = new Map((suppliers ?? []).map((s) => [s.id, s.name as string]));

  const apiKey = process.env.ELEVENLABS_API_KEY;
  for (const session of sessions) {
    let transcript = session.transcript as CallTranscriptTurn[] | null;
    let summary = session.transcript_summary as string | null;
    // Backfill once; never refill a transcript cleared by retention (its evidence is tombstoned).
    if (transcript === null && session.provider_conversation_id && apiKey) {
      const tombstoned = session.transcript_evidence_id
        ? (await client.from("evidence").select("tombstoned_at").eq("id", session.transcript_evidence_id).maybeSingle())
            .data?.tombstoned_at
        : null;
      if (!tombstoned) {
        const fetched = await fetchFromElevenLabs(session.provider_conversation_id, apiKey).catch(() => null);
        if (fetched) {
          transcript = fetched.turns;
          summary = summary ?? fetched.summary;
          await client.from("call_sessions")
            .update({ transcript, transcript_summary: summary })
            .eq("org_id", orgId).eq("action_id", session.action_id);
        }
      }
    }
    const contact = session.contact_id ? contactById.get(session.contact_id) : undefined;
    details.set(String(session.action_id), {
      duration_seconds: session.duration_seconds ?? null,
      started_at: session.started_at ?? null,
      contact_name: contact?.display_name ?? null,
      supplier_name: contact?.supplier_id ? supplierName.get(contact.supplier_id) ?? null : null,
      summary,
      transcript,
    });
  }
  return details;
}
