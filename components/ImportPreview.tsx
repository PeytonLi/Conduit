"use client";

import { useState, type FormEvent } from "react";
import type { MembershipContext } from "@/lib/auth";
import { detectImportType } from "@/lib/domain/import-detect";
import type { ImportFile } from "@/lib/domain/import-schema";
import { DateTimeField, TextField } from "./ui/Field";
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
const supportedTimeZones = typeof Intl.supportedValuesOf === "function"
  ? Intl.supportedValuesOf("timeZone")
  : ["America/Los_Angeles"];

type FileField = ImportFile;
type UploadedFile = { file: File; type: FileField | null };
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

function dateTimeLocalValue(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function dateTimeLocalToIso(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let instant = target;
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const values = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
      const represented = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
      );
      const adjustment = target - represented;
      if (!adjustment) break;
      instant += adjustment;
    }
    if (dateTimeLocalValue(new Date(instant), timeZone) !== value) return null;
    return new Date(instant).toISOString();
  } catch {
    return null;
  }
}

function issueLabel(issue: ValidationIssue): string {
  const location = [issue.file, issue.row === null ? null : `row ${issue.row}`, issue.field]
    .filter(Boolean)
    .join(" · ");
  return location ? `${location}: ${issue.message}` : issue.message;
}

export function ImportPreview({ role }: { role: MembershipContext["role"] }) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [sourceAsOf, setSourceAsOf] = useState(() => dateTimeLocalValue(new Date(), "America/Los_Angeles"));
  const [currency, setCurrency] = useState("USD");
  const [importRecord, setImportRecord] = useState<ImportRecord | null>(null);
  const [contactPermissionsConfirmed, setContactPermissionsConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canImport = role === "owner" || role === "operator";
  const selectedFiles = files.map(({ file }) => file);
  const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  const oversizedFile = selectedFiles.some((file) => file.size > maxFileBytes);
  const oversizedBatch = selectedBytes > maxTotalBytes;

  async function addFiles(fileList: FileList | File[]) {
    const additions = await Promise.all(
      Array.from(fileList)
        .filter((file) => file.name.toLowerCase().endsWith(".csv"))
        .map(async (file) => ({
          file,
          type: detectImportType(file.name, await file.text()).type,
        })),
    );
    setFiles((current) => {
      const assignedTypes = new Set<FileField>();
      return [...current, ...additions].map((entry) => {
        if (!entry.type) return entry;
        if (assignedTypes.has(entry.type)) return { ...entry, type: null };
        assignedTypes.add(entry.type);
        return entry;
      });
    });
    setError("");
  }

  function changeFileType(file: File, type: FileField | null) {
    setFiles((current) => current.map((entry) => {
      if (entry.file === file) return { ...entry, type };
      if (type && entry.type === type) return { ...entry, type: null };
      return entry;
    }));
  }

  async function stageImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!canImport) {
      setError("Only owners and operators can import business data.");
      return;
    }
    const assignedTypes = files.flatMap(({ type }) => type ? [type] : []);
    if (
      fileFields.some(({ field }) => !assignedTypes.includes(field)) ||
      new Set(assignedTypes).size !== assignedTypes.length
    ) {
      setError("Choose one CSV file for each file type.");
      return;
    }
    if (oversizedFile || oversizedBatch) {
      setError("Each CSV must be at most 5 MB and all files together at most 20 MB.");
      return;
    }
    const sourceAsOfIso = dateTimeLocalToIso(sourceAsOf, timezone.trim());
    if (!sourceAsOfIso || !/^[A-Z]{3}$/.test(currency)) {
      setError("Enter a valid source date and time for the selected timezone, and a three-letter currency.");
      return;
    }

    setBusy(true);
    try {
      const form = new FormData();
      form.append("metadata", JSON.stringify({
        schema_version: 1,
        source_as_of: sourceAsOfIso,
        timezone: timezone.trim(),
        currency,
      }));
      for (const { field } of fileFields) {
        const file = files.find((entry) => entry.type === field)?.file;
        if (file) form.append(field, file);
      }
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
      <p>Upload CSV files for all seven data types. Each file can be up to 5 MB; the complete upload can be up to 20 MB.</p>
      {!canImport ? (
        <p role="status">Only owners and operators can import business data.</p>
      ) : (
        <form className={styles.form} onSubmit={stageImport}>
          <div className={styles.metadata}>
            <DateTimeField
              label="Source data as of"
              onChange={(event) => setSourceAsOf(event.target.value)}
              required
              value={sourceAsOf}
            />
            <label className={styles.timezoneField}>
              <span>Timezone</span>
              <select onChange={(event) => setTimezone(event.target.value)} required value={timezone}>
                {!supportedTimeZones.includes(timezone) && <option value={timezone}>{timezone}</option>}
                {supportedTimeZones.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <TextField
              label="Currency"
              maxLength={3}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              required
              value={currency}
            />
          </div>
          <label
            className={styles.dropzone}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void addFiles(event.dataTransfer.files);
            }}
          >
            <span>Drop CSV files here or click to browse</span>
            <input
              accept=".csv,text/csv"
              aria-label="Upload CSV files"
              multiple
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files);
                event.target.value = "";
              }}
              type="file"
            />
          </label>
          <div className={styles.files} aria-label="Import file types">
            {fileFields.map(({ field, label }) => {
              const assigned = files.find((entry) => entry.type === field);
              return (
                <div className={styles.fileRow} key={field}>
                  <span className={styles.fileLabel}>{label}</span>
                  {assigned ? (
                    <>
                      <span className={styles.fileName}>{assigned.file.name}</span>
                      <label className={styles.typeOverride}>
                        Change type
                        <select
                          aria-label={`Change type for ${assigned.file.name}`}
                          onChange={(event) => changeFileType(assigned.file, event.target.value as FileField)}
                          value={field}
                        >
                          {fileFields.map((option) => <option key={option.field} value={option.field}>{option.label}</option>)}
                        </select>
                      </label>
                    </>
                  ) : <span className={styles.fileMissing}>Missing</span>}
                </div>
              );
            })}
            {files.filter((entry) => entry.type === null).map(({ file }) => (
              <div className={styles.fileRow} key={`${file.name}-${file.lastModified}`}>
                <span className={styles.fileName}>{file.name}</span>
                <label className={styles.typeOverride}>
                  Change type
                  <select
                    aria-label={`Change type for ${file.name}`}
                    onChange={(event) => changeFileType(file, event.target.value as FileField)}
                    value=""
                  >
                    <option value="">Choose type…</option>
                    {fileFields.map((option) => <option key={option.field} value={option.field}>{option.label}</option>)}
                  </select>
                </label>
              </div>
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
