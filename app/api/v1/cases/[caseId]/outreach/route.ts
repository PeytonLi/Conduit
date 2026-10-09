import { outreachHandler } from "@/lib/actions/api/handlers";
import { routeDeps } from "@/lib/actions/api/routes";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return outreachHandler(routeDeps(), request, caseId);
}
