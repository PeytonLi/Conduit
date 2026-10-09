import type { ActionKind, ProviderAdapter } from "./types";

const adapters = new Map<ActionKind, ProviderAdapter>();

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.kind, adapter);
}

export function getAdapter(kind: ActionKind): ProviderAdapter {
  const adapter = adapters.get(kind);
  if (!adapter) {
    throw new Error(`No provider adapter registered for ${kind}`);
  }
  return adapter;
}
