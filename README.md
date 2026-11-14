# Conduit

Conduit is a supplier-delay recovery agent. When a vendor slips a delivery, it turns the message into a case, calculates what is actually at risk, gathers recovery options, and only commits after the owner approves.

## Problem

Small businesses usually learn about delayed supplies through email or a phone call. The operational impact lives somewhere else: purchase orders, inventory, warehouse stock, and dated customer or production demand. An owner or buyer has to connect those facts by hand, decide how urgent the shortage is, chase the vendor or an alternate, and avoid double-ordering while protecting customer commitments. That work is slow, easy to get wrong, and usually scattered across inboxes and spreadsheets.

Research for this project looked at awarded procurement and ops agents (including Procuro, Dealwise, and RiskWise) and at deployed workflows where agents only pay off when they finish a concrete job with visible evidence. The pattern that transferred here is not a general assistant. It is one expensive, recurring task with a finish line: recover from a supplier delay without guessing the shortage or spending without authority. Full notes live in [research/neathack-research.md](research/neathack-research.md). The product framing is in [PRD.md](PRD.md).

The job to be done: **when a supplier changes a delivery promise, tell me what is actually at risk and coordinate an evidence-backed recovery I can approve.**

## Solution

Conduit connects a supplier inbox with purchase orders, inventory, and dated demand. On a delay it:

1. Matches the message to the supplier, PO, and item
2. Projects stock against demand and computes the first shortage and bridge quantity
3. Looks for partials or expedites from the original supplier, internal transfers, and approved alternatives
4. Contacts approved suppliers by email or phone within policy limits
5. Builds a versioned recovery plan for owner approval
6. Records the approved change through an action ledger with readback, or exports a manual packet when no live write path exists
7. Monitors receipts and can reopen recovery if the plan slips again

Analysis, supplier outreach, and commitments are separate switches. Verbal quotes stay provisional until written confirmation. New suppliers stay research candidates until an owner approves the contact and, separately, purchasing eligibility. Optional delegated low-value purchasing defaults off.

Harbor Pack is the canonical demo: PO-1042 for CARTON-302015 slips from Tuesday to Friday with 600 on hand and 400 needed per day. The bridge is 600, not a blind reorder of 4,000.

## Architecture

One Next.js app owns the UI, authenticated APIs, OAuth callbacks, voice tools, and provider webhooks. Supabase holds tenant-scoped facts, evidence, actions, approvals, and the event outbox. Inngest runs durable workflows, waits, and retries so a case can pause for hours without keeping a request open. Deterministic domain code owns inventory math; DeepSeek proposes bounded next steps through approved tools.

```text
Supplier email/phone
        │
        ▼
 Inbox connectors (Gmail, Outlook) ──► ingest + dedupe ──► case
        │                                                    │
        │                                                    ▼
 Business data (CSV / Shopify / QBO / Zoho / Odoo)    shortage projection
        │                                                    │
        │                                                    ▼
        │                                           planner + research (DeepSeek, Exa)
        │                                                    │
        │                          ┌─────────────────────────┼─────────────────────────┐
        │                          ▼                         ▼                         ▼
        │                     email outreach            voice call                 options / plans
        │                          │              (SignalWire + ElevenLabs          │
        │                          │               media bridge)                    │
        │                          └─────────────────────────┬───────────────────────┘
        │                                                    ▼
        │                                            owner approval
        │                                                    │
        └────────────────────────────────────────────────────┼──► action ledger
                                                             │
                                                             ▼
                                              demo ledger / live connector write / manual export
                                                             │
                                                             ▼
                                                      receipts + monitoring
```

| Layer | Choice | Role |
| --- | --- | --- |
| App | Next.js 16, React 19, TypeScript | Workspace UI, `/api/v1`, webhooks, voice tools |
| Data / auth | Supabase Postgres, Auth, private Storage | RLS-scoped records, sessions, evidence |
| Workflows | Inngest | Case steps, inbox sync, dispatch, reconciliation |
| Reasoning | DeepSeek (OpenAI-compatible client) | Extraction, planning, bounded tool use |
| Mail | Native Gmail OAuth + Pub/Sub push; Outlook Graph | Inbound delays, threaded outreach, multi-mailbox |
| Voice | SignalWire REST + ElevenLabs media bridge | Outbound supplier calls with signed tools/callbacks |
| Research | Exa (+ optional direct page fetch) | Candidate suppliers and sourced excerpts |
| Business systems | Shopify, QuickBooks Online, Zoho Inventory, Odoo | Fresh reads, approved writes/readback, transfers where supported |
| Hosting | Render (app + voice bridge) | Always-on bridge; CI-gated deploys on `main` |

Logical modules: identity/membership, inbox ingestion, matching, inventory and quote domains, planner, policy checks, workflow, action dispatcher, approval/execution, evidence/audit, provider clients, demo runner. Details: [docs/prd/04-architecture-and-contracts.md](docs/prd/04-architecture-and-contracts.md) and [docs/prd/05-agent-and-integrations.md](docs/prd/05-agent-and-integrations.md).

## Implemented

The product surface described in the PRD journeys is implemented end to end:

- **Org and auth** — memberships, roles, pilot signup, policies, onboarding
- **Inbox** — Gmail (OAuth + Pub/Sub push), Outlook (Graph delta sync), multiple mailboxes with a primary
- **Business data** — CSV import/activation, Harbor Pack replay demo, live connectors for Shopify, QuickBooks Online, Zoho Inventory, and Odoo
- **Cases** — delay matching, shortage assessment, monitoring, operator handoff timeline
- **Research and outreach** — Exa discovery, threaded email, live voice calls through the media bridge
- **Recovery** — versioned plans, owner approval, revalidation, idempotent action ledger, demo ledger and manual export
- **Transfers** — internal stock transfer planning; Shopify executes approved transfers when scopes allow; other connectors recommend and export
- **Supplier onboarding** — separate contact vs purchasing approval, onboarding history, optional delegated low-value purchasing
- **Domain expansions** — fractional quantities, explicit FX handling where configured
- **Reliability controls** — pause/cancel, retention/disconnect, replay isolation, tenant RLS

Hosted app and voice bridge run on Render. See [BUILD_STATUS.md](BUILD_STATUS.md) for evidence notes and [docs/evidence/](docs/evidence/) for the live-run pack.

## Future steps

- Package the ≤3-minute demo video and full submission evidence bundle
- Run more live pilot connectors beyond the QuickBooks sandbox write path (repeat AT-37-style checks on Zoho/Odoo stores as accounts are available)
- Broaden item categories beyond packaging cartons and add multi-warehouse automation at scale
- Stronger supplier discovery and negotiation within tighter owner-configured ceilings
- Additional channels (for example chat) only after mailbox and voice paths stay healthy in production
- Pricing/runway model updates from measured task cost (inference, calls, review time)

## Hosting

Both services run on Render (Starter plan, Oregon region, one instance each). Render deploys a push to `main` only after CI checks pass.

| Service | Root | Build | Start | Health |
| --- | --- | --- | --- | --- |
| Conduit app | repo root | `npm install -g pnpm@10.34.6 && pnpm install --frozen-lockfile && CIRCLE_NODE_TOTAL=3 NODE_OPTIONS=--max-old-space-size=4096 pnpm build` | `pnpm start` | `/api/health` |
| Voice bridge | `services/voice-bridge` | `npm ci` | `node server.mjs` | `/health` |

The app build caps Next.js build workers (`CIRCLE_NODE_TOTAL`) and the heap, because the default build runs out of memory on Render's builder. The voice bridge keeps live calls in memory, so it must stay on an always-on plan with a single instance.

After the app URL changes, sync Inngest with `curl -X PUT <app-url>/api/inngest`, re-run `scripts/voice/setup-agent.ts --apply` with the new `APP_BASE_URL` so the ElevenLabs tools and post-call webhook follow, and update the Supabase Auth site URL and redirect allow list.

Inngest's free plan includes 50,000 executions a month. The cron functions run every 10 minutes to stay under it.

## Local development

### Prerequisites

- Node.js 22
- pnpm 10.34.6
- Docker running locally (required by Supabase CLI)
- Playwright Chromium for browser tests

### Start the app

```sh
pnpm install --frozen-lockfile
pnpm db:start
pnpm db:reset
pnpm exec supabase status -o env
```

Copy the local `API_URL`, `ANON_KEY`, and `SERVICE_ROLE_KEY` from the status output into `.env.local` as `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY`. Do not commit `.env.local`; the publishable key is for local development and the secret key must stay server-side.

```sh
pnpm seed:demo
pnpm dev
```

`pnpm seed:demo` creates the local demo accounts `owner@harbor.example`, `operator@harbor.example`, `viewer@harbor.example`, and `other-owner@other.example`. Their shared password is `HarborPackLocalOnly!2026`; it is intentionally local-only and must never be reused for a real account.

### Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm db:reset
pnpm test:db
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
```

`pnpm db:reset` applies migrations and loads the two-organization local seed. The integration tests connect only to the local Supabase database.

## Docs

| Doc | Contents |
| --- | --- |
| [PRD.md](PRD.md) | Product summary and chapter map |
| [AGENT_HANDOFF.md](AGENT_HANDOFF.md) | Compact context for implementers |
| [BUILD_STATUS.md](BUILD_STATUS.md) | Milestone evidence and open gates |
| [docs/prd/](docs/prd/) | Journeys, domain, architecture, integrations, delivery |
| [research/neathack-research.md](research/neathack-research.md) | Precedents and problem research |
| [docs/evidence/](docs/evidence/) | Live E2E runbook and submission checklist |
