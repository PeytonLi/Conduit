"use client";

import { useEffect, useRef, useState } from "react";
import type { CaseEvidence } from "@/lib/db/queries/cases";
import { formatDateTime } from "@/lib/db/queries/format";
import { humanLabel } from "@/lib/db/queries/labels";
import { Icon } from "@/components/ui/Icon";
import styles from "./evidence-drawer.module.css";

type FileMessage =
  | { kind: "expired" }
  | { kind: "text"; text: string };

const expiredNoticeText =
  "Source expired. The original file was deleted under your retention policy; the excerpt above is kept.";

export function EvidenceDrawer({
  evidence,
  timeZone,
  label = "View source",
}: {
  evidence: CaseEvidence;
  timeZone: string;
  label?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [fileMessage, setFileMessage] = useState<FileMessage | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onClose = () => {
      setFileMessage(null);
      triggerRef.current?.focus();
    };
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, []);

  function openDialog(event: React.MouseEvent<HTMLButtonElement>) {
    triggerRef.current = event.currentTarget;
    dialogRef.current?.showModal();
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }

  async function openOriginal() {
    setFileMessage(null);
    try {
      const response = await fetch(`/api/v1/evidence/${evidence.id}/access`);
      const envelope = await response.json().catch(() => null) as { data?: { url?: string } } | null;
      if (response.status === 410) {
        setFileMessage({ kind: "expired" });
        return;
      }
      if (response.status === 404) {
        setFileMessage({
          kind: "text",
          text: "The original file isn’t retained for this evidence; the excerpt above is the stored source.",
        });
        return;
      }
      if (!response.ok || !envelope?.data?.url) {
        setFileMessage({
          kind: "text",
          text: "The original file couldn’t be opened. The excerpt above remains available.",
        });
        return;
      }
      window.open(envelope.data.url, "_blank", "noopener,noreferrer");
    } catch {
      setFileMessage({
        kind: "text",
        text: "The original file couldn’t be opened. The excerpt above remains available.",
      });
    }
  }

  const showExpiredNotice = evidence.source_expired || fileMessage?.kind === "expired";

  return (
    <>
      <button className={styles.trigger} onClick={openDialog} type="button">
        {label}
      </button>
      <dialog
        aria-labelledby={`evidence-title-${evidence.id}`}
        className={styles.dialog}
        ref={dialogRef}
      >
        <div className={styles.dialogContent}>
          <div className={styles.dialogHeader}>
            <h2 id={`evidence-title-${evidence.id}`} ref={headingRef} tabIndex={-1}>Evidence source</h2>
            <button aria-label="Close evidence" className={styles.close} onClick={() => dialogRef.current?.close()} type="button">×</button>
          </div>
          <dl className={styles.metadata}>
            <div><dt>Source type</dt><dd>{humanLabel("evidenceSourceType", evidence.source_type)}</dd></div>
            {evidence.locator && <div><dt>Source locator</dt><dd>{evidence.locator}</dd></div>}
            <div><dt>Source time</dt><dd>{formatDateTime(evidence.source_time, timeZone) ?? "Not provided"}</dd></div>
            <div><dt>Captured</dt><dd>{formatDateTime(evidence.captured_at, timeZone) ?? "Not provided"}</dd></div>
            {evidence.verified_at && <div><dt>Last verified</dt><dd>{formatDateTime(evidence.verified_at, timeZone)}</dd></div>}
          </dl>
          <h3>Stored excerpt</h3>
          <blockquote>{evidence.supported_excerpt ?? "No excerpt was retained for this source."}</blockquote>
          {showExpiredNotice ? (
            <div className={styles.expiredNotice} role="status">
              <Icon name="file" size={17} />
              <span>{expiredNoticeText}</span>
            </div>
          ) : evidence.has_file && (
            <button className={styles.openFile} onClick={() => void openOriginal()} type="button">
              Open original file
            </button>
          )}
          {fileMessage?.kind === "text" && <p role="status">{fileMessage.text}</p>}
        </div>
      </dialog>
    </>
  );
}
