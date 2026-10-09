import { ELEVENLABS_SIGNATURE_HEADER } from "@/lib/integrations/elevenlabs/signature";
import { handleElevenLabsWebhook } from "@/lib/integrations/elevenlabs/webhook";
import { getVoiceEnv, getVoiceStore } from "@/lib/integrations/elevenlabs/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Raw body: the signature covers the exact bytes, so it must be read before any parsing.
  const rawBody = await request.text();
  try {
    const result = await handleElevenLabsWebhook(rawBody, request.headers.get(ELEVENLABS_SIGNATURE_HEADER), {
      store: getVoiceStore(),
      secret: getVoiceEnv().ELEVENLABS_WEBHOOK_SECRET || undefined,
      now: () => new Date(),
    });
    return Response.json(result.body, { status: result.status });
  } catch {
    // Not yet durably stored: a 5xx makes ElevenLabs retry the delivery.
    return Response.json({ ok: false, code: "storage_unavailable" }, { status: 500 });
  }
}
