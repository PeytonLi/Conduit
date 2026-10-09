# 01 — Product, scope and user journeys

PRD v1.0 · Context: Conduit is a supplier-delay recovery agent. This chapter owns user needs and functional requirements. Read [domain rules](03-domain-and-data.md) before implementing a calculation or state transition.

## 1. Users and value

| Persona | Primary need | Success |
| --- | --- | --- |
| Business owner / purchasing approver | Protect customer commitments while controlling spending | Approves a specific, supported recovery with visible cost and residual risk |
| Operations coordinator / buyer | Understand delays and gather usable supplier responses | A prioritized case with correct quantities, deadlines, contacts, and a complete activity record |
| Supplier contact | Understand the request without repeating known order facts | Gives a precise answer, quote, or revised promise through existing email/phone |
| Technical administrator | Connect data and constrain automation | Knows connection health, scope, permissions, and failed actions |
| Judge / reviewer | Verify an agent completed a meaningful task | Can reproduce the case, inspect traces and fixes, and see the business model |

In B0, owner and technical administrator can be the same person. Suppliers need no Conduit account or new app. They use email or an ordinary telephone. Team size is irrelevant to the product requirements.

The value hypothesis is reduced coordination time and fewer avoidable shortages. Neither savings nor willingness to pay has been validated. The prototype must report what it actually measured.

## 2. Scope and priorities

**B0 is the required first build.** It supports one known packaging item family, integer quantities, one business currency (USD default), one presentation warehouse, one supplier mailbox, a small approved supplier list, and one coherent recovery plan at a time. Other tenants exist only to test isolation.

**P1 adds production access:** one named business system, receiving updates, dependable fresh stock, and controlled writes. Internal transfer execution belongs here. Business integration is a release gate, not a generic promise that every ERP is supported.

**P2 candidates:** Outlook, Signal/Wire chat connectors if desired, multiple mailboxes, automated multi-location transfers, fractional units, foreign exchange, additional languages, supplier onboarding, advanced forecasting, bills of materials, tender events, broader negotiations, and carefully delegated low-value purchasing.

Excluded from B0/P1: moving money, signing contracts, approving new suppliers autonomously, guessing technical equivalence, unrestricted browsing with business credentials, changing payment/bank details, and allowing suppliers to adjust purchasing policy.

## 3. Autonomy and approval

Three independent switches govern the product:

- **Analysis:** can be enabled once imports/connections are validated.
- **Supplier outreach:** owner enables it for listed contacts, channels, hours, and budgets. Otherwise the product drafts the next message/call request for review.
- **Commitments:** every purchase, cancellation, price change, transfer execution, or order amendment requires a fresh owner approval in v1.

A call may ask for or negotiate an offer inside a configured ceiling. It cannot accept the offer or invent authority. Negotiation targets do not authorize spending. Newly discovered suppliers remain research candidates until the owner approves the contact and, separately, the supplier's purchasing eligibility.

Pausing a case stops new dispatch. An already connected call or already sent email cannot be retracted; show it as in flight and request a supported hangup/cancellation if available.

## 4. Journeys

### J01 — Owner connects the business

Trigger: first sign-in.

1. Owner creates or joins the business workspace and chooses its timezone, currency, and operating hours.
2. Owner connects the dedicated Gmail inbox, or uses labeled replay messages.
3. Operator imports the documented CSV set or connects the selected pilot business system.
4. Product previews mappings, missing values, and validation failures before activating the dataset.
5. Owner confirms approved suppliers and exact email/phone contacts, purchasing limits, and outreach settings.
6. Product shows separate statuses for analysis, email, voice, and business write-back readiness.
7. Owner runs the canonical harmless/sample case before enabling outreach.

Success: data freshness and available capabilities are visible; missing credentials do not masquerade as a ready integration. Invalid rows leave the previous valid dataset active. A demo owner account is scoped to a sandbox organization.

### J02 — Supplier reports a delay

Trigger: a new inbound supplier message.

1. Connector saves the external message ID, thread, sender, timestamps, and original content reference.
2. Agent extracts the cited order/item/quantity and old/new promise.
3. Deterministic matching confirms a unique supplier/order line; remaining quantities and units must agree.
4. Product records a new commitment event and opens or updates the active case for the affected supply group.
5. Workflow obtains a fresh inventory/demand snapshot and calculates the impact.
6. Case shows the source message, original promise, new estimate, first shortage date, and affected requirements.

Success: one message does not cause duplicate cases or contacts. A message affecting several lines creates linked impacts, not one guessed match.

### J03 — Message cannot be matched confidently

Trigger: missing order ID, conflicting SKU aliases, multiple open orders, uncertain quantity, or ambiguous date.

The operator sees candidates and the exact unresolved fields. They choose the order/line, correct an extracted value with a reason, or dismiss the message as unrelated. The product then recalculates from the corrected facts. No external outreach or authoritative order update occurs while the match remains ambiguous.

A numeric model confidence score is not authorization. Owner corrections are versioned and preserve the original source.

### J04 — Delay has no operational impact

Trigger: projected usable stock covers all confirmed requirements inside the planning horizon.

The case explains why no recovery is necessary, shows the delayed incoming order, and enters monitoring. It still watches new demand, cancellations, and ETA changes. New evidence can move it back into assessment.

Success: no supplier call or replacement order is created solely because a delivery date changed. “No impact” means no impact within the stated horizon and current data, not a universal guarantee.

### J05 — Original supplier can recover

Trigger: a supported shortage exists.

The agent first evaluates a partial shipment and expedited shipping from the current supplier. It shares only the relevant purchase order and recovery quantity, obtains availability, delivery timing, incremental freight, quote validity, and written confirmation.

The owner sees the changed schedule and total cost before approval. For the carton example, 600 by Wednesday plus 3,400 Friday preserves the ordered total. A supplier's inability to help leads to the next supported option.

### J06 — Internal stock may cover the shortage

Trigger: validated stock exists at another location.

The product checks that location's demand, reservations, transfer travel time, and handling cost. It must not solve one site's shortage by creating another. B0 can display a sourced transfer recommendation; execution is disabled unless the pilot connector supports reservation, dispatch, and receiving.

The owner approves the source, quantity, expected arrival, and cost. Unknown transfer timing makes the option incomplete.

### J07 — Find alternative suppliers and obtain quotes

Trigger: the original supplier cannot meet the deadline or its offer is less suitable.

Search approved catalog suppliers first. When needed, search public websites for candidates using the item's exact specification and destination. Save URLs, retrieval times, relevant excerpts, and explicit unknowns.

For an approved contact, the agent sends a request specifying item, quantity, destination, deadline, and required quote fields. For a new contact, it presents the candidate to the owner before contacting it. A web listing of stock or price is preliminary evidence.

Success: incompatible substitutes are rejected with a concrete reason; research cannot create an approved vendor or a confirmed delivery promise.

### J08 — Call and negotiate

Trigger: a call is the permitted next action and the supplier is within contact hours.

The case supplies a short call brief: business identity, original order, shortage, arrival deadline, questions, and allowable tradeoffs. The voice agent introduces itself as the business's AI assistant, verifies the appropriate order/contact, asks for the missing facts, and requests written confirmation.

It may ask whether freight can be reduced or a smaller partial shipment can arrive sooner. It cannot reveal internal margins, unrelated customers, credentials, or accept contractual terms. An offer exceeding authority is recorded for review.

If there is no answer, busy signal, voicemail, or an unproductive phone tree, record that outcome and use an authorized email fallback. A network timeout after call submission creates an uncertain action for reconciliation; it is not evidence that nobody was called.

Success: a transcript/result is attached to the correct case and quantities/prices/dates are structured with evidence. A verbal offer remains provisional.

### J09 — Compare and validate options

Trigger: one or more candidate recovery plans exist.

The app filters hard constraints before ranking: specification, unit, quantity, arrival before each shortage deadline, approved supplier, written confirmation, currency, and known landed cost. Incomplete offers remain visible with missing fields.

Among feasible plans, the default order is earliest coverage of the shortage, lowest incremental landed cost, then evidence strength and recorded supplier performance if available. The owner can choose another feasible plan with a reason.

The comparison includes the original order's disposition. If an alternative causes overstock unless cancellation is accepted, show both scenarios and the outstanding dependency.

### J10 — Owner approves, rejects, or revises

Trigger: a verified plan is ready.

Owner reviews the affected orders, quantities, receipts, landed cost, source evidence, residual risks, original order treatment, and approval expiration. Approval binds to this exact version.

Rejecting records a reason and returns the case to recovery or closes it as accepted risk. Revising any material term produces a new version. If stock, price, delivery, or policy changes before execution, invalidate the approval and request review of the changed plan.

Success: approving twice or using two browser tabs cannot cause two external commitments.

### J11 — Record the approved recovery

Trigger: approval is current and fresh revalidation passes.

The dispatcher creates a durable action record, sends the permitted amendment or purchase instruction, and records the provider's response. A confirmed external system readback marks the action confirmed.

For B0, the destination is an explicitly named demo order ledger. For CSV/unsupported live connectors, produce a downloadable amendment/PO packet and mark manual execution required. Exporting a file never proves a live supplier order was changed.

If a write may have succeeded but confirmation is missing, show “Checking whether the update was applied.” Reconcile before another attempt. An operator can attach external evidence of a manual completion; the system does not claim it executed that action automatically.

### J12 — Monitor, receive, reopen, and close

Trigger: a recovery is recorded or a harmless delay is being monitored.

At each new message, receipt, demand change, or scheduled reassessment, update the projection. A revised ETA can reopen recovery. Receiving events must identify quantity, item, location, and order; partial receiving leaves the remainder open.

Close as delivered only when required goods were received and the affected demand is covered. An owner may close as accepted risk or cancel the case with a reason. Those outcomes are not counted as successful automated recoveries. Cancelling the case does not cancel existing purchase orders.

### J13 — Connection or model fails

Trigger: revoked OAuth, stale import, unavailable model, malformed model output, provider error, or exhausted budget.

Show which capability is affected and the concrete next action. Safe reads may retry within limits. New side effects stop if permission, data, or outcome is uncertain. The operator can refresh data, reconnect, correct a field, approve a budget increase, or take over manually.

Recovered connections resume from persisted facts. No lost approval, duplicate outreach, or falsely closed case is acceptable.

### J14 — Operator hands work to another person

Trigger: assignment, shift change, or owner review.

A new operator sees a concise current summary and an append-only timeline: source messages, factual revisions, calls, provisional/confirmed offers, approvals, attempted writes, and next deadline. They can inspect each original source and the remaining blocker.

Success: understanding the case does not require the original conversation with the agent or its hidden reasoning.

### J15 — Owner changes access or disconnects a system

Trigger: role change, contact removal, connector disconnection, or an organization-wide pause.

Validate current authority at dispatch time. Revoked contact permission blocks queued outreach. Disconnected systems stop new sync and writes, while historical records retain their source and freshness labels. Owner can export a case and request retention/deletion according to the documented policy.

Existing commitments remain visible. Deleting a case from a screen is never an implicit procurement cancellation.

### J16 — Reviewer reproduces the demonstration

Trigger: a judge or developer opens the demo environment.

They can reset the sandbox, run the harmless delay and shortage fixtures, inspect the original data, replay a deliberate failure, and see the corrected result. Recorded calls are labeled recordings; deterministic replay is labeled replay. At least one actual call and callback must have separate evidence for the B0 live-voice gate.

The demo links a neatlogs before/after run, the corresponding Entire checkpoint, and the CFO.ai financial model.

## 5. Functional requirement catalog

| ID | Requirement | Release / journeys |
| --- | --- | --- |
| FR-001 | Authenticate members and enforce owner/operator/viewer permissions per organization | B0 / J01,J15 |
| FR-002 | Connect a scoped Gmail mailbox and display connection/permission health | B0 / J01,J13 |
| FR-003 | Preview, validate and atomically activate a complete business dataset | B0 / J01 |
| FR-004 | Preserve and deduplicate inbound messages and external identifiers | B0 / J02 |
| FR-005 | Extract cited delay facts and match supplier, order, line, unit and affected quantity | B0 / J02,J03 |
| FR-006 | Provide manual resolution for ambiguous facts without losing source history | B0 / J03 |
| FR-007 | Compute dated stock projections, first shortage, required bridge quantity and affected demand | B0 / J02,J04,J05 |
| FR-008 | Separate confirmed demand/receipts from forecasts and unknown arrivals | B0 / J02,J13 |
| FR-009 | Monitor harmless delays without unnecessary outreach | B0 / J04 |
| FR-010 | Evaluate partial shipment and expedited shipping from the existing supplier | B0 / J05 |
| FR-011 | Evaluate internal transfers without creating a source-location shortage | B0 recommendation; P1 execution / J06 |
| FR-012 | Discover and cite alternative suppliers, preserving approval status and unknowns | B0 / J07 |
| FR-013 | Send permitted, deduplicated threaded quote requests and confirmation follow-ups | B0 / J07,J08 |
| FR-014 | Place a scoped voice call, use authenticated tools and ingest its result | B0 / J08 |
| FR-015 | Enforce negotiation limits and keep verbal offers provisional | B0 / J08 |
| FR-016 | Normalize quotes, reject incompatibilities and compare full landed costs | B0 / J09 |
| FR-017 | Produce versioned recovery plans including original-order treatment and dependencies | B0 / J09,J10 |
| FR-018 | Bind approval to a plan version, cost ceiling, authority and expiry | B0 / J10 |
| FR-019 | Revalidate data, quotes and commitments before execution | B0 / J10,J11 |
| FR-020 | Record authorized recovery with idempotent actions and confirmed readback | B0 demo ledger; P1 real connector / J11 |
| FR-021 | Export a manual execution packet with honest execution status | B0 / J11 |
| FR-022 | Reconcile uncertain external outcomes before allowing a retry | B0 / J08,J11,J13 |
| FR-023 | Track receipts and separate recorded recovery from delivered outcome | B0 fixtures/manual receipt; P1 connector / J12 |
| FR-024 | Support pause, resume, reassign, cancel and accept-risk with audit reasons | B0 / J12,J14,J15 |
| FR-025 | Maintain source-linked timeline, user-friendly status and next action | B0 / all |
| FR-026 | Enforce tenant isolation, tool capabilities, contact policy and secret protection | B0 / all |
| FR-027 | Capture neatlogs traces and measured per-case usage, including failed attempts | B0 / J13,J16 |
| FR-028 | Capture Entire development evidence and a meaningful fix checkpoint | B0 / J16 |
| FR-029 | Produce the CFO.ai operating model with explicit assumptions and scenarios | B0 / J16 |
| FR-030 | Provide reproducible fixtures, honest replay labeling and a resettable isolated demo | B0 / J16 |
| FR-031 | Detect stale data and disable conclusions/commitments that require missing facts | B0 / J01,J13 |
| FR-032 | Handle related cases and concurrent demand so the same supply is not allocated twice | B0 / J02,J10,J11 |
| FR-033 | Bound retries, searches, model usage, calls and follow-ups with visible limits | B0 / J07,J08,J13 |
| FR-034 | Provide keyboard-accessible responsive review, approval and evidence views | B0 / J10,J14 |
| FR-035 | Support one fresh, authorized business-system connector with versioned read/write contracts | P1 / J01,J11,J12 |
| FR-036 | Support disconnect, export and retention processing without hiding unresolved commitments | B0 controls; P1 operational retention / J15 |

## 6. Success metrics

Record raw counts and denominators, not only percentages.

- **Disposition accuracy:** cases whose final classification and evidence match fixed ground truth / all evaluated cases.
- **Shortage accuracy:** correct first shortage time and required quantity / cases with sufficient data.
- **Verified recovery rate:** cases with a feasible, confirmed and recorded recovery / all actionable shortage cases.
- **False-action count:** unauthorized contacts, commitments, incompatible recommendations or duplicate external actions. Target zero in the acceptance set.
- **Case elapsed time:** message observed to first usable recommendation and to recorded recovery. Separate supplier/human waiting from processing time.
- **Human review effort:** measured minutes spent reviewing/correcting; do not invent a counterfactual time saving.
- **Cost per successful case:** all attributable model, search, voice, phone and retry usage over the period / verified successful cases. Failed attempts remain in the numerator.
- **Delivery outcome:** covered requirements and received quantity by deadline, tracked separately from the agent's planning/execution result.
- **Evidence completeness:** required factual fields with accessible, relevant sources / all required fields.

A call that ends successfully is not automatically a successful procurement case. Forecasted revenue at risk is not lost revenue, avoided losses, or realized savings.

Report the mix of harmless and actionable cases. Give actionable-shortage recovery cost/rate separately so easy no-impact cases cannot inflate the apparent procurement success. Count each case episode once in a fixed evaluation cohort; repeated attempts add cost, not new successes. With zero successful cases, cost per success is undefined and must be shown as such.
