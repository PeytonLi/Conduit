"use client";

import { useRef, useState } from "react";
import { postJson, WorkspaceApiError, workspaceErrorMessage } from "./client-api";
import styles from "./quote-correction-form.module.css";

export function QuoteCorrectionForm({
  quoteId,
  expectedVersion,
  timezone,
  evidenceOptions,
  originalText,
}: {
  quoteId: string;
  expectedVersion: number;
  timezone: string;
  evidenceOptions: { id: string; label: string }[];
  originalText: string;
}) {
  const intentKey = useRef<{ fingerprint: string; value: string } | null>(null);
  const [quantity, setQuantity] = useState("");
  const [priceMinor, setPriceMinor] = useState("");
  const [arrival, setArrival] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!/^[0-9]+$/.test(quantity) || !Number.isSafeInteger(Number(quantity))) {
      setError("Quantity must be a whole number.");
      return;
    }
    if (!/^-?[0-9]+$/.test(priceMinor)) {
      setError("Price must be entered as integer minor units, without a decimal point.");
      return;
    }
    if (!arrival || !timezone) {
      setError("Add a correction time and timezone.");
      return;
    }
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    if (!evidenceId) {
      setError("Select source evidence for this correction.");
      return;
    }
    const requestBody = {
      expected_version: expectedVersion,
      quantity: Number(quantity),
      unit_price_minor: BigInt(priceMinor).toString(),
      correction_local_time: arrival,
      timezone,
      reason: reason.trim(),
      evidence_id: evidenceId,
    };
    const fingerprint = JSON.stringify(requestBody);
    if (intentKey.current?.fingerprint !== fingerprint) {
      intentKey.current = { fingerprint, value: crypto.randomUUID() };
    }
    setBusy(true);
    try {
      await postJson(`/api/v1/quotes/${quoteId}/correct`, requestBody, intentKey.current.value);
      intentKey.current = null;
      setMessage("Quote correction submitted for review.");
      setOpen(false);
    } catch (cause) {
      if (cause instanceof WorkspaceApiError && cause.status === 404) {
        setError("Quote correction isn’t available in this build yet. The original extracted text is unchanged.");
      } else {
        setError(workspaceErrorMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.correction}>
      <button aria-expanded={open} onClick={() => setOpen((value) => !value)} type="button">
        Correct quote
      </button>
      {open && (
        <form onSubmit={(event) => void submit(event)}>
          <p>Original extracted text (preserved)</p>
          <blockquote>{originalText || "No extracted text was retained."}</blockquote>
          <label>
            Corrected quantity
            <input inputMode="numeric" onChange={(event) => setQuantity(event.target.value)} pattern="[0-9]+" required value={quantity} />
          </label>
          <label>
            Corrected unit price (minor units)
            <input inputMode="numeric" onChange={(event) => setPriceMinor(event.target.value)} pattern="-?[0-9]+" required value={priceMinor} />
          </label>
          <label>
            Corrected arrival (local date and time)
            <input onChange={(event) => setArrival(event.target.value)} required type="datetime-local" value={arrival} />
          </label>
          <label>
            Timezone
            <input readOnly value={timezone} />
          </label>
          <label>
            Source evidence
            <select onChange={(event) => setEvidenceId(event.target.value)} required value={evidenceId}>
              <option value="">Select evidence</option>
              {evidenceOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label>
            Reason
            <textarea onChange={(event) => setReason(event.target.value)} required value={reason} />
          </label>
          {error && <p role="alert">{error}</p>}
          <button disabled={busy} type="submit">{busy ? "Submitting…" : "Submit correction"}</button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
