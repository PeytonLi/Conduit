"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postJson, WorkspaceApiError, workspaceErrorMessage } from "./client-api";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { CheckboxField, SelectField } from "./ui/Field";
import styles from "./demo-run.module.css";

const demoErrors: Record<string, string> = {
  business_data_active:
    "A business system or file import is supplying this organization's data, and demo data would replace it. Disconnect the business system on Business data first, or run demos in a separate organization.",
  active_case_exists: "Another open case already covers the demo item. Tick “Reset existing demo data first” and try again.",
};

export function DemoRun({ disabled }: { disabled: boolean }) {
  const router = useRouter();
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
      setMessage(error instanceof WorkspaceApiError && demoErrors[error.code]
        ? demoErrors[error.code]
        : workspaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!window.confirm("Clear demo data? Open demo cases close as cancelled and demo suppliers are blocked. Running a scenario again restores them.")) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await postJson<{ closed_cases: number }>("/api/v1/demo/clear", {}, crypto.randomUUID());
      setMessage(`Demo data cleared (${result.closed_cases} case${result.closed_cases === 1 ? "" : "s"} closed).`);
      router.refresh();
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
      <div className={styles.actions}>
        <Button disabled={disabled || busy} onClick={() => void run()}>{busy ? "Working…" : "Run demo scenario"}</Button>
        <Button disabled={disabled || busy} onClick={() => void clear()} variant="secondary">Clear demo data</Button>
      </div>
      {message && <p role="status">{message}</p>}
    </Card>
  );
}
