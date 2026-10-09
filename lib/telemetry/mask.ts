const SENSITIVE_KEY =
  /api[_-]?key|secret|token|authorization|password|cookie|reasoning(_content)?|credential/i;

const PATTERNS: { re: RegExp; replacement: string }[] = [
  { re: /sk-[A-Za-z0-9]{16,}/g, replacement: "[redacted]" },
  { re: /Bearer\s+\S+/g, replacement: "[redacted]" },
  { re: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g, replacement: "[redacted]" },
  {
    re: /([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    replacement: "$1***@$3",
  },
  {
    re: /\+?[0-9][0-9\s-]{8,}[0-9]/g,
    replacement: "[phone]",
  },
];

function maskString(value: string): string {
  let out = value;
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

export function maskTelemetry<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskString(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => maskTelemetry(entry)) as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = maskTelemetry(entry);
      }
    }
    return out as T;
  }
  return value;
}
