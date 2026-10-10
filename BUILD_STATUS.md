# Conduit — Build status

Last updated: October 10, 2026
Specification baseline: PRD v1.0
Current phase: Phase 1 foundation implemented and locally verified; provider feasibility remains open

## Observed workspace state

- Research notes exist at research/neathack-research.md.
- PRD, handoff, and detailed reference chapters have been authored.
- At the time this specification was written, no application source, package manifest, installed project dependencies, or database migrations were present.
- The implementation work is on `devin/1791572968-phase1-setup`, based on the public [PeytonLi/Conduit repository](https://github.com/PeytonLi/Conduit).
- Local environment verified: Node.js v22.23.3, pnpm 10.34.6, Docker 29.7.2, and Supabase CLI 2.120.0.
- No provider credentials, connected accounts, phone calls, supplier messages, or business-system writes have been tested or provisioned.
- Current model choice: DeepSeek. Proposed phone provider: SignalWire.

## Milestone ledger

| Milestone | Status | Evidence |
| --- | --- | --- |
| Specification | Complete | PRD.md and docs/prd/ |
| M0 — Setup and feasibility | In progress | Pinned: Next 16.4.0, React 19.3.0, Supabase JS 2.117.3, SSR 0.12.7, Inngest 4.22.0, Zod 4.6.5, OpenAI 7.31.0, neatlogs 1.1.28, Vitest 5.0.3, Playwright 1.64.0, Supabase CLI 2.120.0. Passed locally: `pnpm install --frozen-lockfile`, `pnpm db:start`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (5 tests), `pnpm db:reset && pnpm test:db` (3 tests), `pnpm build`, `pnpm exec playwright install chromium`, `pnpm test:e2e` (2 tests), and `pnpm seed:demo`. Local Supabase remains running. Live provider proofs, CI, and Entire agent setup remain incomplete. |
| M1 — Domain, data and permissions | Not started | None |
| M2 — Inbox to shortage | Not started | None |
| M3 — Research, email and voice | Not started | None |
| M4 — Approval and recovery recording | Not started | None |
| M5 — Reliability, UX and acceptance | Not started | None |
| M6 — Partner evidence and submission preparation | Not started | None |

## Next action

After the lead integrates this foundation, start Phase 2 on the documented feature-owned branches. Complete provider proofs when the required sandbox accounts and permissions are available, and enable Entire when a supported coding-agent integration is available.

If provider credentials remain unavailable, continue deterministic inventory and quote work against the specified fixtures in clearly labeled replay mode.

## Open gates

1. Live DeepSeek account/model and usage capture.
2. ElevenLabs custom DeepSeek model + SignalWire SIP + authenticated tools + callback.
3. Authorized Gmail test mailbox and OAuth setup.
4. Actual pilot business system and access; B0 uses imports and a demo ledger.
5. Exa account if live public discovery is included in the build.
6. Partner accounts and publishable evidence.
7. Hackathon coding window must be respected for an eligible entry.
8. Entire CLI 0.11.4 is installed, but `entire status` reports not set up. `entire enable` requires selecting a supported coding-agent integration; none was available in this Devin environment.

## Voice connection investigation — October 9, 2026

- Addressed F4/M0/AT-15 diagnosis on `codex/fix-signalwire-tls`, based on `origin/main` at `7635346`.
- Read-only ElevenLabs checks found three failed Conduit calls with `SIP 404: Domain unavailable` and no transcript. The configured outbound address was a registered-device `.sip.signalwire.com` domain; the inspected SignalWire project had no Domain Applications.
- Verified trusted TLS 1.3 on port 5061 for that SignalWire host and `sip.rtc.elevenlabs.io`. This does not prove SIP routing or media interoperability.
- Corrected setup to reject the known wrong domain/address format and empty digest credentials before provider writes, and to update existing SIP trunk routing and credentials instead of only assigning the agent. Added missing setup variables to `.env.example` and documented the authenticated Domain Application path in `docs/voice-setup.md`.
- Regression reproduced before the fix: setup updated only `agentId` on an existing number; seven invalid configurations were accepted. After the fix, all 24 focused voice tests passed, including rejection before any provider writes. Typecheck, lint, and diff whitespace checks passed. The full unit suite had 260 passes and two unrelated failures: CSV content hashing with Windows CRLF fixtures, and the inventory performance threshold (106.37 ms versus 100 ms). Checks ran on the available Node 24.14.0; the project pins Node 22.
- Inspected the user's live harness branch at `8928486` (`devin/1791582744-live-voice-harness`); its preparation scripts use the same voice adapter and need no contract changes for this fix.
- During the initial investigation, provider configurations and application data were not changed and no test calls were placed. Schema and supplier-call payload contracts are unchanged. The subsequently authorized live attempt is recorded below.
- Next action: obtain a PSTN termination Domain Application and its digest credentials from SignalWire, apply the corrected setup in the live environment, and run AT-15 with an explicitly authorized test contact. Live voice remains unverified. Rem's persistent media bridge is an alternative if direct SIP provisioning is unavailable.

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
- **Transport caveats:** native `sip_trunk` remains unverified after SignalWire SIP 404. `busy` was not exercised live (only its mapping is unit-tested); `initiation_failed` was proven earlier on the SIP path. The media-bridge verification does not establish native SIP behavior.

## Specification checks completed

- All internal document links resolve and fenced blocks are balanced.
- All 36 functional requirements have acceptance-test references.
- The catalogs contain 16 distinct user journeys and 42 distinct acceptance scenarios.
- The canonical stock projection, quote/cancellation arithmetic and event/deadline timezone conversions were checked.
- Cross-document review clarified approval consumption, receiving-versus-expected-delivery records, export authority, quote ordering cutoffs and replay clock boundaries.
- These are document checks. Local application checks are recorded in the M0 ledger; live provider tests remain unperformed.

## Ongoing update discipline

After each milestone, replace this snapshot with actual state. Record test evidence and remaining failures. Never change “not started” to “complete” based only on source code existing.
