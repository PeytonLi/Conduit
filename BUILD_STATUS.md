# Conduit — Build status

Last updated: October 9, 2026
Specification baseline: PRD v1.0
Current phase: Planning complete; implementation not started

## Observed workspace state

- Research notes exist at research/neathack-research.md.
- PRD, handoff, and detailed reference chapters have been authored.
- No application source, package manifest, installed project dependencies, or database migrations were present when this specification was written.
- Git is initialized on main, with origin pointing to the public [PeytonLi/Conduit repository](https://github.com/PeytonLi/Conduit).
- No provider credentials, connected accounts, phone calls, supplier messages, or business-system writes have been tested or provisioned.
- Current model choice: DeepSeek. Proposed phone provider: SignalWire.

## Milestone ledger

| Milestone | Status | Evidence |
| --- | --- | --- |
| Specification | Complete | PRD.md and docs/prd/ |
| M0 — Setup and feasibility | In progress | Public GitHub repository created; runtime and provider feasibility checks not started |
| M1 — Domain, data and permissions | Not started | None |
| M2 — Inbox to shortage | Not started | None |
| M3 — Research, email and voice | Not started | None |
| M4 — Approval and recovery recording | Not started | None |
| M5 — Reliability, UX and acceptance | Not started | None |
| M6 — Partner evidence and submission preparation | Not started | None |

## Next action

At the allowed build time, inspect the environment and initialize the application runtime in the existing repository. Enable Entire for the coding session. Establish sandbox provider configurations, then run the M0 DeepSeek/neatlogs and ElevenLabs/SignalWire proofs.

Independent work if credentials are missing: implement deterministic inventory and quote checks against the specified fixtures, with replay mode clearly labeled.

## Open gates

1. Live DeepSeek account/model and usage capture.
2. ElevenLabs custom DeepSeek model + SignalWire SIP + authenticated tools + callback.
3. Authorized Gmail test mailbox and OAuth setup.
4. Actual pilot business system and access; B0 uses imports and a demo ledger.
5. Exa account if live public discovery is included in the build.
6. Partner accounts and publishable evidence.
7. Hackathon coding window must be respected for an eligible entry.

## Specification checks completed

- All internal document links resolve and fenced blocks are balanced.
- All 36 functional requirements have acceptance-test references.
- The catalogs contain 16 distinct user journeys and 42 distinct acceptance scenarios.
- The canonical stock projection, quote/cancellation arithmetic and event/deadline timezone conversions were checked.
- Cross-document review clarified approval consumption, receiving-versus-expected-delivery records, export authority, quote ordering cutoffs and replay clock boundaries.
- These are document checks. Application tests and live provider tests remain unperformed.

## Ongoing update discipline

After each milestone, replace this snapshot with actual state. Record test evidence and remaining failures. Never change “not started” to “complete” based only on source code existing.
