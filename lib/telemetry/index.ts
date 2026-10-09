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
}

export interface TelemetryEnv {
  NEATLOGS_API_KEY?: string;
  NEATLOGS_ENDPOINT?: string;
}

let neatlogsModule: NeatlogsModule | null = null;
let enabled = false;
let initialized = false;
let warned = false;

export async function initTelemetry(
  env: TelemetryEnv,
  deps?: { neatlogs?: NeatlogsModule },
): Promise<void> {
  if (initialized) return;
  initialized = true;
  const apiKey = env.NEATLOGS_API_KEY;
  if (!apiKey) {
    enabled = false;
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
    neatlogsModule = mod;
    enabled = true;
  } catch {
    enabled = false;
    if (!warned) {
      warned = true;
      console.warn("[telemetry] neatlogs initialization failed; telemetry disabled");
    }
  }
}

export function isTelemetryEnabled(): boolean {
  return enabled && neatlogsModule !== null;
}

export function getNeatlogs(): NeatlogsModule | null {
  return neatlogsModule;
}

export async function flushTelemetry(): Promise<void> {
  if (!enabled || !neatlogsModule) return;
  try {
    await neatlogsModule.flush();
  } catch {
    // Telemetry failures never affect business results.
  }
}

export function orgPseudonym(orgId: string): string {
  return "org_" + createHash("sha256").update(orgId).digest("hex").slice(0, 12);
}

/** Test hook: reset module state. */
export function _resetTelemetryForTests(): void {
  neatlogsModule = null;
  enabled = false;
  initialized = false;
  warned = false;
}

export { maskTelemetry };
export { withBusinessSpan } from "./spans";
export type { BusinessSpanName, CorrelationAttrs } from "./spans";
