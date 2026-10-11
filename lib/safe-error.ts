export function safeErrorLogFields(err: unknown): {
  name: string;
  code: string | number | null;
  message: string;
} {
  const details =
    err !== null && typeof err === "object"
      ? (err as { name?: unknown; code?: unknown; message?: unknown })
      : {};
  const message =
    typeof details.message === "string" ? details.message : String(err);
  const safeMessage = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:ak|sk)_[A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\bya29\.[A-Za-z0-9._-]+\b/gi, "[redacted]")
    .replace(/\b1\/\/[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted]",
    )
    .replace(
      /\b((?:access|refresh|authorization|api|client)[_-]?(?:token|key|secret))(\s*[:=]\s*)["']?[^"'`,;\s}]+/gi,
      "$1$2[redacted]",
    );
  return {
    name:
      typeof details.name === "string"
        ? details.name
        : err instanceof Error
          ? err.name
          : "Error",
    code:
      typeof details.code === "string" || typeof details.code === "number"
        ? details.code
        : null,
    message: safeMessage.slice(0, 1000),
  };
}
