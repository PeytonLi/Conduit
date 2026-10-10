# Voice setup: ElevenLabs + SignalWire (F4)

Conduit places supplier calls through **ElevenLabs Agents** using an **imported SIP trunk number** whose carrier is
**SignalWire**. DeepSeek is the agent's custom OpenAI-compatible LLM. Conduit never dials in `replay`; the replay
adapter records a simulated call only.

```
Conduit supplier_call action ─► ElevenLabs SIP outbound call ─► SignalWire SIP ─► supplier phone
          ▲  webhook tools (/api/voice/tools/*, per-call token header)      │
          └──────────── signed post-call webhook (/api/webhooks/elevenlabs) ◄┘
```

> Status: implemented and replay-tested. **Live proof (AT-15) is not done**: it needs real credentials and an
> explicitly authorized test number. Never call a real supplier for testing.

## Components

| Piece | Location |
| --- | --- |
| Call-start adapter (`supplier_call`) | `lib/integrations/elevenlabs/adapter.ts`, registered in `register.ts` |
| Per-call capability (hash only, 15 min) | `lib/integrations/elevenlabs/capability.ts`, `private.voice_grants` |
| Voice tools | `app/api/voice/tools/[tool]/route.ts` → `lib/integrations/elevenlabs/tools.ts` |
| Post-call webhook | `app/api/webhooks/elevenlabs/route.ts` → `lib/integrations/elevenlabs/webhook.ts` |
| Call brief + versioned prompt | `lib/integrations/elevenlabs/brief.ts`, `prompts/supplier-call.v1.ts` |
| SQL (grants, outcomes, dedupe, quarantine) | `supabase/migrations/20261012140000_voice_calls.sql` |
| Missing-callback sweep | `lib/workflows/voice-call.ts` (cron, queues `action.reconcile.requested`) |
| Agent setup | `scripts/voice/setup-agent.ts` |

## Environment

| Variable | Used for |
| --- | --- |
| `ELEVENLABS_API_KEY` | Server-side ElevenLabs API |
| `ELEVENLABS_AGENT_ID` | Agent printed by the setup script |
| `ELEVENLABS_PHONE_NUMBER_ID` | Imported SignalWire SIP trunk number |
| `ELEVENLABS_WEBHOOK_SECRET` | HMAC secret of the post-call webhook |
| `APP_BASE_URL` | Public `https://` base URL that ElevenLabs can reach |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL` | Custom LLM (default base `https://api.deepseek.com`) |
| `SIGNALWIRE_SPACE_URL`, `SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_API_TOKEN` | SignalWire account (dashboard work only) |
| `SIGNALWIRE_PHONE_NUMBER`, `SIGNALWIRE_SIP_ADDRESS`, `SIGNALWIRE_SIP_USERNAME`, `SIGNALWIRE_SIP_PASSWORD` | Optional as a group, setup script only: create/update the trunk number |

Live dispatch only happens when `APP_ENV` is `sandbox`/`live`, the action's mode is not `replay`, and all four
`ELEVENLABS_*` values are present. Otherwise the adapter fails closed without contacting anyone.

## 1. SignalWire (manual)

1. In the SignalWire dashboard, buy or select a phone number for outbound caller ID.
2. Create a **PSTN termination Domain Application** and attach a routing script that connects the incoming SIP
   destination to the PSTN with that number as caller ID. Use its `.dapp.signalwire.com` hostname. A SIP Credential
   at `<space>.sip.signalwire.com` is for registered devices; importing that host into ElevenLabs does not create a
   termination trunk. SignalWire documents this distinction in its [PBX recipe](https://signalwire.com/developers/demos/r/connect-a-pbx-with-a-domain-application.html)
   and [SIP credentials guide](https://signalwire.com/docs/platform/voice/sip/sip-credentials).
3. Obtain the Domain Application's digest credentials from SignalWire Support. These are distinct from the device
   registration password and API token. SignalWire's [outbound AI SIP guide](https://github.com/signalwire/docs/blob/main/fern/products/platform/pages/ai/guides/Integrations/vapi.mdx)
   describes the Domain Application, routing script, and support-issued password; applying that generic SIP routing
   pattern to ElevenLabs still needs the live proof below. Do not expose an unauthenticated PSTN relay. If using IP
   authentication instead, obtain supported SIP source ranges from ElevenLabs; allowlisting one DNS-resolved address
   does not cover its distributed SIP servers.
4. Set `SIGNALWIRE_SIP_ADDRESS` to the **bare hostname**: no `sip:`, `https://`, username, port, or `;transport=tls`.
   The script keeps TLS (5061) and applies the digest credentials. Match the routing script's destination parsing,
   caller ID, G.711 codecs, and SRTP policy on the carrier side. Verify certificate trust for that exact hostname.

## 2. ElevenLabs (automated)

```bash
pnpm tsx scripts/voice/setup-agent.ts            # dry run, prints the plan
pnpm tsx scripts/voice/setup-agent.ts --apply    # idempotent create/update, prints only IDs
```

The script:
- stores the DeepSeek key as an ElevenLabs workspace secret (`conduit_deepseek_api_key`);
- creates/updates six webhook tools named `conduit_<tool>` pointing at `${APP_BASE_URL}/api/voice/tools/<tool>`, each
  sending header `x-conduit-voice-token` from the secret dynamic variable `secret__conduit_voice_token` (secret
  variables are not sent to the LLM and are redacted in callbacks);
- creates the HMAC post-call webhook at `${APP_BASE_URL}/api/webhooks/elevenlabs` if missing — copy its signing secret
  from the dashboard into `ELEVENLABS_WEBHOOK_SECRET`;
- creates/updates the agent "Conduit supplier call": custom LLM `${DEEPSEEK_BASE_URL}/v1`, `chat_completions` (streamed),
  prompt `supplier-call.v1`, built-in `end_call` and `voicemail_detection`, 300 s max duration, post-call events
  `transcript` + `call_initiation_failure`, audio not sent;
- if the `SIGNALWIRE_*` SIP variables are set, validates them before provider writes, imports the number if missing,
  and updates the outbound trunk address, transport, and credentials even when the number was already imported.
  It refuses to overwrite a number imported through another telephony provider.

Set `ELEVENLABS_AGENT_ID` and `ELEVENLABS_PHONE_NUMBER_ID` from the printed IDs.

Correcting local SIP settings alone does not change the live trunk. Rerun setup with `--apply` after obtaining a
working, authenticated termination route. The phone-number ID is preserved.

## Connection failure diagnosed October 9, 2026

Read-only provider checks found three Conduit conversations with `status: failed`, no transcript, and:

```text
INVITE failed: sip status: 404: Domain unavailable (SIP 404)
```

The imported "Conduit SignalWire trunk" was using a `<space>.sip.signalwire.com` SIP Credential hostname, TLS,
and `allowed` media encryption. Both that hostname and `sip.rtc.elevenlabs.io` completed verified TLS 1.3
handshakes on port 5061 with trusted, unexpired certificates. The inspected SignalWire project had no Domain
Applications. This evidence points to missing SIP termination/routing rather than a TLS handshake failure.

The setup script also previously left an existing number's outbound configuration untouched, so rerunning it
could not repair a wrong host or credentials. That is now regression-tested.

**Remaining live step:** provision the authenticated Domain Application and PSTN route in §1, then apply the
corrected setup and run the authorized-contact checklist. No provider configuration was changed and no calls
were placed during this investigation. AT-15 remains unverified.

A subsequent user-authorized live attempt at 4:59 PM PDT on October 9 failed with the same SIP 404. The outbound
API returned `success: false`; conversation `conv_0401m4hhqxqtfrjrvg0fjwy9ks03` reports `failed`, zero duration,
zero transcript turns, and no audio. This verifies the current call path still fails before connection; it does
not validate two-way audio, tools, or application callback ingestion. See `BUILD_STATUS.md` for the test record.

Rem encountered the same SIP 404 and instead used a persistent SignalWire REST + ElevenLabs WebSocket media
bridge (`Rem/bridge/server.mjs` in the user's reference repository). That is a working precedent if direct SIP provisioning is
unavailable, but porting it requires a separate always-running service, authenticated call dispatch, per-call
correlation, clean call termination, and `ulaw_8000` input/output audio. Its open `/call` endpoint should not be
copied into Conduit. MyDuo's ElevenLabs speech path uses Recall for meeting audio and does not solve SIP routing.

## 2b. ElevenLabs (manual equivalent)

1. Agents → Phone numbers → Import number → SIP trunk: SignalWire number, outbound address/transport/credentials from §1.
2. Workspace → Secrets: add the DeepSeek key.
3. Create the agent: LLM = Custom LLM, server URL = DeepSeek base + `/v1`, model = `DEEPSEEK_MODEL`, API key = the secret.
   Paste the prompt from `lib/integrations/elevenlabs/prompts/supplier-call.v1.ts`; first message `{{ai_disclosure}}`.
4. Add the six webhook tools (POST, JSON body as in the setup script) with header `x-conduit-voice-token` =
   dynamic variable `secret__conduit_voice_token`.
5. Enable the built-in End call and Voicemail detection tools.
6. Settings → Webhooks: HMAC webhook to `/api/webhooks/elevenlabs`; enable transcription + call initiation failure
   events; do not send audio. Assign the imported number to the agent.

## Runtime behavior

- **Dispatch**: preconditions (case `active`, contact approved for phone, no other in-flight call, deterministic
  brief) → hashed grant + `call_sessions` row are written **before** the provider is contacted → outbound call with the
  brief as dynamic variables and the token only as `secret__conduit_voice_token`. The SDK call uses `maxRetries: 0`.
  Lost response/5xx/429/timeout ⇒ `unknown` (never redialed; a second dispatch for the action returns `unknown`).
  Definite 4xx ⇒ `failed`, grant revoked. `findResult` looks up the conversation by ID, or by the non-secret
  `conduit_action_id` dynamic variable when the ID was never received.
- **Tools**: every request resolves the token hash, checks revocation, 15-minute expiry, tool allowlist and the case's
  *current* `run_control`. Paused/blocked ⇒ only `request_human_review` and `end_call` work. Arguments are strict
  schemas; scope (org/case/contact) only comes from the grant. Offers are written as `provisional` quotes; added cost is
  computed in integer minor units against `policies.settings.negotiation_ceiling_minor`. Above-ceiling, unconfigured
  ceiling or uncomputable cost ⇒ owner task. The agent receives the same response either way.
- **Callback**: HMAC over `${t}.${rawBody}` (header `ElevenLabs-Signature: t=…,v0=…`), 30 min max age, 5 min future
  skew. Receipt + private payload + evidence + normalized outcome + `supplier.call.finished` outbox row are written in
  one transaction before 2xx. Key `<type>:<conversation_id>`; duplicates ack the original receipt. Unknown
  conversations go to `private.voice_callback_quarantine`. Storage errors return 5xx so ElevenLabs retries.
- **Missing callback**: `voice-stale-call-sweep` (every 5 min) queues `action.reconcile.requested` for calls with no
  callback after 20 minutes.

## Media bridge transport

The default transport remains `sip_trunk`. Set `VOICE_TRANSPORT=media_bridge`
only when the Conduit-owned bridge has been deployed and tested. The flow is:

1. The Conduit adapter prepares the grant and call-session ledger row, then
   sends a signed request to the bridge.
2. The bridge creates the SignalWire REST call.
3. SignalWire fetches capability-protected TwiML and opens a bidirectional
   `<Connect><Stream>` media stream.
4. The bridge forwards PCMU/µ-law 8 kHz audio to and from an ElevenLabs
   signed WebSocket.
5. Existing ElevenLabs post-call callbacks own reconciliation once a
   conversation starts. If the carrier fails before that point, the bridge
   sends a signed status event to `/api/webhooks/voice-bridge`, which uses the
   same callback receipt, quarantine, and action-hint resolution path.

Conduit needs `VOICE_TRANSPORT`, `VOICE_BRIDGE_URL` (HTTPS), and
`VOICE_BRIDGE_SECRET` (at least 32 characters), in addition to
`ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, and
`ELEVENLABS_WEBHOOK_SECRET`. Bridge deployment needs the ElevenLabs agent
credentials, SignalWire space/project/token/caller ID, `PUBLIC_URL`,
`VOICE_BRIDGE_SECRET`, and `CONDUIT_URL`; `BRIDGE_ALLOWED_TO` is an optional
E.164 allowlist. See `services/voice-bridge/README.md` and `render.yaml` for
the Render root directory, `npm ci` build, starter plan, and health check.

The bridge keeps active sessions in memory and must run as one always-on
instance; do not use a free or idle-sleeping plan. Conduit-to-bridge requests
and bridge callbacks use HMAC signatures. SignalWire TwiML, media, and status
paths use per-call capability keys. There is no unauthenticated `/call`
endpoint. Dynamic variables (including
`secret__conduit_voice_token`), secrets, signed URLs, and full phone numbers
must never be logged.

For a media-bridge live test, keep the SIP setup as-is but configure the bridge
URL/secret, confirm the bridge `/health` endpoint, verify the authorized
destination allowlist, and confirm both ElevenLabs audio formats are
`ulaw_8000`. The remaining case, grant, callback, no-answer, and reconciliation
checks are unchanged. Do not mark AT-15 verified until the full authorized
checklist passes.

## M0 feasibility checklist (PRD ch.05 §5)

Run only against an **explicitly authorized test contact**. Record evidence (IDs, timestamps, screenshots) in
`BUILD_STATUS.md`.

1. [ ] Configure a SignalWire number and supported SIP authentication/routing (§1).
2. [ ] Import/configure that number's SIP connection in ElevenLabs and assign the supplier agent (§2).
3. [ ] Set the custom model endpoint, exact DeepSeek model ID, secret key and streaming parameters; verify a test
       conversation in the ElevenLabs dashboard produces responses.
4. [ ] Configure the case-scoped webhook tools, secret dynamic variables and signed post-call callback; confirm a tool
       call without the header is rejected (401).
5. [ ] Start a call to the authorized test contact via a `sandbox` `supplier_call` action for a test case.
6. [ ] Verify caller ID, two-way audio, acceptable turn delay, interrupted speech, one `read_case_facts` lookup, one
       captured provisional offer, clean hangup, and a matching signed callback (`voice_call_outcomes` row,
       `supplier.call.finished` outbox row).
7. [ ] Exercise no-answer and call-start failure paths (`no_answer` / `busy` / `initiation_failed` outcomes).

Until all seven pass, AT-15 remains **unverified** and live voice must stay disabled.
