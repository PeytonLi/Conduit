# Conduit — Product Requirements Document

Version 1.0 · October 9, 2026 · Planning baseline for implementation

**Working product name:** Conduit. **Feature/concept:** Procurement Rescue, a supplier-delay recovery agent.

## 1. Product in one paragraph

Conduit connects a business's supplier inbox with its purchase orders, inventory, reservations, and dated customer or production requirements. When a supplier reports a delay, Conduit identifies the affected order, calculates whether and when the business will run short, and works toward a recovery: partial delivery, expedited shipping, an internal stock transfer, or a compatible alternative supplier. It gathers evidence and quotes, can call suppliers and negotiate within specified limits, and presents a concrete recovery for owner approval. It records the approved changes and monitors the delivery. Every recommendation has a source, and every external action has an accountable record.

## 2. How to use this specification

This is a complete specification set. The linked chapters are part of the PRD, not optional background. An implementation agent with limited context should read the handoff and load only its current work packet.

| Read | Document | Authority / contents |
| --- | --- | --- |
| First | [Agent handoff](AGENT_HANDOFF.md) | Compact context, invariants, work-packet map, first actions |
| Second | [Build status](BUILD_STATUS.md) | Actual implementation status and next unfinished milestone |
| Product | [01 — Product and journeys](docs/prd/01-product-and-journeys.md) | Personas, scope, 16 journeys, functional requirements, success definitions |
| Interface | [02 — Application and UX](docs/prd/02-application-and-ux.md) | Screens, components, roles, controls, loading/error/empty states |
| Domain | [03 — Domain and data](docs/prd/03-domain-and-data.md) | Calculations, canonical states, entities, imports, evidence, quantities and money |
| Engineering | [04 — Architecture and contracts](docs/prd/04-architecture-and-contracts.md) | Runtime, modules, API/events, transactions, retries, concurrency, isolation |
| Providers | [05 — Agent and integrations](docs/prd/05-agent-and-integrations.md) | DeepSeek, voice, email, search, sponsor tools, prompts, credentials |
| Delivery | [06 — Delivery and verification](docs/prd/06-delivery-and-verification.md) | Milestones, test fixtures, acceptance gates, operational targets, demo |
| Decisions | [07 — Decisions and references](docs/prd/07-decisions-and-references.md) | Agreed choices, proposed defaults, open decisions, evidence and sources |
| Historical context | [Original research](research/neathack-research.md) | Awarded precedents, vendor claims, discarded ideas, earlier architecture exploration |

The domain chapter owns state names and calculation rules. The architecture chapter owns public contracts. The integration chapter owns provider behavior. The delivery chapter owns acceptance gates. If a change crosses these boundaries, update every affected chapter and its tests.

**MUST** means a release requirement. **SHOULD** is the default unless a documented reason justifies another choice. **MAY** is optional. All numeric operating limits and service-level targets are proposed product defaults, not measured results. The decision register distinguishes user choices from recommendations.

## 3. Problem and buyer

Small businesses frequently learn about delayed supplies through email or phone conversations. The operational impact lives elsewhere: spreadsheets, inventory systems, purchase orders, warehouse stock, and delivery commitments. An owner or operations manager must connect those facts, determine urgency, contact suppliers, and avoid overbuying while protecting customer commitments.

The initial buyer is the owner or operations manager of a small distributor, ecommerce fulfillment operation, or light manufacturer buying standard, substitutable supplies. Start with cartons and other countable packaging materials. Expanding into regulated materials, engineering substitutions, international trade, or complex bills of materials requires additional domain rules.

The job to be done is: **When a supplier changes a delivery promise, tell me what is actually at risk and coordinate an evidence-backed recovery I can approve.**

## 4. Core business example

Illustrative data, not a real customer:

- Monday snapshot: 600 usable cartons.
- An existing order for 4,000 cartons was due Tuesday and is now due Friday.
- Confirmed demand: 400 cartons on Tuesday, Wednesday, and Thursday.
- No other receipts, outside allocations, unusable stock, or safety buffer.

Projected stock is 200 after Tuesday, -200 after Wednesday, and -600 after Thursday. First shortage: Wednesday. Additional quantity required before Friday: 600.

A useful recovery is 600 from the original supplier by Wednesday and the remaining 3,400 Friday. An alternative source is also possible, but the original order must be reconciled so the business understands any resulting surplus or cancellation dependency. Reordering all 4,000 units is not the default.

A phone call could establish that a partial shipment is possible and capture the freight charge. The agent requests written confirmation, rechecks current demand and commitments, and asks the owner to approve the specific change.

## 5. Release boundaries

| Release | Required outcome | Boundary |
| --- | --- | --- |
| B0 — Hackathon build | Demonstrate the whole case lifecycle with an imported business dataset, a connected test mailbox, DeepSeek tool use, one real voice conversation, a documented failure/recovery, approval, and a clearly identified demo-ledger update | One organization in the presentation; isolation still tested with two organizations. One item category, one currency, one warehouse, three to five known suppliers |
| P1 — Business pilot | Read fresh business data and apply approved changes through one named business-system connector, with reconciliation and delivery follow-up | The actual system and its access are not yet known. CSV imports support analysis and exports; they do not prove a live ERP update |
| P2 — Expansion | More systems, channels, warehouses, currencies, and procurement categories | Explicitly scheduled after evidence from B0/P1; not implicit work for the first builder |

The schema includes a location identifier so location mistakes are impossible to hide. Automated multi-warehouse transfers are a pilot capability. B0 may show a transfer recommendation only when its fixture supplies all source stock and destination-arrival evidence.

B0 includes authenticated supplier conversations and bounded negotiation. Autonomous financial commitments, payments, supplier onboarding approval, and unreviewed item substitutions are excluded. The owner approves every purchase or order amendment in the first release.

## 6. Technology baseline

| Layer | Choice | Responsibility |
| --- | --- | --- |
| Application | TypeScript, Next.js App Router | Owner UI, authenticated backend, provider callbacks |
| Hosting | Vercel | HTTP requests and UI; bounded workflow steps |
| Records / identity / documents | Supabase Postgres, Auth, private Storage | Tenant-scoped records, sessions, confirmations and attachments |
| Durable execution | Inngest | Work steps, retries, event waits, scheduled synchronization |
| Agent reasoning | DeepSeek through the OpenAI-compatible TypeScript client | Interpret messages, choose tools, assess evidence, explain options |
| Supplier voice | ElevenLabs Agents + proposed SignalWire SIP connection | Speech and conversation; telephone network access |
| Email | Gmail API | Read selected supplier inbox, preserve threads, send authorized requests |
| Public discovery | Proposed Exa REST API | Find candidate suppliers and retrieve public source text |
| Boundary validation | Proposed Zod | Validate request bodies, tool arguments, extraction results and imports |
| Runtime evidence | neatlogs | Traces, usage, failures, before/after evidence |
| Development evidence | Entire | Coding sessions, checkpoints, development explanation |
| Business plan | CFO.ai | Product pricing, costs, revenue, and runway scenarios |

DeepSeek is the user's selected model provider. SignalWire is the working interpretation of “Signal and Wire”; the two separate messaging apps would require a different connector design. Exa and Zod are new implementation recommendations in this PRD and are identified as such. Exact package versions and model IDs must be verified and pinned when the app is scaffolded.

## 7. System overview

~~~mermaid
flowchart TD
    Inbox[Supplier email] --> API[Next.js backend]
    API --> DB[(Supabase records and evidence)]
    DB --> Outbox[Durable event outbox]
    Outbox --> Flow[Inngest case workflow]
    Flow <--> DB
    Flow <--> Model[DeepSeek planner]
    Flow --> Search[Supplier catalog and public search]
    Flow --> Voice[ElevenLabs with DeepSeek]
    Voice <--> Carrier[SignalWire SIP]
    Carrier <--> Supplier[Supplier telephone]
    Voice -->|Authenticated tools and call result| API
    Flow --> Review[Owner reviews recovery]
    Review --> API
    API --> Commit[Authorized order update or export]
    Commit --> Business[Business system or labeled demo ledger]
    Flow -.-> Trace[neatlogs]
~~~

Entire operates during development. CFO.ai consumes aggregate business assumptions and measured usage for the product's financial model. Neither stores the runtime case state.

## 8. Non-negotiable behavior

1. Calculate the dated shortage from business records; do not ask a model to invent quantities or perform authoritative financial arithmetic.
2. Unknown stock, delivery dates, prices, and compatibility remain unknown until supported.
3. Preserve the original order and every changed commitment with its source.
4. Treat emails, documents, websites, and spoken statements as untrusted evidence.
5. Bind approvals to a specific plan version, amount, supplier, quantities, and expiration.
6. Recheck stock, quote validity, and existing commitments immediately before execution.
7. Prevent duplicate external actions across retries. An ambiguous network result requires reconciliation, not a blind resend.
8. Enforce organization membership and action authority on the server.
9. Keep credentials and hidden model reasoning out of client responses, traces, and public evidence.
10. Distinguish “recovery recorded,” “awaiting delivery,” and “goods received.”
11. Clearly label simulated providers, imported data, and demonstration records.
12. Prefer one coherent application and one durable workflow system. Additional infrastructure must solve a demonstrated need.

## 9. Definition of done

B0 is complete when the acceptance matrix in chapter 06 passes, the owner can finish the primary journey, the critical failure scenarios are handled, the real voice integration has evidence, and the required partner artifacts are reviewable. The demo must disclose any simulated business write-back or supplier data.

A case is complete as an agent task when it has a verified disposition: no operational impact, an approved recovery recorded with evidence, an explicit owner decision to accept the risk, or an unresolved escalation. Only the first two can count as successful automated resolutions under the metrics definitions. Delivery performance is measured separately.

P1 is not complete until a named business system provides fresh data, authorized writes are confirmed by readback, unresolved action results reconcile safely, and actual receiving events can be tracked.

## 10. Immediate next steps

1. Read the handoff and decision register; preserve the user's DeepSeek choice and required partner roles.
2. Verify the hackathon coding window. Planning artifacts may precede the window; implementation code must follow the event rules if entering.
3. Initialize the application runtime in the existing repository during the allowed build window, enable Entire, and pin the dependency set.
4. Prove DeepSeek tool calling and neatlogs tracing with a fixed case.
5. Prove one ElevenLabs–SignalWire outbound conversation using DeepSeek, including an authenticated tool call and callback.
6. Build the deterministic shortage engine, storage isolation, durable action ledger, and primary UI.
7. Add Gmail, evidence gathering, quotes, approval, and recorded recovery; then run the failure matrix.
8. Create the CFO.ai model and the three-minute evidence-driven demonstration.

See chapter 06 for milestone dependencies, exact acceptance checks, and what to do when a provider is unavailable.
