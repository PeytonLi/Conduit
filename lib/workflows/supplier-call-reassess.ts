import { inngest } from "./client";
import { createServiceClient } from "@/lib/db/service";
import { createSupabaseVoiceStore } from "@/lib/db/voice-store-supabase";
import { reassessFinishedSupplierCall, type FinishedSupplierCall } from "@/lib/domain/supplier-call-reassess";

export const reassessAfterSupplierCallFunction = inngest.createFunction(
  {
    id: "reassess-after-supplier-call",
    triggers: [{ event: "supplier.call.finished" }],
  },
  async ({ event, step }) => {
    const client = createServiceClient();
    const voiceStore = createSupabaseVoiceStore(client);
    return step.run("reassess-after-supplier-offer", () =>
      reassessFinishedSupplierCall(
        {
          async loadAction(orgId, actionId) {
            const { data, error } = await client
              .from("actions")
              .select("case_id,permitted_by")
              .eq("org_id", orgId)
              .eq("id", actionId)
              .maybeSingle();
            if (error) throw new Error(`supplier call action lookup failed: ${error.message}`);
            return data;
          },
          loadOutcome: (orgId, actionId) => voiceStore.callOutcome(orgId, actionId),
          async requestReassessment(input) {
            const { data, error } = await client.rpc("request_reassess_after_call", {
              p: {
                org_id: input.org_id,
                case_id: input.case_id,
                action_id: input.action_id,
                source_event_id: input.event_id,
                outcome: input.outcome,
              },
            });
            if (error) throw new Error(`supplier call reassessment failed: ${error.message}`);
            return data;
          },
        },
        event.data as FinishedSupplierCall,
      ),
    );
  },
);
