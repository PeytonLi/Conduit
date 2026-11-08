"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/Button";
import { policySettingsSchema, type PolicySettings } from "@/lib/policies/schema";
import { parsePolicyMoneyMinor } from "@/lib/policy-money";
import { postJson, WorkspaceApiError, workspaceErrorMessage } from "./client-api";
import { LiveRegion } from "./LiveRegion";
import styles from "./policy-editor.module.css";

const weekdays = [
  [1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"],
  [5, "Friday"], [6, "Saturday"], [7, "Sunday"],
] as const;

function numberField(
  settings: PolicySettings,
  area: "approval" | "freshness" | "budgets" | "outreach",
  key: string,
  value: number,
  setSettings: (next: PolicySettings) => void,
) {
  if (area === "outreach") {
    setSettings({
      ...settings,
      outreach: { ...settings.outreach, [key]: value } as PolicySettings["outreach"],
    });
  } else {
    setSettings({
      ...settings,
      [area]: { ...settings[area], [key]: value },
    } as PolicySettings);
  }
}

export function PolicyEditor({
  version,
  initialSettings,
  currency,
  timeZone,
  suppliers,
}: {
  version: number;
  initialSettings: PolicySettings;
  currency: string;
  timeZone: string;
  suppliers: { id: string; name: string; purchasing_status: string }[];
}) {
  const router = useRouter();
  const [currentVersion, setCurrentVersion] = useState(version);
  const [settings, setSettings] = useState(initialSettings);
  const [reason, setReason] = useState("");
  const [killReason, setKillReason] = useState("");
  const [ceiling, setCeiling] = useState(() => {
    const minor = initialSettings.negotiation.ceiling_minor;
    if (!minor) return "";
    const value = BigInt(minor);
    return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
  });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const delegation = settings.delegated_purchasing;
  function updateDelegation(next: Partial<PolicySettings["delegated_purchasing"]>) {
    setSettings({ ...settings, delegated_purchasing: { ...delegation, ...next } });
  }

  async function killDelegation() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await postJson<{ version: number; delegated_commitments_revoked: number }>("/api/v1/policies/delegation/disable", { reason: killReason.trim() });
      setCurrentVersion(result.version);
      updateDelegation({ enabled: false });
      setMessage(`Delegation disabled. ${result.delegated_commitments_revoked} outstanding commitments revoked.`);
      router.refresh();
    } catch (error) {
      setError(workspaceErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    setError("");
    setMessage("");
    if (!reason.trim()) {
      setError("Enter a reason for this policy change.");
      return;
    }
    let ceilingMinor: string | null;
    try {
      ceilingMinor = parsePolicyMoneyMinor(ceiling);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Check the negotiation ceiling.");
      return;
    }
    const candidate = {
      ...settings,
      commitment_authority: "owner" as const,
      negotiation: { ...settings.negotiation, ceiling_minor: ceilingMinor },
      budgets: { ...settings.budgets, autonomous_commitment_minor: "0" as const },
    };
    const validation = policySettingsSchema.safeParse(candidate);
    if (!validation.success) {
      setError("Check the policy values and try again.");
      return;
    }
    setSaving(true);
    try {
      const result = await postJson<{ version: number }>("/api/v1/policies", {
        expected_version: currentVersion,
        reason: reason.trim(),
        settings: validation.data,
      });
      setCurrentVersion(result.version);
      // Close the form so the visible status (not the clipped LiveRegion) announces success
      // before refresh; avoid remounting via a version key so this message survives.
      setEditing(false);
      setMessage(`Policy version ${result.version} saved`);
      router.refresh();
    } catch (saveError) {
      if (saveError instanceof WorkspaceApiError && saveError.code === "stale_version") {
        setEditing(false);
        setMessage("Policy changed since you opened it; reload.");
      } else {
        setError(workspaceErrorMessage(saveError));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.editor}>
      <Button
        aria-expanded={editing}
        onClick={() => setEditing((open) => !open)}
        variant="secondary"
      >
        {editing ? "Cancel editing" : "Edit policy"}
      </Button>
      <label className={styles.field}>Reason for emergency disable<input maxLength={500} value={killReason} onChange={(event) => setKillReason(event.target.value)} /></label>
      <Button disabled={saving || !killReason.trim()} onClick={() => void killDelegation()} variant="secondary">Disable delegated purchasing now</Button>
      <p className={styles.note}>Disables delegation and cancels work awaiting dispatch. Already dispatched work cannot be retracted.</p>
      {!editing && error && <p role="alert">{error}</p>}
      {!editing && message && <p role="status">{message}</p>}
      {editing && <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset className={styles.group}>
        <legend>Dispatch</legend>
        <label className={styles.checkField}><input checked={settings.dispatch_paused} onChange={(event) => setSettings({ ...settings, dispatch_paused: event.target.checked })} type="checkbox" /> Pause dispatch</label>
      </fieldset>
      <fieldset className={styles.group}>
        <legend>Supplier outreach</legend>
        <label className={styles.checkField}><input checked={settings.outreach.email_enabled} onChange={(event) => setSettings({ ...settings, outreach: { ...settings.outreach, email_enabled: event.target.checked } })} type="checkbox" /> Email enabled</label>
        <label className={styles.checkField}><input checked={settings.outreach.call_enabled} onChange={(event) => setSettings({ ...settings, outreach: { ...settings.outreach, call_enabled: event.target.checked } })} type="checkbox" /> Call enabled</label>
        <fieldset className={styles.days}>
          <legend>Contact weekdays</legend>
          {weekdays.map(([day, label]) => (
            <label className={styles.weekday} key={day}>
              <input
                checked={settings.outreach.contact_hours.weekdays.includes(day)}
                onChange={(event) => {
                  const current = settings.outreach.contact_hours.weekdays;
                  const next = event.target.checked ? [...current, day] : current.filter((value) => value !== day);
                  setSettings({ ...settings, outreach: { ...settings.outreach, contact_hours: { ...settings.outreach.contact_hours, weekdays: next.sort() } } });
                }}
                type="checkbox"
              /> {label}
            </label>
          ))}
        </fieldset>
        <label className={styles.field}>Contact hours start<input type="time" value={settings.outreach.contact_hours.start} onChange={(event) => setSettings({ ...settings, outreach: { ...settings.outreach, contact_hours: { ...settings.outreach.contact_hours, start: event.target.value } } })} /></label>
        <label className={styles.field}>Contact hours end<input type="time" value={settings.outreach.contact_hours.end} onChange={(event) => setSettings({ ...settings, outreach: { ...settings.outreach, contact_hours: { ...settings.outreach.contact_hours, end: event.target.value } } })} /></label>
        {([
          ["max_suppliers_per_episode", "Max suppliers per episode"],
          ["max_calls_per_supplier_per_episode", "Max calls per supplier per episode"],
          ["max_calls_per_episode", "Max calls per episode"],
          ["max_emails_per_supplier_per_episode", "Max emails per supplier per episode"],
        ] as const).map(([key, label]) => (
          <label className={styles.field} key={key}>{label}<input type="number" min={0} value={settings.outreach[key]} onChange={(event) => numberField(settings, "outreach", key, Number(event.target.value), setSettings)} /></label>
        ))}
      </fieldset>
      <fieldset className={styles.group}>
        <legend>Commitment and approval</legend>
        <p className={styles.note}>Commitment authority: owner</p>
        <label className={styles.field}>Negotiation ceiling ({currency})<input inputMode="decimal" onChange={(event) => setCeiling(event.target.value)} value={ceiling} /></label>
        <label className={styles.field}>Approval validity (minutes)<input type="number" min={1} max={30} value={settings.approval.validity_seconds / 60} onChange={(event) => numberField(settings, "approval", "validity_seconds", Number(event.target.value) * 60, setSettings)} /></label>
      </fieldset>
      <fieldset className={styles.group}>
        <legend>Delegated low-value purchasing</legend>
        <p className={styles.note}>Off by default: every commitment needs fresh owner approval. When enabled, eligible bridge purchases within these limits receive a labeled delegated approval. Hours use {timeZone}. Empty allowlist covers all purchasing-eligible suppliers.</p>
        <label className={styles.checkField}><input type="checkbox" checked={delegation.enabled} onChange={(event) => updateDelegation({ enabled: event.target.checked, currency: delegation.currency ?? currency })} /> Enable delegated purchasing</label>
        <label className={styles.field}>Delegated ceiling (integer minor units)<input inputMode="numeric" value={delegation.ceiling_minor ?? ""} onChange={(event) => updateDelegation({ ceiling_minor: event.target.value || null })} /></label>
        <label className={styles.field}>Delegated currency<input maxLength={3} value={delegation.currency ?? currency} onChange={(event) => updateDelegation({ currency: event.target.value.toUpperCase() })} /></label>
        <fieldset className={styles.days}><legend>Supplier allowlist</legend>
          {suppliers.map((supplier) => <label className={styles.weekday} key={supplier.id}>
            <input type="checkbox" checked={delegation.supplier_allowlist.includes(supplier.id)} onChange={(event) => updateDelegation({ supplier_allowlist: event.target.checked ? [...delegation.supplier_allowlist, supplier.id] : delegation.supplier_allowlist.filter((id) => id !== supplier.id) })} />
            {supplier.name} ({supplier.purchasing_status === "approved" ? "purchasing eligible" : "not purchasing eligible"})
          </label>)}
        </fieldset>
        <fieldset className={styles.days}><legend>Delegated weekdays</legend>
          {weekdays.map(([day, label]) => <label className={styles.weekday} key={day}>
            <input type="checkbox" checked={delegation.hours.weekdays.includes(day)} onChange={(event) => updateDelegation({ hours: { ...delegation.hours, weekdays: event.target.checked ? [...delegation.hours.weekdays, day].sort() : delegation.hours.weekdays.filter((value) => value !== day) } })} /> {label}
          </label>)}
        </fieldset>
        <label className={styles.field}>Delegated hours start<input type="time" value={delegation.hours.start} onChange={(event) => updateDelegation({ hours: { ...delegation.hours, start: event.target.value } })} /></label>
        <label className={styles.field}>Delegated hours end<input type="time" value={delegation.hours.end} onChange={(event) => updateDelegation({ hours: { ...delegation.hours, end: event.target.value } })} /></label>
        <label className={styles.field}>Max delegated approvals per day<input type="number" min={1} max={20} value={delegation.max_auto_approvals_per_day} onChange={(event) => updateDelegation({ max_auto_approvals_per_day: Number(event.target.value) })} /></label>
      </fieldset>
      <fieldset className={styles.group}>
        <legend>Freshness (minutes)</legend>
        <label className={styles.field}>Live business data<input type="number" min={1} max={1440} value={settings.freshness.live_business_data_seconds / 60} onChange={(event) => numberField(settings, "freshness", "live_business_data_seconds", Number(event.target.value) * 60, setSettings)} /></label>
        <label className={styles.field}>Availability recheck<input type="number" min={1} max={1440} value={settings.freshness.availability_recheck_seconds / 60} onChange={(event) => numberField(settings, "freshness", "availability_recheck_seconds", Number(event.target.value) * 60, setSettings)} /></label>
      </fieldset>
      <fieldset className={styles.group}>
        <legend>Budgets</legend>
        <label className={styles.field}>Max active case steps<input type="number" min={1} max={50} value={settings.budgets.max_active_case_steps} onChange={(event) => numberField(settings, "budgets", "max_active_case_steps", Number(event.target.value), setSettings)} /></label>
        <label className={styles.field}>Max in-flight calls per organization<input type="number" min={0} max={10} value={settings.budgets.max_inflight_calls_per_org} onChange={(event) => numberField(settings, "budgets", "max_inflight_calls_per_org", Number(event.target.value), setSettings)} /></label>
        <p className={styles.note}>Autonomous commitment: 0</p>
      </fieldset>
      <label className={styles.field}>Reason<textarea maxLength={500} onChange={(event) => setReason(event.target.value)} required value={reason} /></label>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.result}>{message}</p>}
      <LiveRegion message={message} />
      <button className={styles.submit} disabled={saving} type="submit">{saving ? "Saving…" : "Save policy"}</button>
      </form>}
    </section>
  );
}
