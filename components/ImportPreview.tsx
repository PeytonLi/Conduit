"use client";

import { useState, type FormEvent } from "react";
import type { MembershipContext } from "@/lib/auth";
import styles from "./import-preview.module.css";

const fileFields = [
  { field: "suppliers.csv", label: "Suppliers CSV" },
  { field: "items.csv", label: "Items CSV" },
  { field: "purchase_orders.csv", label: "Purchase orders CSV" },
  { field: "purchase_order_lines.csv", label: "Purchase order lines CSV" },
  { field: "receipt_schedules.csv", label: "Receipt schedules CSV" },
  { field: "inventory.csv", label: "Inventory CSV" },
  { field: "demand.csv", label: "Demand CSV" },
] as const;

type FileField = (typeof fileFields)[number]["field"];
type ImportStatus = "staged" | "invalid" | "active" | "superseded";
type ValidationIssue = {
  file: string | null;
  row: number | null;
  field: string | null;
  message: string;
};
type ValidationSummary = {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  counts: Record<string, number>;
};
type ImportRecord = {
  import_id: string;
  status: ImportStatus;
  row_version: number;
  dataset_id: string | null;
  validation_summary: ValidationSummary;
  preview: { counts: Record<string, number> };
};
type ImportEnvelope<T> = {
  data?: T;
  error?: { code?: string };
};
type ImportRequestError = Error & { status: number; code: string };

const maxFileBytes = 5 * 1024 * 1024;
const maxTotalBytes = 20 * 1024 * 1024;

function requestError(status: number, code: string): ImportRequestError {
  return Object.assign(new Error(code), { status, code });
}

async function responseData<T>(response: Response): Promise<T> {
  const envelope = await response.json().catch(() => null) as ImportEnvelope<T> | null;
  if (!response.ok) {
    throw requestError(response.status, envelope?.error?.code ?? "request_failed");
  }
  if (!envelope?.data) throw requestError(0, "invalid_response");
  return envelope.data;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "status" in error) {
    const requestError = error as ImportRequestError;
    if (requestError.code === "forbidden_contact_confirmation") {
      return "Only an owner can confirm contact permissions.";
    }
    if (requestError.status === 413) return "Each CSV must be at most 5 MB and all files together at most 20 MB.";
    if (requestError.status === 409) return "This import changed. Review its latest status before trying again.";
    if (requestError.status === 403) return "You don’t have permission to complete this import.";
    if (requestError.status === 422) return "Check the import details and CSV files, then try again.";
  }
  return "The import could not be completed. Try again.";
}

function statusLabel(status: ImportStatus): string {
  switch (status) {
    case "staged": return "Staged";
    case "invalid": return "Invalid";
    case "active": return "Active";
    case "superseded": return "Superseded";
  }
}

function issueLabel(issue: ValidationIssue): string {
  const location = [issue.file, issue.row === null ? null : `row ${issue.row}`, issue.field]
    .filter(Boolean)
    .join(" · ");
  return location ? `${location}: ${issue.message}` : issue.message;
}

export function ImportPreview({ role }: { role: MembershipContext["role"] }) {
  const [files, setFiles] = useState<Partial<Record<FileField, File>>>({});
  const [sourceAsOf, setSourceAsOf] = useState("");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [currency, setCurrency] = useState("USD");
  const [importRecord, setImportRecord] = useState<ImportRecord | null>(null);
  const [contactPermissionsConfirmed, setContactPermissionsConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canImport = role === "owner" || role === "operator";
  const selectedFiles = fileFields.flatMap(({ field }) => files[field] ? [files[field]!] : []);
  const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  const oversizedFile = selectedFiles.some((file) => file.size > maxFileBytes);
  const oversizedBatch = selectedBytes > maxTotalBytes;

  async function stageImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!canImport) {
      setError("Only owners and operators can import business data.");
      return;
    }
    if (fileFields.some(({ field }) => !files[field])) {
      setError("Choose one CSV file for each file type.");
      return;
    }
    if (oversizedFile || oversizedBatch) {
      setError("Each CSV must be at most 5 MB and all files together at most 20 MB.");
      return;
    }
    if (!sourceAsOf.trim() || !timezone.trim() || !/^[A-Z]{3}$/.test(currency)) {
      setError("Enter a source timestamp with an offset, a timezone, and a three-letter currency.");
      return;
    }

    setBusy(true);
    try {
      const form = new FormData();
      form.append("metadata", JSON.stringify({
        schema_version: 1,
        source_as_of: sourceAsOf.trim(),
        timezone: timezone.trim(),
        currency,
      }));
      for (const { field } of fileFields) form.append(field, files[field]!);
      const staged = await responseData<{
        import_id?: string | null;
        status: ImportStatus;
        row_version?: number;
        dataset_id?: string | null;
        validation_summary?: ValidationSummary;
        preview?: { counts: Record<string, number> };
      }>(await fetch("/api/v1/imports", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: form,
      }));

      if (staged.import_id) {
        const current = await responseData<ImportRecord>(
          await fetch(`/api/v1/imports/${staged.import_id}`),
        );
        setImportRecord(current);
      } else if (staged.validation_summary) {
        setImportRecord({
          import_id: "",
          status: staged.status,
          row_version: staged.row_version ?? 0,
          dataset_id: staged.dataset_id ?? null,
          validation_summary: staged.validation_summary,
          preview: staged.preview ?? { counts: staged.validation_summary.counts },
        });
      } else {
        setImportRecord({
          import_id: "",
          status: staged.status,
          row_version: staged.row_version ?? 0,
          dataset_id: staged.dataset_id ?? null,
          validation_summary: { errors: [], warnings: [], counts: {} },
          preview: staged.preview ?? { counts: {} },
        });
      }
      setContactPermissionsConfirmed(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function activateImport() {
    if (!importRecord?.import_id || importRecord.status !== "staged") return;
    setError("");
    setBusy(true);
    try {
      const activated = await responseData<{
        import_id: string;
        dataset_id: string;
        status: "active";
        row_version: number;
      }>(await fetch(`/api/v1/imports/${importRecord.import_id}/activate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          expected_version: importRecord.row_version,
          contact_permissions_confirmed: role === "owner" && contactPermissionsConfirmed,
        }),
      }));
      setImportRecord({
        ...importRecord,
        status: activated.status,
        row_version: activated.row_version,
        dataset_id: activated.dataset_id,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="import-heading" className={styles.section}>
      <h2 id="import-heading">Import business data</h2>
      <p>Upload one CSV for each data type. Each file can be up to 5 MB; the complete upload can be up to 20 MB.</p>
      {!canImport ? (
        <p role="status">Only owners and operators can import business data.</p>
      ) : (
        <form className={styles.form} onSubmit={stageImport}>
          <div className={styles.metadata}>
            <label>
              Source data as of (ISO 8601 with offset)
              <input
                onChange={(event) => setSourceAsOf(event.target.value)}
                placeholder="2026-10-12T15:00:00Z"
                required
                type="text"
                value={sourceAsOf}
              />
            </label>
            <label>
              Timezone
              <input
                onChange={(event) => setTimezone(event.target.value)}
                required
                value={timezone}
              />
            </label>
            <label>
              Currency
              <input
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                required
                value={currency}
              />
            </label>
          </div>
          <div className={styles.files}>
            {fileFields.map(({ field, label }) => (
              <label key={field}>
                {label}
                <input
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    setFiles((current) => ({ ...current, [field]: file }));
                    setError("");
                  }}
                  type="file"
                />
              </label>
            ))}
          </div>
          {(oversizedFile || oversizedBatch) && (
            <p role="alert">Each CSV must be at most 5 MB and all files together at most 20 MB.</p>
          )}
          <button disabled={busy || !canImport || oversizedFile || oversizedBatch} type="submit">
            {busy ? "Preparing import…" : "Preview import"}
          </button>
        </form>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {importRecord && (
        <section aria-labelledby="import-result-heading" className={styles.result} aria-live="polite">
          <h3 id="import-result-heading">Import preview</h3>
          <p role="status">Status: <strong>{statusLabel(importRecord.status)}</strong></p>
          {Object.entries(importRecord.preview.counts).length > 0 && (
            <ul className={styles.counts}>
              {Object.entries(importRecord.preview.counts).map(([file, count]) => (
                <li key={file}>{file}: {count} rows</li>
              ))}
            </ul>
          )}
          {importRecord.validation_summary.errors.length > 0 && (
            <div>
              <h4>Needs attention</h4>
              <ul>{importRecord.validation_summary.errors.map((issue, index) => <li key={`${issue.file}-${issue.row}-${index}`}>{issueLabel(issue)}</li>)}</ul>
            </div>
          )}
          {importRecord.validation_summary.warnings.length > 0 && (
            <div>
              <h4>Warnings</h4>
              <ul>{importRecord.validation_summary.warnings.map((issue, index) => <li key={`${issue.file}-${issue.row}-${index}`}>{issueLabel(issue)}</li>)}</ul>
            </div>
          )}
          {importRecord.status === "staged" && role === "owner" && (
            <label className={styles.confirmation}>
              <input
                checked={contactPermissionsConfirmed}
                onChange={(event) => setContactPermissionsConfirmed(event.target.checked)}
                type="checkbox"
              />
              I confirm we have permission to use the supplier contact information in these files.
            </label>
          )}
          {importRecord.status === "staged" && (
            <button
              disabled={busy || (role === "owner" && !contactPermissionsConfirmed)}
              onClick={activateImport}
              type="button"
            >
              {busy ? "Activating…" : "Activate import"}
            </button>
          )}
        </section>
      )}
    </section>
  );
}
