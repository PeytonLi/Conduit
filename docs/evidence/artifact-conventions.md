# Artifact filename conventions

Use UTC timestamps in filenames. Prefer lowercase slugs. **Do not** encode secrets in names.

## Pattern

```
<type>-<component>-<YYYYMMDDThhmmssZ>-<optional-slug>.<ext>
```

Examples:

- `health-app-20261108T201530Z-pre-run.json`
- `health-bridge-20261108T201531Z-pre-run.json`
- `screenshot-case-detail-20261108T202100Z-po1042.png`
- `trace-voice-action-20261108T203000Z-fc808e23.json`
- `usage-deepseek-20261108T204500Z-extraction.json`
- `live-run-20261108-harbor-delay.md` (filled copy of template)

## Components

| Prefix | Directory | Content |
| --- | --- | --- |
| `health-app` | `artifacts/health/` | Full JSON body from `GET /api/health` |
| `health-bridge` | `artifacts/health/` | JSON from voice bridge `GET /health` |
| `screenshot-*` | `artifacts/screenshots/` | PNG or WebP UI captures |
| `trace-*` | `artifacts/traces/` | Redacted provider excerpts, webhook payloads, log lines |
| `usage-*` | `artifacts/usage/` | Model usage, billing excerpts, timing tables (CSV/JSON/MD) |
| `video-*` | `artifacts/video/` | MP4 or `NOTES.md` pointing to external hosting |

## Required fields inside live-run record

Regardless of filename, each run documents:

- `run_id` (uuid or slug)
- `app_base_url` (public HTTPS only)
- `git_commit` at time of test (app deploy ref)
- Step timestamps (ISO 8601 UTC)
- `org_id`, `case_id`, `action_id`(s), `conversation_id`(s) when known
- Pass / fail / partial per step — **no** empty checkmarks implying success

## Redaction

Replace emails with `user+N@example.com`, phone numbers with `+1-555-0100`, and truncate bearer tokens. Keep provider ids (conversation id, SignalWire SID) if they are not authentication secrets.

## Git policy

- Commit small JSON/MD evidence when sanitized.
- Keep large videos out of git unless repository policy allows; link in record instead.
- Never commit `.env`, Render env dumps, or Composio/Google refresh tokens.
