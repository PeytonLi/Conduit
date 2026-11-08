import { recordFxRateHandler } from "@/lib/actions/api/handlers";
import { routeDeps } from "@/lib/actions/api/routes";

export async function POST(request: Request) {
  return recordFxRateHandler(routeDeps(), request);
}
