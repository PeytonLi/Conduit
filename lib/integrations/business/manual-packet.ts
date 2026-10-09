/** Manual execution packet for connectors that cannot write. A packet is a handoff, never an applied change. */
export interface ManualPacketStep {
  step_id: string;
  kind: string;
  item_id: string;
  quantity: number | null;
  unit: string;
  destination_location_id: string | null;
  depends_on_step_ids: string[];
  payload: Record<string, unknown>;
}

export interface ManualPacketInput {
  orgId: string;
  caseId: string;
  planId: string;
  planVersion: number;
  actionId: string | null;
  currency: string;
  grossCommitmentMinor: string | null;
  steps: ManualPacketStep[];
  generatedAt: string;
}

export interface ManualExecutionPacket {
  status: "manual_handoff";
  label: string;
  json: Record<string, unknown>;
  csv: string;
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Escapes one CSV cell, neutralising spreadsheet formula prefixes. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

export function buildManualExecutionPacket(input: ManualPacketInput): ManualExecutionPacket {
  const label = "MANUAL EXECUTION PACKET - not applied to any business system; execute and record evidence";
  const header = [
    "plan_id",
    "plan_version",
    "step_id",
    "kind",
    "item_id",
    "quantity",
    "unit",
    "destination_location_id",
    "depends_on",
    "details",
  ];
  const rows = input.steps.map((step) =>
    csvRow([
      input.planId,
      input.planVersion,
      step.step_id,
      step.kind,
      step.item_id,
      step.quantity,
      step.unit,
      step.destination_location_id,
      step.depends_on_step_ids.join(" "),
      step.payload,
    ]),
  );
  return {
    status: "manual_handoff",
    label,
    json: {
      status: "manual_handoff",
      label,
      org_id: input.orgId,
      case_id: input.caseId,
      plan_id: input.planId,
      plan_version: input.planVersion,
      action_id: input.actionId,
      currency: input.currency,
      gross_commitment_minor: input.grossCommitmentMinor,
      generated_at: input.generatedAt,
      steps: input.steps,
    },
    csv: [csvRow(header), ...rows].join("\r\n") + "\r\n",
  };
}
