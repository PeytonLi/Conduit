import "server-only";
import { z } from "zod";
import { createServiceClient } from "@/lib/db/service";
import type { ProjectionFacts } from "@/lib/domain/assessment-input";
import type { NormalizedImport } from "@/lib/domain/import-validate";

const importIssueSchema = z.object({
  file: z.string().nullable(),
  row: z.number().int().nullable(),
  field: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

export const validationSummarySchema = z.object({
  errors: z.array(importIssueSchema),
  warnings: z.array(importIssueSchema),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});

const datasetStatusSchema = z.enum(["staged", "active", "superseded", "invalid"]);

const stageResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("staged"),
    import_id: z.string().uuid(),
    dataset_id: z.string().uuid(),
    status: z.literal("staged"),
    row_version: z.number().int().positive(),
    validation_summary: validationSummarySchema,
  }),
  z.object({
    outcome: z.literal("invalid"),
    import_id: z.string().uuid(),
    dataset_id: z.null(),
    status: z.literal("invalid"),
    row_version: z.number().int().positive(),
    validation_summary: validationSummarySchema,
  }),
  z.object({
    outcome: z.literal("replayed"),
    import_id: z.string().uuid(),
    dataset_id: z.string().uuid().nullable(),
    status: datasetStatusSchema,
    row_version: z.number().int().positive(),
    content_hash: z.string(),
    source_as_of: z.string(),
    validation_summary: validationSummarySchema,
  }),
  z.object({
    outcome: z.literal("noop_same_content"),
    import_id: z.string().uuid().nullable(),
    dataset_id: z.string().uuid(),
  }),
  z.object({ outcome: z.literal("idempotency_conflict") }),
]);

const activateResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("activated"),
    dataset_id: z.string().uuid(),
    superseded_dataset_id: z.string().uuid().nullable(),
    row_version: z.number().int().positive(),
  }),
  z.object({
    outcome: z.literal("already_active"),
    dataset_id: z.string().uuid(),
    row_version: z.number().int().positive(),
  }),
  z.object({
    outcome: z.literal("noop_same_content"),
    dataset_id: z.string().uuid(),
    row_version: z.number().int().positive(),
  }),
  z.object({ outcome: z.literal("not_found") }),
  z.object({
    outcome: z.literal("version_conflict"),
    row_version: z.number().int().positive(),
  }),
  z.object({
    outcome: z.literal("invalid_state"),
    status: datasetStatusSchema,
  }),
  z.object({ outcome: z.literal("forbidden_contact_confirmation") }),
]);

const projectionFactsSchema = z.object({
  dataset: z.object({
    id: z.string().uuid(),
    source_type: z.enum(["csv", "connector", "fixture"]),
    source_as_of: z.string(),
    content_hash: z.string(),
  }).nullable(),
  item: z.object({
    id: z.string().uuid(),
    base_unit: z.string(),
    specification: z.record(z.string(), z.unknown()),
  }).nullable(),
  location: z.object({
    id: z.string().uuid(),
    timezone: z.string(),
  }).nullable(),
  inventory: z.object({
    id: z.string().uuid(),
    physical_qty: z.number().int(),
    unusable_qty: z.number().int(),
    outside_allocations_qty: z.number().int(),
    source_as_of: z.string(),
  }).nullable(),
  demand: z.array(z.object({
    id: z.string().uuid(),
    external_id: z.string(),
    remaining_qty: z.number().int(),
    required_at: z.string(),
    certainty: z.enum(["confirmed", "forecast"]),
    included_reserved_qty: z.number().int(),
    source_as_of: z.string(),
  })),
  receipts: z.array(z.object({
    id: z.string().uuid(),
    po_line_id: z.string().uuid(),
    quantity_remaining: z.number().int(),
    earliest_at: z.string().nullable(),
    latest_at: z.string().nullable(),
    promise_state: z.enum(["confirmed", "estimated", "unknown"]),
    evidence_id: z.string().uuid().nullable(),
    source_as_of: z.string(),
  })),
  lines: z.array(z.object({
    id: z.string().uuid(),
    ordered_qty: z.number().int(),
    received_qty: z.number().int(),
    cancelled_qty: z.number().int(),
    unit_price_minor: z.string(),
  })),
  claims: z.array(z.object({
    id: z.string().uuid(),
    quantity: z.number().int(),
  })),
});

const locationRowsSchema = z.array(z.object({
  id: z.string().uuid(),
  external_id: z.string().nullable(),
  timezone: z.string(),
}));

const currencyRowSchema = z.object({ currency: z.string() });
const importRowSchema = z.object({
  id: z.string().uuid(),
  status: datasetStatusSchema,
  row_version: z.number().int().positive(),
  content_hash: z.string(),
  source_as_of: z.string(),
  dataset_id: z.string().uuid().nullable(),
  validation_summary: validationSummarySchema,
  created_at: z.string(),
  activated_at: z.string().nullable(),
});

export type ValidationSummary = z.infer<typeof validationSummarySchema>;
export type StageResult = z.infer<typeof stageResultSchema>;
export type ActivateResult = z.infer<typeof activateResultSchema>;
export type ImportView = {
  import_id: string;
  status: z.infer<typeof datasetStatusSchema>;
  row_version: number;
  content_hash: string;
  source_as_of: string;
  dataset_id: string | null;
  validation_summary: ValidationSummary;
  preview: { counts: Record<string, number> };
  created_at: string;
  activated_at: string | null;
};

export type StageImportArgs = {
  orgId: string;
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  contentHash: string;
  sourceAsOf: string;
  valid: boolean;
  validationSummary: ValidationSummary;
  payload: NormalizedImport | null;
};

export type ActivateImportArgs = {
  orgId: string;
  importId: string;
  expectedVersion: number;
  userId: string;
  role: "owner" | "operator" | "viewer";
  contactPermissionsConfirmed: boolean;
  idempotencyKey: string;
};

export interface ImportStore {
  listLocations(orgId: string): Promise<{ id: string; externalId: string; timezone: string }[]>;
  getOrgCurrency(orgId: string): Promise<string>;
  stageImport(args: StageImportArgs): Promise<StageResult>;
  activateImport(args: ActivateImportArgs): Promise<ActivateResult>;
  getImport(orgId: string, importId: string): Promise<ImportView | null>;
  loadProjectionFacts(orgId: string, itemId: string, locationId: string): Promise<ProjectionFacts>;
}

export class ImportStoreError extends Error {
  constructor() {
    super("Import storage operation failed");
    this.name = "ImportStoreError";
  }
}

export function createSupabaseImportStore(
  client = createServiceClient(),
): ImportStore {
  return {
    async listLocations(orgId) {
      const { data, error } = await client
        .from("locations")
        .select("id, external_id, timezone")
        .eq("org_id", orgId)
        .eq("active", true);
      if (error) throw new ImportStoreError();
      return locationRowsSchema.parse(data ?? [])
        .filter((location) => location.external_id !== null)
        .map((location) => ({
          id: location.id,
          externalId: location.external_id!,
          timezone: location.timezone,
        }));
    },

    async getOrgCurrency(orgId) {
      const { data, error } = await client
        .from("organizations")
        .select("currency")
        .eq("id", orgId)
        .maybeSingle();
      if (error || data === null) throw new ImportStoreError();
      return currencyRowSchema.parse(data).currency;
    },

    async stageImport(args) {
      const { data, error } = await client.rpc("stage_import", {
        p_org_id: args.orgId,
        p_actor: args.userId,
        p_idempotency_key: args.idempotencyKey,
        p_request_hash: args.requestHash,
        p_content_hash: args.contentHash,
        p_source_as_of: args.sourceAsOf,
        p_valid: args.valid,
        p_validation_summary: args.validationSummary,
        p_payload: args.payload,
      });
      if (error) throw new ImportStoreError();
      return stageResultSchema.parse(data);
    },

    async activateImport(args) {
      const { data, error } = await client.rpc("activate_import", {
        p_org_id: args.orgId,
        p_import_id: args.importId,
        p_expected_version: args.expectedVersion,
        p_actor: args.userId,
        p_actor_role: args.role,
        p_contact_permissions_confirmed: args.contactPermissionsConfirmed,
        p_idempotency_key: args.idempotencyKey,
      });
      if (error) throw new ImportStoreError();
      return activateResultSchema.parse(data);
    },

    async getImport(orgId, importId) {
      const { data, error } = await client
        .from("import_sessions")
        .select("id, status, row_version, content_hash, source_as_of, dataset_id, validation_summary, created_at, activated_at")
        .eq("org_id", orgId)
        .eq("id", importId)
        .maybeSingle();
      if (error) throw new ImportStoreError();
      if (data === null) return null;
      const row = importRowSchema.parse(data);
      return {
        import_id: row.id,
        status: row.status,
        row_version: row.row_version,
        content_hash: row.content_hash,
        source_as_of: row.source_as_of,
        dataset_id: row.dataset_id,
        validation_summary: row.validation_summary,
        preview: { counts: row.validation_summary.counts },
        created_at: row.created_at,
        activated_at: row.activated_at,
      };
    },

    async loadProjectionFacts(orgId, itemId, locationId) {
      const { data, error } = await client.rpc("load_projection_facts", {
        p_org_id: orgId,
        p_item_id: itemId,
        p_location_id: locationId,
      });
      if (error) throw new ImportStoreError();
      return projectionFactsSchema.parse(data) as ProjectionFacts;
    },
  };
}
