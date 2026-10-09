"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CaseDetail } from "@/lib/db/queries/cases";
import { postJson, workspaceErrorMessage } from "./client-api";
import styles from "./case-controls.module.css";

export function CaseControls({
  detail,
  role,
}: {
  detail: CaseDetail;
  role: "owner" | "operator" | "viewer";
}) {
  const router = useRouter();
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busyName, setBusyName] = useState("");

  async function submit(
    name: string,
    path: string,
    body: Record<string, unknown>,
  ) {
    if (inFlight.current) return;
    const fingerprint = JSON.stringify({ name, path, body });
    if (fingerprint !== intent.current?.fingerprint) intent.current = { fingerprint, key: crypto.randomUUID() };
    inFlight.current = true;
    setBusyName(name);
    setMessage("");
    try {
      await postJson(path, body, intent.current.key);
      intent.current = null;
      setMessage("The request was accepted. Refreshing case details.");
      router.refresh();
    } catch (error) {
      setMessage(workspaceErrorMessage(error));
    } finally {
      inFlight.current = false;
      setBusyName("");
    }
  }

  if (role === "viewer") {
    return <p className={styles.readOnly}>Read-only access.</p>;
  }

  const canControl = detail.permissions.can_control;
  return (
    <section aria-labelledby="controls-heading" className={styles.controls}>
      <h2 id="controls-heading">Case controls</h2>
      {!canControl && <p className={styles.readOnly}>You don’t have permission to change this case.</p>}
      {canControl && (
        <>
          <label className={styles.reason}>
            Reason for change
            <textarea onChange={(event) => setReason(event.target.value)} value={reason} />
          </label>
          <div className={styles.actions}>
            {detail.case.run_control === "active" ? (
              <button
                disabled={Boolean(busyName)}
                onClick={() => void submit("pause", `/api/v1/cases/${detail.case.id}/control`, {
                  command: "pause",
                  expected_version: detail.case.row_version,
                  reason: reason.trim() || undefined,
                })}
                type="button"
              >
                {busyName === "pause" ? "Pausing…" : "Pause case"}
              </button>
            ) : detail.case.run_control === "paused" ? (
              <button
                disabled={Boolean(busyName)}
                onClick={() => void submit("resume", `/api/v1/cases/${detail.case.id}/control`, {
                  command: "resume",
                  expected_version: detail.case.row_version,
                  reason: reason.trim() || undefined,
                })}
                type="button"
              >
                {busyName === "resume" ? "Resuming…" : "Resume case"}
              </button>
            ) : (
              <p className={styles.readOnly}>This case is blocked until its outcome is reviewed.</p>
            )}
            {detail.permissions.can_reassess && (
              <button
                disabled={Boolean(busyName) || !reason.trim()}
                onClick={() => void submit("reassess", `/api/v1/cases/${detail.case.id}/reassess`, {
                  expected_version: detail.case.row_version,
                  reason: reason.trim(),
                })}
                type="button"
              >
                {busyName === "reassess" ? "Requesting reassessment…" : "Request reassessment"}
              </button>
            )}
            {detail.permissions.can_accept_risk && detail.case.phase !== "closed" && (
              <button
                className={styles.riskButton}
                disabled={Boolean(busyName) || !reason.trim()}
                onClick={() => void submit("accept-risk", `/api/v1/cases/${detail.case.id}/control`, {
                  command: "close",
                  outcome: "accepted_risk",
                  expected_version: detail.case.row_version,
                  reason: reason.trim(),
                })}
                type="button"
              >
                {busyName === "accept-risk" ? "Closing…" : "Close with accepted risk"}
              </button>
            )}
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
