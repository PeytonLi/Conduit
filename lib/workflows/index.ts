import type { InngestFunction } from "inngest";
import { inngest } from "./client";

import { caseAssessmentFunction } from "./case-assessment";
import { caseRecoveryFunction } from "./case-recovery";

export const functions: InngestFunction.Any[] = [
  caseAssessmentFunction,
  caseRecoveryFunction,
];
export { inngest };
