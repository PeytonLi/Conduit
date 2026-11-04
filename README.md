# Conduit

Conduit is a supplier delay recovery agent. It connects supplier messages with purchase orders, inventory, and dated demand to identify shortages, research alternatives, contact suppliers by email or phone, and prepare a recovery plan for business owner approval. After approval it records the plan and monitors receipts.

**Stack:** Next.js 16 and React 19, Supabase (Postgres, Auth, private Storage), Inngest for durable background work, DeepSeek for extraction and planning, Gmail through Composio, Exa for supplier research, and ElevenLabs with SignalWire for calls. Calls run through SignalWire REST + `<Connect><Stream>` to the ElevenLabs WebSocket media bridge in `services/voice-bridge` (`VOICE_TRANSPORT=media_bridge`).

**Status:** Inbox ingestion, assessment, research, email and voice outreach, approval, recovery recording, and monitoring are built. The remaining acceptance gap is AT-37 (a real business-system connector). See [BUILD_STATUS.md](BUILD_STATUS.md) for evidence and open gates.

Start with the [product requirements](PRD.md). Implementation agents should read the [compact handoff](AGENT_HANDOFF.md) and [current build status](BUILD_STATUS.md), then load the relevant [reference chapters](docs/prd/). The [research notes](research/neathack-research.md) cover hackathon requirements, precedents, and integration research.

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
