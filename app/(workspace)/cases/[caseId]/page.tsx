export default async function CasePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return <h1>Case {caseId} — Not implemented yet</h1>;
}
