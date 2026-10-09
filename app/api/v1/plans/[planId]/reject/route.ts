import { rejectPlanHandler } from "@/lib/actions/api/handlers";
import { routeDeps } from "@/lib/actions/api/routes";

export async function POST(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  return rejectPlanHandler(routeDeps(), request, planId);
}
