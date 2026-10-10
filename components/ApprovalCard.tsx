"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApprovalView, CaseSummary } from "@/lib/db/queries/cases";
import { formatDateTime, formatMoney, formatQuantity } from "@/lib/db/queries/format";
import { isExpiredAt } from "@/lib/db/queries/clock";
import { humanLabel } from "@/lib/db/queries/labels";
import { StatusBadge } from "./StatusBadge";
import { postJson, WorkspaceApiError, workspaceErrorMessage } from "./client-api";
import { LiveRegion } from "./LiveRegion";
import styles from "./approval-card.module.css";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function ApprovalCard({
  plan,
  caseSummary,
  canApprove,
  role,
  environmentMode,
  originalOrderTreatment,
}: {
  plan: ApprovalView;
  caseSummary: CaseSummary;
  canApprove: boolean;
  role: "owner" | "operator" | "viewer";
  environmentMode: "live" | "sandbox" | "replay";
  originalOrderTreatment: string;
}) {
  const router = useRouter();
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const approveButton = useRef<HTMLButtonElement>(null);
  const rejectDialog = useRef<HTMLDialogElement>(null);
  const rejectHeading = useRef<HTMLHeadingElement>(null);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const selfMutating = useRef(false);
  const intentKey = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stale, setStale] = useState(false);
  const [expired] = useState(() => isExpiredAt(plan.expires_at, new Date(caseSummary.clock_now)));
  const [message, setMessage] = useState("");
  const [polling, setPolling] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const timeZone = caseSummary.location.timezone;
  const commitment = formatMoney(plan.approved_ceiling_minor ?? plan.incremental_cost_minor, plan.currency);
  const gross = formatMoney(plan.gross_commitment_minor, plan.currency);

  useEffect(() => {
    if (
      inFlight.current ||
      selfMutating.current ||
      (plan.status !== "ready" && plan.status !== "pending" && plan.status !== "awaiting_approval")
    ) return;
    let active = true;
    const poll = async () => {
      while (active) {
        await wait(3000);
        if (!active || selfMutating.current || inFlight.current) return;
        try {
          const response = await fetch(`/api/v1/cases/${caseSummary.id}`, { cache: "no-store" });
          if (selfMutating.current || inFlight.current) return;
          if (!response.ok) continue;
          const envelope = await response.json() as { data?: { case?: { row_version?: number }; plan?: { row_version?: number } } };
          if (selfMutating.current || inFlight.current) return;
          const latest = envelope.data;
          if (
            latest?.case?.row_version !== undefined &&
            (latest.case.row_version !== caseSummary.row_version ||
              (latest.plan?.row_version !== undefined && latest.plan.row_version !== plan.row_version))
          ) {
            setStale(true);
            setMessage("This plan changed; review the updated terms.");
            return;
          }
        } catch {
          // A later poll can recover; background refreshes are not announced.
        }
      }
    };
    void poll();
    return () => {
      active = false;
    };
  }, [caseSummary.id, caseSummary.row_version, plan.row_version, plan.status, submitting]);

  async function pollAction(actionId: string) {
    setPolling(true);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      await wait(2000);
      try {
        const response = await fetch(`/api/v1/actions/${actionId}`, { cache: "no-store" });
        if (!response.ok) continue;
        const envelope = await response.json() as { data?: { action?: { state?: string } } };
        const state = envelope.data?.action?.state;
        if (state === "confirmed") {
          setMessage("Recovery action confirmed.");
          setPolling(false);
          return;
        }
        if (state === "failed") {
          setMessage("The recovery action failed. Review the case before trying again.");
          setPolling(false);
          return;
        }
        if (state === "unknown") {
          setMessage("The recovery outcome is unknown. Check whether the update was applied.");
          setPolling(false);
          return;
        }
      } catch {
        setMessage("The approval was recorded, but the recovery status couldn’t be refreshed.");
        setPolling(false);
        return;
      }
    }
    setMessage("Recovery outcome is unknown after 60 seconds. Check whether the update was applied.");
    setPolling(false);
  }

  function openConfirmation() {
    setMessage("");
    confirmDialog.current?.showModal();
    window.requestAnimationFrame(() => confirmHeading.current?.focus());
  }

  async function submitApproval() {
    if (inFlight.current || stale || expired) return;
    inFlight.current = true;
    intentKey.current ??= crypto.randomUUID();
    setSubmitting(true);
    setMessage("");
    let approvalSucceeded = false;
    try {
      selfMutating.current = true;
      const result = await postJson<{ expires_at: string }>(
        `/api/v1/plans/${plan.plan_id}/approve`,
        {
          plan_version: plan.plan_version,
          input_fingerprint: plan.input_fingerprint,
          approved_ceiling_minor: plan.approved_ceiling_minor ?? plan.incremental_cost_minor ?? "0",
          expected_version: plan.row_version,
        },
        intentKey.current,
      );
      approvalSucceeded = true;
      intentKey.current = null;
      confirmDialog.current?.close();
      setMessage(`Plan approved. Approval valid until ${formatDateTime(result.expires_at, timeZone) ?? "Unknown"}.`);
      router.refresh();
      const response = await fetch(`/api/v1/cases/${caseSummary.id}`, { cache: "no-store" });
      if (response.ok) {
        const refreshed = await response.json() as {
          data?: { plan?: { plan_actions?: { id: string; state: string }[] } | null };
        };
        const actionable = refreshed.data?.plan?.plan_actions?.filter((action) =>
          ["prepared", "dispatching", "submitted"].includes(action.state),
        ) ?? [];
        for (const action of actionable) await pollAction(action.id);
      }
    } catch (error) {
      if (!approvalSucceeded) selfMutating.current = false;
      if (error instanceof WorkspaceApiError && ["stale_fingerprint", "stale_version", "invalid_state"].includes(error.code)) {
        setStale(true);
        setMessage("This plan changed; review the updated terms.");
      } else if (error instanceof WorkspaceApiError && ["plan_expired", "approval_expired"].includes(error.code)) {
        setMessage("This approval window has expired; request updated terms.");
      } else if (error instanceof WorkspaceApiError && ["forbidden", "approval_authority_revoked"].includes(error.code)) {
        setMessage("Only an owner can approve this plan.");
      } else if (error instanceof WorkspaceApiError && ["dispatch_paused", "case_not_active"].includes(error.code)) {
        setMessage("Case is paused or closed; resume it before approving.");
      } else if (error instanceof WorkspaceApiError && ["policy_denied", "mode_not_allowed"].includes(error.code)) {
        setMessage("Current policy does not allow this plan to be approved.");
      } else {
        setMessage(workspaceErrorMessage(error));
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function submitRejection() {
    const reason = rejectReason.trim();
    if (!reason) {
      setMessage("Enter a reason to reject this plan.");
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    let rejectionSucceeded = false;
    try {
      selfMutating.current = true;
      await postJson(`/api/v1/plans/${plan.plan_id}/reject`, {
        expected_version: plan.row_version,
        reason,
      });
      rejectionSucceeded = true;
      rejectDialog.current?.close();
      setRejectReason("");
      setMessage("Plan rejected.");
      router.refresh();
    } catch (error) {
      if (!rejectionSucceeded) selfMutating.current = false;
      setMessage(workspaceErrorMessage(error));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const disabledReason = expired
    ? "This approval window has expired; request updated terms."
    : stale
      ? "This plan changed; review the updated terms."
      : null;

  return (
    <section aria-labelledby="approval-title" className={styles.card}>
      <div className={styles.header}>
        <div><p className={styles.eyebrow}>Decision</p><h2 id="approval-title">Approve recovery plan v{plan.plan_version}</h2></div>
        <StatusBadge tone={plan.status === "approved" ? "success" : "info"}>{humanLabel("planStatus", plan.status)}</StatusBadge>
      </div>
      <dl className={styles.terms}>
        <div><dt>Supplier</dt><dd>{plan.supplier?.name ?? "Unknown"}</dd></div>
        <div><dt>Additional commitment</dt><dd>{commitment ?? "Unknown"}</dd></div>
        <div><dt>Gross commitment</dt><dd>{gross ?? "Unknown"}</dd></div>
        <div><dt>Original order treatment</dt><dd>{originalOrderTreatment || "Unknown"}</dd></div>
        <div><dt>Dependencies</dt><dd>{plan.dependencies.length ? plan.dependencies.join(", ") : "None"}</dd></div>
        <div><dt>Approval expiry</dt><dd>{plan.expires_at ? `Expires ${formatDateTime(plan.expires_at, timeZone)}` : "Unknown"}</dd></div>
      </dl>
      <h3>Recovery steps</h3>
      <ol className={styles.steps}>
        {plan.steps.map((step) => (
          <li key={step.step_id}>
            <strong>{step.summary}</strong>
            {step.quantity !== null && <span>{formatQuantity(step.quantity, step.unit) ?? "Unknown"}</span>}
            <span>{humanLabel("executionMode", step.execution_mode)}</span>
          </li>
        ))}
      </ol>
      <p className={styles.replayNotice}>
        {caseSummary.data_label === "Replay" ||
        (caseSummary.data_label === null && environmentMode === "replay")
          ? "Replay: approving records the decision in the demo only; no supplier or business system is contacted."
          : "Approval records the owner’s decision; external execution depends on configured capabilities."}
      </p>
      {role !== "owner" && (
        <p className={styles.permission}>Waiting for owner. Only an owner can approve this plan.</p>
      )}
      {canApprove && (
        <>
          {disabledReason && <p className={styles.disabledReason}>{disabledReason}</p>}
          <div className={styles.actions}>
            <button
              aria-busy={submitting || polling}
              className={styles.approve}
              disabled={Boolean(disabledReason) || submitting || polling}
              onClick={openConfirmation}
              ref={approveButton}
              type="button"
            >
              Approve this plan
            </button>
            <button
              className={styles.reject}
              disabled={submitting || polling}
              onClick={() => {
                setMessage("");
                rejectDialog.current?.showModal();
                window.requestAnimationFrame(() => rejectHeading.current?.focus());
              }}
              ref={rejectButton}
              type="button"
            >
              Reject plan
            </button>
          </div>
        </>
      )}
      {message && <p className={styles.result}>{message}{stale && <button onClick={() => router.refresh()} type="button">Reload case</button>}</p>}
      <LiveRegion message={message} />
      <dialog
        aria-labelledby="confirm-approval-title"
        className={styles.confirmDialog}
        onClose={() => approveButton.current?.focus()}
        ref={confirmDialog}
      >
        <h2 id="confirm-approval-title" ref={confirmHeading} tabIndex={-1}>Confirm recovery plan approval</h2>
        <p>Approve plan version {plan.plan_version} with an additional commitment of {commitment ?? "Unknown"}?</p>
        <p>This action is recorded for case {caseSummary.id}.</p>
        <div className={styles.confirmActions}>
          <button disabled={submitting} onClick={() => confirmDialog.current?.close()} type="button">Cancel</button>
          <button aria-busy={submitting || polling} disabled={submitting || polling} onClick={() => void submitApproval()} type="button">
            {submitting ? "Approving…" : polling ? "Checking action…" : "Confirm approval"}
          </button>
        </div>
      </dialog>
      <dialog
        aria-labelledby="reject-plan-title"
        className={styles.confirmDialog}
        onClose={() => rejectButton.current?.focus()}
        ref={rejectDialog}
      >
        <h2 id="reject-plan-title" ref={rejectHeading} tabIndex={-1}>Reject recovery plan</h2>
        <label htmlFor="reject-plan-reason">Reason</label>
        <textarea
          id="reject-plan-reason"
          maxLength={500}
          onChange={(event) => setRejectReason(event.target.value)}
          required
          value={rejectReason}
        />
        <div className={styles.confirmActions}>
          <button disabled={submitting} onClick={() => rejectDialog.current?.close()} type="button">Cancel</button>
          <button disabled={submitting || !rejectReason.trim()} onClick={() => void submitRejection()} type="button">Reject plan</button>
        </div>
      </dialog>
    </section>
  );
}
