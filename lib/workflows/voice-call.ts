import { inngest } from "./client";
import { getVoiceStore } from "@/lib/integrations/elevenlabs/runtime";

/** Callback expected within: max call length (~5 min) + provider retry backoff headroom. */
export const VOICE_CALLBACK_GRACE_SECONDS = 20 * 60;

/**
 * Flags supplier calls whose signed callback is overdue and requests reconciliation
 * (conversation lookup). It never redials.
 */
export const voiceStaleCallSweep = inngest.createFunction(
  { id: "voice-stale-call-sweep", triggers: [{ cron: "*/5 * * * *" }] },
  async ({ step }) => {
    const flagged = await step.run("flag-stale-calls", () =>
      getVoiceStore().flagStaleCalls(new Date(), VOICE_CALLBACK_GRACE_SECONDS),
    );
    return { flagged };
  },
);
