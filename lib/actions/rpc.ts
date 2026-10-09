/** Calls one F5 Postgres command. Implementations: Supabase service client (server) or pg (tests). */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type LedgerFailure = { ok: false; code: string; message: string } & Record<string, unknown>;
export type LedgerResult<T extends object> = ({ ok: true } & T) | LedgerFailure;

export async function callLedger<T extends object>(
  rpc: Rpc,
  fn: string,
  args: Record<string, unknown>,
): Promise<LedgerResult<T>> {
  const result = (await rpc(fn, args)) as LedgerResult<T> | null;
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new Error(`Ledger function ${fn} returned an invalid result`);
  }
  return result;
}
