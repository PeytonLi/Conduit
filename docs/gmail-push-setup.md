# Gmail push (Cloud Pub/Sub) setup

Push is additive. The 10-minute Inngest poll (`inbox-gmail-poll`) keeps running and stays the fallback; a push notification only triggers the same `syncGmailConnection` history-cursor sync sooner. Replay mode never registers a watch and the webhook ignores deliveries without contacting Google. Push applies to `GMAIL_PROVIDER=google` only (Composio has no `users.watch`).

## How it works

1. On Gmail connect (`/api/auth/gmail/callback`) and every 6 hours (`inbox-gmail-watch-renew`), Conduit calls `users.watch` with `GMAIL_PUBSUB_TOPIC` for each healthy, non-replay connection whose watch is missing, uses another topic, or expires within 24 hours. The expiration is stored on `connections.watch_expires_at`.
2. Gmail publishes `{emailAddress, historyId}` to the topic. A push subscription POSTs it to `/api/webhooks/gmail` with a Google-signed OIDC token.
3. The route verifies the token (signature, issuer, expiry, `aud`, and that `email` is the configured service account), finds the healthy connection(s) for that mailbox in each organization, and runs the shared sync. It returns `5xx` if a sync throws so Pub/Sub redelivers; provider failures are acknowledged because the sync already records connection status and the poll retries.

## One-time GCP setup

Use the same Google Cloud project that owns the Gmail OAuth client.

1. Enable the Gmail API and Cloud Pub/Sub API.
2. Create a topic, for example `gmail-push`.
3. Grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on that topic.
4. Create a service account for push delivery, for example `gmail-push@<project>.iam.gserviceaccount.com`.
5. Create a **push** subscription on the topic:
   - Endpoint: `https://<app host>/api/webhooks/gmail`
   - Enable authentication, select the service account above, and set the audience to the endpoint URL (or any string you also put in `GMAIL_PUBSUB_AUDIENCE`).
   - Ack deadline of at least 30 seconds.
6. Let Pub/Sub mint tokens for that service account: grant the Pub/Sub service agent (`service-<project number>@gcp-sa-pubsub.iam.gserviceaccount.com`) the **Service Account Token Creator** role on it.

## Environment

| Variable | Value |
| --- | --- |
| `GMAIL_PUBSUB_TOPIC` | `projects/<project>/topics/<topic>`. Enables watch registration and renewal. |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL` | The service account on the push subscription. Required for the webhook; without it the route returns `503`. |
| `GMAIL_PUBSUB_AUDIENCE` | Optional. Defaults to `${APP_BASE_URL}/api/webhooks/gmail`. |

Apply migration `20261108120000_gmail_push_watch.sql` before deploying. Existing connections are registered by the next renewal run (within 6 hours); reconnecting registers immediately.

## Verifying

- `connections.watch_expires_at` is populated roughly 7 days out for the connection.
- Send a message to the connected inbox; a case message should appear within seconds rather than up to 10 minutes.
- A request without a valid Google token returns `401`.
