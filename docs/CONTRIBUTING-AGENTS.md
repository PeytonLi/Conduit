# Contributing as a feature agent

Phase 2 work is divided by file ownership so agents can build in parallel. Keep changes inside the assigned area; coordinate any cross-owner edits in the pull request. The shared contracts listed below take precedence over the ownership map.

## Shared contracts

These files define seams used by multiple features. Treat each as a **shared contract — change only with a note in the PR**:

- `lib/domain/types.ts` and `lib/domain/inventory.ts` (`projectInventory` signature)
- `lib/agent/tools/types.ts`
- `lib/actions/types.ts` and `lib/actions/adapters.ts`
- `lib/integrations/business/types.ts`
- `lib/workflows/events.ts` (event map and outbox publisher signature)
- `lib/schemas/**` (shared schemas and public barrel)
- `lib/workflows/index.ts` (workflow function registry)

The Phase 1 domain inventory implementation is intentionally a throwing stub. Implement behavior in the assigned feature branch without changing its public signature.

## Ownership map

| Feature | Owned paths |
| --- | --- |
| F1 — domain engine and import | `lib/domain/**`, `lib/db/imports*`, `app/api/v1/imports/**`, `tests/domain/**` |
| F2 — inbox, extraction, and matching | `lib/integrations/gmail/**`, `lib/agent/extraction*`, `lib/domain/matching*` (exception to F1), `app/api/v1/cases/from-message/**`, `app/api/auth/gmail/**`, `lib/workflows/inbox*` |
| F3 — planner, research, and telemetry | `lib/agent/**` (except `lib/agent/extraction*`), `lib/integrations/deepseek/**`, `lib/integrations/exa/**`, `lib/telemetry/**`, `lib/workflows/case-recovery*` |
| F4 — voice | `lib/integrations/elevenlabs/**`, `lib/integrations/signalwire/**`, `app/api/voice/**`, `app/api/webhooks/**` |
| F5 — approval, actions, and demo ledger | `lib/actions/**`, `lib/policies/**`, `lib/integrations/business/**`, `app/api/v1/plans/**`, `app/api/v1/actions/**`, `lib/workflows/outbox*`, `lib/workflows/reconcile*` |
| F6 — UI | `app/(workspace)/**`, `app/(auth)/**`, `components/**`, and `app/api/v1/{cases (GET + control),suppliers,activity,connections,policies,memberships,demo}/**` |

## Database changes

- Name every migration `supabase/migrations/<UTC timestamp>_<short_feature_name>.sql`.
- After the core schema migration is merged, never edit it. Add a new timestamped migration for every schema change; migrations must be append-only and safe to apply in order.
- Keep tenant IDs and role checks explicit in constraints, queries, and policies. New tenant-owned tables need `org_id`, RLS, a membership-scoped policy, and explicit grants.

## Registry append points

- Add workflow functions to `lib/workflows/index.ts`; do not replace another feature's registrations.
- Export shared or feature schemas from `lib/schemas/index.ts`.
- Add new event names and payloads to the shared event map before publishing them.

## Invariants

- Keep inventory, money, compatibility, and authority decisions deterministic; model uncertain facts explicitly.
- Preserve source references, promises, versions, and unknowns through imports, assessments, plans, and actions.
- Every financial commitment requires owner approval.
- Create an action record before dispatching any external effect; never blindly retry an action with an uncertain outcome.
- Scope rows, files, and tools to the organization and case authorized for the request.
- Replay and demo modes must not cause real supplier or business-system effects.
- Distinguish a written offer from an accepted order, and a recovery recorded from goods received.
- Label the demo ledger as a demo; never log secrets or raw hidden reasoning.

Run the narrowest relevant unit, integration, and journey checks for each change. Do not mark a milestone complete based only on source files existing; record actual verification in `BUILD_STATUS.md`.
