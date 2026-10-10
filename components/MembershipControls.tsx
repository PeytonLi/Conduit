"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MembershipView } from "@/lib/db/queries/memberships";
import { postJson, WorkspaceApiError, workspaceErrorMessage } from "./client-api";
import { Button } from "./ui/Button";
import { CheckboxField, SelectField, TextField } from "./ui/Field";
import styles from "./membership-controls.module.css";

export function MembershipControls({ member, editable }: { member: MembershipView; editable: boolean }) {
  const router = useRouter();
  const [role, setRole] = useState(member.role);
  const [active, setActive] = useState(member.active);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef<{ intent: string; value: string } | null>(null);
  const pending = role !== member.role || active !== member.active;

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
      router.refresh();
    } catch (error) {
      setMessage(error instanceof WorkspaceApiError && error.code === "last_owner_required"
        ? "This organization must retain at least one active owner."
        : workspaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <td><SelectField label="Role" visuallyHiddenLabel disabled={!editable} onChange={(event) => setRole(event.target.value as typeof role)} value={role}>
        <option value="owner">Owner</option><option value="operator">Operator</option><option value="viewer">Viewer</option>
    </SelectField></td>
    <td>
      <form className={styles.form} onSubmit={(event) => void save(event)}>
        <CheckboxField checked={active} disabled={!editable} label="Active" onChange={(event) => setActive(event.target.checked)} visuallyHiddenLabel />
        {pending && editable && (
          <div className={styles.pending}>
            <TextField label="Reason for change" onChange={(event) => setReason(event.target.value)} required value={reason} />
            <Button disabled={busy || !reason.trim()} type="submit">{busy ? "Saving…" : "Save changes"}</Button>
          </div>
        )}
        {message && <p className={styles.message} role="status">{message}</p>}
      </form>
    </td>
  </>;
}
