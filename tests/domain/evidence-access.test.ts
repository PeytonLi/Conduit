import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryContext } from "@/lib/db/queries/client";

const mocks = vi.hoisted(() => ({
  evidence: null as null | {
    id: string;
    private_object_path: string | null;
    retention_until: string | null;
    tombstoned_at: string | null;
  },
  query: null as unknown as {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
  },
  storage: { createSignedUrl: vi.fn() },
}));

vi.mock("@/lib/db/service", () => ({
  createServiceClient: () => ({
    from: () => mocks.query,
    storage: { from: () => mocks.storage },
  }),
}));

import { getEvidenceAccess } from "@/lib/db/queries/evidence-access";

describe("AT-38 evidence access", () => {
  beforeEach(() => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockImplementation(async () => ({
      data: mocks.evidence,
      error: null,
    }));
    mocks.query = query;
    mocks.storage.createSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://storage.example/signed" },
      error: null,
    });
  });

  it("returns HTTP 410 for a due retention timestamp or a tombstone", async () => {
    const context = { orgId: "org-1" } as QueryContext;
    const now = new Date("2026-10-12T15:00:00.000Z");
    for (const evidence of [
      {
        id: "evidence-1",
        private_object_path: "org-1/source.eml",
        retention_until: now.toISOString(),
        tombstoned_at: null,
      },
      {
        id: "evidence-2",
        private_object_path: null,
        retention_until: "2026-10-13T00:00:00.000Z",
        tombstoned_at: "2026-10-12T14:00:00.000Z",
      },
    ]) {
      mocks.evidence = evidence;
      await expect(getEvidenceAccess(context, evidence.id, now)).rejects.toMatchObject({
        code: "source_expired",
        status: 410,
        message: "Source expired",
      });
    }
    expect(mocks.storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it("signs a retained evidence object", async () => {
    mocks.evidence = {
      id: "evidence-3",
      private_object_path: "org-1/source.eml",
      retention_until: null,
      tombstoned_at: null,
    };
    await expect(
      getEvidenceAccess({ orgId: "org-1" } as QueryContext, "evidence-3", new Date("2026-10-12T15:00:00.000Z")),
    ).resolves.toEqual({
      url: "https://storage.example/signed",
      expires_at: "2026-10-12T15:05:00.000Z",
    });
  });
});
