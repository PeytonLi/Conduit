import type { InngestFunction } from "inngest";
import { inngest } from "./client";
import "@/lib/integrations/elevenlabs/register";
import { voiceStaleCallSweep } from "./voice-call";

export const functions: InngestFunction.Any[] = [voiceStaleCallSweep];
export { inngest };
