# Conduit voice bridge

This service is the authenticated media-bridge transport for Conduit supplier
calls. Conduit prepares the action and grants first, then sends one signed
request to `POST /calls`. The bridge creates a SignalWire REST call, serves
capability-protected TwiML, and connects SignalWire's bidirectional
`<Connect><Stream>` audio to an ElevenLabs signed WebSocket. If the carrier
fails before an ElevenLabs conversation starts, the bridge sends the signed
status callback to Conduit for the existing callback/reconciliation path.

## Render deployment

Deploy this directory as a Render web service with:

- Root directory: `services/voice-bridge`
- Build command: `npm ci`
- Start command: `node server.mjs`
- Starter plan, exactly one instance, and `/health` as the health check
- `PUBLIC_URL` set to the assigned HTTPS service URL, with no trailing path

Set every required variable from `render.yaml`. `BRIDGE_ALLOWED_TO` is an
optional comma-separated E.164 allowlist. `PORT` takes precedence over
`BRIDGE_PORT`, then defaults to 8080.

State is intentionally in memory, so use one instance only and do not use a
free or idle-sleeping plan. A restart loses in-flight sessions and prevents
SignalWire callbacks from resolving their capability records.

SignalWire TwiML, media, and status URLs carry a per-call capability key.
There is no unauthenticated call-creation endpoint. Conduit-to-bridge requests
and bridge-to-Conduit callbacks use HMAC signatures. Do not log dynamic
variables, media keys, signatures, signed ElevenLabs URLs, full phone numbers,
or provider credentials.

## Local development

Install dependencies and start the service:

```sh
npm ci
node server.mjs
```

SignalWire must be able to reach `PUBLIC_URL`, so local development needs a
public HTTPS tunnel whose forwarding target is the bridge port. Keep the
bridge and Conduit URLs aligned with the tunnel/service URLs. `/health` does
not expose configuration.
