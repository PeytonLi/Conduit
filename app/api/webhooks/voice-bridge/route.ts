import { CONDUIT_SIGNATURE_HEADER } from "@/lib/integrations/elevenlabs/signature";
import { handleVoiceBridgeWebhook } from "@/lib/integrations/elevenlabs/bridge-webhook";
import { getVoiceEnv, getVoiceStore } from "@/lib/integrations/elevenlabs/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    const env = getVoiceEnv();
    if (!env.VOICE_BRIDGE_SECRET) {
      return Response.json({ ok: false, code: "not_configured" }, { status: 503 });
    }
    const result = await handleVoiceBridgeWebhook(
      rawBody,
      request.headers.get(CONDUIT_SIGNATURE_HEADER),
      {
        store: getVoiceStore(),
        secret: env.VOICE_BRIDGE_SECRET,
        now: () => new Date(),
      },
    );
    return Response.json(result.body, { status: result.status });
  } catch {
    return Response.json({ ok: false, code: "storage_unavailable" }, { status: 500 });
  }
}
