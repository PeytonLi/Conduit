# 03 — Domain model, calculations and data

PRD v1.0 · This chapter is authoritative for domain vocabulary, state values and arithmetic. Use [04](04-architecture-and-contracts.md) for API transactions and [06](06-delivery-and-verification.md) for fixtures.

## 1. Vocabulary and primitive types

- **Case:** the recovery work for one organization, item and destination location, including affected order lines and dated requirements.
- **Assessment:** an immutable calculation from a specific input snapshot and policy version.
- **Recovery plan:** a versioned set of proposed actions that covers the dated shortage and states what happens to original commitments.
- **Offer / quote:** supplier-provided terms; it may be provisional, incomplete, expired or verified.
- **Commitment:** an accepted order, amendment, cancellation or transfer with traceable authority and confirmation.
- **Receipt:** observed arrival of goods. An ETA is not a receipt.
- **Action:** one intended external side effect with a stable ID and reconciliation lifecycle.
- **Evidence:** retained source content supporting a particular factual assertion.
- **Known:** supported by identifiable evidence; it does not mean infallible or permanently current.

IDs are UUIDs. Provider IDs are opaque strings. UTC timestamps use ISO 8601 with an explicit offset on input. Keep the organization's and destination's IANA timezones for display and date interpretation.

B0 quantities are nonnegative integers in an item's declared base unit; carton quantities mean cartons, never packs unless converted by a verified catalog mapping. Reject fractional quantities in B0. Use integer arithmetic and reject values outside the documented safe range (0–1,000,000,000 units).

Procurement money is integer currency minor units in the database and decimal digit strings in JSON/CSV. B0 supports one organization currency and unit prices exactly representable in that currency's minor unit; reject extra precision rather than silently round it. Negative amounts are allowed only for explicitly typed credits. The maximum supported amount is 1,000,000,000,000 minor units. Perform arithmetic using integer/BigInt or database numeric operations; never binary floating point. AI/voice/search usage costs retain provider precision as decimal strings and database numeric values until aggregation; do not round each sub-cent API request to zero.

Unknown values are null plus a reason. Zero means a known zero. Percentages, probabilities and model confidence must not substitute for evidence or authority.

## 2. Item compatibility and units

The canonical packaging item contains SKU, description, base unit, dimensions in millimeters, material/grade, and required certifications or other constraints when relevant. For the carton fixture: 300 × 200 × 150 mm, material_grade=KRAFT-SW-DEMO, one carton per base unit. The grade is a fictional fixture identifier, not a claimed engineering certification.

A candidate is compatible only when every required field matches or an explicit owner-approved substitution rule allows the difference. A missing required specification is incomplete. Similar product names, model opinion, or a supplier's generic “equivalent” claim is insufficient.

Supplier pack size is a positive integer. Order quantity must respect its minimum quantity and pack multiple. If 600 are required and only packs of 250 are sold, quote 750 and expose the 150-unit surplus and its cost. Do not change the shortage itself to 750.

Units, item mapping, warehouse, currency and supplier eligibility are hard checks. Model-generated descriptions cannot override them.

## 3. Inventory projection

### 3.1 Inputs

For each item/location, obtain a coherent snapshot time T0:

- Physical on-hand quantity.
- Unusable/quarantined quantity.
- Outside allocations: commitments whose corresponding demand is NOT included in the demand dataset.
- Confirmed, unfulfilled demand, each with a required-at time and source ID.
- Confirmed future receipts, each with quantity, arrival window and evidence.
- Safety buffer quantity from the active policy, default zero.
- Existing pending execution/stock claims needed to prevent duplicate allocation.
- A planning horizon, default T0 plus 30 days.

Reservations against demand already included in the dataset are metadata. Do not subtract them a second time. Inputs must declare their reservation semantics. If a connector cannot distinguish included demand from outside allocations, the assessment is insufficient until mapped or reviewed.

Remove or supersede the affected order's old receipt expectation. Use its latest evidenced delivery estimate. Unknown ETA receipts do not count toward guaranteed coverage. Forecast demand is a separate optional scenario, never silently merged with confirmed requirements.

### 3.2 Calculation

Initial coverage balance:

~~~text
usable_start = physical_on_hand - unusable_qty - outside_allocations_qty
coverage_start = usable_start - safety_buffer_qty
projected(t) = coverage_start
             + confirmed_receipts_arriving_by(t)
             - confirmed_remaining_demand_due_by(t)

bridge_quantity = max(0, -minimum(projected(t) over the assessment horizon))
first_shortage_at = earliest event time with projected(t) < 0
~~~

Do not sum every negative balance: -200 then -600 means a 600-unit bridge, not 800.

The output must include cumulative additional supply required at each shortage deadline. A single total quantity is insufficient when part of it is needed earlier. To validate a proposed plan, add its receipts, remove its cancelled/reallocated receipts, and rerun the entire timeline. A plan is feasible only if it covers every relevant deadline without an unexplained negative balance.

**Time rules:** evaluate confirmed arrivals against the destination's required-at time. A receipt counts at the latest end of its supported arrival window. A date-only arrival counts at the end of that local date; it cannot cover an earlier same-day requirement. If no time can safely be assigned, mark the option incomplete. Use UTC for ordering after resolving local dates; daylight-saving transitions must not invent nonexistent times.

Past-due unfulfilled demand counts at T0. Past-due unreceived supplies are overdue and do not become inventory automatically. Physical stock changes only from a new authoritative snapshot or an actual receiving adjustment. A receipt already reflected in physical stock must not be added again.

A 30-day horizon does not justify a claim about requirements outside it. If recovery depends on data beyond that horizon, request an explicit horizon extension or escalate.

### 3.3 Canonical example

Fixture clock: Monday October 12, 2026, 08:00 America/Los_Angeles. Dates are illustrative. The delayed order arrives Friday October 16 at 08:00; demand occurs at 09:00 local on each preceding day.

| Event | Change | Projected stock |
| --- | --- | --- |
| Monday start | 600 usable | 600 |
| Tuesday demand | -400 | 200 |
| Wednesday demand | -400 | -200 |
| Thursday demand | -400 | -600 |
| Friday delayed receipt | +4,000 | 3,400 |

Required recovery: at least 200 by Wednesday 09:00 and 600 cumulatively by Thursday 09:00. A single delivery of 600 by Wednesday 08:00 satisfies both.

Split the original PO into 600 Wednesday and 3,400 Friday: final stock remains 3,400. Add an alternative 600 without reducing the original 4,000: final stock becomes 4,000, exposing 600 additional units relative to the original plan.

### 3.4 Freshness and quality

Every record has source_as_of and fetched_at/imported_at; fetching stale business data does not make the source fresh. The default freshness threshold for automatic assessment/execution is 15 minutes for stock, demand and current commitments in live mode. The owner may require a tighter threshold; relaxing it is a recorded policy change.

CSV data is a snapshot. It can support a clearly dated recommendation and manual export. It cannot pass the pilot live-write gate. Demo mode uses a frozen fixture clock and a labeled demo ledger.

Assessment quality has exactly two values: sufficient or insufficient. If inputs are stale, incomplete, contradictory, or have incompatible units, preserve the last valid assessment and create an insufficient assessment. Never manufacture zero stock/demand or claim no impact.

## 4. Quotes, costs and ranking

Required quote terms: supplier/contact, exact item/specification, available/order quantity, unit, unit price, currency, freight, fees, nonrecoverable tax, delivery destination, supported arrival window, expiry, latest_order_at for that promised arrival, written-confirmation evidence, and any MOQ/pack constraints. If the supplier explicitly guarantees the arrival for any order accepted before quote expiry, latest_order_at may equal that expiry; otherwise obtain the cutoff rather than infer a lead time.

A known zero charge must be explicit. “Shipping calculated later” makes landed cost incomplete.

~~~text
landed_cost = quantity * unit_price_minor
            + freight_minor + fees_minor + nonrecoverable_tax_minor

incremental_cost = new_recovery_cost
                 + original_order_change_fees
                 - confirmed_original_order_credits
~~~

Show both gross new cash commitment and net incremental cost. A possible cancellation credit is a scenario until confirmed. Do not count the full original PO cost again as a new expense when only its schedule changes.

Canonical quote fixtures:

- Original PO: 4,000 cartons at 35 cents = 140,000 cents, already committed.
- Split shipment: the same 4,000 at the same price, plus 7,500 cents freight. Incremental cost: 7,500.
- Alternative: 600 at 42 cents plus 6,000 freight = 31,200 cents gross.
- If cancellation of 600 original units is accepted with a 21,000-cent credit, alternative net incremental cost is 10,200; otherwise the gross 31,200 and 600-unit surplus remain visible.
- A cheaper but wrong-size carton is rejected before ranking.

Filter feasibility first. Then rank by covering the earliest deadline, lower verified incremental cost, and stronger supported delivery evidence. Do not invent supplier reliability scores. If no observed history exists, display “No performance history.”

Default revalidation: quotes older than 60 minutes require availability reconfirmation unless their written terms explicitly reserve the quantity through execution. Expired quotes always require renewal. A verbal offer can create a provisional quote but cannot make a plan ready.

## 5. Canonical state machines

### 5.1 Case phase

Allowed values: new, needs_review, assessing, recovering, awaiting_supplier, awaiting_approval, executing, monitoring, closed.

| Phase | Entry / work | Allowed next phases |
| --- | --- | --- |
| new | Inbound evidence recorded | needs_review, assessing, closed |
| needs_review | Match or required fact unresolved | assessing, closed |
| assessing | Validate inputs and calculate current impact | needs_review, recovering, monitoring, closed |
| recovering | Gather/evaluate options | awaiting_supplier, awaiting_approval, needs_review, assessing, closed |
| awaiting_supplier | A scoped request is waiting on external evidence | recovering, assessing, needs_review, closed |
| awaiting_approval | A ready plan requires owner decision | executing, recovering, assessing, closed |
| executing | A financial action or amendment is being reconciled | monitoring, recovering, needs_review |
| monitoring | No-impact case or recorded recovery awaiting future developments | assessing, closed |
| closed | Terminal disposition for this case episode | assessing only by explicit reopen with new relevant evidence |

Separate run_control: active, paused, blocked. Paused/blocked does not erase phase. Ingesting evidence continues; dispatch requires active. Block reasons are stale_data, missing_data, connection_unavailable, provider_unavailable, budget_exhausted, outcome_unknown, policy_denied, no_feasible_plan or manual_execution_required. Each has a visible next action. Executing cases with uncertain commitments cannot close or release claims until reconciliation or a documented owner takeover addresses the uncertainty.

Closed outcomes: delivered, no_impact, accepted_risk, cancelled, unresolved. A reason and actor are required. delivered requires receiving evidence; no_impact requires the monitored period to end or the affected order to arrive without shortage. Reopening increments the episode and preserves history.

Task-outcome milestones are recorded separately for reporting: no_impact, recovery_recorded, manual_handoff, accepted_risk, unresolved. They are not promises of delivery. A reopened case is active again; reporting must distinguish current outcome from historical milestones.

Severity defaults: critical for a confirmed shortage within 24 hours or already occurring; urgent for 24–72 hours; warning beyond 72 hours; info when no shortage exists. Unknown impact displays “Needs information” rather than a fabricated severity score.

### 5.2 Other state values

| Entity | Allowed states / meaning |
| --- | --- |
| Quote | provisional, verified, expired, rejected, superseded |
| Plan | draft, ready, approved, rejected, expired, superseded, executing, executed, execution_uncertain, failed |
| Approval | active, revoked, expired, consumed |
| Action | prepared, dispatching, submitted, confirmed, failed, unknown, cancelled |
| Import | staged, invalid, ready, active, superseded |
| Connection | disconnected, configuring, healthy, degraded, expired, revoked |
| Allocation claim | active, consumed, released, uncertain |
| Expected receipt promise | confirmed, estimated, unknown, superseded |
| Message processing | pending, processed, needs_review, ignored, error |

An action in confirmed means its external outcome is known, not necessarily favorable. A completed call with no answer can be confirmed with result=no_answer. failed means the request is known to have failed without the intended effect. unknown means it may have succeeded and must reconcile. Chapter 04 owns the transition algorithm.

## 6. Evidence and fact revisions

Evidence sources: email, call transcript, supplier document, web page, business-system record, import row, or human-confirmed entry.

Each fact retains: source/evidence ID; exact passage, page, row or record locator; extracted value; extraction version; observed time; actor/provider; and verification status. A source's publication date differs from retrieval time. Retain the relevant supported excerpt and a content hash.

The original message/document is immutable. Corrections append a new fact revision and a reason. Supplier statements establish what the supplier said; written quote/acceptance and business-system readback establish different levels of commitment. A model-generated summary is never the sole source of a price, deadline or quantity.

B0 stores PDFs and images as private evidence attachments; operators can enter sourced terms with page references. Automated scanned-PDF OCR and arbitrary document interpretation are deferred. Do not claim a PDF was understood when it was merely uploaded.

## 7. Data dictionary

Unless stated otherwise, every business table has id UUID, org_id UUID, created_at, updated_at and a row_version integer. org_id is immutable. Foreign keys include organization compatibility. Immutable event/version tables use created_at and never overwrite content.

| Table | Required business fields / constraints |
| --- | --- |
| organizations | name, timezone, currency, environment_mode (replay/sandbox/live), current_policy_version_id; ID is the tenant boundary |
| memberships | org_id + auth_user_id unique, role (owner/operator/viewer), active; no permissions from user-editable metadata |
| locations | name, external_id nullable, timezone, destination_address, active |
| suppliers | name, external_id nullable, purchasing_status (candidate/approved/blocked), approval_actor/time nullable, notes |
| supplier_contacts | supplier_id, channel (email/phone), exact normalized address/number, display_name, timezone, permitted_channels, outreach_approved_at/by, identity_evidence_id |
| items | sku unique per org, description, base_unit, specification JSON with validated schema, active |
| supplier_items | supplier_id + item_id, supplier_sku, pack_size, minimum_qty, verified_specification_evidence_id, last_verified_at |
| connections | provider, external_account_id, state, scopes, last_success_at, last_error_code, sync_cursor, capabilities JSON; no raw secrets |
| private.integration_credentials | connection_id, encrypted credential material, key_version, expires_at; server-only schema with no client grants |
| policy_versions | version unique per org, validated policy JSON, author, reason, effective_at; immutable |
| datasets | source_connection_id nullable, source_type (csv/connector/fixture), schema_version, source_as_of, imported_at, content_hash, state, validation_summary |
| inventory_snapshots | dataset_id, item_id, location_id, physical_qty, unusable_qty, outside_allocations_qty, source_as_of; unique item/location in a dataset |
| demand_requirements | dataset_id, external_id, item_id, location_id, remaining_qty, required_at, certainty (confirmed/forecast), included_reserved_qty, status, source_as_of |
| purchase_orders | external_id, supplier_id, currency, status, source_version, dataset_id |
| purchase_order_lines | purchase_order_id, external_line_id, item_id, destination_location_id, ordered_qty, received_qty, cancelled_qty, unit_price_minor, original_due_at; remaining quantity cannot be negative |
| receipt_schedules | po_line_id, quantity_remaining, earliest_at nullable, latest_at nullable, evidence_id, promise_state, supersedes_id nullable, source_as_of; active schedules cannot exceed remaining line quantity |
| commitment_events | po_line_id, kind (delay/split/expedite/cancel/accept/receive/correction), previous/new schedule references, affected_qty, evidence_id, actor; append-only |
| receiving_events | source_connection_id, external_receipt_id unique per connection, po_line_id, item_id, location_id, quantity, received_at, kind (received/reversal), reverses_event_id nullable, evidence_id; append-only, quantity nonnegative |
| messages | connection_id, provider_message_id unique per connection, provider_thread_id, rfc_message_id nullable, direction, sender/recipients, sent_at, received_at, body_evidence_id, processing_state |
| cases | item_id, location_id, phase, run_control, block_reason nullable, severity, assignee_user_id nullable, current_assessment_id nullable, current_plan_id nullable, episode, next_check_at nullable, closed_outcome/reason nullable |
| case_order_lines | case_id + po_line_id unique, affected_qty, triggering_message_id |
| assessments | case_id, version, input_fingerprint, policy_version_id, source_versions, horizon_start/end, quality, first_shortage_at nullable, bridge_qty nullable, projection JSON, dated_requirements JSON, evidence_ids |
| evidence | source_type, external_id/URL nullable, private_object_path nullable, source_time nullable, captured_at, content_hash, locator, supported_excerpt, verification_actor/time nullable, retention_until |
| case_evidence | case_id + evidence_id + purpose; source can support several related cases inside the same org |
| quotes | case_id, supplier_id/contact_id, item_id, quantity, unit, unit_price_minor/currency, freight/tax/fees, destination, arrival_start/end, valid_until, latest_order_at, status, original_order_terms, evidence_ids, verified_at; missing provisional terms are nullable |
| recovery_plans | case_id, version unique per case, assessment_id, input_fingerprint, policy_version_id, status, validated steps JSON, gross_commitment_minor, incremental_cost_minor, expiry, dependencies, evidence_ids |
| approvals | plan_id, plan_version, approving_user_id, authority_role, input_fingerprint, approved_ceiling_minor, currency, expires_at, status, consumed_by_action_id nullable, idempotency_key; immutable terms |
| actions | case_id, plan_id nullable, type, state, payload_version, canonical_payload_hash, idempotency_key unique per org, provider, provider_ref nullable, permitted_by, attempts, dispatch_started_at, next_reconcile_at, outcome, error_code |
| allocation_claims | plan_id, item_id, location_id, demand_ids, receipt/stock references, quantity, state, expires_at nullable; explicit reservations must not double-subtract included demand |
| call_sessions | action_id unique, provider_conversation_id unique nullable, provider_call_id nullable, contact_id, started/ended_at, duration_seconds, disposition, transcript_evidence_id nullable |
| private.tool_grants | action_id, token_hash, allowed_tool_names, case_id, contact_id, expires_at, revoked_at; bind voice requests to one case without exposing secrets to the model |
| callback_receipts | provider + external_event_key unique, verified_at, payload_hash, private_evidence_id, processing_state, related_action_id nullable, retry_count |
| event_outbox | event_id unique, aggregate_id, event_type, schema_version, payload JSON containing IDs, created_at, delivered_at nullable, attempts |
| audit_events | actor_type/id, case_id nullable, entity_type/id, event_name, previous/new version refs, reason, request_id, occurred_at; append-only |
| usage_events | provider + request_id + charge_type unique, case_id/action_id nullable, model nullable, raw_units JSON, estimated_cost_decimal nullable, actual_cost_decimal nullable, billing_currency, rate_version, recorded_at; costs are major-currency-unit decimal strings mapped to numeric(24,12) |

JSON fields must have versioned validation schemas. Use relational columns for identity, authorization, states, amounts, joins, uniqueness and filtering; JSON is for bounded snapshots or typed step payloads, not an unstructured replacement for the domain.

Receiving events are distinct from expected receipt schedules. In a live connector, receiving triggers a fresh stock read and is not blindly added to a stock snapshot that may already include it. The demo ledger applies a receiving adjustment transactionally once by external_receipt_id. Reversals reference the original event and cannot reverse more than its un-reversed quantity.

### 7.1 Recovery-plan step contract

Every step has step_id, kind, item_id, quantity, unit, destination_location_id, depends_on_step_ids, evidence_ids and an explicit execution_mode (demo_ledger/live_connector/manual). Quantities and all monetary fields follow section 1. Dependencies must form an acyclic graph. B0 allows at most one externally executed financial step per approved plan.

| Kind | Additional required fields | Invariant |
| --- | --- | --- |
| amend_delivery_schedule | po_line_id, full replacement schedule with quantities/windows, added_freight_minor, supplier_confirmation_evidence_id | Replacement schedule totals the current unreceived/uncancelled quantity; retains original history |
| purchase_bridge | supplier_id, contact_id, quote_id, quote_version, arrival_window, landed_cost_minor, original_order_disposition | Purchase eligibility and every dated shortage constraint pass; surplus is disclosed |
| transfer_stock | source_location_id, arrival_window, transfer_cost_minor, source_coverage_evidence | Source demand still covered; execution requires live connector capability |
| cancel_original_quantity | po_line_id, cancellation_quantity, confirmed_credit_minor, cancellation_fee_minor, supplier_acceptance_evidence_id | No credit assumed without evidence; dependency consequences explicit; manual in B0 multi-action plans |

Draft steps may have null unknown terms and a missing_fields list. A ready plan cannot. A material change produces a new immutable plan version. Other step kinds are unsupported until this contract and its tests change.

Accepting risk is an owner case-control decision, not a purchasing step. It records affected requirements and the owner's reason without implying a supplier commitment.

## 8. Identity and concurrency constraints

- One active case per org/item/location. New delays affecting the same stock pool join that case and invalidate affected assessments/plans. Several item lines in one email create linked cases sharing the source.
- Duplicate email: unique connection/provider_message_id. A Gmail thread ID is not a message ID.
- Duplicate callback: unique provider/external_event_key. If the provider has no delivery ID, derive a stable event key from conversation/action ID, event type and source event version/time, plus a canonical hash.
- Duplicate action: unique org/idempotency_key. Reusing the key with a different payload hash is a conflict.
- Two approvals of one plan cannot produce two commitment actions.
- Use transactional compare-and-swap on row_version for UI writes. Material input changes invalidate approval; unrelated audit updates alone do not.
- Lock affected item/location allocation groups during execution preparation. Use consistent lock ordering for transfers involving two locations.
- Claims related to uncertain external commitments cannot expire automatically and make stock appear free. Release only after reconciliation or a recorded owner resolution.

## 9. Import contract

B0 accepts UTF-8 CSV with headers and comma separation. One import session represents a coherent snapshot. All file references use external IDs, not internal UUIDs. The importer translates them inside the organization. Empty optional cells mean null. Dates require ISO 8601 timestamps with offsets; the UI may assist conversion before validation.

| File | Required columns |
| --- | --- |
| suppliers.csv | supplier_id,name,purchasing_status,contact_name,email,phone,contact_timezone,outreach_approved |
| items.csv | item_id,sku,description,base_unit,length_mm,width_mm,height_mm,material_grade |
| purchase_orders.csv | po_id,supplier_id,currency,status |
| purchase_order_lines.csv | po_id,line_id,item_id,location_id,ordered_qty,received_qty,cancelled_qty,unit_price_minor,original_due_at |
| receipt_schedules.csv | receipt_id,po_id,line_id,quantity_remaining,earliest_at,latest_at,promise_state,source_reference |
| inventory.csv | item_id,location_id,physical_qty,unusable_qty,outside_allocations_qty,source_as_of |
| demand.csv | demand_id,item_id,location_id,remaining_qty,required_at,certainty,included_reserved_qty,source_as_of |

Location is configured during onboarding; B0 files must use that external location ID. Import metadata includes snapshot/source_as_of, business timezone, schema_version=1, and currency. Phone/email can be empty when unused; outreach_approved cannot create authority unless an owner confirms the import's contact permissions.

Validate all files, duplicate IDs, references, quantities, schedule totals, units, timestamps, currencies, pack rules and allocation semantics before activation. A transaction supersedes the previous dataset and activates the new one. Reimporting the same content hash is a no-op. A partial or invalid import does not erase the active dataset.

Past action/audit/evidence records survive dataset replacement. Stable external IDs reconcile updated business records and preserve links to prior assessments.

## 10. Retention and deletion defaults

Proposed defaults: original emails, extracted quote evidence and call transcripts 30 days; raw voice audio disabled by default; case audit and approval/action summaries 365 days; usage metrics 365 days. The owner must select retention appropriate to the pilot before real business data is processed.

Private evidence links expire after five minutes and require current membership before issuance. Deleting retained content leaves an explicit tombstone and unavailable-source label; no silent replacement with a generated summary. Do not delete evidence needed for an unresolved action until its disposition is addressed.

Disconnection revokes tokens and stops new access; it does not delete existing commitments. Retention jobs must propagate configured deletion to connected storage/providers where supported and report gaps. No claim of end-to-end encryption is made for content processed by external AI/voice services.
