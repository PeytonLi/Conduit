import type { InngestFunction } from "inngest";
import { inngest } from "./client";
import "@/lib/integrations/elevenlabs/register";
import { voiceStaleCallSweep } from "./voice-call";

import { caseAssessmentFunction } from "./case-assessment";
import { caseRecoveryFunction } from "./case-recovery";

export const functions: InngestFunction.Any[] = [
  voiceStaleCallSweep,
  caseAssessmentFunction,
  caseRecoveryFunction,
];
export { inngest };
