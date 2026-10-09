"use client";

import { useRef, useState } from "react";
import { postJson, workspaceErrorMessage } from "./client-api";

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
    <section>
      <label>Fixture
        <select disabled={disabled || busy} onChange={(event) => setFixture(event.target.value)} value={fixture}>
          <option value="harbor-pack-canonical">Harbor Pack Replay</option>
          <option value="harbor-pack-harmless">Harmless scenario</option>
        </select>
      </label>
      <label><input checked={reset} disabled={disabled || busy} onChange={(event) => setReset(event.target.checked)} type="checkbox" /> Reset existing demo data first</label>
      <p>Replay only: scenarios are simulated and do not contact suppliers or external systems.</p>
      <button disabled={disabled || busy} onClick={() => void run()} type="button">{busy ? "Loading scenario…" : "Run demo scenario"}</button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
