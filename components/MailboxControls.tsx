"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import styles from "./connect-gmail-button.module.css";

export const outlookConnectFailureMessage = "Outlook couldn’t be connected. Please try again.";

type ConnectResponse = Pick<Response, "ok" | "json">;
type ConnectFetch = (input: string, init: RequestInit) => Promise<ConnectResponse>;

/** Asks the server for the Microsoft consent URL and hands it to `assign`. */
export async function requestOutlookConnection(
  fetcher: ConnectFetch,
  assign: (url: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const response = await fetcher("/api/auth/outlook/connect", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok) {
      onError(outlookConnectFailureMessage);
      return;
    }
    const payload = (await response.json()) as { data?: { authorization_url?: unknown } };
    const authorizationUrl = payload.data?.authorization_url;
    if (typeof authorizationUrl !== "string" || !authorizationUrl) {
      onError(outlookConnectFailureMessage);
      return;
    }
    assign(authorizationUrl);
  } catch {
    onError(outlookConnectFailureMessage);
  }
}

/** `another` is set when an Outlook mailbox is already connected. */
export function ConnectOutlookButton({ another = false }: { another?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    setError("");
    setPending(true);
    await requestOutlookConnection(
      (input, init) => fetch(input, init),
      (url) => window.location.assign(url),
      setError,
    );
    setPending(false);
  }

  return (
    <div className={styles.container}>
      <Button className={styles.button} disabled={pending} onClick={() => void connect()} variant="primary">
        {pending ? "Connecting…" : another ? "Connect another Outlook account" : "Connect Outlook"}
      </Button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

export function mailboxPrimaryPath(connectionId: string): string {
  return `/api/v1/connections/mailboxes/${encodeURIComponent(connectionId)}/primary`;
}

/** Makes this mailbox the default sender for supplier email. */
export function MakePrimaryMailboxButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function makePrimary() {
    setError("");
    setPending(true);
    try {
      const response = await fetch(mailboxPrimaryPath(connectionId), {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      if (!response.ok) {
        setError("The primary mailbox couldn’t be changed. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("The primary mailbox couldn’t be changed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.container}>
      <Button className={styles.button} disabled={pending} onClick={() => void makePrimary()} variant="secondary">
        {pending ? "Saving…" : "Make primary"}
      </Button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
