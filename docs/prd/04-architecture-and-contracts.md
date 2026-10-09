# 04 — Architecture, contracts and reliability

PRD v1.0 · Read [03](03-domain-and-data.md) for canonical states/types and [05](05-agent-and-integrations.md) for provider-specific behavior. This chapter owns application contracts and execution semantics.

## 1. Runtime and responsibilities

Use one Next.js TypeScript application on Vercel. Route handlers receive UI requests, OAuth callbacks, voice tools and provider events. Inngest invokes bounded workflow functions in the application. Supabase stores facts, evidence, actions, approvals and the event outbox.

There is no always-running audio server in the baseline. ElevenLabs and SignalWire exchange the voice call over SIP. DeepSeek planning uses normal model requests. Only if the custom voice-model integration needs adaptation should a thin streaming model endpoint be added.

The workflow can pause for hours without keeping a request open. Persist state before acknowledging events. A hosting process or browser tab is never the owner of a case's progress.

~~~mermaid
sequenceDiagram
    participant G as Gmail connector
    participant A as App backend
    participant D as Postgres
    participant W as Inngest
    participant M as DeepSeek
    participant V as ElevenLabs / SignalWire
    participant O as Owner
    G->>A: New supplier message
    A->>D: Transaction: message + case event + outbox
    A-->>W: Publish durable event ID
    W->>D: Load current facts and policy
    W->>M: Bounded context and allowed tools
    M-->>W: Proposed next action
    W->>D: Authorize and prepare action
    W->>V: Start scoped call
    V->>A: Authenticated tool request / signed result
    A->>D: Persist callback and evidence
    A-->>W: Wake matching case
    W->>D: Verify offer and save ready plan
    O->>A: Approve exact plan version
    A->>D: Approval + execution preparation
    W->>D: Revalidate and reserve allocation claims
    W->>A: Execute through selected business connector
    A->>D: Save external readback and outcome
~~~

## 2. Logical modules

| Module | Responsibility | Must not do |
| --- | --- | --- |
| Identity / membership | Verify session, active org role, invite/seed controls | Trust client role or user-editable metadata |
| Inbox ingestion | Cursor, paging, MIME extraction, deduplication and message storage | Execute supplier instructions as policy |
| Matching | Propose/explain candidates; deterministic unique match validation | Resolve ambiguity through invented confidence |
| Inventory domain | Project stock, dates, coverage, plan feasibility | Call an LLM for authoritative arithmetic |
| Quote domain | Normalize costs/specs, missing fields, expiry and ranking | Rank an incomplete price as a confirmed best quote |
| Planner | DeepSeek context, schema validation and bounded tool loop | Write SQL or bypass approved tools |
| Policy checks | Contact, hours, budget, roles and action eligibility | Let the model update its own authority |
| Workflow | Persisted transitions, waits, timeouts and resumption | Treat workflow retries as provider idempotency |
| Action dispatcher | Prepare, send, reconcile and confirm side effects | Blindly repeat uncertain external actions |
| Approval / execution | Version binding, revalidation, claims and readback | Treat an export or verbal promise as a committed update |
| Evidence / audit | Source capture, immutable facts, redaction and export | Store secrets or hidden model reasoning |
| Provider clients | Small typed calls to documented APIs | Become a generic plugin platform |
| Usage / telemetry | Correlate case/action traces and costs | Convert missing costs into zero |
| Demo runner | Replay fixtures against isolated sandbox records | Reach live contacts or business systems |

## 3. Proposed code layout

This is a target layout, not existing implementation:

~~~text
app/
  (auth)/login/
  (workspace)/cases/
  (workspace)/business-data/
  (workspace)/suppliers/
  (workspace)/activity/
  (workspace)/settings/
  api/v1/
  api/webhooks/
  api/voice/tools/
  api/inngest/
components/
  cases/  evidence/  approvals/  imports/  shared/
lib/
  auth/                 # validated session and current memberships
  schemas/              # shared boundary contracts
  domain/               # inventory, quantities, quotes, plans
  db/                   # scoped queries and transactional operations
  agent/                # planner, context assembly, allowed tools
  policies/             # authority and business-limit checks
  actions/              # dispatch and reconciliation
  integrations/         # gmail, deepseek, elevenlabs, signalwire, exa, business
  workflows/            # cases, sync, outbox, reconciliation, monitoring
  telemetry/            # neatlogs and usage normalization
supabase/migrations/
tests/fixtures/
tests/domain/
tests/integration/
tests/journeys/
docs/prd/
~~~

Use direct provider functions and typed domain boundaries. Avoid microservices, an additional queue, a vector database, a generalized connector marketplace, or a multi-agent framework until a concrete requirement needs one.

## 4. API conventions

All business endpoints are under /api/v1. Authenticated sessions resolve the active organization and membership on the server. A client-supplied org_id, actor or role cannot grant access. References must belong to that organization.

Every response contains api_schema_version=1 and request_id, plus data or error. Errors contain code, safe_message, retryable and optional field_errors. Never return provider secrets or raw internal errors.

Mutating user requests include an Idempotency-Key and, for existing mutable records, expected_version. Repeating the same key/body returns the same action or result. A different body under the same key returns 409. Authentication, parsing, origin/CSRF checks and authorization precede mutation.

Use 401 for missing identity; 403 for disallowed role; 404 for nonexistent or other-tenant resources; 409 for stale version, state/policy conflict or uncertain action; 422 for invalid facts/schema; 429 for rate limits; 503 for a temporarily unavailable dependency. A 202 response returns a durable action/job ID that can be polled.

| Endpoint | Inputs / purpose | Output / authority |
| --- | --- | --- |
| GET /cases | Cursor, filters, sort | Scoped paginated case summaries |
| GET /cases/:id | Case ID | Current assessment, plan, next action, source freshness and version |
| POST /cases/from-message | Source text and metadata, or existing message_id | Stored evidence and queued case assessment; owner/operator |
| POST /cases/:id/resolve-match | expected_version, line selections, corrected fields, source/reason | New factual revision and queued assessment |
| POST /cases/:id/reassess | expected_version, reason | Durable reassessment event |
| POST /cases/:id/control | expected_version, pause/resume/assign/close/reopen, reason | Guarded transition; financial risk acceptance owner-only |
| GET /cases/:id/options | Case ID | Candidate plans and missing/rejected constraints |
| POST /cases/:id/outreach | contact_id, channel, purpose, quote fields, expected_version | Prepared action if policy allows; otherwise reviewable draft |
| POST /cases/:id/plans | assessment_id, validated proposal | New draft plan; never an executed purchase |
| POST /plans/:id/approve | plan_version, input_fingerprint, approved_ceiling_minor, expected_version | Approval and execution job; owner only |
| POST /plans/:id/reject | plan_version, reason | Rejection and next workflow transition; owner only |
| POST /plans/:id/export | plan_version | Private recovery packet with manual-execution status |
| POST /actions/:id/reconcile | expected_version, optional external evidence | Reconciliation job; owner/operator; cannot force a fake success |
| GET /actions/:id | Action ID | Submitted/confirmed/failed/unknown and safe provider summary |
| GET /cases/:id/evidence | Case ID | Permitted evidence metadata |
| GET /evidence/:id/access | Evidence ID | Five-minute signed source access after membership check |
| POST /imports | Files + snapshot metadata | Staged import ID and validation job |
| GET /imports/:id | Import ID | Row errors and activation preview |
| POST /imports/:id/activate | expected_version, owner-confirmed contact permissions | Atomic dataset activation and reassessment events |
| GET /business-data | Entity, item/location, cursor | Scoped current records and source times |
| GET /suppliers | Filters/cursor | Candidates and approved suppliers |
| POST /suppliers/:id/approval | contact or purchasing scope, reason, evidence | Versioned owner decision |
| GET /connections | None | Safe readiness details, never credentials |
| POST /connections/:provider/connect | Owner session and provider-specific request | OAuth URL or configuration workflow |
| POST /connections/:id/disconnect | expected_version, reason | Revoke access and stop queued dependent dispatch |
| POST /connections/:id/refresh | expected_version | Authorized sync/health-check job |
| POST /policies | expected_version, validated settings and reason | New immutable policy version; owner only |
| POST /memberships/:id/role | expected_version, role/active | Owner-only change; preserve at least one active owner |
| GET /activity | Cursor and filters | Scoped audit history |
| POST /demo/run | fixture_id, reset flag | Sandbox replay only; disabled for live organization |

Membership creation/login/password recovery should use the documented Supabase Auth flow; do not expose an unauthenticated “create owner” endpoint. Demo account provisioning is a controlled setup task.

### 4.1 Approval payload

Illustrative placeholder contract:

~~~json
{
  "plan_version": 3,
  "input_fingerprint": "<sha256-of-material-facts>",
  "approved_ceiling_minor": "7500",
  "expected_version": 12
}
~~~

The backend derives plan ID, organization, user and actual plan terms. The ceiling is checked against the displayed gross commitment and currency; it does not authorize a different supplier, larger quantity or modified schedule.

Exporting an unapproved plan produces a clearly marked draft and never changes the case outcome. Only an approved plan routed through the manual-execution branch can produce manual_handoff. A viewer's redacted case export grants no purchasing authority.

### 4.2 Assessment response

~~~json
{
  "api_schema_version": 1,
  "request_id": "<uuid>",
  "data": {
    "case_id": "<uuid>",
    "assessment_version": 2,
    "quality": "sufficient",
    "unit": "carton",
    "first_shortage_at": "2026-10-14T16:00:00Z",
    "bridge_quantity": 600,
    "requirements": [
      {"by": "2026-10-14T16:00:00Z", "cumulative_quantity": 200},
      {"by": "2026-10-15T16:00:00Z", "cumulative_quantity": 600}
    ],
    "source_as_of": "2026-10-12T15:00:00Z",
    "input_fingerprint": "<sha256>",
    "evidence_ids": ["<uuid>"],
    "mode": "replay"
  }
}
~~~

This frozen replay example does not imply fresh live data. An insufficient assessment returns null shortage fields and explicit missing/stale facts.

## 5. Event contracts

Every internal event has schema_version=1, event_id, org_id, aggregate_id, occurred_at, correlation_id, causation_id, and typed data containing IDs/versions. Raw emails, secrets and full documents remain in private storage. Event consumers reload authority and state from the database.

| Event | Required data | Consumer effect |
| --- | --- | --- |
| supplier.message.received | message_id | Extract, match and open/update case |
| case.assessment.requested | case_id, source_version | Recalculate from current valid inputs |
| business.snapshot.activated | dataset_id | Reassess affected active cases |
| case.recovery.requested | case_id, assessment_version | Run bounded planner/tool loop |
| supplier.response.recorded | case_id, evidence_id | Resume verification |
| supplier.call.finished | case_id, action_id, conversation_id | Interpret structured result and next action |
| plan.approved | case_id, plan_id, approval_id | Revalidate and prepare execution |
| action.reconcile.requested | action_id | Inspect provider result, never blindly resend |
| action.outcome.recorded | action_id, outcome_version | Continue plan or expose unresolved dependency |
| receipt.recorded | po_line_id, receipt_event_id | Update received quantities and reassess |
| case.control.changed | case_id, version | Apply pause/resume/reopen without deleting evidence |
| policy.changed | policy_version_id | Recheck queued action authority |

The event outbox is committed in the same database transaction as the business change. Publish afterward. A one-minute scheduled dispatcher retries unpublished events. Durable IDs and consumer deduplication tolerate duplicate delivery. If Inngest is down, records remain pending and resume after recovery; do not report workflow completion.

## 6. Workflow execution

1. Claim the case's current work/version. Serialize mutations per case and constrain execution per organization.
2. Reload current membership/policy, run_control, input quality and active action states.
3. Perform deterministic assessment. If material facts are unchanged, reuse the assessment rather than spend on another model call.
4. Assemble bounded context; invoke DeepSeek only when interpretation or planning is needed.
5. Validate each proposed tool call and its authority. Persist its result with sources.
6. Save the next phase and explicit wake condition before waiting.
7. For external replies, use case/action/plan IDs to match the right event.
8. After wake or timeout, reload persisted state and continue from facts rather than a stale in-memory conversation.

Each inference request and its validated tool result is a bounded durable step; do not put an entire multi-call planner cycle or external wait inside one hosting invocation. B0's disabled thinking mode permits storing only sanitized content/tool-call data between steps. If a future thinking-mode protocol needs hidden fields for continuation, add private encrypted short-lived state and redaction tests before enabling it.

Inngest event waits see events after listening begins. A response can arrive early. The callback handler must persist it before publishing. The worker checks persisted outcomes before waiting and uses bounded waits (60-second reconciliation ticks while awaiting critical action/approval results) so a missed wake cannot stall the case indefinitely. For longer supplier waits, retain the durable deadline and check persisted replies on each scheduled wake. An event is a wake-up hint; the database is the source of truth.

Concurrency target: at most five active case steps per organization and one in-flight supplier call per organization. Database locks/version checks enforce correctness independently of workflow concurrency settings. Never hold a database transaction open during a network call or a human wait.

## 7. External action lifecycle

### 7.1 Before dispatch

Within one transaction:

- Revalidate contact/role/policy, allowed mode and input freshness.
- Validate the complete typed payload and compute its canonical hash.
- Look up or create the unique idempotent action.
- For a financial action, verify active approval, exact plan/fingerprint, expiry and gross ceiling.
- Check pending commitments and claim affected stock/demand groups.
- Save audit event/outbox entry and the intended provider.

Consume a financial approval atomically for its one action and record consumed_by_action_id. Continuation/reconciliation of that same action retains the original authority; no different action can reuse it. If the action has not dispatched before approval expiry, cancel the prepared attempt and require renewed review. Expiry after a confirmed dispatch does not erase the external commitment or prevent reconciliation.

Then claim the action via compare-and-swap: prepared -> dispatching. Save dispatch_started_at before calling the provider.

### 7.2 After dispatch

- Definitive provider rejection with no effect: failed.
- Provider accepted and returned a reference: submitted; capture that reference immediately.
- Authoritative completion/readback: confirmed with a typed outcome.
- Timeout, interrupted response, process crash after dispatch, or contradictory readback: unknown.
- Cancelled before dispatch: cancelled. An already submitted action needs provider cancellation/reconciliation, not a local status rewrite.

The retrying workflow first reads this action. It never treats a missing completed step as permission to call the provider again. Use provider idempotency when supported and verified. Otherwise look up by provider reference or recorded external correlation. If the provider cannot establish the result, retain unknown and require operator resolution.

A Gmail RFC Message-ID helps locate a sent message but is not a guaranteed provider idempotency mechanism. Absence from an eventually consistent search is not proof of failed delivery. Similar caution applies when an outbound call succeeded but its returned conversation ID was lost.

### 7.3 Execution and compensation

Revalidate the material input fingerprint immediately before preparing a financial action. It covers stock, demand, commitments, quote terms, destination, policy and plan version; presentation-only changes do not invalidate it.

Local allocation claims prevent simultaneous plans from spending the same available stock/demand allocation. A confirmed receipt and its claim are reconciled without double-counting. Unknown external results keep uncertain claims held.

No cross-provider distributed transaction is assumed. For dependent steps such as cancelling part of an old PO and buying a replacement, the plan must specify order, failure consequences and fallback. A cancellation that succeeds before a replacement fails creates an exposed shortage. In B0, disallow such dependent live multi-write plans; demonstrate a single split amendment or a manual coordinated packet. P1 requires a tested connector-specific sequence and owner-approved consequences.

Never “rollback” a real order by deleting its local row. Compensation is another explicit, authorized business action.

## 8. Provider callbacks and voice tools

- /api/webhooks/elevenlabs receives post-call/failure payloads. Validate the signature against the raw body, enforce timestamp policy using the current SDK, then durably store a callback receipt before returning success.
- /api/voice/tools/:tool receives a per-call secret capability in a header. Resolve its hashed token to the allowed case, contact and tool set. Do not accept arbitrary org/case access from model arguments.
- /api/webhooks/signalwire is optional if the chosen integration needs carrier callbacks; verify the provider's documented authentication before trusting them.
- /api/auth/gmail/callback validates OAuth state, initiating owner identity, redirect URI and organization before storing credentials.
- /api/inngest validates the framework's signing/authentication configuration.

Return a successful callback acknowledgment only after durable storage. Processing occurs asynchronously. Duplicate callbacks acknowledge the original receipt. Unknown conversation IDs are quarantined for reconciliation and cannot create arbitrary cases.

Post-call analysis can arrive after a case is paused or a tool token expires. Accept valid provider evidence for the known action; do not use it to bypass current approval or restart a cancelled action.

## 9. Security, tenancy and storage

All browser access goes through authenticated application routes. Use the documented Supabase SSR session flow and server-verified identity (getUser/getClaims as appropriate); do not trust unverified getSession user data for authority. Mutations check current membership, not only potentially stale role claims.

Enable RLS for exposed tables and explicit least-privilege grants. Reads are organization-membership scoped. Sensitive mutations go through validated backend commands and transactional database functions. Use SECURITY INVOKER by default; do not add a SECURITY DEFINER workaround to fix missing access. Server secret/service credentials bypass RLS and therefore require explicit organization predicates and same-tenant reference validation.

Credential tables and voice-grant hashes live in a private schema with no client access. Use authenticated encryption with a versioned environment-managed key for OAuth refresh tokens. Avoid logging token-bearing responses or URLs.

Private storage paths include org and evidence ID; policies enforce active membership. Signed links expire after five minutes. Reject executable files and unsupported MIME types; cap B0 attachments at 10 MB and imports at 10,000 rows per file. Escape spreadsheet formula prefixes in exported user/supplier strings.

Public URL discovery uses the search provider. If a direct fetcher is later added, it must reject private/local network targets, unsafe schemes, embedded credentials, redirects into private addresses, excessive size and unbounded requests.

Production, preview, sandbox and replay have separate credentials/data. Preview and replay cannot send real supplier messages, start real calls, or write a live business system. The backend enforces this regardless of UI flags.

## 10. Deployment and operational behavior

- Keep app/database regions close where account choices permit; measure actual latency.
- Pin runtime/package versions and commit a lockfile. Record current model IDs, prompt versions and migrations.
- Apply migrations to an isolated environment first; verify grants, RLS and cross-tenant denial before real data.
- Serve read-only case history during a provider outage when the database is healthy. Show stale evidence and pending work.
- Provide a global dispatch pause that leaves inbox/callback ingestion and reconciliation available.
- Rollback application code only when schema compatibility allows; use forward fixes for irreversible migrations.
- Implement health checks without returning secrets. A provider health check is separate from permission to send a real call/email.
- Operational dashboards track unpublished outbox age, callback backlog, unknown actions, expired connections, stale datasets and budget limits.

Provider outage recovery must preserve approvals, uncertain actions and audit history. See [06](06-delivery-and-verification.md) for fault tests and measurable targets.
