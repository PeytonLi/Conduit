# 02 — Application components and user experience

PRD v1.0 · Context: the owner needs an operational case, its evidence, and a next action. Product journeys are in [01](01-product-and-journeys.md); canonical states are in [03](03-domain-and-data.md).

## 1. Information architecture

The default signed-in destination is the case queue. Use a compact left navigation on desktop and a collapsed menu on small screens: Cases, Business data, Suppliers, Activity, Settings. Place connection readiness and the global automation pause inside Settings; surface failures where they affect a case.

| Route | Purpose | Primary actions |
| --- | --- | --- |
| /login | Sign in / password recovery | Sign in, recover access |
| /onboarding | Configure a business and initial dataset | Set timezone/currency, connect inbox, preview import, review contacts and policy |
| /cases | Prioritized work queue and summary | Open case, filter, assign, create case from pasted message |
| /cases/[caseId] | Investigate and resolve one supply problem | Review evidence, compare offers, approve, request revision, pause, close |
| /business-data | Inventory, demand, purchase orders and import freshness | Inspect records, import CSV, refresh supported connector |
| /suppliers | Approved and researched suppliers | Review contacts/specifications, approve contact, mark purchasing eligibility |
| /activity | Organization action/audit history | Filter by case/person/outcome and open source case |
| /settings/integrations | Provider connection health | Connect/reconnect/disconnect, run a scoped health check |
| /settings/policies | Hours, limits and automation authority | Save a versioned policy, pause all dispatch |
| /settings/members | Owner/operator/viewer memberships | Owner changes a role or removes membership |
| /demo | Sandbox-only fixture runner | Reset isolated demo data, run named scenario, open evidence |

Account enrollment for the initial build may be controlled by a seeded/invited user list; public self-service signup and subscription billing are not required. Authentication still uses Supabase Auth. Do not invent a fake login that bypasses authorization.

## 2. Role matrix

A person can have different roles in different organizations. Server-side membership, not a client-provided role, is authoritative.

| Capability | Owner | Operator | Viewer |
| --- | --- | --- | --- |
| Read organization cases and evidence | Yes | Yes | Yes |
| Resolve an ambiguous match / add a sourced correction | Yes | Yes | No |
| Import or refresh business records | Yes | Yes | No |
| Assign case / pause an individual case | Yes | Yes | No |
| Draft or request a permitted supplier action | Yes | Yes | No |
| Change global outreach or spending policy | Yes | No | No |
| Approve a new supplier contact / purchasing eligibility | Yes | No | No |
| Approve a financial commitment or accept a risk | Yes | No | No |
| Connect/disconnect providers and change memberships | Yes | No | No |
| Export a redacted case packet | Yes | Yes | Yes |
| Access secret credentials / raw tokens | No UI access | No | No |

Operations staff can request a call only within owner-enabled policy. Approval controls must show the approving identity and exact terms. Hiding a button is not an authorization check.

## 3. Case queue

Show actionable work before aggregate metrics. Default sort: blocked execution/uncertain external action, imminent shortage, owner decision needed, supplier response overdue, other active cases, harmless monitoring.

Each row/card contains:

- Case title: item + affected order/reference.
- Supplier or number of affected suppliers.
- First shortage date/time, or “No shortage in the next 30 days.”
- Quantity at risk, warehouse, and unit.
- Phase plus a separate paused/blocked badge.
- Current blocker or next action and its due time.
- Assignee, source freshness, and last business update.
- Clear Demo/Replay/Imported-data label when applicable.

Filters: phase, severity, assignee, supplier, item, needs my decision, data stale, uncertain action, and closed outcome. Counts must use the same filters as the list. Search by PO, item/SKU, supplier, or case ID.

Empty state distinguishes no cases from no matching filters. Loading uses stable skeleton rows. Connection failure preserves the last known list with its refresh time. A failed network request must not render “No problems.”

Summary tiles: active shortages, decisions waiting, uncertain actions, recoveries recorded. Delivery results and historical processing cost belong below the queue, with denominators and periods visible.

## 4. Case detail layout

### Header and summary

- Item/specification, location, related purchase orders, phase, severity, assignee.
- Plain-language impact sentence: “600 cartons are needed before the delayed shipment arrives; stock first runs short Wednesday at 9:00 AM.”
- Source dataset time and current assessment time.
- Primary next-action button derived from state and role.
- Secondary actions: pause/resume, reassign, export, close with reason.

Show a concise factual explanation, not hidden model reasoning. Example: “The supplier moved PO-1042 to Friday. Confirmed demand uses the remaining stock by Wednesday.”

### Impact panel

Display a dated table and simple stock line chart with on-hand stock, usable stock, receipts, demand, and projected balance. A table must provide the same information for accessibility.

Show the shortage quantity, first shortage, full planning horizon, original/revised receipt schedule, and affected customer/production references. Forecast demand is a separately labeled scenario, disabled by default.

Clicking a number opens its input records and source timestamps. Unknown or stale inputs have explicit labels and a refresh/review action.

### Options panel

One row/card per candidate plan:

- Supplier/location, exact item and specification status.
- Quantity and arrival schedule.
- Item cost, freight, nonrecoverable tax, fees, cancellation charges/credits, total cash outlay and net incremental cost.
- Quote validity and written-confirmation status.
- Treatment of the original order.
- Feasibility: feasible, incomplete, or rejected, with reasons.
- Evidence links and last verified time.

Place feasible options above incomplete and rejected ones. Keep rejected options inspectable to explain the decision. An unconfirmed cheap price cannot become the displayed best option.

### Activity and evidence panel

Chronological events grouped by business action: received delay, matched order, recalculated stock, request sent, call outcome, offer verified, approval, execution, receipt. Each event includes actor, timestamp, result, and source/action reference.

Email view includes sender, recipient, sent/received time, thread, and sanitized body. Quote evidence points to exact message passage or document page. Call view includes outcome, structured facts, transcript, and an audio link only when recorded and permitted. Provider trace links are accessible in a developer/evidence drawer rather than dominating the owner's main flow.

### Decision panel

Show a complete approval summary, all unresolved dependencies, expiry, and the exact additional commitment. Buttons: Approve this plan, Request changes, Reject. The owner must confirm after seeing the current version.

Material changes while the page is open invalidate the displayed action and show “This plan changed; review the updated terms.” Duplicate clicks disable locally and are deduplicated on the server. A slow request shows pending status and polls its action ID.

## 5. Reusable application components

| Component | Inputs | Required behavior |
| --- | --- | --- |
| WorkspaceShell | Verified membership and organization | Navigation, organization identity, environment label |
| CaseQueue / CaseCard | Server-filtered cases | Sort, pagination, accessible links, visible next action |
| ImpactSummary | Assessment version and input freshness | Explain shortage/unknowns; source-linked values |
| StockProjection | Dated projection points | Table plus chart; timezone and unit labels |
| EvidenceLink / EvidenceDrawer | Evidence ID, permission | Open the exact retained source; show missing/expired evidence honestly |
| SupplierOptionTable | Candidate plan versions | Compare constraints before cost; preserve rejected options |
| QuoteEditor | Extracted quote + source | Human correction with reason and validation; never overwrite source text |
| ActionTimeline | Audit/action events | Show intended, submitted, confirmed, failed, or uncertain status distinctly |
| CallBrief / CallResult | Authorized call job, result | Show goal, limits, state and outcomes; prevent another start while uncertain |
| ApprovalCard | Plan, approval eligibility, version | Full terms, expiry, owner-only action, stale-version handling |
| ReadinessPanel | Connection and data checks | Explain exactly which capability is ready or blocked |
| ImportPreview | Staged rows and errors | Row-level errors, atomic activation, previous dataset preserved |
| PolicyEditor | Versioned policy | Separate outreach, negotiation and commitment authority |
| RecoveryPacket | Plan and evidence | Downloadable, source-linked document/CSV with execution status |
| DemoScenarioRunner | Sandbox membership and fixture catalog | Reset only sandbox records; live dispatch disabled in replay |

Logical components may share files initially. Do not create a general component framework for one screen.

## 6. Forms and validation

Required fields are labeled; optional values remain null instead of zero. Quantity is an integer in the item's base unit. Monetary input follows the organization's currency precision and shows currency next to every amount. Date/time inputs display an explicit timezone.

A correction requires a reason and source reference. Approving a contact requires verified contact identity plus channel permission; approving a supplier for purchasing is a separate control.

Import flow: upload -> column/format preview -> row and cross-file validation -> activation summary -> atomic activation. Validation errors include filename, row number, field, reason and expected format. Do not partially activate a dataset.

Connection forms never echo stored secrets. Use masked status, reconnect, or replace controls. Owner configuration in the product does not expose developer environment variables.

## 7. State-to-next-action behavior

Exact state values are defined in chapter 03; the following are display mappings.

| Situation | User-facing next action |
| --- | --- |
| New / assessing | “Checking the impact” plus progress and last update |
| Needs review | “Match this message” or “Resolve missing information” |
| Recovering | Show research/contact activity and cancel/pause control |
| Awaiting supplier | Show who was contacted, when, expected reply and next follow-up |
| Awaiting approval | Owner sees approval; others see “Waiting for owner” |
| Executing | Show action in progress; no duplicate submit control |
| Unknown action result | “Check whether the update was applied”; read-only until reconciled |
| Monitoring | Show next delivery/check time and current coverage |
| Blocked by stale data | “Refresh business data”; show last usable snapshot |
| Paused | Reason, actor, resume; still ingest incoming evidence |
| Closed | Outcome and reason; preserve export and source access |

Do not turn provider errors into vague “Something went wrong” messages when a useful next action is known. Do not show API keys, SQL errors, internal stack traces, or provider request bodies to business users.

## 8. Accessibility and responsive behavior

- Target WCAG 2.2 AA interaction and contrast; status cannot depend on color alone.
- Every action is keyboard accessible with visible focus; dialogs trap/restore focus and have accessible names.
- Tables expose headings; charts have equivalent tables; badges contain text.
- Inputs have labels, field errors, and a focusable error summary.
- Use clear dates such as “Wed, Oct 14, 9:00 AM PDT” for deadlines.
- Desktop supports dense operational comparison. Mobile preserves impact, next action, approval terms, and evidence access without horizontal-only interactions.
- Announce meaningful async completion/failure accessibly without announcing every polling refresh.
- Avoid automatic audio playback. Confirmations and irreversible product actions must have descriptive labels.

## 9. Proposed visual direction

Use a restrained operations workspace: light neutral background, strong text hierarchy, compact tables, clear section boundaries, and one primary action per state. Red indicates a confirmed urgent risk; amber indicates uncertainty; green indicates verified success. Keep neutral “monitoring” distinct from “delivered.”

System fonts and CSS Modules are sufficient for B0. Brand design, animation, marketing pages, and a custom design system are not prerequisites. Choose detail that helps a buyer evaluate a recovery.

## 10. Acceptance

Every page must handle loading, empty, error, stale, unauthorized and success states. The primary journey must work with keyboard-only input and on a narrow viewport. Owner and operator see different action permissions while reading the same factual case. All controls must use the server contracts and state/version checks in chapter 04.

See [test matrix](06-delivery-and-verification.md) for concrete scenarios. No UI element may imply that a demo write, a verbal quote, or a completed call proves a real fulfilled order.
