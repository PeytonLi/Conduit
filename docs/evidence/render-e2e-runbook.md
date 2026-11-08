# Render live E2E runbook

**Goal:** One documented journey on the **hosted Render app** (not local replay): new org signup, Gmail connected, a real supplier delay message becomes a case, one authorized voice call, owner approves a recovery plan. Record everything in [templates/live-run-record.md](./templates/live-run-record.md) and store artifacts per [artifact-conventions.md](./artifact-conventions.md).

**Prerequisites:** Render app and voice bridge deployed (see [README hosting](../../README.md#hosting)). Operator has authorized test phone number, access to a Gmail account that can receive/send test mail, and Render/Supabase dashboard read access if debugging. Provider keys live only in Render env — **never** paste them into this repo.

## 0. Baseline snapshot (before UI work)

1. Set `APP_BASE_URL` to the public Conduit URL (e.g. `https://<service>.onrender.com`).
2. Run `node scripts/evidence/capture-health-snapshot.mjs` (optional `VOICE_BRIDGE_URL`).
3. Note deploy commit from Render dashboard → save in live-run record as `render_deploy_ref`.
4. Confirm `/api/health` returns `capabilities` with expected `ready` flags for deepseek, gmail, voice, exa, inngest (same shape as local; values are booleans only).

## 1. Sign up and org bootstrap

1. Open the Render app URL in a clean browser profile (or incognito).
2. Sign up / sign in via Supabase Auth (email you control).
3. Complete org onboarding if prompted (owner role).
4. **Capture:** screenshot of dashboard or settings showing org name (redact email if publishing).
5. **Record:** user id, org id, UTC timestamp of signup — from Supabase Auth or app profile API if visible to owner.

## 2. Connect Gmail

1. As owner, open inbox / integrations and start Gmail OAuth (Composio or native per deployment).
2. Complete consent with the test mailbox only.
3. Wait until connection status shows connected (not expired).
4. **Capture:** screenshot of connected state (hide tokens).
5. **Record:** connection id or integration label, UTC timestamp when status became connected.
6. If sync is manual, trigger or wait for first poll (cron ~10 min on Inngest free tier — see README).

## 3. Supplier delay email → case

Use the **Harbor Pack** fictional scenario from [PRD fixture](../prd/06-delivery-and-verification.md) §3, or an equivalent clearly labeled test message to an address the connected inbox watches.

1. Send (or receive) one email that states a delay for PO **PO-1042** / SKU **CARTON-302015** (or your org’s matching demo PO if seeded differently on Render).
2. Wait for ingestion (target: within polling window; note actual elapsed time).
3. Open the new case in the app.
4. Verify: single case, sourced fields, assessment phase appropriate (not duplicate cases on refresh).
5. **Record:** Gmail `message_id` (if shown), internal case id, source evidence id, UTC timestamps for send and case creation.
6. **Capture:** case detail screenshot showing source excerpt and shortage facts.

**Checks aligned with acceptance:** AT-03 (no duplicate), AT-05 if ambiguous (stop and document), AT-22 if OAuth fails.

## 4. Research and outreach (as needed for your path)

If the deployment requires research before call:

1. Confirm Exa-backed research ran or operator approved catalog path.
2. **Record:** any research job ids, URLs saved on case (public URLs only in artifacts).

For **voice** path (AT-15 live proof on Render):

1. Confirm an approved supplier contact and authorized **test** phone number (see [voice-setup.md](../voice-setup.md)).
2. Ensure `VOICE_TRANSPORT=media_bridge` and bridge URL matches Render voice service.
3. Start supplier call from the case UI or workflow that dispatches `supplier_call`.
4. During call: AI disclosure, two-way audio, scoped tools if offered — note what actually happened.
5. After call: action outcome, ElevenLabs `conversation_id`, SignalWire call SID if visible in logs, action id from case ledger.
6. **Capture:** action row screenshot, sanitized trace file in `artifacts/traces/`.
7. **Do not** claim AT-15 passed unless criteria in BUILD_STATUS / PRD are met on **this** run.

## 5. Written confirmation / email path (optional in same run)

If exercising email outreach in the same session:

1. Send one approved threaded reply if policy allows.
2. **Record:** action id, message evidence id, recipient domain (not full address in public repo).

## 6. Owner approval and recovery recording

1. Switch to owner account (or same owner session).
2. Review recovery options, approve the current plan version once.
3. Confirm demo ledger / export shows approved split or documented manual handoff.
4. **Record:** plan version id, approval timestamp, commit action id, final case phase.
5. **Capture:** approval UI screenshot, ledger readback screenshot.

**Checks:** AT-19 (binding), AT-23 (recorded recovery), AT-24 if no write connector.

## 7. Close the run record

1. Copy [templates/live-run-record.md](./templates/live-run-record.md) to `artifacts/live-run-<YYYYMMDD>-<slug>.md` (filled, honest).
2. Mark each checklist row in [submission-checklist.md](./submission-checklist.md) only when evidence exists.
3. Update [BUILD_STATUS.md](../../BUILD_STATUS.md) **only** after human review — do not auto-mark gates closed.

## Failure handling

Document failures as first-class evidence (PRD §6): timestamps, error codes, conversation ids, and whether retry occurred. Do not replace failed rows with mock passes.

## Out of scope for this runbook

- AT-37 on production ERP (QuickBooks evidence already in BUILD_STATUS; optional Zoho/Odoo repeat is separate).
- Publishing hackathon post or uploading video without user authorization.
- Changing provider configuration on Render except through documented setup scripts with explicit approval.
