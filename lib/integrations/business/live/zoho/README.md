# Zoho Inventory connector

`zohoInventoryProvider` implements `ErpClient` over Zoho Inventory API v1.

- **Auth**: OAuth via `/api/auth/zoho/connect` → `/api/auth/zoho/callback` (env `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, optional `ZOHO_REDIRECT_URI`, default `${APP_BASE_URL}/api/auth/zoho/callback`). The stored credential is `{ refresh_token, api_domain, accounts_server, organization_id }`, encrypted by `storeErpConnection`. The accounts server comes from the callback's `accounts-server` parameter, the API domain from the token response; both must be known Zoho data centers (.com, .eu, .in, .com.au, .jp, .ca, .com.cn, .sa). The organization is the only org or the default org on the account.
- **Requests**: every call carries `organization_id`, with header `Authorization: Zoho-oauthtoken`. Access tokens (1 h) are refreshed on demand and once on 401. Calls run one at a time, as Zoho limits each org to 100 requests/min, 1,000–10,000 per day by plan, and 5–10 concurrent. A 429 becomes `ZohoRateLimitError` (or a `rate_limited` rejection for splits).
- **Snapshot**: open POs (detail per PO), open sales orders (dated demand from `shipment_date`), per-location stock from item detail (`locations[].location_stock_on_hand`), locations from `/locations`. Orgs without locations map to `org:<organization_id>`. Over 150 detail reads per list raises an error rather than returning a partial snapshot.
- **Version**: PO `last_modified_time`. Zoho has no conditional update, so the client re-reads the PO right before the PUT; a change between that read and the PUT is not detected.
- **Receipts**: purchase receives with status `received`, one receipt per line (`<receive_id>:<line_item_id>`). Deleted receives are not reported as reversals.

## Delivery split limitation

Zoho PO lines have no delivery date of their own; only the PO header has `delivery_date`. A split is written as:

1. One new PO per later delivery (same vendor, item, rate, location), `reference_number` `CDT-<hash(change_ref)>-<n>`, marked issued.
2. The original PO line shrinks to the first delivery's quantity, its `delivery_date` moves to that date, and a line `Conduit change <change_ref>: {json}` is appended to its notes.

The notes line is written last and is what `findChange` reads. A retry finds existing follow-up POs by reference instead of creating more. If Zoho rejects the final update, the follow-up POs are cancelled. POs where another line still has open quantity are rejected with `not_supported_by_provider`, since moving the header date would move those lines too.
