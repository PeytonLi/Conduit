"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SupplierSummary } from "@/lib/db/queries/suppliers";
import { postJson, workspaceErrorMessage } from "./client-api";

export function SupplierApprovalControls({ supplier }: { supplier: SupplierSummary }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef<{ intent: string; value: string } | null>(null);
  const [decision, setDecision] = useState<"approve" | "block" | "revoke">("approve");

  async function submit(scope: "purchasing" | "contact", contactId?: string) {
    setBusy(true);
    setMessage("");
    const intent = JSON.stringify({ scope, contactId, decision, reason: reason.trim() });
    if (key.current?.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
    try {
      await postJson(`/api/v1/suppliers/${supplier.id}/approval`, {
        scope, contact_id: contactId, decision, expected_version: supplier.row_version, reason: reason.trim(),
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

  return <section>
    <label>Decision <select onChange={(event) => setDecision(event.target.value as typeof decision)} value={decision}>
      <option value="approve">Approve</option><option value="block">Block</option><option value="revoke">Revoke approval</option>
    </select></label>
    <label>Reason <textarea onChange={(event) => setReason(event.target.value)} value={reason} /></label>
    <button disabled={busy || !reason.trim()} onClick={() => void submit("purchasing")} type="button">Update purchasing approval</button>
    {supplier.contacts.map((contact) => <button disabled={busy || !reason.trim()} key={contact.id} onClick={() => void submit("contact", contact.id)} type="button">Update outreach approval for {contact.display_name ?? contact.address}</button>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
