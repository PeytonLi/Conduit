"use client";

import { useRef, useState } from "react";
import { postJson, workspaceErrorMessage } from "./client-api";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { CheckboxField, SelectField } from "./ui/Field";
import styles from "./demo-run.module.css";

export function DemoRun({ disabled }: { disabled: boolean }) {
  const [fixture, setFixture] = useState("harbor-pack-canonical");
  const [reset, setReset] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const key = useRef<{ intent: string; value: string } | null>(null);

  async function run() {
    setBusy(true);
    setMessage("");
    const intent = JSON.stringify({ fixture, reset });
    if (key.current?.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
    try {
      const result = await postJson<{ case_id?: string }>(
        "/api/v1/demo/run",
        { fixture_id: fixture, reset },
        key.current.value,
      );
      key.current = null;
      setMessage(`Demo scenario loaded${result.case_id ? `: case ${result.case_id}` : ""}.`);
    } catch (error) {
      setMessage(workspaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={styles.card}>
      <h2>Replay scenario</h2>
      <SelectField disabled={disabled || busy} label="Scenario" onChange={(event) => setFixture(event.target.value)} value={fixture}>
          <option value="harbor-pack-canonical">Harbor Pack Replay</option>
          <option value="harbor-pack-harmless">Harmless scenario</option>
      </SelectField>
      <CheckboxField checked={reset} disabled={disabled || busy} label="Reset existing demo data first" onChange={(event) => setReset(event.target.checked)} />
      <p className={styles.note}>Replay-only: scenarios are simulated and do not contact suppliers or external systems.</p>
      <Button disabled={disabled || busy} onClick={() => void run()}>{busy ? "Loading scenario…" : "Run demo scenario"}</Button>
      {message && <p role="status">{message}</p>}
    </Card>
  );
}
