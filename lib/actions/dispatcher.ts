import { getAdapter } from "./adapters";
import {
  claimDispatch,
  getAction,
  recordOutcome,
  terminalStates,
  toActionRecord,
  type Ledger,
  type LedgerAction,
} from "./ledger";
import { getReplayAdapter } from "./replay";
import type { ActionKind, DispatchResult, ProviderAdapter, ReconcileResult } from "./types";

export type AdapterResolver = (kind: ActionKind, mode: LedgerAction["mode"]) => ProviderAdapter;

export interface DispatcherDeps extends Ledger {
  resolveAdapter?: AdapterResolver;
  /** A dispatching claim younger than this is treated as in flight by another worker. */
  leaseSeconds?: number;
}

export type DispatchReport =
  | { status: "dispatched" | "reconciled"; action: LedgerAction }
  | { status: "in_flight" | "terminal" | "awaiting_manual_confirmation" | "not_dispatched"; action: LedgerAction }
  | { status: "held"; code: string; action: LedgerAction }
  | { status: "not_found" };

export class ModeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeViolationError";
  }
}

/** Server-side mode enforcement: replay actions can only ever reach replay adapters. */
export const resolveAdapterForMode: AdapterResolver = (kind, mode) => {
  if (mode === "replay") {
    return getReplayAdapter(kind);
  }
  if (mode === "live" && kind === "demo_ledger_amendment") {
    throw new ModeViolationError("The demo ledger is never written in live mode");
  }
  return getAdapter(kind);
};

const DEFAULT_LEASE_SECONDS = 300;
const uncertain = (safeSummary: string): DispatchResult => ({ outcome: "unknown", safeSummary });

/**
 * Dispatches one action at most once. A retry always reads the ledger first: anything already
 * dispatching, submitted or unknown is reconciled through findResult, never re-sent.
 */
export async function dispatchAction(deps: DispatcherDeps, orgId: string, actionId: string): Promise<DispatchReport> {
  const read = await getAction(deps, orgId, actionId);
  if (!read.ok) return { status: "not_found" };
  const action = read.action;
  if (action.state !== "prepared") {
    return reconcileExisting(deps, action);
  }

  const adapter = (deps.resolveAdapter ?? resolveAdapterForMode)(action.kind, action.mode);
  const claim = await claimDispatch(deps, orgId, actionId, deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS);
  if (!claim.ok) {
    const latest = await getAction(deps, orgId, actionId);
    if (!latest.ok) return { status: "not_found" };
    if (claim.code === "not_claimable") return reconcileExisting(deps, latest.action);
    return { status: "held", code: claim.code, action: latest.action };
  }

  let result: DispatchResult;
  let errorCode: string | null = null;
  try {
    result = await adapter.dispatch(toActionRecord(claim.action));
  } catch {
    // The request may have reached the provider; record uncertainty instead of retrying.
    result = uncertain("Provider call did not return a definitive result");
    errorCode = "dispatch_exception";
  }
  const recorded = await recordOutcome(deps, orgId, actionId, result, "dispatch", errorCode);
  return finish(deps, orgId, actionId, recorded, "dispatched");
}

export async function reconcileAction(deps: DispatcherDeps, orgId: string, actionId: string): Promise<DispatchReport> {
  const read = await getAction(deps, orgId, actionId);
  if (!read.ok) return { status: "not_found" };
  if (read.action.state === "prepared") return { status: "not_dispatched", action: read.action };
  return reconcileExisting(deps, read.action);
}

async function reconcileExisting(deps: DispatcherDeps, action: LedgerAction): Promise<DispatchReport> {
  if (terminalStates.includes(action.state)) return { status: "terminal", action };
  if (action.state === "prepared") return { status: "not_dispatched", action };
  if (action.state === "dispatching" && action.dispatch_started_at) {
    const leaseEnds = Date.parse(action.dispatch_started_at) + (deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    if (deps.clock.now().getTime() < leaseEnds) return { status: "in_flight", action };
  }
  if (action.kind === "manual_export" && action.state === "submitted") {
    return { status: "awaiting_manual_confirmation", action };
  }

  const adapter = (deps.resolveAdapter ?? resolveAdapterForMode)(action.kind, action.mode);
  let result: ReconcileResult;
  try {
    result = await adapter.findResult(toActionRecord(action));
  } catch {
    result = { outcome: "unknown", safeSummary: "Provider status lookup failed" };
  }
  if (action.state === "submitted" && result.outcome === "unknown") {
    return { status: "reconciled", action };
  }
  const recorded = await recordOutcome(deps, action.org_id, action.id, result, "reconcile");
  return finish(deps, action.org_id, action.id, recorded, "reconciled");
}

async function finish(
  deps: DispatcherDeps,
  orgId: string,
  actionId: string,
  recorded: Awaited<ReturnType<typeof recordOutcome>>,
  status: "dispatched" | "reconciled",
): Promise<DispatchReport> {
  if (recorded.ok) return { status, action: recorded.action };
  const latest = await getAction(deps, orgId, actionId);
  if (!latest.ok) return { status: "not_found" };
  return { status: "held", code: recorded.code, action: latest.action };
}
