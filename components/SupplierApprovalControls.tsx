"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SupplierSummary } from "@/lib/db/queries/suppliers";
import { postJson, workspaceErrorMessage } from "./client-api";
import { Button } from "./ui/Button";
import { SelectField, TextAreaField } from "./ui/Field";
import styles from "./supplier-approval-controls.module.css";

export function SupplierApprovalControls({ supplier }: { supplier: SupplierSummary }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [evidenceIds, setEvidenceIds] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef<{ intent: string; value: string } | null>(null);
  const [decision, setDecision] = useState<"approve" | "block" | "revoke">("approve");

  async function submit(scope: "purchasing" | "contact", expectedVersion: number, contactId?: string) {
    setBusy(true);
    setMessage("");
    const evidence = evidenceIds.split(/[\s,]+/).filter(Boolean);
    const intent = JSON.stringify({ scope, contactId, expectedVersion, decision, reason: reason.trim(), evidence, evidenceNote });
    if (key.current?.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
    try {
      await postJson(`/api/v1/suppliers/${supplier.id}/approval`, {
        scope, contact_id: contactId, decision, expected_version: expectedVersion, reason: reason.trim(),
        evidence_ids: evidence, evidence_note: evidenceNote.trim() || null,
      }, key.current.value);
      key.current = null;
      setMessage("Supplier approval updated.");
      router.refresh();
    } catch (error) {
      setMessage(workspaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className={styles.controls}>
    <p>Approve contact outreach first, then separately approve purchasing with onboarding evidence. A purchasing approval does not approve a commitment.</p>
    <SelectField label="Decision" onChange={(event) => setDecision(event.target.value as typeof decision)} value={decision}>
      <option value="approve">Approve</option><option value="block">Block</option><option value="revoke">Revoke approval</option>
    </SelectField>
    <TextAreaField label="Reason" onChange={(event) => setReason(event.target.value)} value={reason} />
    <TextAreaField label="Onboarding evidence note" maxLength={2000} onChange={(event) => setEvidenceNote(event.target.value)} value={evidenceNote} />
    <TextAreaField label="Evidence IDs (optional, comma separated)" onChange={(event) => setEvidenceIds(event.target.value)} value={evidenceIds} />
    <div className={styles.actions}>
      <Button disabled={busy || !reason.trim() || (decision === "approve" && (supplier.stage === "blocked" || !supplier.contacts.some((contact) => contact.outreach_approved) || (!evidenceNote.trim() && !evidenceIds.trim())))} onClick={() => void submit("purchasing", supplier.row_version)} variant="secondary">
        {busy ? "Saving…" : "Update purchasing approval"}
      </Button>
      {supplier.contacts.map((contact) => (
        <Button disabled={busy || !reason.trim() || (decision === "approve" && (supplier.stage === "blocked" || !contact.identity_verified || !contact.permitted_channels.includes(contact.channel)))} key={contact.id} onClick={() => void submit("contact", contact.row_version, contact.id)} variant="secondary">
          Update outreach approval for {contact.display_name ?? contact.address}
        </Button>
      ))}
    </div>
    {message && <p className={styles.message} role="status">{message}</p>}
  </section>;
}
