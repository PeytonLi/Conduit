# 07 — Decisions, assumptions, open questions and references

PRD v1.0 · October 9, 2026

This register tells a new agent which choices came from the user, which are proposed defaults, and what remains unverified. It is the place to record later scope/architecture changes.

## 1. Decision register

| ID | Decision | Status / basis | Consequence |
| --- | --- | --- | --- |
| D-001 | Build a supplier-delay recovery agent connected to existing business records and communications | User-selected concept | Delay -> impact -> recovery -> approval -> recorded outcome is the primary journey |
| D-002 | Use DeepSeek for reasoning and tool calling | Explicit user choice replacing Claude | Keep DeepSeek as provider; test/pin a current account-available model before implementation |
| D-003 | Use SignalWire as telephone carrier instead of Twilio | Working interpretation of “Signal and Wire,” retained in the accepted proposed stack | First test is SignalWire + ElevenLabs SIP. If the user meant two messaging apps, revise this decision before channel implementation |
| D-004 | Use ElevenLabs for supplier voice | Explicit user requirement | B0 includes a real scoped call; live model/SIP compatibility is still a gate |
| D-005 | Use neatlogs, Entire and CFO.ai | Explicit user requirement and organizer requirement | Runtime traces, development checkpoints and business model must each have visible evidence |
| D-006 | TypeScript + Next.js hosted on Vercel | Proposed stack accepted as the working direction | One application with route handlers and UI |
| D-007 | Supabase Postgres/Auth/private Storage | Proposed working architecture | Tenant-scoped records, explicit grants/RLS, server-only credentials |
| D-008 | Inngest for durable execution | Proposed working architecture | Persist work and wait for replies; database action/outbox semantics remain required |
| D-009 | Gmail is the first communications connector | Proposed default; target business mailbox not supplied | Implement one authorized mailbox, polling first |
| D-010 | Imported CSV + demo ledger first; one named business connector for pilot | Default because target system is unknown | No false claim of live ERP write-back; manual export is a supported product result |
| D-011 | Packaging supplies, integer quantities, USD and one presentation warehouse | Proposed B0 boundary | Keep exact domain constraints; broaden only with new mappings/tests |
| D-012 | Thinking disabled initially for planner and voice | Proposed implementation default | Lower protocol complexity; thinking can be enabled after tool continuation/redaction/latency tests |
| D-013 | Exa REST for public supplier discovery | New proposal in this PRD | One additional API key; approved supplier catalog remains first source |
| D-014 | Zod for boundary validation | New implementation proposal | Shared schemas protect API, model tools, imports and provider payloads |
| D-015 | Owner approves every financial commitment in v1 | Proposed product authority boundary | Outreach permission and negotiation limits do not grant purchasing authority |
| D-016 | One active case per organization/item/location | Proposed consistency rule | Several delayed POs sharing stock are assessed together; messages can link multiple item cases |
| D-017 | Backend action ledger + transactional outbox | Proposed reliability design | Handle early callbacks, restart, retries and unknown external outcomes without a second job platform |
| D-018 | Store private factual evidence and concise explanations | Proposed evidence/privacy design | Avoid raw hidden reasoning and unnecessary personal data in telemetry |
| D-019 | Simple operations UI with CSS Modules/system fonts | Proposed presentation default | Invest first in correct decisions, evidence and approvals |
| D-020 | Public [PeytonLi/Conduit](https://github.com/PeytonLi/Conduit) repository; application code begins during the permitted build window | User authorized public repository creation; planning documents published | Review future public evidence for credentials and private business data before publication |
| D-021 | Conduit is the working product name; Procurement Rescue describes the idea | Workspace-derived working name | Rename consistently if the user chooses another name |

A proposed decision is implementable as the default within the specified scope; it is not a reason to repeatedly stop for cosmetic or routine choices. A credential, contact authorization or business-system fact cannot be guessed.

## 2. Open decisions and concrete resolution

| Question / uncertainty | Current default | How to resolve | Blocks |
| --- | --- | --- | --- |
| Is the intended provider SignalWire? | Yes, working assumption | User clarification if different; preserve architecture until then | A different answer changes the voice/channel implementation |
| Which business system supplies inventory and orders? | CSV snapshot/demo ledger | Owner identifies one system and grants scoped pilot access | Live P1 reads/writes, not B0 domain/UI work |
| Which mailbox is authorized? | Dedicated Gmail test mailbox | Owner OAuth connection in setup | Live email proof |
| Which phone number/contact may be called? | No live number invented | User/owner supplies an authorized test contact and enables that scope | Real call test and supplier outreach |
| Does DeepSeek work reliably inside the configured ElevenLabs agent? | Direct compatible endpoint, thinking off | M0 streamed tool-call/audio/callback experiment | B0 live voice completion |
| Which exact model and package versions? | Current stable account-available versions | Context7/current docs plus actual model request; pin and record in BUILD_STATUS | Reproducible scaffold/provider proof |
| Does neatlogs correctly attribute DeepSeek usage? | Explicit wrapper plus business spans | Inspect one actual stored trace against provider response/billing | Accurate usage evidence |
| Is Gmail OAuth ready beyond a test mailbox? | Controlled testing setup | Check current Google scope/verification/account requirements | Public pilot rollout |
| Is live web discovery needed in the first recording? | Exa proposal, catalog first | Enable a key and verify one source-backed search | Live discovery claim, not catalog recovery |
| Can the business connector reconcile an ambiguous write? | Unknown | Capability proof with safe test records | Any live automated financial update |
| What are acceptable purchasing and contact limits? | Conservative documented defaults; no financial autonomy | Owner configures policy using actual operations | Live dispatch/commitment |
| What retention and provider region fit the customer? | Proposed durations; private storage; no default audio | Owner selects settings before real business data | Real-data pilot |
| What price and demand are validated? | None; CFO.ai scenarios are assumptions | Interviews and measured pilot economics | Commercial claims, not building the prototype |

Do not fabricate customer demand, supported systems, quotes, provider compatibility, account access or live test results to close this register.

## 3. Significant tradeoffs

### Imported data versus a live business connection

Imports let the first agent exercise real domain calculations and an understandable demo. They also age quickly. The source timestamp and manual-export boundary are visible throughout. A pilot requires a coherent, refreshable connector and confirmed writeback.

### Managed voice versus custom audio infrastructure

The initial SIP path reduces audio implementation work. Compatibility and response time remain empirical. Build a thin model adapter only for a demonstrated integration issue; avoid an entire audio server as a speculative fallback.

### Durable workflow versus business truth

Inngest coordinates execution. It cannot decide whether a timed-out phone call or purchase reached another provider. The action ledger, external IDs and reconciliation establish that fact.

### One case per stock pool

Grouping related delays avoids independently promising the same inventory. It makes a case capable of containing several order lines, which the UI and call brief must handle precisely. Multi-location optimization is deferred until transfer data exists.

### Separate candidate, offer and commitment

This creates more explicit states but prevents a search result, spoken price or accepted API request from being misrepresented as a fulfilled supply decision.

### Required partner use

The business task is the product. neatlogs explains its runs; Entire explains development; CFO.ai explains its business model. Each has a concrete role without pretending they are interchangeable runtime databases.

## 4. Evidence and prior art

These examples support plausibility and demo design; they do not validate Conduit's market demand or reliability.

- **Procuro:** an organizer-awarded ElevenLabs hackathon project described calling suppliers to find delayed parts. This is a close workflow precedent.
- **Dealwise:** an organizer-awarded project described calling businesses for quotes, with real phone-tree constraints.
- **RiskWise:** Microsoft hackathon overall winner combined operational inputs and external evidence into a useful risk decision.
- **SAP's supply disruption discussion:** connects delivery-date changes with inventory and production implications. Conduit's proposed focus is coordinating communication and recovery around those facts.
- **Deployed agent case studies in the research notes:** show the importance of bounded work, reviewable evidence, real outputs and measured outcomes. Reported vendor ROI is not a forecast for this product.

The novel contribution must be demonstrated through the specific recovery workflow, reliability and user value. Do not present “an AI procurement agent” as a category without existing competitors.

## 5. Source register

Documentation was consulted through Context7 and official pages during the planning conversation. Vendor capabilities remain subject to account configuration and live verification. These links are reference sources, not instructions to override project or user requirements.

| Ref | Source | Supports |
| --- | --- | --- |
| S01 | [neatHack official page](https://neatlogs.com/hackathon) | Rules, rubric, required partner roles, build/submission schedule |
| S02 | [DeepSeek API introduction](https://api-docs.deepseek.com/) | OpenAI-compatible interface and JavaScript client configuration |
| S03 | [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion) | Tool calling, streaming and thinking parameters |
| S04 | [ElevenLabs custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm) | Custom streaming model integration and tools |
| S05 | [ElevenLabs SIP](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking) | Inbound/outbound SIP, transport, authentication and codecs |
| S06 | [ElevenLabs webhook tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools) | External backend tools during a call |
| S07 | [ElevenLabs post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks) | Results, signatures, failures and delivery behavior |
| S08 | [ElevenLabs secret dynamic variables changelog](https://elevenlabs.io/docs/changelog/2025/5/26) | Header-only secret variables excluded from LLM context |
| S09 | [SignalWire SIP documentation source](https://github.com/signalwire/docs/blob/main/fern/products/platform/pages/calling/voice/SIP/sip-trunking/index.mdx) | Carrier-side SIP configuration |
| S10 | [neatlogs TypeScript SDK](https://docs.neatlogs.com/sdk/typescript) | Explicit client wrappers, spans and lifecycle |
| S11 | [neatlogs OTLP](https://docs.neatlogs.com/sdk/opentelemetry) | Documented trace transport; avoid assuming arbitrary JSON compatibility |
| S12 | [ElevenLabs OTLP export](https://elevenlabs.io/docs/eleven-agents/customization/opentelemetry-traces) | Export surfaces and OTLP-shaped conversation data |
| S13 | [Entire documentation](https://docs.entire.io/) | Coding sessions/checkpoints |
| S14 | [Entire checkpoint architecture](https://github.com/entireio/cli/blob/main/docs/architecture/sessions-and-checkpoints.md) | Relationship to development state and commits |
| S15 | [CFO.ai model building](https://docs.cfo.ai/getting-started/build-your-financial-model) | Business assumptions, model and scenarios |
| S16 | [CFO.ai sharing](https://docs.cfo.ai/dashboards/share-pages-and-scenarios) | Reviewable model/scenario sharing |
| S17 | [CFO.ai MCP](https://docs.cfo.ai/integrations/mcp-server) | Optional integration, not required runtime infrastructure |
| S18 | [Inngest event waits](https://www.inngest.com/docs/durable-execution/primitives/step-waitforevent) | Matching, timeouts and early-event behavior |
| S19 | [Inngest idempotency](https://www.inngest.com/docs/guides/handling-idempotency) | Platform assistance with duplicate events |
| S20 | [Supabase documentation](https://supabase.com/docs) | Postgres, Auth, Storage and platform setup |
| S21 | [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) | Data isolation |
| S22 | [Supabase explicit API grants change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) | Grants are separate from row policies |
| S23 | [Supabase SSR](https://github.com/supabase/ssr) | Server client, cookies and verified identity |
| S24 | [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync) | Full/partial sync and history handling |
| S25 | [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending) | MIME and send behavior |
| S26 | [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) | Scope selection and restricted-access requirements |
| S27 | [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push) | Pub/Sub dependency for later push notifications |
| S28 | [Next.js route handlers](https://github.com/vercel/next.js/blob/canary/docs/01-app/03-api-reference/03-file-conventions/route.mdx) | Application HTTP endpoints |
| S29 | [Vercel backend guidance](https://vercel.com/docs/frameworks/backend) | Next.js/function hosting |
| S30 | [Exa official OpenAPI specifications](https://github.com/exa-labs/openapi-spec) | Proposed search/content REST integration |
| S31 | [Zod](https://github.com/colinhacks/zod) | Proposed typed boundary validation |
| S32 | [ElevenLabs hackathon winners](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon) | Procuro / Dealwise award evidence |
| S33 | [Microsoft hackathon winners](https://microsoft.github.io/AI_Agents_Hackathon/winners/) | RiskWise award evidence |
| S34 | [SAP disruption recovery](https://news.sap.com/2024/04/addressing-supply-chain-logistics-port-disruptions/) | Existing supply-chain impact context |
| S35 | [Signal CLI](https://github.com/asamk/signal-cli) and [Wire integrations](https://wire.com/en/integrations) | Only relevant if the messaging-app interpretation replaces SignalWire |

The Supabase changelog was checked. Explicit grants for new exposed tables matter to this schema. The PostgreSQL minor-release notes concern existing extensions/indexes and do not create an additional migration task in this empty project. Verify current versions and limits again at implementation time.

## 6. Change control

For a changed decision, append date, old/new choice, reason, affected requirements/contracts, migration implications and tests to rerun. Update PRD, handoff and BUILD_STATUS where the change affects a new agent's first actions.

Do not overwrite historical research to make it appear that an untested proposal was already verified. The PRD is the implementation baseline; the research document preserves how the idea developed.

## 7. Known limitations at handoff

No app, dependency install, database, account provisioning, API credential test, email, phone call, supplier negotiation, deployment or business-system write was performed to produce this specification. Customer validation of the proposed pricing or savings has not been provided.

The largest implementation uncertainties are the live DeepSeek/ElevenLabs/SignalWire pairing, the selected business system, actual data quality, and reliable reconciliation of provider-side effects. M0/P1 gates are designed to resolve these without weakening the business requirements.
