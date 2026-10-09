import { buildProjectionInput } from "@/lib/domain/assessment-input";
import type { ImportStore } from "./store";

export async function loadProjectionInput(
  store: ImportStore,
  args: {
    orgId: string;
    itemId: string;
    locationId: string;
    horizonDays?: number;
    safetyBufferQty?: number;
  },
) {
  const facts = await store.loadProjectionFacts(args.orgId, args.itemId, args.locationId);
  return buildProjectionInput(facts, {
    ...(args.horizonDays === undefined ? {} : { horizonDays: args.horizonDays }),
    ...(args.safetyBufferQty === undefined ? {} : { safetyBufferQty: args.safetyBufferQty }),
  });
}
