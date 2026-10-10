# Conduit — Build status

Last updated: October 9, 2026
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

## Specification checks completed

- All internal document links resolve and fenced blocks are balanced.
- All 36 functional requirements have acceptance-test references.
- The catalogs contain 16 distinct user journeys and 42 distinct acceptance scenarios.
- The canonical stock projection, quote/cancellation arithmetic and event/deadline timezone conversions were checked.
- Cross-document review clarified approval consumption, receiving-versus-expected-delivery records, export authority, quote ordering cutoffs and replay clock boundaries.
- These are document checks. Local application checks are recorded in the M0 ledger; live provider tests remain unperformed.

## Ongoing update discipline

After each milestone, replace this snapshot with actual state. Record test evidence and remaining failures. Never change “not started” to “complete” based only on source code existing.
