# Outlook (Microsoft Graph) setup

Outlook is a second mailbox provider next to Gmail. An organization can connect several mailboxes (any mix of Gmail and Outlook accounts). Conduit reads supplier email from all of them and sends supplier email from one chosen per action, defaulting to the organization's **primary** mailbox.

> **Status:** built and covered by automated tests against faked Microsoft endpoints. It has **not** been verified against a real Microsoft tenant. See "Live verification checklist" below before relying on it.

## How it works

- **Connect.** An organization owner clicks **Connect Outlook** on Settings > Integrations. The authorization-code flow with PKCE runs against `https://login.microsoftonline.com/<tenant>/oauth2/v2.0`. The request uses `prompt=select_account`, so an owner can add a second Microsoft account instead of silently reusing the signed-in one. State is signed, expires after 10 minutes, and is bound to the organization, owner, redirect URI, provider and an HttpOnly nonce cookie.
- **Store.** The refresh token is encrypted with `CREDENTIAL_ENCRYPTION_KEY` (AES-256-GCM, same as Gmail) and stored in the private credential table. Microsoft rotates refresh tokens; the new one is stored whenever Microsoft returns one.
- **Read.** Inngest function `inbox-outlook-poll` runs every 10 minutes. For each healthy Outlook connection it runs a Graph **Inbox delta query** (`/me/mailFolders/inbox/messages/delta`), downloads each new message as MIME (`/me/messages/{id}/$value`), and ingests it through the same `ingestMessage` path as Gmail. The delta link is the sync cursor and advances only after every page was stored. An expired delta link triggers a bounded 7-day resync; duplicates are dropped by message id. Requests use immutable ids, so moving a message between folders does not create a duplicate. There is no push yet; polling is the only path.
- **Send.** Supplier email goes out as a Graph draft that carries Conduit's `Message-ID` (`internetMessageId`), then `send` on that draft. After an uncertain failure the dispatcher looks for that Message-ID in Sent Items instead of resending. A leftover draft from an interrupted attempt is reused.
- **Several mailboxes.**
  - One mailbox per organization is the **primary**: the default sender. The first mailbox connected becomes primary; an owner can change it. If the primary is disconnected, the oldest remaining active mailbox takes over.
  - `request_supplier_email` accepts an optional `connection_id`. A named mailbox must be active in the same organization, and the dispatch claim re-checks that exact connection. There is no silent fallback to another mailbox.
  - The same email delivered to two mailboxes (a shared alias, a CC) is processed once: copies from another mailbox are stored as `ignored`.
- **Replay.** Replay mode never contacts Microsoft. The connect route refuses, the poll is disabled, the send path uses the replay transport, and every Microsoft request (including the token endpoint) goes through a guard that throws before any network call.

## Microsoft Entra app registration

1. In the Azure portal open **Microsoft Entra ID > App registrations > New registration**.
2. Supported account types: choose what you need. **Accounts in any organizational directory and personal Microsoft accounts** works with `MICROSOFT_TENANT_ID=common`. For a single company use **this directory only** and set `MICROSOFT_TENANT_ID` to the tenant id.
3. Redirect URI (platform **Web**): `https://<app host>/api/auth/outlook/callback`. It must match `MICROSOFT_REDIRECT_URI` exactly. Add `http://localhost:3000/api/auth/outlook/callback` as a second URI for local development.
4. **Certificates & secrets > New client secret.** Copy the secret **value** once.
5. **API permissions > Add a permission > Microsoft Graph > Delegated permissions:** `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`. None of these require tenant-admin consent by default, though a tenant policy may require it. If so, grant admin consent here.

`Mail.ReadWrite` is requested only because Graph needs it to create a draft. Conduit never edits or deletes messages that already exist in a mailbox.

## Environment

| Variable | Value |
| --- | --- |
| `MICROSOFT_CLIENT_ID` | Application (client) ID. |
| `MICROSOFT_CLIENT_SECRET` | Client secret value. |
| `MICROSOFT_REDIRECT_URI` | `https://<app host>/api/auth/outlook/callback` |
| `MICROSOFT_TENANT_ID` | Optional. `common` (default), `organizations`, `consumers`, a tenant id, or a domain. |
| `CREDENTIAL_ENCRYPTION_KEY` | Already required for Gmail; also required here. |

Apply migration `20261108130000_outlook_multi_mailbox.sql` before deploying. It adds `connections.is_primary`, the provider-neutral `mailbox_*` RPCs, and updates the dispatch claim, disconnect and message-store functions. Existing Gmail connections keep working: the oldest active Gmail connection per organization becomes its primary. `/api/health` reports an `outlook` capability.

## Connecting and managing mailboxes

1. Settings > Integrations shows an **Outlook** card once the three required variables are set. Owners click **Connect Outlook** (or **Connect another Outlook account**).
2. Sign in with the mailbox's Microsoft account and approve the permissions.
3. The **Mailboxes** list shows every Gmail and Outlook connection with its address, health, last sync and a **Primary** marker.
   - **Healthy**: syncing normally.
   - **Sync delayed**: healthy, but no successful sync for 30 minutes.
   - **Needs attention**: the last sync failed in a way that may recover (throttling, outage).
   - **Reconnect needed**: the token was revoked or expired. Use **Remove**, then connect the account again.
4. **Make primary** changes the default sender. **Disconnect** deletes the stored token for that one mailbox. Microsoft has no per-token revocation endpoint, so to remove the app on Microsoft's side as well, remove it under *My Account > Apps & services* (or the tenant's Enterprise applications).

## Live verification checklist

Not done. These need a real Microsoft account and an Entra app registration:

1. Connect a personal Outlook.com account and a work/school Microsoft 365 mailbox. Confirm both appear, the first is primary, and "Make primary" switches it.
2. Send a test email to each mailbox and confirm it is ingested within one poll tick (initial connect imports the last 7 days as historical and does not open cases).
3. Confirm `Prefer: IdType="ImmutableId"` is honored by the delta endpoint, and that moving a message out of and back into Inbox does not create a second source message.
4. Create a delay notice that matches a purchase order, and confirm a case opens exactly once, including when the same email is sent to both mailboxes.
5. Prepare a supplier email against an approved test contact, approve it, and confirm it arrives from the chosen mailbox. In particular confirm that Exchange keeps the `internetMessageId` set on the draft, because send reconciliation depends on finding it in Sent Items.
6. Simulate an interrupted send (stop after the draft is created) and confirm the retry reuses the draft rather than creating another.
7. Revoke the app grant in Microsoft, run a poll, and confirm the connection moves to **Reconnect needed**.
8. Confirm a rotated refresh token is stored: the encrypted credential for the connection changes after a refresh that returns a new token.

Known limits: no push notifications (poll only), replies are not threaded with an `In-Reply-To` header (Graph does not allow setting it), only the Inbox folder is read, and attachments are recorded as references like Gmail.
