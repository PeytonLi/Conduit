# Foreign currency quotes and recovery costs

`organizations.currency` is the home currency (USD by default). Quote amounts stay
in their original currency and integer minor units. Plans and approval ceilings
use home-currency minor units. FX is a cost comparison estimate, not a payment or
a guarantee of the bank's eventual settlement rate.

An owner can record a manual rate through `POST /api/v1/fx-rates`:

```json
{
  "from_currency": "EUR",
  "numerator": "11",
  "denominator": "10",
  "as_of": "2026-11-08T12:00:00Z",
  "source": "Owner: bank quote reference 123"
}
```

The exact ratio means **11 home minor units per 10 source minor units**. Both
values are positive integer strings, up to 18 digits. For currencies with the
same minor-unit scale, this example is also 1.10 USD per EUR. For JPY to USD,
the numerator must express USD cents per yen, not dollars per yen. No binary
floating-point money or rate arithmetic is used. Convert the entire cost once,
rounding to the nearest home minor unit, half away from zero.

The authenticated membership supplies the organization and actor. The target
currency comes from the organization. Operators, viewers, suppliers, and model
tool arguments cannot enter rates. Rates are append-only, with source, timestamp,
and entering owner retained. Do not include credentials in the source reference.

The most recent non-future observation for the exact currency pair is selected
(then creation time and ID for ties). There is no inferred inverse rate,
triangulation, or default rate. Missing or stale evidence makes the converted
cost null and the plan draft. `organizations.fx_max_age_seconds` is the explicit
freshness policy, default 86,400 seconds, supported range 1–2,592,000. Configure
it through trusted workspace administration. A policy change invalidates the
material fingerprint of existing plans.

Quote comparison displays the original total, home total, and rate source/time.
Item, freight, fees and tax are quoted in the quote currency; original-order
cancellation, credits and original commitment offsets are in home currency.
Manual recovery step payloads may specify `currency` for amendment charges,
transfer costs, or cancellation fees/credits; absent currency retains the
existing home-currency contract. A purchase step always uses its stored quote's
currency, never a model-supplied override.

The ledger stores original/converted costs and the complete rate snapshot in
`plan_steps.payload.cost_conversion`. Approvals copy that evidence into
`approvals.conversion_evidence`, bind the converted totals and snapshots in the
material fingerprint, and expire no later than the rate's freshness deadline.
Appending a newer rate does not rewrite a reviewed plan: create a new plan
version to use it. Changing stored plan costs, quote terms, home currency, or FX
policy requires fresh review. JSON/CSV execution exports retain original amounts
and conversion evidence.

Foreign costs currently require manual execution. Automated connector payloads
retain their existing home-currency contract. Extend a connector's validated
currency mapping and write/readback tests before enabling foreign writes.
CSV/ERP inventory import currency rules are unchanged; this feature covers
quotes and recovery costs, not multi-currency accounting or settlement.

On rollout, recreate pending plans made before this migration. The expanded
material fingerprint intentionally prevents their old approvals from executing
without review under the new currency/evidence contract.

## Adding a rate provider

No vendor or credential is required for the manual path. To integrate a provider,
add a trusted server-side adapter that reads an explicitly configured provider
for the organization and appends observations to `fx_rates` using the service
role. Set `entered_by` null for provider observations and record a source name
and provider reference in `source`, plus the provider's observation `as_of`.
Normalize the provider's decimal major-unit rate to an exact minor-unit ratio
before inserting; reduce to the supported integer bounds or reject it. Never
pass an unvalidated model/supplier rate into this adapter. On timeout, missing
pair, stale observation, or unsupported precision, retain an incomplete cost.
Reuse the existing conversion, snapshot, fingerprint and expiry logic; do not
overwrite rates or approvals.
