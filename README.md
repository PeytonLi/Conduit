# Conduit

Conduit is a planned supplier delay recovery agent. It connects supplier messages with purchase orders, inventory, and dated demand to identify shortages, investigate alternatives, collect quotes, and prepare a recovery plan for business owner approval.

The proposed workflow supports email and supplier calls using DeepSeek, ElevenLabs, and SignalWire, with neatlogs for runtime traces, Entire for development history, and CFO.ai for the product's business model.

**Status:** The Phase 1 application and local-development foundation has passed local verification. No live provider or supplier workflow is enabled, and Phase 2 business behavior remains unimplemented. See [BUILD_STATUS.md](BUILD_STATUS.md) for evidence and remaining gates.

Start with the [product requirements](PRD.md). Implementation agents should read the [compact handoff](AGENT_HANDOFF.md) and [current build status](BUILD_STATUS.md), then load the relevant [reference chapters](docs/prd/). The [research notes](research/neathack-research.md) cover hackathon requirements, precedents, and integration research.

The current milestone and verification evidence are tracked in [BUILD_STATUS.md](BUILD_STATUS.md). The scaffold intentionally leaves Phase 2 business behavior unimplemented.

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
