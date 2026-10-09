/** Minimal step surface so the helper can be unit tested with a fake step and clock. */
export interface WaitStep {
  waitForEvent(
    id: string,
    options: { event: string; timeout: string; if: string },
  ): Promise<{ data: { case_id: string; action_id: string; conversation_id: string } } | null>;
}

const ACTION_ID = /^[0-9a-f-]{36}$/i;

/**
 * Waits for supplier.call.finished for one action. Returns "missing" on timeout so the caller
 * requests action.reconcile.requested; the caller must never dispatch a second call.
 */
export async function waitForSupplierCall(step: WaitStep, actionId: string, timeout = "20m") {
  if (!ACTION_ID.test(actionId)) throw new Error("invalid action id");
  const event = await step.waitForEvent(`wait-supplier-call-${actionId}`, {
    event: "supplier.call.finished",
    timeout,
    if: `async.data.action_id == '${actionId}'`,
  });
  return event ? ({ status: "finished", conversationId: event.data.conversation_id } as const) : ({ status: "missing" } as const);
}
