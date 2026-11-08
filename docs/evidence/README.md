# M6 evidence and submission pack (scaffold)

This directory holds **instructions, checklists, and artifact slots** for hackathon / B0 live verification on the Render deployment. Nothing here claims a completed live E2E until a human (or authorized agent with secrets) fills in the templates and drops real artifacts.

**Status:** Scaffold only — live Render E2E evidence is still **outstanding**. See [BUILD_STATUS.md](../../BUILD_STATUS.md) open gates.

## Start here

| Document | Purpose |
| --- | --- |
| [render-e2e-runbook.md](./render-e2e-runbook.md) | Step-by-step: signup → Gmail → supplier delay email → voice call → owner approval |
| [submission-checklist.md](./submission-checklist.md) | Checklist mapped to BUILD_STATUS open gates and PRD M6 |
| [artifact-conventions.md](./artifact-conventions.md) | Filename rules and what to redact |
| [templates/live-run-record.md](./templates/live-run-record.md) | Copy per run; record timestamps, IDs, outcomes (no fabricated passes) |

## Artifact directories

Place files only after a real run. Do not commit secrets, raw OAuth tokens, or unredacted PII.

| Path | Contents |
| --- | --- |
| `artifacts/health/` | JSON snapshots from `/api/health` and voice-bridge `/health` |
| `artifacts/screenshots/` | UI captures (case, approval, inbox connection) — redact emails/phones as needed |
| `artifacts/traces/` | Provider/conversation IDs, webhook excerpts, Inngest run links (sanitized) |
| `artifacts/usage/` | DeepSeek usage excerpts, Exa query summaries, call duration metrics |
| `artifacts/video/` | Demo video source or export notes (≤3 minutes per PRD) |

Each subdirectory contains a `.gitkeep` until real artifacts exist. Large binaries may stay local or in release assets; record paths in `live-run-record` either way.

## Helper script

From repo root, with `APP_BASE_URL` set to the public Render app URL (no secrets required):

```sh
node scripts/evidence/capture-health-snapshot.mjs
```

Optional: `VOICE_BRIDGE_URL` for the bridge health check. Output goes under `artifacts/health/` with a UTC timestamp in the filename.

## Related docs

- Hosting and health endpoints: [README.md](../../README.md#hosting)
- M6 exit criteria and partner evidence: [docs/prd/06-delivery-and-verification.md](../prd/06-delivery-and-verification.md) §6–7
- Voice setup (authorized test numbers, media bridge): [docs/voice-setup.md](../voice-setup.md)
