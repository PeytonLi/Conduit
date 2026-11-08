import { delegationKillSwitchHandler } from "@/lib/actions/api/handlers";
import { routeDeps } from "@/lib/actions/api/routes";
import { sameOriginAllowed } from "@/lib/db/queries/idempotency";
import { fail } from "@/lib/api/http";

export async function POST(request: Request) {
  if (!sameOriginAllowed(request)) return fail("origin_rejected", "Request origin is not allowed", 403, false);
  return delegationKillSwitchHandler(routeDeps(), request);
}
