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

## Specification checks completed

- All internal document links resolve and fenced blocks are balanced.
- All 36 functional requirements have acceptance-test references.
- The catalogs contain 16 distinct user journeys and 42 distinct acceptance scenarios.
- The canonical stock projection, quote/cancellation arithmetic and event/deadline timezone conversions were checked.
- Cross-document review clarified approval consumption, receiving-versus-expected-delivery records, export authority, quote ordering cutoffs and replay clock boundaries.
- These are document checks. Local application checks are recorded in the M0 ledger; live provider tests remain unperformed.

## Ongoing update discipline

After each milestone, replace this snapshot with actual state. Record test evidence and remaining failures. Never change “not started” to “complete” based only on source code existing.
