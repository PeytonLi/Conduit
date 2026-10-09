import { createHash } from "node:crypto";
import { validateImport } from "@/lib/domain/import-validate";
import { parseInstant, toIso } from "@/lib/domain/time";
import type { ImportStore, StageResult, ValidationSummary } from "./store";

export async function createImport(args: {
  store: ImportStore;
  orgId: string;
  userId: string;
  idempotencyKey: string;
  files: Record<string, string>;
  metadata: {
    schema_version: 1;
    source_as_of: string;
    timezone: string;
    currency: string;
  };
  now: string;
}): Promise<StageResult> {
  const [orgCurrency, knownLocations] = await Promise.all([
    args.store.getOrgCurrency(args.orgId),
    args.store.listLocations(args.orgId),
  ]);
  const validation = validateImport({
    files: args.files,
    metadata: args.metadata,
    orgCurrency,
    knownLocations,
    now: args.now,
  });
  const validationSummary: ValidationSummary = {
    errors: validation.errors,
    warnings: validation.warnings,
    counts: validation.counts,
  };
  const requestHash = createHash("sha256").update(validation.contentHash).digest("hex");
  const sourceAsOfMilliseconds = parseInstant(args.metadata.source_as_of);
  const sourceAsOf = validation.payload?.metadata.source_as_of
    ?? (sourceAsOfMilliseconds === null
      ? args.now
      : toIso(sourceAsOfMilliseconds));
  return args.store.stageImport({
    orgId: args.orgId,
    userId: args.userId,
    idempotencyKey: args.idempotencyKey,
    requestHash,
    contentHash: validation.contentHash,
    sourceAsOf,
    valid: validation.ok,
    validationSummary,
    payload: validation.payload,
  });
}

export function activate(args: {
  store: ImportStore;
  orgId: string;
  userId: string;
  role: "owner" | "operator" | "viewer";
  importId: string;
  expectedVersion: number;
  contactPermissionsConfirmed: boolean;
  idempotencyKey: string;
}) {
  return args.store.activateImport({
    orgId: args.orgId,
    importId: args.importId,
    expectedVersion: args.expectedVersion,
    userId: args.userId,
    role: args.role,
    contactPermissionsConfirmed: args.contactPermissionsConfirmed,
    idempotencyKey: args.idempotencyKey,
  });
}

export function getImport(args: {
  store: ImportStore;
  orgId: string;
  importId: string;
}) {
  return args.store.getImport(args.orgId, args.importId);
}
