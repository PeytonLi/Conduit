"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CaseDetail } from "@/lib/db/queries/cases";
import { Button } from "./ui/Button";
import { Disclosure } from "./ui/Disclosure";
import { SelectField, TextAreaField } from "./ui/Field";
import { postJson, workspaceErrorMessage } from "./client-api";
import styles from "./case-controls.module.css";

type CaseAction = "pause" | "resume" | "reassess" | "accept-risk";

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
  const [chosenAction, setChosenAction] = useState<CaseAction | "">("");

  useEffect(() => {
    function requestReassessment() {
      if (!detail.permissions.can_reassess || role === "viewer") return;
      const disclosure = document.getElementById("case-options");
      if (disclosure instanceof HTMLDetailsElement) disclosure.open = true;
      setChosenAction("reassess");
      requestAnimationFrame(() => {
        document.getElementById("case-options")?.querySelector("textarea")?.focus();
      });
    }
    window.addEventListener("conduit:request-reassessment", requestReassessment);
    return () => window.removeEventListener("conduit:request-reassessment", requestReassessment);
  }, [detail.permissions.can_reassess, role]);

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
    return (
      <Disclosure className={styles.controls} summary="Case options">
        <p className={styles.readOnly}>Read-only access.</p>
      </Disclosure>
    );
  }

  const canControl = detail.permissions.can_control;
  const availableActions: CaseAction[] = [
    ...(detail.case.run_control === "active" ? ["pause" as const] : []),
    ...(detail.case.run_control === "paused" ? ["resume" as const] : []),
    ...(detail.permissions.can_reassess ? ["reassess" as const] : []),
    ...(detail.permissions.can_accept_risk && detail.case.phase !== "closed" ? ["accept-risk" as const] : []),
  ];
  const requiresReason = chosenAction === "reassess" || chosenAction === "accept-risk";

  async function submitChosenAction() {
    if (!chosenAction) return;
    if (requiresReason && !reason.trim()) {
      setMessage("Add a reason before continuing.");
      return;
    }
    const body: Record<string, unknown> = {
      expected_version: detail.case.row_version,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    const path = chosenAction === "reassess"
      ? `/api/v1/cases/${detail.case.id}/reassess`
      : `/api/v1/cases/${detail.case.id}/control`;
    if (chosenAction === "pause" || chosenAction === "resume") body.command = chosenAction;
    if (chosenAction === "accept-risk") {
      body.command = "close";
      body.outcome = "accepted_risk";
    }
    await submit(chosenAction, path, body);
  }

  return (
    <Disclosure id="case-options" className={styles.controls} summary="Case options">
      {!canControl ? (
        <p className={styles.readOnly}>You don’t have permission to change this case.</p>
      ) : availableActions.length ? (
        <>
          <SelectField
            label="Action"
            onChange={(event) => {
              setChosenAction(event.target.value as CaseAction | "");
              setMessage("");
            }}
            value={chosenAction}
          >
            <option value="">Choose an action</option>
            {availableActions.map((action) => (
              <option key={action} value={action}>
                {action === "accept-risk" ? "Close with accepted risk" : action === "reassess" ? "Request reassessment" : action === "pause" ? "Pause case" : "Resume case"}
              </option>
            ))}
          </SelectField>
          {chosenAction && (
            <>
              <TextAreaField
                label="Reason for change"
                onChange={(event) => setReason(event.target.value)}
                value={reason}
              />
              <Button
                disabled={Boolean(busyName) || (requiresReason && !reason.trim())}
                onClick={() => void submitChosenAction()}
                variant={chosenAction === "accept-risk" ? "danger" : "primary"}
              >
                {busyName === chosenAction ? "Saving…" : chosenAction === "accept-risk" ? "Close with accepted risk" : chosenAction === "reassess" ? "Request reassessment" : chosenAction === "pause" ? "Pause case" : "Resume case"}
              </Button>
            </>
          )}
        </>
      ) : (
        <p className={styles.readOnly}>No case options are available right now.</p>
      )}
      {message && <p role="status">{message}</p>}
    </Disclosure>
  );
}
