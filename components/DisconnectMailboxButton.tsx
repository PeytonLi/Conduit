"use client";

import { Button } from "@/components/ui/Button";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./disconnect-mailbox-button.module.css";

export function mailboxDisconnectPath(connectionId: string): string {
  return `/api/v1/connections/mailboxes/${encodeURIComponent(connectionId)}`;
}

/**
 * Disconnects one mailbox connection. `providerLabel` is "Gmail" or "Outlook".
 * An expired or revoked mailbox is only being removed, so the button says
 * "Remove" and no longer promises that Conduit stops reading and sending.
 */
export function DisconnectMailboxButton({
  connectionId,
  providerLabel,
  active = true,
}: {
  connectionId: string;
  providerLabel: string;
  active?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const verb = active ? "Disconnect" : "Remove";
  const failure = `${providerLabel} couldn’t be ${active ? "disconnected" : "removed"}. Please try again.`;

  async function disconnect() {
    setError("");
    setPending(true);
    try {
      const response = await fetch(mailboxDisconnectPath(connectionId), {
        method: "DELETE",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      if (!response.ok) {
        setError(failure);
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setError(failure);
    } finally {
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <Button
        className={`${styles.button} ${styles.disconnect}`}
        onClick={() => {
          setError("");
          setConfirming(true);
        }}
        variant="secondary"
      >
        {verb}
      </Button>
    );
  }

  return (
    <div
      aria-busy={pending}
      aria-label={`${providerLabel} ${active ? "disconnect" : "removal"} confirmation`}
      className={styles.confirmation}
      role="group"
    >
      <p className={styles.message}>
        {active
          ? `Disconnect ${providerLabel}? Conduit will stop reading and sending supplier email.`
          : `Remove this ${providerLabel} connection? It is no longer working.`}
      </p>
      <div className={styles.actions}>
        <Button
          className={styles.button}
          disabled={pending}
          onClick={() => void disconnect()}
          variant="danger"
        >
          {pending ? `${active ? "Disconnecting" : "Removing"}…` : verb}
        </Button>
        <Button
          className={styles.button}
          disabled={pending}
          onClick={() => {
            setError("");
            setConfirming(false);
          }}
          variant="secondary"
        >
          Cancel
        </Button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
