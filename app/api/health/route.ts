import { capabilities } from "@/lib/env";

export function GET() {
  const status = capabilities();
  const readiness = Object.fromEntries(
    Object.entries(status).map(([key, capability]) => [key, capability.ready]),
  );
  return Response.json({ capabilities: readiness });
}
