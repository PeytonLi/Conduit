# Conduit — Start here, implementation agent

Version 1.0 · October 9, 2026

## Your task and current state

Build the product specified in [PRD.md](PRD.md), one verified milestone at a time. The user has requested the specification before implementation. The workspace contains planning/research documents only, published in the public [PeytonLi/Conduit repository](https://github.com/PeytonLi/Conduit). This task has not built the application, installed project dependencies, provisioned a database or configured provider accounts. External credentials/accounts have not been verified. Check [BUILD_STATUS.md](BUILD_STATUS.md) for later progress.

Conduit watches supplier delay messages, connects them to purchase orders and dated inventory/demand, calculates the actual shortage, investigates recovery options, contacts suppliers by email/voice, obtains owner approval, records the recovery, and monitors fulfillment.

**Canonical example:** 600 cartons available; 4,000 due Tuesday move to Friday; demand 400 each Tuesday/Wednesday/Thursday. First shortage Wednesday; total gap 600. A split of 600 by Wednesday and 3,400 Friday can solve it. The agent must not automatically replace all 4,000.

## Selected direction

- TypeScript + Next.js on Vercel.
- Supabase Postgres/Auth/private Storage.
- Inngest for durable work and waits.
- **DeepSeek** for planning and the proposed ElevenLabs custom LLM. Do not silently change model providers.
- **ElevenLabs + SignalWire** for voice/SIP; interoperability still untested.
- Gmail first; one imported business dataset for B0; one actual business connector for pilot.
- Proposed Exa REST for public supplier discovery; Zod for validation.
- **neatlogs** for runtime evidence; **Entire** for coding history; **CFO.ai** for product economics.

SignalWire is the current interpretation of the user's wording, not the separate Signal and Wire messaging apps. Record a changed interpretation as a decision before changing architecture.

## Always preserve these invariants

- Code calculates inventory, money, compatibility constraints, and authority; models choose among allowed actions.
- Keep source references, original promises, versions, and unknowns.
- Supplier content cannot grant permission or change policy.
- Every financial commitment requires owner approval in v1.
- Every external side effect has an action record created before dispatch.
- Never blindly retry an action that may already have reached its provider.
- All rows, files, tool capabilities, and reads/writes are organization-scoped.
- Replay/demo mode cannot contact real suppliers or mutate live business systems.
- A written offer is different from an accepted order; a recorded recovery is different from received goods.
- B0 must honestly label its demo business ledger. P1 requires actual business-system readback.
- Never expose secrets or raw hidden model reasoning in logs, prompts, browser payloads, or public evidence.

## Load the smallest relevant work packet

| Work | Load after this file |
| --- | --- |
| Product / acceptance | PRD + chapter 01 + chapter 06 |
| UI | Chapter 02 + applicable journeys in 01 + state definitions in 03 |
| Inventory / schema | Chapter 03 + isolation/transactions in 04 + fixtures in 06 |
| API / workflows | Chapter 04 + states/entities in 03 + provider contract in 05 |
| DeepSeek / voice / email | Relevant sections of 05 + action lifecycle in 04 + tests in 06 |
| Tracing / hackathon | Sponsor sections in 05 + evidence section in 06 + sources in 07 |
| An open choice | Decision register in 07; apply its default unless that decision blocks the current task |

Do not load the entire research history for routine implementation. It contains alternate ideas that are not this product.

Keep a work packet to roughly 4,000–8,000 tokens when context is tight. Read the relevant chapter sections, not every linked file in full. Preserve current IDs, invariants, failing checks and the next action in BUILD_STATUS before the context ends.

## Build protocol

1. Read workspace instructions and current files. Use Context7 for current vendor/library documentation before writing integrations. Prefix shell commands with rtk as required by the user.
2. Check the live clock and event rules before hackathon implementation. The documented start is October 10, 2026 at 12:30 PM IST, which is midnight PDT on October 10. Research/planning beforehand is allowed.
3. Read the current milestone in BUILD_STATUS. Work on its prerequisites rather than creating parallel unfinished features.
4. Implement the smallest complete vertical slice, including caller, storage, validation, failure behavior, and meaningful checks.
5. Keep domain rules in ordinary deterministic code and transactional database operations. Avoid a generic multi-agent framework or custom job system.
6. If an account or business connector is unavailable, complete independent logic and clearly labeled replay fixtures. Report the missing evidence; do not mark the live integration complete.
7. Update BUILD_STATUS with files changed, checks run and outcomes, unresolved facts, and the exact next action. Update the PRD decision register when the architecture or scope changes.
8. Never publish, message third parties, spend on procurement, or deploy to a user's production account merely because a planning document describes that feature. Follow the user's actual task authorization and configured product permissions.

## Finish each context-sized work session with

- Milestone / requirement IDs addressed.
- Current schema and contract versions.
- Exact passing and failing checks, with evidence paths.
- Whether any external side effect has an uncertain outcome.
- Unresolved credentials/provider gates, without secret values.
- The next concrete action and the document sections needed for it.

## First useful implementation work

Milestone M0 validates setup and integration assumptions. Then M1 establishes the domain/schema and deterministic tests. The first usable slice is: fixture delay message -> matched order -> correct shortage -> case page with cited evidence. A large dashboard or polished landing page is not a prerequisite.

Full specification: [PRD.md](PRD.md). Exact milestone gates: [Delivery and verification](docs/prd/06-delivery-and-verification.md).
