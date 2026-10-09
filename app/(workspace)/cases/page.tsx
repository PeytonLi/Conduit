import { CaseQueue } from "@/components/CaseQueue";
import { requireMembership } from "@/lib/auth";
import { listCases } from "@/lib/db/queries/cases";
import { caseListQuerySchema, type CaseListQuery } from "@/lib/db/queries/contracts";
import { systemClock } from "@/lib/db/queries/clock";

type SearchParams = Record<string, string | string[] | undefined>;

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function filtersFromSearchParams(params: SearchParams): CaseListQuery {
  const parsed = caseListQuerySchema.safeParse({
    phase: asArray(params.phase),
    severity: asArray(params.severity),
    assignee: Array.isArray(params.assignee) ? params.assignee[0] : params.assignee,
    supplier: Array.isArray(params.supplier) ? params.supplier[0] : params.supplier,
    item: Array.isArray(params.item) ? params.item[0] : params.item,
    needs_my_decision: params.needs_my_decision,
    data_stale: params.data_stale,
    uncertain_action: params.uncertain_action,
    closed_outcome: Array.isArray(params.closed_outcome) ? params.closed_outcome[0] : params.closed_outcome,
    q: Array.isArray(params.q) ? params.q[0] : params.q,
    include_closed: params.include_closed,
    limit: Array.isArray(params.limit) ? params.limit[0] : params.limit,
  });
  return parsed.success ? parsed.data : { limit: 25 };
}

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const membership = await requireMembership();
  const filters = filtersFromSearchParams(await searchParams);
  let initialData = null;
  let initialError = false;
  try {
    initialData = await listCases(membership, filters, systemClock.now());
  } catch {
    initialError = true;
  }
  return (
    <CaseQueue
      initialData={initialData}
      initialFilters={filters}
      initialError={initialError}
      userId={membership.userId}
    />
  );
}
