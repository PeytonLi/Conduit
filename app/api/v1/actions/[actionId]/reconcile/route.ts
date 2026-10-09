import { reconcileActionHandler } from "@/lib/actions/api/handlers";
import { routeDeps } from "@/lib/actions/api/routes";

export async function POST(request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const { actionId } = await params;
  return reconcileActionHandler(routeDeps(), request, actionId);
}
