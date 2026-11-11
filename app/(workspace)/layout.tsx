import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { AuthenticationError, AuthorizationError, requireMembership } from "@/lib/auth";
import { QueryError } from "@/lib/db/queries/client";
import { getBusinessData } from "@/lib/db/queries/business-data";
import { listConnections, type ConnectionsResult } from "@/lib/db/queries/connections";
import { listCases } from "@/lib/db/queries/cases";
import { caseListQuerySchema } from "@/lib/db/queries/contracts";
import { getOrganization, getSignedInEmail } from "@/lib/db/queries/organization";
import { getCurrentPolicy } from "@/lib/db/queries/policies";
import { listSuppliers } from "@/lib/db/queries/suppliers";
import { systemClock } from "@/lib/db/queries/clock";
import { capabilities, parseServerEnv } from "@/lib/env";
import { isOnboardingComplete } from "@/lib/ui/get-started";

async function settle<T>(label: string, task: Promise<T>, fallback: T): Promise<T> {
  try {
    return await task;
  } catch (error) {
    if (error instanceof QueryError) {
      console.error(`workspace layout: ${label} unavailable`, {
        code: error.code,
        status: error.status,
        message: error.message,
      });
      return fallback;
    }
    throw error;
  }
}

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let membership;
  try {
    membership = await requireMembership();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      redirect("/login");
    }
    if (error instanceof AuthorizationError) {
      redirect("/signup?error=membership");
    }
    throw error;
  }
  const env = parseServerEnv(process.env);
  const emptyConnections: ConnectionsResult = {
    connections: [],
    environment_capabilities: capabilities(env),
  };
  const [organization, email, business, connections, suppliers, policy, cases] = await Promise.all([
    getOrganization(membership),
    settle("signed-in email", getSignedInEmail(membership), null),
    settle("business data", getBusinessData(membership), {
      datasets: [],
      inventory: [],
      demand: [],
      purchase_orders: [],
    }),
    settle("connections", listConnections(membership), emptyConnections),
    settle("suppliers", listSuppliers(membership), []),
    settle("policy", getCurrentPolicy(membership), null),
    settle(
      "cases",
      listCases(membership, caseListQuerySchema.parse({ limit: 1 }), systemClock.now()),
      {
        items: [],
        next_cursor: null,
        total_matching: 0,
        counts: {
          by_phase: {
            new: 0,
            needs_review: 0,
            assessing: 0,
            recovering: 0,
            awaiting_supplier: 0,
            awaiting_approval: 0,
            executing: 0,
            monitoring: 0,
            closed: 0,
          },
        },
        summary: {
          active_shortages: 0,
          decisions_waiting: 0,
          uncertain_actions: 0,
          recoveries_recorded: 0,
          active_cases: 0,
          total_cases: 0,
        },
        refreshed_at: new Date(0).toISOString(),
      },
    ),
  ]);
  const onboardingComplete = isOnboardingComplete(
    connections.connections,
    business,
    suppliers,
    policy !== null,
    cases.items.length,
  );

  return (
    <WorkspaceShell
      membership={membership}
      organization={organization}
      email={email}
      environment={env.APP_ENV}
      onboardingComplete={onboardingComplete}
    >
      {children}
    </WorkspaceShell>
  );
}
