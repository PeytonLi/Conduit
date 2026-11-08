# Conduit — Build status

Last updated: November 8, 2026
Specification baseline: PRD v1.0
Current phase: Phases 1 and 2 built and deployed on Render; acceptance and submission evidence remain open

## Observed workspace state

- Policy configuration is owner-gated. Optional delegated low-value bridge-purchase approvals are implemented; delegation defaults off, so every commitment still needs fresh owner approval until an owner explicitly enables a bounded policy. Hosted migration/configuration and a live owner acceptance run remain open.
- Research notes exist at research/neathack-research.md.
- PRD, handoff, and detailed reference chapters have been authored.
- The application lives in the public [PeytonLi/Conduit repository](https://github.com/PeytonLi/Conduit) with 23 Supabase migrations applied to the hosted project (including the live business-connector tables).
- Hosting: Render Starter web services in Oregon for the app and the voice bridge, with deploys gated on passing CI. `/api/health` reports DeepSeek, Gmail, voice, Exa and Inngest configured.
- Local environment verified: Node.js v22.23.3, pnpm 10.34.6, Docker 29.7.2, and Supabase CLI 2.120.0.
- Provider credentials are configured on the hosted app. A full live run (Gmail connected, real supplier email, real call) has not yet been recorded as evidence on the Render deployment. The only real business-system writes so far are audited test writes to an Intuit QuickBooks Online sandbox company (see AT-37 below).
- Current model choice: DeepSeek. Current voice route: SignalWire REST + `<Connect><Stream>` to the ElevenLabs WebSocket media bridge (PR #12, `VOICE_TRANSPORT=media_bridge`), superseding native SIP after `SIP 404 Domain unavailable` from the registered-device host.

## Milestone ledger

| Milestone | Status | Evidence |
| --- | --- | --- |
| Specification | Complete | PRD.md and docs/prd/ |
| M0 — Setup and feasibility | In progress | Pinned: Next 16.4.0, React 19.3.0, Supabase JS 2.117.3, SSR 0.12.7, Inngest 4.22.0, Zod 4.6.5, OpenAI 7.31.0, Vitest 5.0.3, Playwright 1.64.0, Supabase CLI 2.120.0. Passed locally: `pnpm install --frozen-lockfile`, `pnpm db:start`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (5 tests), `pnpm db:reset && pnpm test:db` (3 tests), `pnpm build`, `pnpm exec playwright install chromium`, `pnpm test:e2e` (2 tests), and `pnpm seed:demo`. Local Supabase remains running. Live provider proofs and CI remain incomplete. |
| M1 — Domain, data and permissions | Done | Schema, tenant controls, deterministic inventory, action ledger, and integration hardening landed in [#1](https://github.com/PeytonLi/Conduit/pull/1), [#3](https://github.com/PeytonLi/Conduit/pull/3), and [#7](https://github.com/PeytonLi/Conduit/pull/7). |
| M2 — Inbox to shortage | Done | Inbox ingestion and case workflow delivered in [#6](https://github.com/PeytonLi/Conduit/pull/6), with UI and integration work in [#7](https://github.com/PeytonLi/Conduit/pull/7) and [#13](https://github.com/PeytonLi/Conduit/pull/13). |
| M3 — Research, email and voice | Done | Planner, call contracts, provider wiring, and media bridge delivered in [#5](https://github.com/PeytonLi/Conduit/pull/5), [#9](https://github.com/PeytonLi/Conduit/pull/9), [#10](https://github.com/PeytonLi/Conduit/pull/10), [#11](https://github.com/PeytonLi/Conduit/pull/11), and [#12](https://github.com/PeytonLi/Conduit/pull/12). Live voice-provider success remains unverified; see the M0 gate and voice investigation below. |
| M4 — Approval and recovery recording | Done | Versioned recovery, owner/operator approval flows, ledger recording, and voice/action integration landed in [#3](https://github.com/PeytonLi/Conduit/pull/3), [#8](https://github.com/PeytonLi/Conduit/pull/8), [#12](https://github.com/PeytonLi/Conduit/pull/12), and [#14](https://github.com/PeytonLi/Conduit/pull/14). |
| M5 — Reliability, UX and acceptance | In progress | Reliability and UX work landed in [#7](https://github.com/PeytonLi/Conduit/pull/7), [#13](https://github.com/PeytonLi/Conduit/pull/13), and [#14](https://github.com/PeytonLi/Conduit/pull/14). AT-38 retention/disconnect controls and AT-33 replay isolation (`tests/domain/at33-replay-isolation.test.ts`) are covered. AT-37 Real connector passed against a QuickBooks Online sandbox; see the evidence below. |
| M6 — Evidence and submission preparation | In progress | A measured inventory before/after performance run and repository setup/docs exist; the complete evidence bundle and demo video/submission artifacts remain **outstanding** (scaffold only in `docs/evidence/`). See [#14](https://github.com/PeytonLi/Conduit/pull/14) for inventory performance work; follow `docs/evidence/render-e2e-runbook.md` and `docs/evidence/submission-checklist.md` for the live Render pack. |

## Next action

Execute the Render live E2E using [docs/evidence/render-e2e-runbook.md](docs/evidence/render-e2e-runbook.md): sign up, connect Gmail, receive a supplier delay email, place one call to an approved test number, approve a plan. Fill [docs/evidence/templates/live-run-record.md](docs/evidence/templates/live-run-record.md) and drop artifacts under `docs/evidence/artifacts/` per [docs/evidence/artifact-conventions.md](docs/evidence/artifact-conventions.md). Baseline health: `node scripts/evidence/capture-health-snapshot.mjs` with `APP_BASE_URL` set. Optionally repeat AT-37 on Zoho Inventory or a hosted Odoo once a test account is connected. **No live Render E2E has been recorded in this evidence pack yet.**

## Open gates

1. Recorded live evidence on the Render deployment (Gmail, voice, DeepSeek usage) — tracked in [docs/evidence/submission-checklist.md](docs/evidence/submission-checklist.md).
2. M6 evidence bundle, demo video and submission artifacts — slots under `docs/evidence/artifacts/`; see [docs/evidence/README.md](docs/evidence/README.md).

## Supplier onboarding and delegated purchasing — November 8, 2026

- Implemented locally: supplier stages (`candidate` → `contact_approved` → `purchasing_eligible`, plus blocked), separate owner approvals, evidence notes/IDs, immutable tenant-scoped onboarding history, and contact-version conflict checks. Revoking the last approved contact removes purchasing eligibility. Candidate/blocked suppliers cannot authorize commitments; eligibility is rechecked before dispatch.
- Owners can optionally enable bounded bridge-purchase approvals in Settings → Policies: ceiling in integer minor units, matching business currency, supplier allowlist, local weekdays/hours, and a daily limit. Default remains off. Ready plans from the API and planner run the database gate; approvals and audit events explicitly identify delegation, policy version, evaluated terms, and the accountable owner. Planner finalization captures the material fingerprint and uses the replay clock.
- The owner-only emergency disable control revokes outstanding delegated approvals and cancels prepared actions. Policy changes do the same. Concurrent approvals share a database lock so they cannot exceed the daily limit. Already dispatched work cannot be retracted; ordinary owner approvals are retained.
- Verification: lint and typecheck passed; full unit suite **982 passed, 24 skipped**; **48 integration tests passed** across onboarding/delegation, approvals, actions, live transfers, planner/ledger, and ledger suites against an isolated local PostgreSQL database. The complete feature migration also applied successfully to a fresh schema clone. Production build passed with local Supabase environment values.
- **Not deployed or verified live.** Apply migration `20261108170000_supplier_onboarding_delegated_purchasing.sql` before the application update. Owners still need verified contact identity evidence, separate contact/purchasing decisions, correct organization currency/timezone, and explicit delegation opt-in. No automatic purchase-order creation is added: approved bridge purchases use the existing manual export/handoff path. Full browser journeys and the entire integration suite were not run in this worktree. Setup and limits: [docs/supplier-onboarding-delegation.md](docs/supplier-onboarding-delegation.md).
- The build reports a security upgrade notice for the existing pinned Next.js 16.4.0 dependency; no dependency versions were changed in this feature.

## Outlook and multiple mailboxes — November 8, 2026

Decision D-022 (docs/prd/07). Setup and the live checklist: [docs/outlook-setup.md](docs/outlook-setup.md).

- An organization can hold several mailbox connections (Gmail and Outlook) with one **primary**. Migration `20261108130000_outlook_multi_mailbox.sql` adds `connections.is_primary` (partial unique index, mailbox providers only), provider-neutral `mailbox_*` RPCs, `inbox_list_mailbox_connections`, a generalized `ui_disconnect_connection` (by connection id, any health) and `ledger_claim_dispatch` that validates the mailbox the action names instead of "any Gmail". `inbox_store_message` now stores a second copy of the same inbound Message-ID from another mailbox as `ignored` with no event.
- Outlook: OAuth code flow with PKCE (`lib/integrations/outlook/oauth.ts`), Graph Inbox delta sync into `ingestMessage` (`sync.ts`, Inngest `inbox-outlook-poll`), draft-then-send with Message-ID reconciliation in Sent Items (`api.ts`). Every Microsoft call goes through a replay guard.
- Routing: `request_supplier_email` takes an optional `connection_id`; the supplier email adapter resolves the transport from the connection in the payload (`lib/integrations/mailbox/resolve.ts`). UI: Mailboxes list with health, primary, make-primary and per-connection disconnect/remove.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test` (676 passed), integration suite against local Supabase (all suites passed, including new `mailbox-multi.test.ts`), `pnpm build`, and the Playwright spec `ui-activity-integrations-members` (4 passed).
- **Not verified live.** No Microsoft credentials were available. Open: the checklist in docs/outlook-setup.md, notably that Exchange preserves the draft's `internetMessageId` (send reconciliation depends on it), immutable-id behavior of the delta endpoint, and tenant consent policy for `Mail.ReadWrite`/`Mail.Send`.
- Limits: poll only (no Graph push), no `In-Reply-To` threading on Outlook sends, Inbox folder only. The operator outreach endpoint (`POST .../outreach`) still builds a payload without `connection_id`, as before.

## Internal stock transfer execution (J06, FR-011) — November 8, 2026

Internal transfers can now be executed, not only recommended, when the connected business system supports it. The owner still approves every transfer. **No transfer has been run against a real Shopify store or any other live business system.** All evidence below is mocked or runs against a local database.

| Provider | Transfers | How |
| --- | --- | --- |
| Shopify | **Executes** when the token holds `write_inventory_transfers` and `write_inventory_shipments`; otherwise recommend-only | Create a READY_TO_SHIP transfer (reserves the origin), then an in-transit shipment (dispatches), then read both back. Both writes carry deterministic idempotency keys; the transfer's `referenceName` and the shipment barcode carry the stamp derived from the action id. |
| Odoo, Zoho Inventory, QuickBooks Online | Recommend-only | No transfer writes exist in these connectors. A transfer is still shown, still checked against the source, and exports as a manual packet. The reason is shown to the owner. |

What changed:

- Domain (`lib/domain/transfers.ts`, `plans.ts`): the existing source-coverage rule is shared and extended with `maxSafeTransferQuantity` (exact binary search over the same projection), capability blockers (reserve, dispatch, receive), and a source-must-differ check. Quantities come from code, never from a model.
- Ledger: new action kind `live_business_transfer` (migrations `20261108150000`, `20261108150100`). The action row exists before dispatch; the approved step must match the action payload (source, quantity, arrival, cost, item, destination); the approval is consumed in the same transaction; the quantity is held as an allocation claim at the source and the destination; an unknown outcome blocks the case and keeps claims `uncertain` until reconciled. Locks cover both locations. One automated write per plan still applies.
- Idempotent change refs and reconciliation: the action id is the change reference. `executeApprovedPlan` now settles an existing action for a step instead of preparing again, so a replayed event cannot re-send (this also covers amendments). Reconcile reads Shopify by stamp or provider reference and never writes: in transit/received is confirmed, reserved but not dispatched stays unknown, cancelled fails.
- Freshness: plan creation refuses a quantity the source cannot spare (also as a recommendation). Before the write the connection is re-resolved, the snapshot is refreshed (any change supersedes the dataset, so the approval is rejected as stale), the coverage rule runs again on the fresh facts, and the connector re-reads live source stock and refuses to write if on-hand minus the quantity is below the floor pinned at prepare time.
- UI: case Options tab lists sources with what each can spare and whether Conduit will execute or only recommend (with the reason); the operator supplies quantity, arrival time in the location's time zone, and handling cost to create the plan. The approval card shows source, arrival, cost, mode, and in-flight / confirmed / unknown / failed states with the connector's readback as evidence.
- Shopify permission: `write_inventory_transfers` is requested only when `SHOPIFY_TRANSFER_EXECUTION=true`; the default OAuth scopes are unchanged. Stores connected earlier must reconnect.

Checks run (Node 24.14; the project pins 22): `pnpm typecheck`, `pnpm lint`, `pnpm test` (645 passed, 24 skipped), `pnpm build` compiles (static generation needs Supabase env, not provided). New tests: `tests/domain/transfers.test.ts`, `shopify-transfer.test.ts`, `live-transfer.test.ts`, `transfer-ui.test.ts`, and `tests/integration/live-transfer.test.ts` (12 tests: ledger, approval, claims, stale data, unknown and reconcile, replay, manual export). The integration tests ran against a schema-only copy of the local Supabase database with the new migrations applied, together with the existing action, approval, ledger, planner-ledger and erp-live integration suites; `supabase db reset` was not run on this migration set, and the remaining integration suites (RLS and grants) were not meaningful on that copy.

Limits and unresolved facts:

- Shopify mutation shapes (`inventoryTransferCreateAsReadyToShip`, `inventoryShipmentCreateInTransit`, `InventoryLevel` quantities) follow Shopify's published 2026 docs and an emulator; they have not run against a store. Whether READY_TO_SHIP reserves exactly the `available` quantity, and the shipment barcode and `referenceName` fields, are unverified live. AT-37 is not claimed for transfers. The existing opt-in `tests/domain/shopify-live.test.ts` is the place to add the live proof.
- Stock in transit is not a scheduled receipt in Conduit. After dispatch the source stock drops at the next sync, but the destination only sees the units once Shopify shows them received, so a reassessment during transit can look short. Receiving is read back from the shipment; Conduit never receives goods.
- Reconciling by stamp scans Shopify transfers (up to 1,000) when no provider reference is stored.
- Plans with a live transfer and a live amendment are rejected (one automated write per plan). The DeepSeek planner can still propose `transfer_stock`, but those plans stay drafts because the model cannot supply source, arrival, or cost; transfers are created from the Options tab.
- Transfer cost and arrival time are entered by the operator; no shipping lane or handling-cost data exists.

## DeepSeek thinking mode (opt-in) — November 8, 2026

- `DEEPSEEK_THINKING_ENABLED=true` turns on thinking for the planner and message extraction. Default stays off; voice prompts untouched.
- Hidden reasoning is replayed to DeepSeek from a process-local `ReasoningVault` only; durable step output, DB rows, telemetry and browser payloads carry an opaque handle. Design and caveats: docs/prd/05-agent-and-integrations.md section 3.
- Checks: `pnpm test` (532 passed, incl. `tests/domain/deepseek-thinking.test.ts`), `pnpm typecheck`, `pnpm lint`. Not verified against the live DeepSeek API (no run recorded with thinking on); keep it off in production until one planner cycle has been observed.

## AT-37 real connector evidence — November 7, 2026

Passed for QuickBooks Online against a real Intuit sandbox company ("Sandbox Company US 9497", `sandbox-quickbooks.api.intuit.com`). An independent audit session approved the planned writes before they ran, and every write targeted only that sandbox. The run used the shared `describeErpClientContract` suite through `tests/domain/quickbooks-live.test.ts` (skipped unless its env flag is set), with the code from [#39](https://github.com/PeytonLi/Conduit/pull/39), [#41](https://github.com/PeytonLi/Conduit/pull/41), [#42](https://github.com/PeytonLi/Conduit/pull/42) and [#43](https://github.com/PeytonLi/Conduit/pull/43).

| Check | Result |
| --- | --- |
| Fresh read | Passed: snapshot of purchase orders, items and vendors read live. |
| Version conflict | Passed: a write with a stale `SyncToken` was refused and reported as a conflict, not applied. |
| Approved write and readback | Passed: delivery split applied (original PO reduced, a second PO created with the `CDT-` change reference), then read back and matched. |
| Unknown write reconciliation | Passed: retrying the same change reference found the existing change instead of creating a duplicate, and an unknown reference returned `not_found`. |
| Receiving | Passed, with a manual step: Bill 153 was created by hand in the QuickBooks UI from purchase order 1010 (QBO id 151). `listReceipts` returned `bill:153:2` for 1 of 10 units on line `151:1`, and the snapshot showed `received_qty` 1. |

Limits:

- The QuickBooks API cannot create a Bill linked to a purchase order (a line link is rejected with "Add a line item to continue"; a header link is dropped), so receiving is only visible when bills are entered from the purchase order inside QuickBooks.
- QuickBooks has no per-line delivery dates, so a split becomes a reduced original PO plus a new PO. It has no demand source, so demand stays empty.
- One extra unaudited sandbox write happened while debugging: an unlinked $1 Bill (id 152).
- Odoo passed the same contract against a local Odoo 20 container in [#40](https://github.com/PeytonLi/Conduit/pull/40), not a customer system.
- Zoho Inventory passed every contract check against a real Zoho Inventory test org in [#37](https://github.com/PeytonLi/Conduit/pull/37), including receiving through purchase receives; see that PR for its evidence.
- Shopify has **not** been run against a real store yet; AT-37 is not claimed for it. `tests/domain/shopify-live.test.ts` is ready to run the shared contract against one declared development store (`SHOPIFY_LIVE_TEST=preflight` reads only, `SHOPIFY_LIVE_TEST=1` writes; see `.env.example`), and is skipped without credentials. It refuses to write unless the API reports the declared shop, a development plan, and an active location and tracked item. What it covers once credentials exist: fresh read, a stable version, version conflict, approved split with readback and no duplicate on retry, unknown-write reconciliation (the response to a real shipment create is dropped, then the retry completes it without a duplicate), change-reference reuse, `not_found` for an unknown change, receiving through a shipment received outside Conduit, and refresh-token rotation with the new pair stored. Documented limits:
  - Shopify has no conditional write (no ETag or `If-Match`) and transfers expose no `updatedAt`, so the version is a hash of the transfer and conflict detection is a read-compare-write with a small window, not an atomic check.
  - Transfers have no per-line delivery date. A split creates one dated shipment per delivery, and only quantity not already on a shipment can be split.
  - Demand comes from fulfillment orders, which the contract fixture does not seed, so demand mapping stays covered by mocks only.
  - Conduit never creates receipts; the fixture ships and receives units to stand in for a warehouse, which needs the shipment-receive write scope on the dev-store token.
  - The cleanup that cancels the seeded transfers is best effort, and the contract's transfer and shipment mutations are written from Shopify's documented shapes and have not run against a store yet.

## Voice connection investigation — October 9, 2026

- Addressed F4/M0/AT-15 diagnosis on `codex/fix-signalwire-tls`, based on `origin/main` at `7635346`.
- Read-only ElevenLabs checks found three failed Conduit calls with `SIP 404: Domain unavailable` and no transcript. The configured outbound address was a registered-device `.sip.signalwire.com` domain; the inspected SignalWire project had no Domain Applications.
- Verified trusted TLS 1.3 on port 5061 for that SignalWire host and `sip.rtc.elevenlabs.io`. This does not prove SIP routing or media interoperability.
- Corrected setup to reject the known wrong domain/address format and empty digest credentials before provider writes, and to update existing SIP trunk routing and credentials instead of only assigning the agent. Added missing setup variables to `.env.example` and documented the authenticated Domain Application path in `docs/voice-setup.md`.
- Regression reproduced before the fix: setup updated only `agentId` on an existing number; seven invalid configurations were accepted. After the fix, all 24 focused voice tests passed, including rejection before any provider writes. Typecheck, lint, and diff whitespace checks passed. The full unit suite had 260 passes and two unrelated failures: CSV content hashing with Windows CRLF fixtures, and the inventory performance threshold (106.37 ms versus 100 ms). Checks ran on the available Node 24.14.0; the project pins Node 22.
- Inspected the user's live harness branch at `8928486` (`devin/1791582744-live-voice-harness`); its preparation scripts use the same voice adapter and need no contract changes for this fix.
- During the initial investigation, provider configurations and application data were not changed and no test calls were placed. Schema and supplier-call payload contracts are unchanged. The subsequently authorized live attempt is recorded below.
- The original native SIP follow-up is superseded by PR #12's SignalWire REST + `<Connect><Stream>` media-bridge route (`VOICE_TRANSPORT=media_bridge`); the registered-device host returned `SIP 404 Domain unavailable`. Native SIP is historical, not an open verification item.

### Authorized live call test — October 9, 2026, 4:59 PM PDT

- At the user's explicit request, submitted one outbound call through the currently assigned Conduit agent and SignalWire SIP trunk to the user's previously supplied test number. Used a clearly disclosed connection-test brief; no real order or commitment was authorized.
- API outcome: HTTP 200 with `success: false` and `INVITE failed: sip status: 404: Domain unavailable (SIP 404)`. Conversation ID: `conv_0401m4hhqxqtfrjrvg0fjwy9ks03`; attempt timestamp: `2026-10-09T23:59:56.193Z`.
- Independently fetched that conversation: `status: failed`, duration 0 seconds, transcript 0 turns, no user audio, no response audio, and `call_initialization_error` code 404. The live address remains the registered-device `.sip.signalwire.com` host, TLS, media encryption `allowed`, with credentials present.
- End-to-end result: **failed at SIP call initialization**. No phone connection occurred. Two-way audio, scoped tools, signed callback ingestion, and the app's action/database workflow were not verified; this was a direct provider call-path probe because Conduit's application environment is not available in this checkout.
- No automatic retry, provider-configuration changes, or uncertain call outcome. The setup PR does not provision the missing carrier termination route. AT-15 remains open.

### Authorized media-bridge live call tests — October 10, 2026

- **Call 1** (action `4863e7d8…`, conversation `conv_3501m4ksf999efp96xk72qxxwdwk`): connected through the bridge and gave the AI disclosure at 0 seconds. The supplier's “Hello.” was transcribed, but the supplier heard no agent audio. The bridge parsed the wrong ElevenLabs audio shape and routed pong responses incorrectly; commit `e0ad6a1` fixed top-level `audio_event.audio_base_64` handling and routes pongs to ElevenLabs. Outcome: `answered_no_solution` / `no_offer`; no tools; no redial.
- **Call 2** (21:06Z, action `fc808e23…`, SignalWire SID `c6abb07c…`, conversation `conv_0101m4kt7cp9fbj9aft34q9yt2av`): two-way audio verified. First agent audio arrived 0.45 seconds after the agent WebSocket opened; 6,001 carrier-to-agent and 167 agent-to-carrier audio chunks were recorded, with one interruption clearing carrier audio. The agent disclosed that it was an AI, confirmed the contact, and stated PO-1042, the SKU, and the need for 600 units. The supplier offered 200 units arriving Monday. The carrier side ended the call at approximately 140 seconds, before price was gathered. No Conduit tools were called because the prompt used bare tool names while the agent registered `conduit_`-prefixed names; prompt v2 aligns these names, pending provider update. Action state: `confirmed`. The signed post-call webhook stored `answered_no_solution` / `no_offer`; the status callback completed; no redial.
- **Call 3** (2026-10-10 21:31:56Z, action `f9f2670f-4cfa-49b0-91c9-0343a8ae7940`, SignalWire SID `eb3870df…`, conversation `conv_9001m4kvp09yes9rj19054cjwg0c`; prompt `supplier-call.v2`): two-way audio. First agent audio arrived 0.45 seconds after the agent WebSocket opened; 14,724 carrier-to-agent and 375 agent-to-carrier chunks were recorded, with three interruptions cleared. The agent disclosed that it was an AI at 0 seconds and confirmed the contact.
  - `conduit_read_case_facts` succeeded once at 23 seconds; `validate_offer` succeeded twice; `record_provisional_offer` recorded quote `0bee5ffe…` as provisional; `request_written_confirmation` succeeded; `conduit_end_call` completed; then the ElevenLabs system `end_call` ran. All tool calls succeeded.
  - The provisional offer was for 600 units at USD 0.40 per unit (40 minor units), with USD 50.00 freight (5,000 minor units); split delivery was allowed. Arrival was the end of local October 14, quote validity ended October 16 local, and the latest order date was the start of October 13 local. `verified_at` was null. `validate_offer` reported `meets_deadline=false`: the date-only arrival is local end-of-day, after the first shortage at 09:00 local on October 14.
  - The supplier confirmed the read-back. The agent stated owner approval was required and made no commitment. Termination was `end_call tool was called`; the bridge logged `hangup_requested` with `agent_end` and REST HTTP 200, then carrier stop. `ended_first=agent`; duration was 294 seconds. The action was confirmed; the signed post-call webhook stored `answered_with_offer` / `provisional_offer`; `supplier.call.finished` was published; no redial occurred.
- **Call 4** (2026-10-10 21:52:14Z, action `8bb6b302-c060-4bb7-9058-252650d1b9d6`, SignalWire SID `fe7c7d17…`): the supplier declined. A SignalWire `no-answer` callback arrived at 48 seconds with no ElevenLabs conversation; the bridge forwarded a signed `call_status` callback and Conduit returned HTTP 200. The outcome was `no_answer` / `not_reached`, with `transport_completed=false`; `supplier.call.finished` was published. The case had exactly two `supplier_call` actions, so there was no redial.
  - The callback exposed a correlation bug: `provider_conversation_id` was set to the SignalWire SID. Migration `20261012190700_voice_bridge_callback_conversation_id.sql` fixes future bridge callbacks; the existing sandbox row was left as recorded.
- **Tool authorization probes:** requests to `/api/voice/tools/read_case_facts` without a header and with a bogus `x-conduit-voice-token` both returned HTTP 401.
- **AT-15 — VERIFIED via `media_bridge` (2026-10-10).** Met criteria: authorized sandbox calls; AI disclosure and contact confirmation; two-way audio and interruption clearing; scoped case-fact and offer tools; provisional offer capture, read-back confirmation, and clean agent-initiated end without commitment; signed callback/outcome and `supplier.call.finished` evidence; no-answer outcome handling and no redial under the case cap; and rejection of missing/invalid tool authorization.
- **Transport caveats:** native `sip_trunk` was superseded after SignalWire SIP 404 and is not an open verification item. `busy` was not exercised live (only its mapping is unit-tested); `initiation_failed` was proven earlier on the SIP path. PR #12's `media_bridge` route was verified in AT-15.

## Specification checks completed

- All internal document links resolve and fenced blocks are balanced.
- All 36 functional requirements have acceptance-test references.
- The catalogs contain 16 distinct user journeys and 42 distinct acceptance scenarios.
- The canonical stock projection, quote/cancellation arithmetic and event/deadline timezone conversions were checked.
- Cross-document review clarified approval consumption, receiving-versus-expected-delivery records, export authority, quote ordering cutoffs and replay clock boundaries.
- These are document checks. Local application checks are recorded in the M0 ledger; live provider tests remain unperformed.

## Ongoing update discipline

After each milestone, replace this snapshot with actual state. Record test evidence and remaining failures. Never change “not started” to “complete” based only on source code existing.
