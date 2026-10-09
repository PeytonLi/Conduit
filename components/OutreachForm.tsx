"use client";

import { useMemo, useRef, useState } from "react";
import type { SupplierContactView } from "@/lib/db/queries/cases";
import { outreachBodyLimit, validateOutreachDraft, type OutreachChannel } from "@/lib/outreach-validation";
import { humanLabel } from "@/lib/db/queries/labels";
import { LiveRegion } from "./LiveRegion";
import { postJson, workspaceErrorMessage } from "./client-api";
import styles from "./outreach-form.module.css";

export function OutreachForm({
  caseId,
  contacts,
  isReplay,
}: {
  caseId: string;
  contacts: SupplierContactView[];
  isReplay: boolean;
}) {
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const selected = contacts.find((contact) => contact.id === contactId) ?? contacts[0];
  const channels = useMemo(() => {
    if (!selected) return [];
    return [...new Set([selected.channel, ...selected.permitted_channels])]
      .filter((channel): channel is OutreachChannel => channel === "email" || channel === "phone");
  }, [selected]);
  const [channel, setChannel] = useState<OutreachChannel>(channels[0] ?? "email");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [replayNotice, setReplayNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const intentKey = useRef<string | null>(null);
  const limit = outreachBodyLimit(channel);
  const draftError = validateOutreachDraft({ channel, body, subject: channel === "email" ? subject : undefined });

  async function submit() {
    const validation = validateOutreachDraft({ channel, body, subject: channel === "email" ? subject : undefined });
    if (validation) {
      setError(validation);
      return;
    }
    if (!selected || !channels.includes(channel)) {
      setError("Choose a permitted supplier contact and channel.");
      return;
    }
    setError("");
    setMessage("");
    setReplayNotice("");
    setSubmitting(true);
    const idempotencyKey = intentKey.current ?? crypto.randomUUID();
    intentKey.current = idempotencyKey;
    try {
      const result = await postJson<{
        result: "prepared_action" | "draft";
        denials?: (string | { code?: string })[];
      }>(`/api/v1/cases/${caseId}/outreach`, {
        contact_id: selected.id,
        channel,
        message: { ...(channel === "email" && subject.trim() ? { subject: subject.trim() } : {}), body: body.trim() },
      }, idempotencyKey);
      intentKey.current = null;
      if (result.result === "prepared_action") {
        setMessage("Request prepared");
        if (isReplay) setReplayNotice("Replay: simulated; no supplier is contacted.");
      } else {
        const denials = (result.denials ?? []).map((denial) =>
          humanLabel("outreachDenial", typeof denial === "string" ? denial : denial.code),
        );
        setMessage(`Saved as draft; not sent:${denials.length ? ` ${denials.join(", ")}` : ""}`);
      }
    } catch (submitError) {
      setError(workspaceErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="contact-supplier-heading" className={styles.form}>
      <h3 id="contact-supplier-heading">Contact supplier</h3>
      <label className={styles.contactField}>
        Supplier contact
        <select
          onChange={(event) => {
            const next = contacts.find((contact) => contact.id === event.target.value);
            setContactId(event.target.value);
            const permitted = [...new Set(next ? [next.channel, ...next.permitted_channels] : [])]
              .filter((value): value is OutreachChannel => value === "email" || value === "phone");
            intentKey.current = null;
            setChannel(permitted[0] ?? "email");
            setSubject("");
          }}
          value={selected?.id ?? ""}
        >
          {contacts.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.supplier_name} — {contact.display_name ?? contact.masked_address} ({humanLabel("outreachChannel", contact.channel)})
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        Channel
        <select onChange={(event) => {
          intentKey.current = null;
          setChannel(event.target.value as OutreachChannel);
        }} value={channel}>
          {channels.map((permitted) => <option key={permitted} value={permitted}>{humanLabel("outreachChannel", permitted)}</option>)}
        </select>
      </label>
      {channel === "email" && (
        <label className={styles.field}>
          Subject
          <input maxLength={200} onChange={(event) => {
            intentKey.current = null;
            setSubject(event.target.value);
          }} value={subject} />
        </label>
      )}
      <label className={styles.messageField}>
        Message
        <textarea maxLength={limit + 1} onChange={(event) => {
          intentKey.current = null;
          setError("");
          setBody(event.target.value);
        }} value={body} />
      </label>
      {channel === "phone" && <p aria-live="polite" className={styles.counter}>{body.length}/{limit}</p>}
      {(error || draftError) && <p className={styles.error} role="alert">{error || draftError}</p>}
      <button className={styles.submit} disabled={submitting || Boolean(draftError)} onClick={() => void submit()} type="button">
        {submitting ? "Preparing…" : "Prepare request"}
      </button>
      {message && <p className={styles.result}>{message}</p>}
      {replayNotice && <p className={styles.notice}>{replayNotice}</p>}
      <LiveRegion message={[message, replayNotice].filter(Boolean).join(" ")} />
    </section>
  );
}
