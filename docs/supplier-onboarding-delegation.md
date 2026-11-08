# Supplier onboarding and delegated purchasing

Apply `20261108170000_supplier_onboarding_delegated_purchasing.sql` before deploying the application changes. This feature has been tested locally, not against the hosted organization or real supplier purchases.

Owners manage supplier onboarding at **Suppliers**, also linked from **Settings → Policies**:

1. A candidate has no outreach authority. A contact needs verified identity evidence and permission for its channel before the owner can approve that contact.
2. Contact approval permits outreach within the separate outreach policy, contact hours, and episode budgets. It does not grant purchasing eligibility.
3. An owner separately approves purchasing, providing existing evidence IDs or an onboarding evidence note and a reason. Each decision records its actor, evidence, reason, and stage transition in immutable onboarding history.

Blocking or revoking purchasing prevents plan approval and commitment preparation. Dispatch rechecks eligibility, so a prepared commitment is cancelled if purchasing eligibility was revoked. Revoking the last approved contact also removes purchasing eligibility. Existing imported purchasing approvals are retained; the history records decisions made after this migration.

Every commitment requires a fresh owner approval by default. Owners can opt into **Delegated low-value purchasing** in **Settings → Policies**, setting:

- A positive ceiling in integer minor units, and the organization's currency (no currency conversion).
- An optional supplier allowlist. An empty list covers all purchasing-eligible suppliers.
- ISO weekdays and a same-day hours window in the organization's timezone, with an exclusive end time.
- A daily approval limit (1–20, default 3).

Only ready bridge-purchase plans with verified, current quote terms and unchanged material fingerprints qualify. The database checks the full gross commitment against the ceiling and authorizes exactly that amount. Other plan kinds and out-of-policy plans still need owner approval. Delegated approvals record `approval_mode = 'delegated'`, the policy version, the delegating owner, and the evaluated limits; the case approval card labels them **Owner-delegated approval**.

Delegation grants approval, not new connector capabilities. Bridge purchases continue through the existing manual export/handoff path. No automatic purchase-order creation or supplier commitment transport is added.

**Disable delegated purchasing now** requires an owner and a reason. It uses the latest saved policy, revokes outstanding delegated approvals, and cancels prepared actions. Any policy version change also invalidates outstanding delegated work. Already dispatched work cannot be retracted. Disabling delegation does not revoke ordinary owner approvals.

Before using this live, the owner must apply the migration, verify the business currency and timezone, verify contact identities, approve contacts and purchasing separately, and deliberately enable the desired delegation limits. Existing provider credentials, connection health, and outreach policy still govern external communications. Record a live acceptance run separately; local tests do not prove live provider behavior.
