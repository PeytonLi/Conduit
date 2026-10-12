const SENSITIVE_KEY =
  /api[_-]?key|secret|token|authorization|password|cookie|reasoning(_content)?|credential/i;
const NUMERIC_TOKEN_COUNT_KEY =
  /(^|[._-])(max_tokens|[a-z_]*tokens|token_count(\.[a-z_]+)?)$/i;
const NUMERIC_TOKEN_COUNT_STRING = /^\d+(\.\d+)?$/;

const PATTERNS: { re: RegExp; replacement: string }[] = [
  { re: /sk-[A-Za-z0-9]{16,}/g, replacement: "[redacted]" },
  { re: /Bearer\s+\S+/g, replacement: "[redacted]" },
  { re: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g, replacement: "[redacted]" },
  {
    re: /([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    replacement: "$1***@$3",
  },
  {
    re: /(?<![\w-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g,
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
      const numericTokenCount =
        NUMERIC_TOKEN_COUNT_KEY.test(key) &&
        ((typeof entry === "number" && Number.isFinite(entry)) ||
          (typeof entry === "string" && NUMERIC_TOKEN_COUNT_STRING.test(entry)));
      if (numericTokenCount) {
        out[key] = entry;
      } else if (SENSITIVE_KEY.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = maskTelemetry(entry);
      }
    }
    return out as T;
  }
  return value;
}
