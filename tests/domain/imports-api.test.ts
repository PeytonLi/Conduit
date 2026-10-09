import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportStore, StageResult } from "@/lib/db/imports";
import { AuthenticationError, AuthorizationError } from "@/lib/auth";
import { POST as createImportRoute } from "@/app/api/v1/imports/route";
import { GET as getImportRoute } from "@/app/api/v1/imports/[importId]/route";
import { POST as activateImportRoute } from "@/app/api/v1/imports/[importId]/activate/route";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  getImportStore: vi.fn(),
}));

vi.mock("@/lib/auth", () => {
  class MockAuthenticationError extends Error {}
  class MockAuthorizationError extends Error {}
  return {
    requireMembership: mocks.requireMembership,
    AuthenticationError: MockAuthenticationError,
    AuthorizationError: MockAuthorizationError,
  };
});

vi.mock("@/lib/db/imports", () => ({
  getImportStore: mocks.getImportStore,
}));

const orgId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const importId = "30000000-0000-4000-8000-000000000001";
const datasetId = "40000000-0000-4000-8000-000000000001";
const metadata = {
  schema_version: 1 as const,
  source_as_of: "2026-10-12T15:00:00Z",
  timezone: "America/Los_Angeles",
  currency: "USD",
};
const fixtureFiles = [
  "suppliers.csv",
  "items.csv",
  "purchase_orders.csv",
  "purchase_order_lines.csv",
  "receipt_schedules.csv",
  "inventory.csv",
  "demand.csv",
];

let store: ImportStore;

function makeForm(invalid = false) {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  for (const fileName of fixtureFiles) {
    let content = readFileSync(
      join(process.cwd(), "tests/fixtures/harbor-pack", fileName),
      "utf8",
    );
    if (invalid && fileName === "inventory.csv") {
      content = content.replace("600,0,0", "1,2,0");
    }
    form.append(fileName, new File([content], fileName, { type: "text/csv" }));
  }
  return form;
}

function makePostRequest(
  path: string,
  form?: FormData,
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    ...(form ? { body: form } : {}),
  });
}

async function responseJson(response: Response) {
  return response.json() as Promise<{
    data?: Record<string, unknown>;
    error?: { code: string };
  }>;
}

describe("import API routes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T15:00:00Z"));
    mocks.requireMembership.mockReset().mockResolvedValue({ userId, orgId, role: "owner" });
    mocks.getImportStore.mockReset();

    store = {
      listLocations: vi.fn().mockResolvedValue([{
        id: "50000000-0000-4000-8000-000000000001",
        externalId: "MAIN-WAREHOUSE",
        timezone: "America/Los_Angeles",
      }]),
      getOrgCurrency: vi.fn().mockResolvedValue("USD"),
      stageImport: vi.fn(async (args): Promise<StageResult> => {
        if (!args.valid) {
          return {
            outcome: "invalid",
            import_id: importId,
            dataset_id: null,
            status: "invalid",
            row_version: 1,
            validation_summary: args.validationSummary,
          };
        }
        return {
          outcome: "staged",
          import_id: importId,
          dataset_id: datasetId,
          status: "staged",
          row_version: 1,
          validation_summary: args.validationSummary,
        };
      }),
      activateImport: vi.fn().mockResolvedValue({
        outcome: "version_conflict",
        row_version: 2,
      }),
      getImport: vi.fn().mockResolvedValue(null),
      loadProjectionFacts: vi.fn(),
    };
    mocks.getImportStore.mockReturnValue(store);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("imports API: authenticates requests and restricts imports to owners and operators", async () => {
    mocks.requireMembership.mockRejectedValueOnce(new AuthenticationError());
    const unauthenticated = await createImportRoute(makePostRequest("/api/v1/imports"));
    expect(unauthenticated.status).toBe(401);
    expect((await responseJson(unauthenticated)).error?.code).toBe("unauthenticated");

    mocks.requireMembership.mockRejectedValueOnce(new AuthorizationError());
    const viewer = await createImportRoute(makePostRequest("/api/v1/imports"));
    expect(viewer.status).toBe(403);
    expect((await responseJson(viewer)).error?.code).toBe("forbidden");
  });

  it("imports API: requires idempotency keys and rejects mismatched origins before parsing", async () => {
    const missingKey = await createImportRoute(makePostRequest(
      "/api/v1/imports",
      undefined,
      { Origin: "http://localhost" },
    ));
    expect(missingKey.status).toBe(422);
    expect((await responseJson(missingKey)).error?.code).toBe("idempotency_key_required");

    const mismatch = await createImportRoute(makePostRequest(
      "/api/v1/imports",
      undefined,
      { Origin: "https://attacker.example", "Idempotency-Key": "bad-origin" },
    ));
    expect(mismatch.status).toBe(403);
    expect((await responseJson(mismatch)).error?.code).toBe("origin_mismatch");
  });

  it("imports API: creates staged imports from multipart CSV uploads", async () => {
    const response = await createImportRoute(makePostRequest(
      "/api/v1/imports",
      makeForm(),
      { Origin: "http://localhost", "Idempotency-Key": "stage-harbor" },
    ));
    const body = await responseJson(response);
    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      import_id: importId,
      status: "staged",
      row_version: 1,
      dataset_id: datasetId,
      preview: { counts: { "suppliers.csv": 4 } },
    });
    expect(store.stageImport).toHaveBeenCalledWith(expect.objectContaining({ valid: true }));
  });

  it("imports API: persists invalid multipart imports with validation errors", async () => {
    const response = await createImportRoute(makePostRequest(
      "/api/v1/imports",
      makeForm(true),
      { Origin: "http://localhost", "Idempotency-Key": "invalid-harbor" },
    ));
    const body = await responseJson(response);
    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      import_id: importId,
      status: "invalid",
      validation_summary: {
        errors: [expect.objectContaining({ code: "contradictory_stock" })],
      },
    });
    expect(store.stageImport).toHaveBeenCalledWith(expect.objectContaining({
      valid: false,
      payload: null,
    }));
  });

  it("imports API: maps stage idempotency conflicts and replays to their documented responses", async () => {
    vi.mocked(store.stageImport).mockResolvedValueOnce({ outcome: "idempotency_conflict" });
    const conflict = await createImportRoute(makePostRequest(
      "/api/v1/imports",
      makeForm(),
      { "Idempotency-Key": "conflict" },
    ));
    expect(conflict.status).toBe(409);
    expect((await responseJson(conflict)).error?.code).toBe("idempotency_conflict");

    vi.mocked(store.stageImport).mockResolvedValueOnce({
      outcome: "replayed",
      import_id: importId,
      dataset_id: datasetId,
      status: "staged",
      row_version: 1,
      content_hash: "hash",
      source_as_of: metadata.source_as_of,
      validation_summary: { errors: [], warnings: [], counts: {} },
    });
    const replay = await createImportRoute(makePostRequest(
      "/api/v1/imports",
      makeForm(),
      { "Idempotency-Key": "replay" },
    ));
    expect(replay.status).toBe(200);
    expect((await responseJson(replay)).data).toMatchObject({
      import_id: importId,
      status: "staged",
      row_version: 1,
      dataset_id: datasetId,
    });

    vi.mocked(store.stageImport).mockResolvedValueOnce({
      outcome: "replayed",
      import_id: importId,
      dataset_id: datasetId,
      status: "active",
      row_version: 2,
      content_hash: "hash",
      source_as_of: metadata.source_as_of,
      validation_summary: { errors: [], warnings: [], counts: {} },
    });
    const activeReplay = await createImportRoute(makePostRequest(
      "/api/v1/imports",
      makeForm(),
      { "Idempotency-Key": "replay-active" },
    ));
    expect(activeReplay.status).toBe(200);
    expect((await responseJson(activeReplay)).data).toMatchObject({
      import_id: importId,
      status: "active",
      row_version: 2,
      dataset_id: datasetId,
    });
  });

  it("imports API: maps stale activation versions to conflict responses", async () => {
    const response = await activateImportRoute(
      makePostRequest(
        `/api/v1/imports/${importId}/activate`,
        undefined,
        {
          Origin: "http://localhost",
          "Idempotency-Key": "activate",
          "Content-Type": "application/json",
        },
      ),
      { params: Promise.resolve({ importId }) },
    );
    expect(response.status).toBe(422);

    const conflict = await activateImportRoute(
      new Request(`http://localhost/api/v1/imports/${importId}/activate`, {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Idempotency-Key": "activate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expected_version: 1 }),
      }),
      { params: Promise.resolve({ importId }) },
    );
    expect(conflict.status).toBe(409);
    expect((await responseJson(conflict)).error?.code).toBe("conflict");
  });

  it("imports API: returns 404 for malformed and cross-tenant import IDs", async () => {
    const malformed = await getImportRoute(new Request("http://localhost"), {
      params: Promise.resolve({ importId: "not-a-uuid" }),
    });
    expect(malformed.status).toBe(404);

    vi.mocked(store.getImport).mockResolvedValueOnce(null);
    const crossTenant = await getImportRoute(new Request(`http://localhost/${importId}`), {
      params: Promise.resolve({ importId }),
    });
    expect(crossTenant.status).toBe(404);
    expect((await responseJson(crossTenant)).error?.code).toBe("not_found");
    expect(store.getImport).toHaveBeenCalledWith(orgId, importId);
  });
});
