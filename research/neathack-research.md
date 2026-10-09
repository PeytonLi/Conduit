# NeatHack research

Research date: October 8, 2026 (America/Los_Angeles). Verified precedents, event requirements, sponsor roles, and proposed project ideas. Rankings and prototype scopes below are our judgments, not predicted judging results.

## Event requirements

[Official rules and rubric](https://neatlogs.com/hackathon): agent 30%, partner usage 25%, demo 20%, building in public 15%, usefulness/originality 10%. Use neatlogs during development, Entire checkpoints or graph output, and CFO.ai for the agent business's pricing, costs, revenue, and runway. Submit a public repository, a video of at most three minutes covering all three partners, and supporting evidence via the official X quote post. Show before/after runs and failure recovery. Planning beforehand is allowed; code must be written during October 10–12. Submission closes October 12 at 11:55 PM IST, equivalent to 11:25 AM PDT.

## What each sponsor can contribute

- **Entire:** captures coding-agent sessions and checkpoints linked to commits; its code graph maps symbols and relationships. These are development-history capabilities. Application state persistence still needs to be implemented in the application. [Entire introduction](https://docs.entire.io/), [CLI architecture](https://github.com/entireio/cli/blob/main/docs/architecture/sessions-and-checkpoints.md).
- **neatlogs:** traces agent runs, tool calls, retries, latency, and cost. Investigate can correlate failures across runs and attach evidence to a proposed fix. Use it to discover an actual problem, change the implementation, and measure the resulting behavior. [Documentation](https://docs.neatlogs.com/docs), [Investigate](https://docs.neatlogs.com/docs/features/ai-search). The Experiments page labels its datasets feature as coming soon; keep the prototype's fixed checks in the repository instead of depending on it. [Experiments](https://docs.neatlogs.com/docs/features/experiments).
- **CFO.ai:** create an inspectable operating model with explicit assumptions and alternate scenarios. Supply measured execution costs, proposed pricing, customer volume, support/review effort, fixed expenses, and starting cash. Produce a shareable business-plan page. [Model building](https://docs.cfo.ai/getting-started/build-your-financial-model), [sharing](https://docs.cfo.ai/dashboards/share-pages-and-scenarios). Remote MCP access exists but is optional for the required business-planning role. [MCP documentation](https://docs.cfo.ai/integrations/mcp-server).

Context7 matched Entire's official CLI. It did not return relevant matches for neatlogs or CFO.ai after alternate queries; their current official documentation was used directly.

## What the evidence establishes

- **Organizer-awarded winner:** verifies an award and a judged prototype. It does not establish lasting customer adoption or business savings.
- **Vendor/customer case study:** provides evidence that a named customer used a workflow and reported results. These figures are self-reported and have not been independently audited here.
- **Independent research:** can test usefulness in a particular setting. Its findings do not automatically generalize to a different agent, workflow, or newer model.

## Verified hackathon winners

Microsoft's AI Agents Hackathon ran April 8–30, 2025. Its official results identify each award below. [Event overview](https://microsoft.github.io/AI_Agents_Hackathon/), [organizer's winner showcase](https://microsoft.github.io/AI_Agents_Hackathon/winners/).

The ElevenLabs/a16z Worldwide Hackathon's advertised build weekend was February 22–23, 2025; the organizer published winners February 28. Local chapter placements are distinct from the global grand prize. [Event and agenda](https://elevenlabs-worldwide-hackathon.devpost.com/), [organizer's results](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon).

| Project | Verified award | Actual workflow described by its builders | Transferable idea (research inference) |
| --- | --- | --- | --- |
| **RiskWise** | Microsoft 2025 **Best Overall Agent**. [Award](https://microsoft.github.io/AI_Agents_Hackathon/winners/) | Combines equipment schedule data with geopolitical, tariff, and logistics signals; produces a structured risk report with citations. The submission explicitly describes a proof of concept. [Team submission](https://github.com/microsoft/AI_Agents_Hackathon/issues/526) | Connect private operational data to public evidence, then deliver a decision-ready artifact. |
| **TARIFFED!** | Microsoft 2025 **Best Use of Azure AI Agent Service**. [Award](https://microsoft.github.io/AI_Agents_Hackathon/winners/) | Grounds tariff questions in a custom Harmonized Tariff Schedule database; searches for domestic substitutes. [Team submission](https://github.com/microsoft/AI_Agents_Hackathon/issues/349) | A difficult, specific information problem can beat a broad general assistant; structured data improves verifiability. |
| **Konveyor** | Microsoft 2025 **Best Python Agent**. [Award](https://microsoft.github.io/AI_Agents_Hackathon/winners/) | Engineering onboarding: cited documentation answers, code explanations, knowledge-gap detection, and personalized learning paths. [Team submission](https://github.com/microsoft/AI_Agents_Hackathon/issues/645) | Turn development history and documentation into actionable onboarding tasks, with a check that the instructions actually work. |
| **Procuro** | ElevenLabs February 2025, **New York 2nd place**. [Organizer results](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon) | Calls vendors to find delayed parts; builders describe quote comparisons, purchase-order generation, and shipping follow-ups. They planned a later customer MVP. [Team project](https://devpost.com/software/procuro) | Show a complete procurement request becoming a usable quote/availability table and purchase-order draft. |
| **Dealwise** | ElevenLabs February 2025, **San Francisco 1st place**. [Organizer results](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon) | Finds nearby service businesses, calls them, and collects quotes; builders report a few successful quotes and bookings. They document phone-tree failures and switching to home services. [Team project](https://devpost.com/software/john-ai) | A clear real-world before/after is memorable; constrain the operating environment and make failure recovery visible. |
| **Show Me How** | ElevenLabs February 2025, **New York 3rd place**. [Organizer results](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon) | An expert records a task once; the system learns the recording and guides later users through clicks and steps. [Team project](https://devpost.com/software/show-me-how) | Capture an expert's process and replay it in context. A browser QA or onboarding agent can turn the guidance into a verified completed task. |

The award status is strong primary evidence. The project descriptions are builder claims, not independent performance evaluations. Do not import Konveyor's unsourced onboarding-cost claim or call any of these prototypes commercially proven.

## Deployed agents with measurable reported results

### Basis: accounting workflows

OpenAI's August 12, 2025 case study says Basis agents perform reconciliations, journal entries, and financial summaries, with accountants able to inspect supporting data and decisions. It reports **up to 30% time savings**, and later says firms report **30% on average**. Preserve that attribution rather than presenting an audited benchmark. [OpenAI/Basis customer story](https://openai.com/index/basis/).

**Useful pattern (inference):** produce a reconciled ledger plus an exception queue and source-linked evidence. A hackathon version should prove it matches real records, accounts for every row, and avoids double-counting. Measure correct matches, unresolved exceptions, review time, and execution cost; leave ambiguous items for review.

### Resolve AI at Coinbase: incident investigation

Resolve's September 30, 2026 customer story reports **72% less investigation time**, **under 10 minutes to likely root cause**, and **250+ sessions weekly** used by over 100 engineers. It correlates alerts, Datadog telemetry, Terraform applies, deployments, and load-test signals. The story says this deployment does not yet expose source code or proprietary runbooks. These are vendor-reported operational metrics, not independent measurements. [Resolve/Coinbase customer story](https://resolve.ai/customers/coinbase).

**Useful pattern (inference):** the agent gathers an evidence chain for an incident before proposing an action. A small demo can introduce one broken deployment, identify the change, run a check, and produce a verified repair or review-ready patch. Measure correct cause, time to evidence, successful verification, and false alarms. Do not claim diagnosis alone guarantees a fix.

### Devin at Nubank: repetitive ETL migration

Cognition's Nubank case study reports **8–12x engineering-hour efficiency** and **over 20x lower cost for the migration scope delegated to Devin**. The efficiency calculation compares ordinary migration effort with prompting and reviewing agent changes. The broader project involved roughly 100,000 data-class implementations in a six-million-line ETL repository; that is project scope, not a claim the agent independently rewrote every line. Humans reviewed and approved changes. [Cognition/Devin Nubank story](https://devin.ai/customers/nubank).

**Useful pattern (inference):** repeated tasks with variation and a testable acceptance condition make good agent work. A scoped code-migration agent can discover callers, migrate one deprecated pattern, run tests, repair failures, and leave a reviewed patch. Measure complete accepted tasks, regression count, human review effort, and cost per accepted task.

## Independent evidence and measurement lessons

METR's July 2025 randomized trial found that 16 experienced open-source developers took **19% longer** on 246 issues when permitted to use early-2025 AI tools, despite believing they were faster. That result concerns those tools and that setting; it is not evidence that current agents generally slow developers. [Original experiment](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/).

METR's February 24, 2026 update says newer-study recruitment, task-selection, and time-measurement effects made its current productivity estimate unreliable. The authors believed newer tools likely helped more, but said the experiment gave only weak evidence of the increase's size. [Updated measurement analysis](https://metr.org/blog/2026-02-24-uplift-update/).

**Practical implication (inference):** build a small fixed task set with ground truth. Report end-to-end task success, elapsed time, human review time, and cost. Keep failures in the denominator. A polished successful run and an honest task-level check are stronger evidence than inferred hours saved.

## Patterns worth transferring to NeatHack

These are brainstorming judgments, not claims made by the sources:

1. **Choose one expensive, recurring task with a finish line.** A completed reconciliation, vendor dossier, verified bug fix, or runnable onboarding path is easier to demonstrate than a general assistant.
2. **Use tools to act and verify.** Retrieval plus a report may be sufficient only when the report is the actual deliverable. Otherwise include execution and a check that the result worked.
3. **Make the evidence visible.** Show which records, sources, commands, and tool outputs supported the outcome. This is a natural fit for demonstrating neatlogs traces and a failed-then-fixed run.
4. **Constrain the environment enough to finish in a weekend.** One repository, one category of vendors, or two input files can still be a substantial task.
5. **Show a recovery with a purpose.** A missing page, conflicting invoice, failed test, or bad tool call should trigger a sensible alternative and a verified result.
6. **Separate reported business outcomes from your own measured demo.** Public precedents establish a plausible buyer problem; your task-level checks establish that this prototype works.

Potential directions to evaluate against the rubric:

- **Incident-to-patch agent:** alert + recent changes -> evidence-backed diagnosis -> patch -> regression check -> review artifact. Inspired by Resolve and Devin.
- **Vendor review agent:** buying request -> vendor research + pricing/security documents -> comparable shortlist -> approval packet. Inspired by RiskWise, Procuro, and Dealwise.
- **Reconciliation exception agent:** bank/ledger/receipt inputs -> matched entries -> investigated discrepancies -> balanced result + exception report. Inspired by Basis.
- **Executable handoff agent:** repository + development history -> runbook -> fresh-environment setup -> smoke-test verification -> onboarding checklist. Inspired by Konveyor and Show Me How.

## Best sources for a concise answer

1. [Microsoft official winner showcase](https://microsoft.github.io/AI_Agents_Hackathon/winners/) — verified awards for RiskWise, TARIFFED!, and Konveyor.
2. [ElevenLabs official February 2025 results](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon) — exact chapter placements for Procuro, Dealwise, and Show Me How.
3. [OpenAI/Basis customer story](https://openai.com/index/basis/) — accounting tasks, reviewability, and reported time savings.
4. [Resolve/Coinbase customer story](https://resolve.ai/customers/coinbase) — production workflow, usage volume, and reported investigation metrics.
5. [Devin/Nubank customer story](https://devin.ai/customers/nubank) — constrained migration use case and explicit metric definitions.
6. [METR February 2026 measurement update](https://metr.org/blog/2026-02-24-uplift-update/) — why honest measurement needs careful scope and denominators.

Not checked: customer contracts, audited ROI, or whether the older prototypes remain live. Award wins and vendor-reported savings do not predict this event's result.

## Proposed shortlist

These ideas borrow useful workflow patterns, not the winners' code. No prototype has been built or measured. Keep the initial implementation to one workflow and verify the outcome using checks that the agent cannot redefine.

### 1. Exception Desk: resolve invoice discrepancies

**Goal:** turn invoices, purchase orders, delivery receipts, and a ledger into a verified reconciliation and a review queue.

The agent reads records, compares quantities and amounts using deterministic arithmetic, investigates unmatched rows, retrieves missing supporting documents, and generates an evidence-backed approval or exception packet. Its finish line is that every input has a justified disposition; it should not invent evidence or move money to force completion.

**Original angle:** investigate exceptions after matching. A document extractor stops after reading the invoice; this agent determines why it does not match and what would resolve it.

**Demo:** a supplier uploads the same invoice twice, a receipt is missing, and a later document reveals partial delivery. The agent finds the receipt, accounts for the partial delivery, and prevents duplicate approval even after a retry.

**Initial scope:** one company, one currency, one invoice format family, a small ledger and document folder. Add more input formats only after the exception workflow works.

**Measure:** correct dispositions, false approvals, unresolved cases, review effort, and cost per resolved case. Use a fixed ground-truth input set and include failures in the denominator.

**Sponsor use:** neatlogs exposes false matches or duplicate processing; Entire captures the fix and its regression check; CFO.ai models subscription revenue against invoice volume, inference, and human review costs.

**Evidence:** Basis's deployed accounting workflows establish a plausible buyer problem. [Basis case study](https://openai.com/index/basis/).

**Main uncertainty:** a controlled document set can validate the workflow, but does not establish general accounting accuracy or customer willingness to pay.

### 2. Procurement Rescue: replace a delayed supplier

**Goal, refined October 9:** react to a supplier's delay message, assess its impact using the business's inventory and demand schedule, then investigate and coordinate the best recovery. Alternative sourcing is one action the agent can choose.

The agent searches suppliers, extracts specifications and delivery terms, rejects mismatches, compares delivered cost, follows up on incomplete evidence, and rechecks the chosen option before drafting the order. Unknown stock or delivery dates remain unknown until confirmed.

**Original angle:** recover when the initially preferred supplier becomes unavailable. Availability verification makes the result more useful than a static search summary.

**Demo:** the cheapest supplier's stock changes mid-run. The agent detects the change, rejects an incompatible substitute, and selects a confirmed alternative meeting the deadline.

**Initial scope:** one product category, three to five suppliers, supported web/API sources or a clearly disclosed controlled supplier environment. Voice calls can enhance the demo but are not necessary to the core workflow.

**Measure:** specification compliance, confirmed availability, delivered-cost accuracy, evidence completeness, and cost per usable decision.

**Sponsor use:** neatlogs reveals bad source extraction and failed availability checks; Entire records the recovery fix; CFO.ai models per-request or monthly pricing and the cost of unsuccessful searches.

**Evidence:** RiskWise, Procuro, and Dealwise were awarded for related operational research and sourcing tasks. [Microsoft results](https://microsoft.github.io/AI_Agents_Hackathon/winners/), [ElevenLabs results](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon).

**Main uncertainty:** browsing alone often cannot confirm inventory, delivery promises, or quotes. Disclose which evidence is live and which is simulated.

**Refined business workflow:** connect one supplier inbox or message channel to purchase orders, stock on hand, stock reservations, other incoming shipments, and confirmed customer/production requirements by date. Match a delay message to the supplier, order, and affected item; preserve the original commitment and record the revised estimate with its source. Ambiguous matches need clarification. Supplier messages are evidence, not authority to change purchasing policy.

Calculate whether projected available stock falls below demand before the delayed delivery arrives, accounting for reservations and other reliable receipts. Separate confirmed demand from forecasts. Determine the first shortage date and the quantity needed to cover the gap. If there is no shortage, update the case and monitor it. If there is one, investigate partial delivery or expedited shipping from the original supplier, internal stock transfers, and approved alternatives. Do not automatically reorder the delayed quantity in full.

**Illustrative case:** 4,000 cartons move from Tuesday delivery to Friday. The business has 600 usable cartons and needs 400 on each of Tuesday, Wednesday, and Thursday. The gap is 600 cartons, with the first shortage on Wednesday. The agent can ask the current supplier to deliver 600 by Wednesday and the remaining 3,400 on Friday. If that fails, source only the gap and reconcile the existing order before any additional commitment.

**Supplier calling:** a proposed voice tool can ask for available quantity, delivery date, expedited freight, partial shipments, quote validity, and written confirmation. Give it the specific order context and allowed tradeoffs. Business rules should enforce spending and commitment limits outside the conversation prompt. A verbal offer remains provisional until supported by the confirmation required by the company's purchasing process.

ElevenLabs documents direct SIP connectivity for inbound and outbound calls and tools for retrieving external information during a conversation. The October 9 stack proposal uses SignalWire as the tentative phone provider, pending clarification of whether the user meant that provider or the separate Signal and Wire messaging apps. Generic SIP support establishes a plausible integration path; the specific account-to-account connection has not been tested. [ElevenLabs SIP integration](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking), [SignalWire SIP documentation](https://github.com/signalwire/docs/blob/main/fern/products/platform/pages/calling/voice/SIP/sip-trunking/index.mdx), [webhook tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools). Existing supply-chain systems already connect delivery-date changes to inventory and production effects; the proposed opportunity is resolving supplier communications through that context. [SAP disruption recovery](https://news.sap.com/2024/04/addressing-supply-chain-logistics-port-disruptions/).

**Smallest demonstration of this refinement:** one inbox, one simple stock/order/demand table, one item category, one supplier phone conversation with a consenting participant, and an approved recovery recorded back to the order. Show both a harmless delay and an actionable shortage, plus an unsuccessful recovery attempt. Broader system integrations and open-ended negotiation remain outside the initial scope.

### 3. Repo Passport: an executable engineering handoff

**Goal:** make a repository runnable by someone who was not involved in building it, and prove the handoff works in a clean environment.

The agent uses repository files and available Entire session/checkpoint context to infer setup decisions. It attempts the documented setup, investigates failures, corrects stale instructions or setup scripts, reruns setup in a fresh environment, and produces a runbook plus a review-ready patch and verification record.

**Original angle:** verify the instructions by executing them. The deliverable is a successful fresh setup rather than an onboarding chatbot.

**Demo:** an undocumented environment variable and a stale start command break the first attempt. The agent finds the recorded decision behind the configuration, updates the setup instructions, and proves a fresh clone passes the smoke test. Missing credentials must be identified as a blocker rather than fabricated.

**Initial scope:** one repository, one local setup path, one smoke test. Use only session history created and permitted for the demo.

**Measure:** successful clean setups, unresolved prerequisites, incorrect setup steps, execution time, and human follow-up needed.

**Sponsor use:** Entire context is useful input as well as development evidence; neatlogs captures failed commands and recovery; CFO.ai models team subscriptions or fees per verified handoff.

**Evidence:** Konveyor and Show Me How were awarded for knowledge-transfer workflows; executable verification is the proposed additional distinction. [Microsoft results](https://microsoft.github.io/AI_Agents_Hackathon/winners/), [ElevenLabs results](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon).

**Main uncertainty:** environment setup can consume the weekend; scope the supported runtime and repository tightly. Willingness to pay is not established by these awards.

### 4. Checkout Medic: a verified repair for one broken customer journey

**Goal:** detect a broken checkout, reproduce it, identify the cause, propose a patch, and verify the journey works again.

Use browser evidence, error traces, and recent repository changes to choose a repair. A passing independent regression check and a review-ready patch are the finish line.

**Demo:** a discount-code regression breaks checkout; the first fix passes a basic test but fails the affected customer journey. The agent uses that failure to revise the patch and reruns both checks.

**Initial scope:** one local storefront, one checkout journey, one defect class. Keep expected outcomes fixed so the agent cannot solve the task by weakening tests.

**Sponsor use:** neatlogs provides failure evidence, Entire links the relevant coding history and repair session, and CFO.ai models a monitoring subscription plus investigation costs.

**Evidence:** Resolve/Coinbase supports incident investigation; Devin/Nubank supports bounded, reviewable code changes. [Resolve case study](https://resolve.ai/customers/coinbase), [Devin case study](https://devin.ai/customers/nubank).

**Main uncertainty:** coding-agent execution and browser verification are a larger implementation burden. Differentiate on completing and verifying a specific customer journey, because neatlogs already offers investigation-to-fix workflows.

### 5. Migration Mechanic: finish one narrow code migration

**Goal:** replace one deprecated interface across a repository while preserving behavior.

The agent discovers callers, studies the replacement interface, changes implementations and affected fixtures, runs independent checks, repairs failures, and produces a review-ready migration patch.

**Demo:** the replacement returns a different unit or shape, so a mechanical replacement fails. The agent diagnoses the mismatch and fixes every affected caller without modifying expected results to hide the error.

**Initial scope:** one migration rule and a handful of modules. Keep an explicit supported scope so broad refactoring does not overwhelm verification.

**Sponsor use:** Entire supplies and records code context, neatlogs shows the migration loop and failed checks, and CFO.ai models price and cost per accepted migration.

**Evidence:** Nubank's Devin case study is unusually relevant because it describes repeated, variable migrations with human review and defined efficiency metrics. [Devin/Nubank](https://devin.ai/customers/nubank).

**Main uncertainty:** the space is crowded. The distinction needs to be a concrete migration problem with stronger verification, rather than a general coding agent.

## Recommendation

- **Strongest reported deployment precedent:** Exception Desk.
- **Strongest cluster of related hackathon-winning precedents:** Procurement Rescue.
- **Most distinctive role for Entire:** Repo Passport.
- **Strong technical demonstrations with more execution burden:** Checkout Medic and Migration Mechanic.

If prioritizing a clear business problem and checkable completion, start by comparing Exception Desk and Procurement Rescue. If the appeal is making AI-generated code maintainable, Repo Passport has a useful and less generic product story. These are judgments based on the rubric and cited examples, not validated market demand.

## Demonstration and business evidence to plan

Suggested three-minute story: 20 seconds for the goal, 60 for the agent and a meaningful recovery, 40 for measured before/after runs, 25 for the relevant Entire checkpoint, 25 for the CFO.ai model, and 10 for the final verified artifact. Use real captured runs; label deliberate failure injection and simulated data.

For the business model, use cost per **verified completed task**, including unsuccessful runs, retries, and review. Build a base scenario and a worse-reliability scenario. Compare measured task costs with proposed pricing, customer acquisition assumptions, fixed costs, and runway. Proposed prices and adoption forecasts remain assumptions until tested.

Build-in-public material can show the first failed run, the trace that explained it, the fix, and a concrete improvement. No posts have been published as part of this research.

Research only: sponsor documentation was read, but accounts, integrations, prototypes, and reported customer ROI were not tested.

## Proposed Procurement Rescue stack — October 9, decisions pending

**Recommendation, updated October 9 at the user's request:** TypeScript, Next.js hosted on Vercel, Supabase, Inngest, and DeepSeek accessed through an OpenAI-compatible TypeScript client. ElevenLabs handles supplier voice conversations, with SignalWire as the tentative telephone carrier. Gmail is the proposed first email connector. These are proposed choices, not installed dependencies or completed integrations.

**Naming assumption:** SignalWire is one phone/SIP provider and fits the requested replacement for Twilio. If the user instead means the separate Signal and Wire messaging apps, the communication layer changes. Wire provides an Apps SDK for messages and approvals; signal-cli is an unofficial connector whose current documentation includes calling through a separate audio tunnel. Those apps do not themselves provide an ordinary telephone-carrier connection. A persistent connector worker and additional audio integration would need separate evaluation. [Wire integrations](https://wire.com/en/integrations), [signal-cli](https://github.com/asamk/signal-cli), [Signal calling tunnel](https://github.com/asamk/signal-cli/blob/master/docs/CALL_TUNNEL.md).

### Each required product's responsibility

| Product | Use in this project | Concrete integration |
| --- | --- | --- |
| ElevenLabs | Conduct the live supplier conversation | Configure an ElevenLabs Agent with a custom DeepSeek-compatible LLM endpoint; provide order, shortage, delivery deadline, and allowed tradeoffs. Give it authenticated backend tools for reading case facts and recording provisional offers. Start a SIP outbound call and ingest the conversation result. Test streamed tool calls and response time before committing to the custom-model connection. |
| SignalWire, tentative | Carry calls to and from ordinary phone numbers | Connect a SignalWire number/SIP configuration to ElevenLabs. Test authentication, audio compatibility, outbound routing, and call termination before committing to this path. |
| neatlogs | Explain and improve agent runs | Wrap the application's OpenAI-compatible client configured for DeepSeek using wrapOpenAI, and add explicit spans for inventory calculations, quote checks, call requests/results, failures, and approvals. Verify model identification, usage capture, and cost attribution in a live trace. Correlate records by case and action IDs. Hosted ElevenLabs internals require supported exports or callbacks; wrapping the app's client does not automatically trace them. |
| Entire | Capture development decisions and coding sessions | Enable Entire with the coding agent in the repository. Show a checkpoint explaining a meaningful fix, such as preventing duplicate calls after a retry. Runtime business cases remain in the database and workflow system. |
| CFO.ai | Model the product's business economics | Build the hackathon business plan using pricing assumptions, measured inference costs, ElevenLabs minutes, SignalWire charges, hosting, support/review, revenue, and runway. Include unsuccessful runs in cost per completed case. Manual metrics import is sufficient initially; its MCP server is optional. |

Primary documentation: [ElevenLabs SIP](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking), [voice tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools), [neatlogs TypeScript SDK](https://docs.neatlogs.com/sdk/typescript), [Entire](https://docs.entire.io/), [CFO.ai financial models](https://docs.cfo.ai/getting-started/build-your-financial-model).

ElevenLabs provides [post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks) containing transcripts, analysis, and metadata. It also supports [OpenTelemetry exports](https://elevenlabs.io/docs/eleven-agents/customization/opentelemetry-traces) through webhooks or API retrieval; forwarding those exports directly into neatlogs has not been verified. Start by recording the application's voice tool requests and returned call facts with the neatlogs SDK, correlated by conversation ID.

### Application components

| Component | Choice | Purpose |
| --- | --- | --- |
| Application language and interface | TypeScript + Next.js | One application for the owner's case dashboard, approvals, connector endpoints, and authenticated tools used by the voice agent. |
| Hosting | Vercel | Host the dashboard and short backend requests. External events resume the workflow rather than holding a request open during a call or supplier wait. |
| Business records, login, attachments | Supabase Postgres + Auth + Storage | Store suppliers, items, purchase orders, inventory, reservations, demand dates, cases, offers, action attempts, and confirmation documents. Enforce organization-scoped access and keep server credentials private. |
| Workflow execution | Inngest | Run bounded steps, retry failures, and wait for a supplier reply, completed call, or owner approval matched to the correct case. Persist callbacks before resuming so an early response is not lost. |
| Planning and interpretation | DeepSeek via the OpenAI-compatible TypeScript client | Interpret delay messages, suggest recovery actions, research alternatives through a supplier-search tool when needed, and call validated business tools. Code/SQL calculates stock and costs and enforces purchasing authority. |
| Email | Gmail API, proposed first connector | Read one authorized mailbox, preserve message/thread IDs, detect duplicates, and capture supplier replies. Use polling initially; Gmail push notifications introduce Google Cloud Pub/Sub. |
| Business system integration | One connector or explicitly dated CSV imports | Read the actual purchase-order, stock, and demand source. Select the real connector once the target business system is known; a CSV demo must disclose freshness limits. |

[Inngest event waits](https://www.inngest.com/docs/durable-execution/primitives/step-waitforevent), [Supabase documentation](https://supabase.com/docs), [DeepSeek API and JavaScript client examples](https://api-docs.deepseek.com/), [Gmail push requirements](https://developers.google.com/workspace/gmail/api/guides/push).

**DeepSeek integration:** the official API documents OpenAI-compatible Chat Completions, streaming, and function calling. The OpenAI SDK is the client library; requests use DeepSeek's endpoint and API key. For live calls, propose streaming with thinking disabled to prioritize conversational response time. Case analysis can use thinking mode when justified, preserving the tool-loop message fields required by DeepSeek. ElevenLabs supports custom OpenAI-compatible streaming endpoints and tool calls, so direct DeepSeek integration is a proposal based on matching interfaces, not a tested provider pairing. Use a thin application adapter only if the live integration requires one. [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion), [ElevenLabs custom LLMs](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm). CFO.ai should use measured DeepSeek usage and current billing alongside voice and hosting costs.

### End-to-end case

1. A supplier email postpones a 4,000-carton order until Friday. The app preserves the message, matches the order, and opens a case.
2. The workflow reads current stock, reservations, and dated demand. Deterministic arithmetic finds a 600-carton gap beginning Wednesday.
3. DeepSeek proposes asking the original supplier for a split delivery before buying elsewhere. The app validates the allowed action.
4. ElevenLabs calls through the proposed SignalWire SIP connection. Its tools expose only the relevant order facts and allowed negotiation terms. It records a provisional offer for 600 cartons by Wednesday and the balance Friday.
5. The call result reaches the app. Inngest resumes the case, requests written confirmation, and waits for the response. A failed call can lead to an email follow-up or another approved supplier.
6. The owner reviews the evidence, delivered cost, and proposed order change. Before committing, the app rechecks stock and existing commitments. An authorized write-back records the recovery in the business system.
7. neatlogs shows the case's decisions, attempts, and outcome. Entire documents the implementation and fix history. CFO.ai uses aggregate usage and completion metrics to model the product's economics.

**Checks before finalizing:** prove one real ElevenLabs/SignalWire outbound conversation using the custom DeepSeek LLM, including streamed tool calls and the result callback; verify DeepSeek usage capture in neatlogs; authorize one test mailbox; choose the source of purchase-order, stock, and demand data. Workflow retries do not by themselves prevent a duplicate external call or purchase after a partial failure: use action IDs, provider idempotency where available, and reconciliation. No accounts, calls, messages, or integrations were provisioned or tested for this proposal.
