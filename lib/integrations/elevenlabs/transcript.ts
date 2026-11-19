export interface CallTranscriptTurn {
  role: "agent" | "supplier";
  message: string;
  at_seconds: number | null;
}

type Loose = Record<string, unknown>;
const rec = (value: unknown): Loose => (value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : {});

/** Normalizes an ElevenLabs conversation transcript into agent/supplier turns; tool-only turns are dropped. */
export function extractTranscript(data: unknown): { turns: CallTranscriptTurn[]; summary: string | null } {
  const body = rec(data);
  const raw = Array.isArray(body.transcript) ? body.transcript : [];
  const turns: CallTranscriptTurn[] = [];
  for (const entry of raw.slice(0, 1000)) {
    const turn = rec(entry);
    const message = typeof turn.message === "string" ? turn.message.trim() : "";
    if (!message) continue;
    const at = turn.time_in_call_secs;
    turns.push({
      role: turn.role === "user" ? "supplier" : "agent",
      message: message.slice(0, 4000),
      at_seconds: typeof at === "number" && Number.isFinite(at) ? at : null,
    });
  }
  const summary = rec(body.analysis).transcript_summary;
  return { turns, summary: typeof summary === "string" && summary.trim() ? summary.trim().slice(0, 4000) : null };
}
