import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const revoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/integrations/gmail/revoke", () => ({ revokeGmailCredential: revoke }));

import { RpcError, type RpcClient } from "@/lib/db/messages";
import { QueryError } from "@/lib/db/queries/client";
import {
  disconnectMailboxConnection,
  setPrimaryMailbox,
} from "@/lib/integrations/mailbox/connections";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000b1";
const ID = "00000000-0000-4000-8000-0000000000c1";
const env = { CREDENTIAL_ENCRYPTION_KEY: undefined, COMPOSIO_API_KEY: undefined };

function rpcWith(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: RpcClient = {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ fn, args });
      const handler = handlers[fn];
      if (!handler) throw new Error(`unexpected rpc ${fn}`);
      return handler(args) as T;
    },
  };
  return { rpc, calls };
}

describe("disconnectMailboxConnection", () => {
  it("disconnects by id inside the caller's organization, revoking a Gmail token first", async () => {
    revoke.mockClear();
    const { rpc, calls } = rpcWith({
      mailbox_load_credential: () => ({ provider: "gmail", status: "healthy" }),
      ui_disconnect_connection: () => ({ ok: true, disconnected: true }),
    });
    await disconnectMailboxConnection({ rpc, env, orgId: ORG, actorUserId: USER, connectionId: ID });

    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, connectionId: ID }));
    expect(calls.map((c) => c.fn)).toEqual(["mailbox_load_credential", "ui_disconnect_connection"]);
    expect(calls[1].args).toEqual({ org_id: ORG, actor_user_id: USER, connection_id: ID });
  });

  it("deletes an Outlook credential locally without calling a revocation endpoint", async () => {
    revoke.mockClear();
    const { rpc } = rpcWith({
      mailbox_load_credential: () => ({ provider: "outlook", status: "expired" }),
      ui_disconnect_connection: () => ({ ok: true, disconnected: true }),
    });
    await expect(
      disconnectMailboxConnection({ rpc, env, orgId: ORG, actorUserId: USER, connectionId: ID }),
    ).resolves.toMatchObject({ disconnected: true });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("answers 404 for a connection of another organization or one that is not a mailbox", async () => {
    const missing = rpcWith({
      mailbox_load_credential: () => {
        throw new RpcError("P0404", "mailbox connection not found");
      },
      ui_disconnect_connection: () => {
        throw new Error("must not run");
      },
    });
    await expect(
      disconnectMailboxConnection({ rpc: missing.rpc, env, orgId: ORG, actorUserId: USER, connectionId: ID }),
    ).rejects.toMatchObject({ status: 404, code: "mailbox_not_found" });

    const erp = rpcWith({
      mailbox_load_credential: () => ({ provider: "quickbooks", status: "healthy" }),
    });
    await expect(
      disconnectMailboxConnection({ rpc: erp.rpc, env, orgId: ORG, actorUserId: USER, connectionId: ID }),
    ).rejects.toBeInstanceOf(QueryError);
    expect(erp.calls.map((c) => c.fn)).toEqual(["mailbox_load_credential"]);
  });
});

describe("setPrimaryMailbox", () => {
  it("returns whether the primary changed", async () => {
    const { rpc, calls } = rpcWith({
      mailbox_set_primary: () => ({ ok: true, changed: true, connection_id: ID }),
    });
    await expect(setPrimaryMailbox({ rpc, orgId: ORG, actorUserId: USER, connectionId: ID })).resolves.toEqual({
      connection_id: ID,
      changed: true,
    });
    expect(calls[0].args).toEqual({ org_id: ORG, actor_user_id: USER, connection_id: ID });
  });

  it("refuses a mailbox that is not connected", async () => {
    const { rpc } = rpcWith({ mailbox_set_primary: () => ({ ok: false, code: "not_connected" }) });
    await expect(
      setPrimaryMailbox({ rpc, orgId: ORG, actorUserId: USER, connectionId: ID }),
    ).rejects.toMatchObject({ status: 409, code: "mailbox_not_connected" });
  });
});
