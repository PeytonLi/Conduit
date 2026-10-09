import { z } from "zod";
import type { LedgerAction } from "./ledger";
import { callLedger, type Clock, type Rpc } from "./rpc";

export const outreachRequestSchema = z
  .object({
    contact_id: z.string().uuid(),
    channel: z.enum(["email", "phone"]),
    message: z
      .object({
        subject: z.string().trim().max(200).optional(),
        body: z.string().trim().min(1).max(5000),
      })
      .strict(),
  })
  .strict();

export type OutreachResult =
  | { result: "prepared_action"; action: LedgerAction; replayed: boolean }
  | { result: "draft"; draft_id: string; denials: string[]; replayed: boolean };

/** Prepared action if policy allows contacting this supplier now; otherwise a reviewable draft. */
export function requestOutreach(
  deps: { rpc: Rpc; clock: Clock },
  input: { orgId: string; caseId: string; userId: string; idempotencyKey: string; body: z.infer<typeof outreachRequestSchema> },
) {
  return callLedger<OutreachResult>(deps.rpc, "prepare_outreach", {
    p_org_id: input.orgId,
    p_case_id: input.caseId,
    p_actor_user_id: input.userId,
    p_contact_id: input.body.contact_id,
    p_channel: input.body.channel,
    p_payload: { message: input.body.message },
    p_idempotency_key: input.idempotencyKey,
    p_now: deps.clock.now().toISOString(),
  });
}
