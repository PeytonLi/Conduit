import { describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "@/lib/auth/membership";
import { recordFxRateHandler, type HandlerDeps } from "./handlers";

const body = { from_currency: "EUR", numerator: "11", denominator: "10",
  as_of: "2026-10-12T15:00:00Z", source: "Owner bank quote" };
const request = (value: unknown) => new Request("http://localhost/api/v1/fx-rates", {
  method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json" },
});
const rpc = vi.fn(async () => ({ ok: true, rate_id: "rate" }));
const deps = { ledger: { rpc, clock: { now: () => new Date(body.as_of) } },
  auth: vi.fn(async () => ({ orgId: "org", userId: "owner", role: "owner" })), publish: vi.fn(),
} as unknown as HandlerDeps;

describe("owner-entered FX API", () => {
  it("derives tenant and actor from membership and validates evidence", async () => {
    expect((await recordFxRateHandler(deps, request(body))).status).toBe(201);
    expect(rpc).toHaveBeenCalledWith("fx_rate_record", expect.objectContaining({ p_org_id: "org", p_actor_user_id: "owner", p_numerator: "11" }));
    for (const invalid of [{ ...body, numerator: "0" }, { ...body, source: "" },
      { ...body, as_of: "yesterday" }, { ...body, org_id: "attacker" }]) {
      expect((await recordFxRateHandler(deps, request(invalid))).status).toBe(422);
    }
  });
  it("rejects callers without owner authority", async () => {
    const denied = { ...deps, auth: async () => { throw new AuthorizationError(); } };
    expect((await recordFxRateHandler(denied, request(body))).status).toBe(403);
  });
});
