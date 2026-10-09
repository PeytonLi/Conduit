import { getActionHandler } from "@/lib/actions/api/handlers";
import { routeDeps } from "@/lib/actions/api/routes";

export async function GET(_request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const { actionId } = await params;
  return getActionHandler(routeDeps(), actionId);
}
