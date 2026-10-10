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
}: {
  version: number;
  initialSettings: PolicySettings;
  currency: string;
}) {
  const router = useRouter();
  const [currentVersion, setCurrentVersion] = useState(version);
  const [settings, setSettings] = useState(initialSettings);
  const [reason, setReason] = useState("");
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
      setMessage(`Policy version ${result.version} saved`);
      router.refresh();
    } catch (saveError) {
      if (saveError instanceof WorkspaceApiError && saveError.code === "stale_version") {
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
