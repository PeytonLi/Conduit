"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import type { BusinessConnectMethod } from "@/lib/integrations/business/live/availability";
import styles from "./business-system.module.css";

type Fetcher = (input: string, init: RequestInit) => Promise<Pick<Response, "ok" | "json">>;

/** POSTs to a provider connect route; follows authorization_url for OAuth providers. */
export async function requestBusinessConnection(
  fetcher: Fetcher,
  path: string,
  body: Record<string, string> | null,
): Promise<{ ok: true; authorizationUrl: string | null } | { ok: false; message: string }> {
  try {
    const response = await fetcher(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      data?: { authorization_url?: unknown };
      error?: { safe_message?: unknown };
    };
    if (!response.ok) {
      const message = typeof payload.error?.safe_message === "string" ? payload.error.safe_message : null;
      return { ok: false, message: message ?? "The business system couldn’t be connected. Please try again." };
    }
    const url = payload.data?.authorization_url;
    return { ok: true, authorizationUrl: typeof url === "string" && url ? url : null };
  } catch {
    return { ok: false, message: "The business system couldn’t be connected. Please try again." };
  }
}

export function ConnectBusinessSystem({
  label,
  method,
  connectPath,
}: {
  label: string;
  method: BusinessConnectMethod;
  connectPath: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(method === "oauth");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setError("");
    setPending(true);
    const body = event ? Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string> : null;
    const result = await requestBusinessConnection((input, init) => fetch(input, init), connectPath, body);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
    else router.refresh();
  }

  if (method === "oauth") {
    return (
      <div className={styles.container}>
        <Button className={styles.button} disabled={pending} onClick={() => void submit()} variant="primary">
          {pending ? "Connecting…" : `Connect ${label}`}
        </Button>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    );
  }

  if (!open) {
    return (
      <Button className={styles.button} onClick={() => setOpen(true)} variant="primary">
        Connect {label}
      </Button>
    );
  }

  return (
    <form aria-label={`Connect ${label}`} className={styles.form} onSubmit={(event) => void submit(event)}>
      {method === "odoo_form" ? (
        <>
          <TextField autoComplete="url" label="Odoo URL" name="url" placeholder="https://example.odoo.com" required type="url" />
          <TextField autoComplete="off" label="Database" name="database" required />
          <TextField autoComplete="username" label="User (login email)" name="username" required />
          <TextField autoComplete="off" label="API key" name="api_key" required type="password" />
        </>
      ) : (
        <TextField
          autoComplete="off"
          hint="Your store’s myshopify.com address"
          label="Shop domain"
          name="shop"
          pattern="[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com"
          placeholder="your-store.myshopify.com"
          required
        />
      )}
      <div className={styles.actions}>
        <Button className={styles.button} disabled={pending} type="submit" variant="primary">
          {pending ? "Connecting…" : "Connect"}
        </Button>
        <Button className={styles.button} disabled={pending} onClick={() => setOpen(false)} variant="secondary">
          Cancel
        </Button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

export function ConnectedBusinessSystemActions({ provider, label }: { provider: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"" | "sync" | "disconnect">("");
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");

  async function call(kind: "sync" | "disconnect") {
    setMessage("");
    setPending(kind);
    try {
      const response = await fetch(
        kind === "sync" ? "/api/v1/connections/business/sync" : `/api/v1/connections/business?provider=${provider}`,
        { method: kind === "sync" ? "POST" : "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } },
      );
      if (!response.ok) {
        setMessage(kind === "sync" ? "Sync couldn’t be started. Please try again." : `${label} couldn’t be disconnected. Please try again.`);
        return;
      }
      if (kind === "sync") setMessage("Sync started. Refresh in a minute to see new data.");
      setConfirming(false);
      router.refresh();
    } catch {
      setMessage("The request failed. Please try again.");
    } finally {
      setPending("");
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.actions}>
        <Button className={styles.button} disabled={pending !== ""} onClick={() => void call("sync")} variant="secondary">
          {pending === "sync" ? "Starting…" : "Sync now"}
        </Button>
        {confirming ? (
          <>
            <Button className={styles.button} disabled={pending !== ""} onClick={() => void call("disconnect")} variant="danger">
              {pending === "disconnect" ? "Disconnecting…" : `Disconnect ${label}`}
            </Button>
            <Button className={styles.button} disabled={pending !== ""} onClick={() => setConfirming(false)} variant="secondary">
              Cancel
            </Button>
          </>
        ) : (
          <Button className={styles.button} disabled={pending !== ""} onClick={() => setConfirming(true)} variant="secondary">
            Disconnect
          </Button>
        )}
      </div>
      {message && <p className={styles.error} role="status">{message}</p>}
    </div>
  );
}
