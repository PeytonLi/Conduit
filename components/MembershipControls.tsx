"use client";

import { useRef, useState } from "react";
import type { MembershipView } from "@/lib/db/queries/memberships";
import { postJson, WorkspaceApiError, workspaceErrorMessage } from "./client-api";

export function MembershipControls({ member }: { member: MembershipView }) {
  const [role, setRole] = useState(member.role);
  const [active, setActive] = useState(member.active);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef<{ intent: string; value: string } | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const intent = JSON.stringify({ role, active, reason: reason.trim() });
    if (key.current?.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
    try {
      await postJson(`/api/v1/memberships/${member.id}/role`, {
        role, active, expected_version: member.row_version, reason: reason.trim(),
      }, key.current.value);
      key.current = null;
      setMessage("Membership updated.");
    } catch (error) {
      setMessage(error instanceof WorkspaceApiError && error.code === "last_owner_required"
        ? "This organization must retain at least one active owner."
        : workspaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={(event) => void save(event)}>
    <label>Role <select onChange={(event) => setRole(event.target.value as typeof role)} value={role}>
      <option value="owner">Owner</option><option value="operator">Operator</option><option value="viewer">Viewer</option>
    </select></label>
    <label><input checked={active} onChange={(event) => setActive(event.target.checked)} type="checkbox" /> Active</label>
    <label>Reason <input onChange={(event) => setReason(event.target.value)} required value={reason} /></label>
    <button disabled={busy || !reason.trim()} type="submit">{busy ? "Saving…" : "Save member"}</button>
    {message && <p role="status">{message}</p>}
  </form>;
}
