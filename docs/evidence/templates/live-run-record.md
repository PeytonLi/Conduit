# Live run record (template)

Copy this file to `docs/evidence/artifacts/live-run-<YYYYMMDD>-<slug>.md` and fill in after the run. Leave fields as `TODO` or `not_attempted` rather than inventing values.

**Run status:** `not_started` | `in_progress` | `completed` | `failed` | `partial`

## Metadata

| Field | Value |
| --- | --- |
| run_id | |
| recorded_by | |
| recorded_at_utc | |
| environment | `render` |
| app_base_url | |
| voice_bridge_url | |
| render_deploy_ref / git_commit | |
| runbook_version | link to commit of `docs/evidence/render-e2e-runbook.md` |

## Health snapshots

| When (UTC) | File path | deepseek.ready | gmail.ready | voice.ready | exa.ready | inngest.ready |
| --- | --- | --- | --- | --- | --- | --- |
| pre-run | | | | | | |
| post-run | | | | | | |

Instructions: save JSON via `node scripts/evidence/capture-health-snapshot.mjs` or `curl -sS "$APP_BASE_URL/api/health"`. Copy boolean `ready` values from the response — do not mark ready unless the JSON file is attached.

## Step log

| Step | Started (UTC) | Ended (UTC) | Result | Notes |
| --- | --- | --- | --- | --- |
| 0. Health baseline | | | | |
| 1. Signup / org | | | | org_id: |
| 2. Gmail connect | | | | integration: |
| 3. Delay email → case | | | | gmail_message_id: ; case_id: |
| 4. Research (if any) | | | | |
| 5. Voice call | | | | action_id: ; conversation_id: ; signalwire_sid: |
| 6. Email send (optional) | | | | action_id: |
| 7. Owner approval | | | | plan_version: ; approval_action_id: |

**Result** column: `pass` | `fail` | `skip` | `not_attempted` only.

## Identifiers (single table for search)

| Kind | ID | Source (UI / API / log) |
| --- | --- | --- |
| org | | |
| user (owner) | | |
| case | | |
| supplier_call action | | |
| approval / commit action | | |
| evidence | | |
| ElevenLabs conversation | | |
| SignalWire call | | |

## DeepSeek / usage (no fabricated metrics)

| Phase | Model (if known) | Tokens or cost (if shown) | Artifact path |
| --- | --- | --- | --- |
| extraction | | | |
| planning | | | |
| other | | | |

If usage is unknown, write `unknown` and cite where billing was checked.

## Voice outcome (AT-15 honesty)

| Criterion | Met? | Evidence |
| --- | --- | --- |
| Authorized test number | | |
| Two-way audio | | |
| AI disclosure | | |
| Scoped tool use | | |
| Signed callback / outcome stored | | |
| Clean termination | | |

Overall AT-15 on this run: `not_evaluated` | `pass` | `fail`

## Artifacts index

| Path | Description |
| --- | --- |
| | |
| | |

## Failures and follow-ups

Document anything that blocked the journey. Link BUILD_STATUS updates here; do not close gates in prose without checklist proof.

---

_Scaffold template — completing this file does not by itself satisfy M6._
