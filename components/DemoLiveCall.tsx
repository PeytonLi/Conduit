"use client";

import { useRef, useState } from "react";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { TextAreaField } from "./ui/Field";
import styles from "./demo-run.module.css";

const DEFAULT_PURPOSE =
  "Demo call for PO-1042 CARTON-302015: need 600 by Wed; any quote is provisional until written.";

export function DemoLiveCall({ disabled }: { disabled: boolean }) {
  const [purpose, setPurpose] = useState(DEFAULT_PURPOSE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const key = useRef<{ intent: string; value: string } | null>(null);

  async function placeCall() {
    setBusy(true);
    setMessage("");
    const intent = JSON.stringify({ purpose: purpose.trim() });
    if (key.current?.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
    try {
      const response = await fetch("/api/v1/demo/call", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current.value,
        },
        body: JSON.stringify({ purpose: purpose.trim() }),
      });
      const envelope = (await response.json().catch(() => null)) as {
        data?: { case_id: string; action_id: string; masked_phone: string };
        error?: { code?: string; safe_message?: string };
      } | null;
      if (!response.ok || !envelope?.data) {
        setMessage(
          envelope?.error?.safe_message ||
            "Couldn’t start the live demo call. Load Harbor Pack first and confirm the phone contact is approved.",
        );
        return;
      }
      key.current = null;
      const result = envelope.data;
      setMessage(
        `Calling ${result.masked_phone}. Answer that phone and record. Case ${result.case_id.slice(0, 8)}… · action ${result.action_id.slice(0, 8)}…`,
      );
    } catch {
      setMessage("Couldn’t connect. The call was not started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={styles.card}>
      <h2>Live demo call</h2>
      <p className={styles.note}>
        Places a real phone call through the voice bridge to your approved sandbox contact. Answer the phone and
        record. This is not part of Harbor Pack Replay.
      </p>
      <TextAreaField
        disabled={disabled || busy}
        label="Call purpose"
        onChange={(event) => {
          key.current = null;
          setPurpose(event.target.value.slice(0, 200));
        }}
        value={purpose}
      />
      <p aria-live="polite">{purpose.length}/200</p>
      <Button disabled={disabled || busy || !purpose.trim()} onClick={() => void placeCall()}>
        {busy ? "Starting call…" : "Place live demo call"}
      </Button>
      {message && <p role="status">{message}</p>}
    </Card>
  );
}
