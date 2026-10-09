export class WorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "WorkspaceApiError";
  }
}

export async function postJson<T>(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new WorkspaceApiError(0, "network_error");
  }
  const envelope = await response.json().catch(() => null) as {
    data?: T;
    error?: { code?: string };
  } | null;
  if (!response.ok) {
    throw new WorkspaceApiError(response.status, envelope?.error?.code ?? "request_failed");
  }
  if (!envelope?.data) throw new WorkspaceApiError(0, "invalid_response");
  return envelope.data;
}

export function workspaceErrorMessage(error: unknown): string {
  if (!(error instanceof WorkspaceApiError)) {
    return "Couldn’t connect. Your changes weren’t confirmed.";
  }
  if (error.status === 401) return "Your session has expired. Sign in again.";
  if (error.status === 403) return "You don’t have permission to do that.";
  if (error.status === 404) return "This operation isn’t available in this build yet.";
  if (error.status === 409) return "This item changed. Review the updated terms.";
  if (error.status === 422) return "Check the details and try again.";
  return "Couldn’t connect. Your changes weren’t confirmed.";
}
