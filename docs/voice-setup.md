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
| `SIGNALWIRE_PHONE_NUMBER`, `SIGNALWIRE_SIP_ADDRESS`, `SIGNALWIRE_SIP_USERNAME`, `SIGNALWIRE_SIP_PASSWORD` | Optional, setup script only: import the trunk number |

Live dispatch only happens when `APP_ENV` is `sandbox`/`live`, the action's mode is not `replay`, and all four
`ELEVENLABS_*` values are present. Otherwise the adapter fails closed without contacting anyone.

## 1. SignalWire (manual)

1. In the SignalWire dashboard, buy or select a phone number for outbound caller ID.
2. Create a SIP endpoint / SIP connection that accepts outbound INVITEs from ElevenLabs and routes them to the PSTN with
   that number as caller ID. Record the SIP address (host) exactly as SignalWire shows it, plus the SIP username and
   password. Prefer TLS transport if your SignalWire configuration supports it.
3. Restrict the endpoint as tightly as SignalWire allows (credentials; IP allowlist of ElevenLabs SIP ranges if offered).
4. Verify current SignalWire documentation for codecs, transport and authentication — interoperability with ElevenLabs
   is a plausible path, not a proven one, until the M0 checklist below passes.

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
- if the `SIGNALWIRE_*` SIP variables are set, imports the number as an ElevenLabs SIP trunk number and assigns the agent.

Set `ELEVENLABS_AGENT_ID` and `ELEVENLABS_PHONE_NUMBER_ID` from the printed IDs.

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
