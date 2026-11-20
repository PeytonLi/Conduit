"use client";

import Link from "next/link";
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
  const [caseId, setCaseId] = useState<string | null>(null);
  const key = useRef<{ intent: string; value: string } | null>(null);

  async function placeCall() {
    setBusy(true);
    setMessage("");
    setCaseId(null);
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
      setMessage(`Starting the call to ${result.masked_phone}…`);
      // The call is dispatched in the background; report whether it actually dialed.
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await fetch(`/api/v1/actions/${result.action_id}`)
          .then((r) => r.json())
          .catch(() => null) as { data?: { action?: { state?: string; outcome?: { safe_summary?: string } } } } | null;
        const action = status?.data?.action;
        if (action?.state === "failed" || action?.state === "cancelled") {
          setMessage(`The call was not placed: ${action.outcome?.safe_summary ?? "it failed before dialing."}`);
          return;
        }
        if (action?.state && !["prepared", "dispatching"].includes(action.state)) break;
      }
      setMessage(
        `Calling ${result.masked_phone}. Answer that phone and record. The transcript appears on the case a few seconds after the call ends.`,
      );
      setCaseId(result.case_id);
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
      {caseId && <Link href={`/cases/${caseId}`}>Open case to see the call and transcript</Link>}
    </Card>
  );
}
