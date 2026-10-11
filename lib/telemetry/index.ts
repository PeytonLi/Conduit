import { createHash } from "node:crypto";
import { maskTelemetry } from "./mask";

export interface NeatlogsModule {
  init(options?: {
    apiKey?: string;
    workflowName?: string;
    endpoint?: string;
    mask?: unknown;
    registerShutdownHandlers?: boolean;
  }): Promise<void>;
  trace<T>(
    options: { name: string; kind?: string; input?: unknown },
    fn: (span: { setAttribute(key: string, value: unknown): void }) => T | Promise<T>,
  ): Promise<T>;
  flush(): Promise<unknown>;
  shutdown(reason?: string, timeoutMs?: number): Promise<unknown>;
  wrapOpenAI?: <T>(client: T) => T;
}

export interface TelemetryEnv {
  NEATLOGS_API_KEY?: string;
  NEATLOGS_ENDPOINT?: string;
  [key: string]: string | undefined;
}

interface TelemetryState {
  neatlogsModule: NeatlogsModule | null;
  enabled: boolean;
  initialized: boolean;
  warned: boolean;
}

const telemetryStateKey = Symbol.for("conduit.telemetry.state");
// Next loads instrumentation and route bundles as separate module instances.
const state = (
  globalThis as unknown as { [key: symbol]: TelemetryState | undefined }
)[telemetryStateKey] ??= {
  neatlogsModule: null,
  enabled: false,
  initialized: false,
  warned: false,
};

export async function initTelemetry(
  env: TelemetryEnv,
  deps?: { neatlogs?: NeatlogsModule },
): Promise<void> {
  if (state.initialized) return;
  state.initialized = true;
  const apiKey = env.NEATLOGS_API_KEY;
  if (!apiKey) {
    state.enabled = false;
    return;
  }
  try {
    const mod =
      deps?.neatlogs ?? ((await import("neatlogs")) as unknown as NeatlogsModule);
    await mod.init({
      apiKey,
      workflowName: "conduit",
      endpoint: env.NEATLOGS_ENDPOINT || undefined,
      mask: maskTelemetry,
      registerShutdownHandlers: false,
    });
    state.neatlogsModule = mod;
    state.enabled = true;
  } catch {
    state.enabled = false;
    if (!state.warned) {
      state.warned = true;
      console.warn("[telemetry] neatlogs initialization failed; telemetry disabled");
    }
  }
}

export function isTelemetryEnabled(): boolean {
  return state.enabled && state.neatlogsModule !== null;
}

export function getNeatlogs(): NeatlogsModule | null {
  return state.neatlogsModule;
}

export async function flushTelemetry(): Promise<void> {
  if (!state.enabled || !state.neatlogsModule) return;
  try {
    await state.neatlogsModule.flush();
  } catch {
    // Telemetry failures never affect business results.
  }
}

export function orgPseudonym(orgId: string): string {
  return "org_" + createHash("sha256").update(orgId).digest("hex").slice(0, 12);
}

/** Test hook: reset module state. */
export function _resetTelemetryForTests(): void {
  state.neatlogsModule = null;
  state.enabled = false;
  state.initialized = false;
  state.warned = false;
}

export { maskTelemetry };
export { withBusinessSpan } from "./spans";
export type { BusinessSpanName, CorrelationAttrs } from "./spans";
