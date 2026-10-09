import "server-only";
import { createServiceClient } from "@/lib/db/service";
import type { Rpc } from "./rpc";

export function createServiceRpc(): Rpc {
  const client = createServiceClient();
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      throw new Error(`Ledger function ${fn} failed: ${error.code ?? "unknown"}`);
    }
    return data;
  };
}
