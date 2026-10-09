import type { ActionKind, ProviderAdapter } from "./types";

const replayBrand = Symbol.for("conduit.replayAdapter");

/** A provider adapter that can never contact a real supplier or write a live system. */
export type ReplayAdapter = ProviderAdapter & { readonly [replayBrand]: true };

const replayAdapters = new Map<ActionKind, ReplayAdapter>();

export function asReplayAdapter(adapter: ProviderAdapter): ReplayAdapter {
  return Object.assign(adapter, { [replayBrand]: true as const });
}

export function isReplayAdapter(adapter: ProviderAdapter): adapter is ReplayAdapter {
  return (adapter as Partial<ReplayAdapter>)[replayBrand] === true;
}

export function registerReplayAdapter(adapter: ReplayAdapter): void {
  replayAdapters.set(adapter.kind, adapter);
}

export function getReplayAdapter(kind: ActionKind): ReplayAdapter {
  const adapter = replayAdapters.get(kind);
  if (!adapter || !isReplayAdapter(adapter)) {
    throw new ReplayViolationError(kind);
  }
  return adapter;
}

export class ReplayViolationError extends Error {
  constructor(kind: ActionKind) {
    super(`No replay adapter registered for ${kind}; replay mode never uses live adapters`);
    this.name = "ReplayViolationError";
  }
}
