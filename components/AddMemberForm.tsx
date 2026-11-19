"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson, WorkspaceApiError, workspaceErrorMessage } from "./client-api";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { SelectField, TextField } from "./ui/Field";
import styles from "./membership-controls.module.css";

const errorCopy: Record<string, string> = {
  already_member: "This person is already a member.",
  member_in_other_org: "This person already belongs to another organization.",
  password_required: "No account exists for this email yet. Set a temporary password (12+ characters).",
};

export function AddMemberForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("operator");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await postJson<{ created_account: boolean }>(
        "/api/v1/memberships",
        { email: email.trim(), role, ...(password ? { password } : {}) },
        crypto.randomUUID(),
      );
      setMessage(result.created_account
        ? `Added ${email.trim()}. Share the temporary password so they can sign in at /login.`
        : `Added ${email.trim()}. They can sign in with their existing password.`);
      setEmail("");
      setPassword("");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof WorkspaceApiError && errorCopy[error.code]
        ? errorCopy[error.code]
        : workspaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <h2 className={styles.heading}>Add a member</h2>
        <TextField autoComplete="off" label="Email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
        <SelectField label="Role" onChange={(event) => setRole(event.target.value)} value={role}>
          <option value="operator">Operator</option><option value="viewer">Viewer</option><option value="owner">Owner</option>
        </SelectField>
        <TextField
          autoComplete="new-password"
          hint="Needed only if they don’t have a Conduit account yet. 12+ characters."
          label="Temporary password"
          minLength={12}
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
        <Button disabled={busy || !email.trim()} type="submit">{busy ? "Adding…" : "Add member"}</Button>
        {message && <p className={styles.message} role="status">{message}</p>}
      </form>
    </Card>
  );
}
