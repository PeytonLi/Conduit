import { createPolicyHandler } from "@/lib/actions/api/handlers";
import { routeDeps } from "@/lib/actions/api/routes";

export async function POST(request: Request) {
  return createPolicyHandler(routeDeps(), request);
}
