# M6 submission checklist

Map each item to evidence on disk or in BUILD_STATUS. Check **only** when a concrete artifact or BUILD_STATUS entry exists — leave unchecked while scaffold-only.

## BUILD_STATUS open gates

| Gate (BUILD_STATUS) | Check | Evidence location |
| --- | --- | --- |
| 1. Recorded live evidence on Render (Gmail, voice, DeepSeek usage) | [ ] | `artifacts/screenshots/`, `artifacts/traces/`, `artifacts/usage/`, filled `live-run-record` |
| 2. M6 evidence bundle, demo video, submission artifacts | [ ] | `artifacts/video/`, partner submission copy, README/demo script updated |

## PRD M6 exit evidence ([06-delivery-and-verification.md](../prd/06-delivery-and-verification.md) §1)

| Requirement | Check | Notes |
| --- | --- | --- |
| Reproducible evidence bundle | [ ] | This directory + immutable run record |
| ≤3-minute demo video | [ ] | `artifacts/video/` or linked URL in record |
| Partner / hackathon artifacts prepared | [ ] | Public repo, scoring dimensions per PRD §6 |
| README / setup accurate for reviewers | [ ] | README hosting + local dev verified by runner |
| Before/after benchmark (inventory performance) | [ ] | See BUILD_STATUS M6 / PR #14 reference |

## Live E2E journey (render-e2e-runbook)

| Step | Check | Required IDs / artifacts |
| --- | --- | --- |
| Health baseline captured | [ ] | `artifacts/health/health-app-*.json` |
| Signup / org created on Render | [ ] | org id, timestamp, screenshot |
| Gmail connected on Render | [ ] | connection timestamp, screenshot |
| Delay email → single correct case | [ ] | message id, case id, screenshots |
| DeepSeek used on live path (extraction/plan) | [ ] | usage artifact or provider log ref |
| Voice call on authorized test number | [ ] | action id, conversation id, trace |
| Owner approval + recovery recorded | [ ] | plan version, action ids, screenshots |

## B0 acceptance rows blocked without live proof

Do not check these for Render unless this run satisfied the **live** column in the acceptance matrix:

| Test | Live proof needed | Check when evidenced |
| --- | --- | --- |
| AT-15 Voice live proof | Two-way audio, tools, signed callback | [ ] |
| AT-02 / AT-20 / AT-22 | Gmail live sync / revoke | [ ] partial |
| AT-13 | Live send to approved contact | [ ] |
| NFR-004 | Inbox detect ≤120s (measured) | [ ] |
| NFR-006 | Voice turn latency sample | [ ] |

Replay and CI-covered tests remain documented in BUILD_STATUS M0/M5; this checklist does not duplicate every AT row.

## Partner evidence pack (PRD §6)

| Item | Check | Path |
| --- | --- | --- |
| Sanitized fixture inputs + expected results | [ ] | tests/fixtures / docs (link in record) |
| Run outputs and metric table | [ ] | `artifacts/usage/` |
| Documented defect + fix + rerun | [ ] | BUILD_STATUS or `artifacts/traces/` |
| Live call proof separated from replay | [ ] | labels in live-run-record |
| Architecture / limitations / versions | [ ] | PRD, README, BUILD_STATUS |
| Secret scan on committed artifacts | [ ] | manual review before push |

## Pre-submission review

- [ ] No `.env`, tokens, or webhook secrets in committed files
- [ ] PII redacted in screenshots and traces
- [ ] BUILD_STATUS “Next action” reflects actual remaining work
- [ ] Video length ≤180 seconds (if included)
