"use client";

import { Button } from "@/components/ui/Button";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./disconnect-gmail-button.module.css";

export function DisconnectGmailButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  async function disconnect() {
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/v1/connections/gmail", {
        method: "DELETE",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      if (!response.ok) {
        setError("Gmail couldn’t be disconnected. Please try again.");
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Gmail couldn’t be disconnected. Please try again.");
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
        Disconnect
      </Button>
    );
  }

  return (
    <div
      aria-busy={pending}
      aria-label="Gmail disconnect confirmation"
      className={styles.confirmation}
      role="group"
    >
      <p className={styles.message}>Disconnect Gmail? Conduit will stop reading and sending supplier email.</p>
      <div className={styles.actions}>
        <Button
          className={styles.button}
          disabled={pending}
          onClick={() => void disconnect()}
          variant="danger"
        >
          {pending ? "Disconnecting…" : "Disconnect"}
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
