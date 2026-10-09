import { VOICE_TOKEN_HEADER } from "@/lib/integrations/elevenlabs/capability";
import { handleVoiceToolRequest } from "@/lib/integrations/elevenlabs/tools";
import { getVoiceStore } from "@/lib/integrations/elevenlabs/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ tool: string }> }) {
  const { tool } = await context.params;
  const text = await request.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ ok: false, code: "invalid_json", message: "Body must be JSON." }, { status: 400 });
    }
  }
  try {
    const result = await handleVoiceToolRequest(tool, request.headers.get(VOICE_TOKEN_HEADER), body, {
      store: getVoiceStore(),
      now: () => new Date(),
    });
    return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json(
      { ok: false, code: "unavailable", message: "Tool temporarily unavailable; request human review." },
      { status: 503 },
    );
  }
}
