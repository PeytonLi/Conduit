import { notFound } from "next/navigation";
import { CaseDetailView } from "@/components/CaseDetailView";
import { requireMembership } from "@/lib/auth";
import {
  getCaseDetail,
  getCaseEvidence,
  getCaseOptions,
  getCaseTimeline,
} from "@/lib/db/queries/cases";
import { QueryError } from "@/lib/db/queries/client";
import { systemClock } from "@/lib/db/queries/clock";
import { getOrganization } from "@/lib/db/queries/organization";

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [{ caseId }, { tab }] = await Promise.all([params, searchParams]);
  const membership = await requireMembership();
  let result;
  try {
    result = await Promise.all([
      getCaseDetail(membership, caseId, systemClock.now()),
      getCaseOptions(membership, caseId),
      getCaseEvidence(membership, caseId),
      getCaseTimeline(membership, caseId),
      getOrganization(membership),
    ]);
  } catch (error) {
    if (error instanceof QueryError && error.status === 404) notFound();
    throw error;
  }
  const [detail, options, evidence, timeline, organization] = result;
  return (
    <CaseDetailView
      detail={detail}
      environmentMode={organization.environment_mode}
      evidence={evidence}
      options={options.options}
      role={membership.role}
      timeline={timeline}
      organizationTimeZone={organization.timezone}
      initialTab={typeof tab === "string" ? tab : undefined}
    />
  );
}
