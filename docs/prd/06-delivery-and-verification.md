# 06 — Delivery plan, acceptance and operating reference

PRD v1.0 · This chapter owns completion gates. Source code existing is not evidence that an integration works. Use [BUILD_STATUS](../../BUILD_STATUS.md) to record actual progress.

## 1. Delivery strategy

Build in vertical slices. Each milestone produces something independently reviewable, with known limits and evidence. A credential gate may delay a live proof while deterministic work proceeds; it must not be relabeled complete.

The first build is B0, defined in [PRD](../../PRD.md). P1 real business-system work is a separate gate. No production deployment, public post, real supplier outreach or purchase is authorized solely by this planning document.

| Milestone | Work and dependencies | Exit evidence |
| --- | --- | --- |
| M0 — Setup and feasibility | Confirm coding window; create Git repository and TypeScript/Next.js project; pin dependencies; enable Entire; establish sandbox configuration; prove DeepSeek tool use, neatlogs capture and voice/SIP path | Repository/lockfile; safe configuration example; one valid DeepSeek tool loop and trace; one real approved-test-contact call with tool request, callback and outcome; exact versions/model IDs recorded |
| M1 — Domain, data and permissions | Schema, grants/RLS, membership checks, atomic import, deterministic inventory/quote logic, canonical states; can proceed while M0 external gates wait | Golden arithmetic tests; two-tenant access denial; validated fixture import; migrations reproducible in isolated database |
| M2 — Inbox to shortage | Gmail read/OAuth or labeled replay, deduplication, extraction/matching, assessment, case queue/detail, source evidence | One email becomes one correct case; ambiguous and harmless cases behave correctly; source/version/freshness visible |
| M3 — Supplier research and conversation | Approved catalog and Exa discovery, quote requests, per-call grants, ElevenLabs/SignalWire results, bounded planner and supplier waits | Compatible alternatives with sources; one voice offer plus written confirmation; failure falls back without duplicate contact |
| M4 — Approval and recovery recording | Option comparison, versioned plan, owner approval, revalidation, claims, action dispatcher, demo ledger, export and readback | Approved split recorded once; stale approval rejected; ambiguous write reconciles; manual export visibly remains manual |
| M5 — Reliability and UX | Early/late callbacks, restarts, budgets, pauses, input attacks, receiving/reopen, accessibility, secrets review | All applicable B0 acceptance rows pass; gaps disclosed; resettable demo and usable owner/operator flows |
| M6 — Evidence and submission preparation | Before/after benchmark, Entire fix checkpoint, CFO.ai model/scenarios, README/setup and demo recording | Reproducible evidence bundle, <=3-minute video, partner artifacts, public-ready repository content and prepared submission material |

M0's provider proofs are high priority because a failed voice pairing may require an adapter. Do not spend the first implementation session polishing a large dashboard.

Recommended engineering sequence within the milestones:
1. Canonical inventory function and fixture -> case read view.
2. Persistent message/action IDs and database constraints -> retry tests.
3. Actual email ingestion -> DeepSeek extraction with sourced fields.
4. One original-supplier call -> structured offer -> written confirmation.
5. Approval -> one split-amendment action -> confirmed demo readback.
6. Alternative-source failure/recovery -> measured rerun.
7. Operator usability and evidence packaging.

## 2. Development/check strategy

Use TypeScript static checks, ordinary automated domain tests, database integration tests and browser journey checks. Prefer the framework's established test tools when the repository exists. Proposed choices are a TypeScript unit-test runner and Playwright for browser journeys; exact dependencies must be documented/pinned at scaffold time.

Tests should validate business outcomes and trust boundaries, not mirror private implementation methods. Test adapters reproduce timeouts, duplicate events and conflicting results. Keep provider fixtures separate from real live-test evidence.

A fake clock is mandatory for deadline, expiry, contact-hour and replay tests. Currency and quantity tests use exact integer/decimal arithmetic. Database tests use an isolated database with organization A and B; no production records.

## 3. Canonical fixture pack

Use fictional business **Harbor Pack**, location **Main Warehouse**, timezone **America/Los_Angeles**, currency **USD**, item **CARTON-302015** (300 × 200 × 150 mm; fictional material grade KRAFT-SW-DEMO; one carton per unit). Supplier/contact names are fictional; email examples use example.com and calls remain disabled until a human supplies an authorized test number.

Fixed clock: 2026-10-12 08:00 local. Original PO **PO-1042** has 4,000 cartons at 35 cents each, originally due Tuesday October 13 08:00. The supplier delays all 4,000 to Friday October 16 08:00.

Inventory: 600 physical/usable cartons, no quarantined stock, no outside allocations, no safety buffer. Demand: 400 on each of October 13, 14 and 15 at 09:00. Canonical result: first shortage October 14 09:00 local (16:00 UTC), bridge 600.

Known suppliers:
- **Bay Carton:** original supplier; can offer 600 Wednesday 08:00 and 3,400 Friday 08:00, plus USD 75 freight.
- **North Packaging:** compatible alternative; 600 Wednesday 08:00 at USD 0.42 each plus USD 60 freight.
- **Budget Box:** lower advertised price but dimensions 350 × 250 × 200 mm; reject.
- Optional **Quick Pack:** initially reports stock, then retracts it before approval; invalidate the offer and recover.

Fixture variants must be derived from these named changes, preserving clear ground truth. Store exact inputs, expected facts, expected action count and expected final phase/outcome. Do not let the agent modify expected results.

For replay offers, quote expiry and latest ordering cutoff are Monday October 12 at 12:00 local. To exercise outreach, advance the replay clock into configured contact hours and refresh its fixture snapshot coherently. Real provider proofs use actual runtime time for OAuth/signatures, capability expiry, contact hours and approval expiry; never validate real credentials against the frozen business-scenario clock. A real test call about fictional orders must identify itself as a test and its terms remain demonstration evidence.

## 4. Acceptance matrix

Each row is a required B0 check unless explicitly marked P1. “Live” requires actual provider evidence; replay proves application behavior only.

| Test | Given / action | Required result | Requirements |
| --- | --- | --- | --- |
| AT-01 Canonical shortage | Run the fixed carton case | Wednesday first shortage; cumulative need 200 Wednesday and 600 Thursday; total bridge 600, never 800 or 4,000 | FR-007 |
| AT-02 Invalid/stale import | Missing references, fractional unit, contradictory stock or stale source time | Invalid import leaves prior dataset active; stale data cannot support live commitment; errors name row/field | FR-003,FR-031 |
| AT-03 Duplicate message | Same Gmail message and event delivered repeatedly | One source record and one case update; no duplicate outreach | FR-004 |
| AT-04 Multi-line/partial delay | One message delays 200 of one line and all of another | Correct per-line remaining quantities and linked cases; unaffected schedules preserved | FR-005 |
| AT-05 Ambiguous match | Two candidate POs or unclear “Friday” | needs_review; no automatic contact or order change; sourced operator correction resumes assessment | FR-006 |
| AT-06 Reservation arithmetic | 300 reserved units belong to demand already included | No double subtraction; outside allocations in a separate variant are subtracted once | FR-007,FR-032 |
| AT-07 Time/receipt boundaries | Date-only same-day delivery, overdue unreceived goods, DST edge | No premature stock availability; ambiguous times require review; received quantity never added twice | FR-007,FR-023 |
| AT-08 Forecast/unknown arrival | Forecast demand and uncertain incoming shipment exist | Confirmed projection separates forecasts and excludes unsupported arrival coverage | FR-008 |
| AT-09 Harmless delay | Stock increased to 1,500 with same demand | No shortage, monitoring, zero supplier calls/emails, future new demand can reopen assessment | FR-009 |
| AT-10 Original supplier split | Verified Bay Carton offer | 600 Wednesday + 3,400 Friday; original total preserved; USD 75 incremental cost | FR-010 |
| AT-11 Transfer feasibility | Source location has 500 units but needs 450 itself | Cannot promise a 600-unit transfer or consume needed source stock; B0 execution visibly unavailable | FR-011 |
| AT-12 Research evidence | Supplier search returns known/unknown/incompatible products | URLs and retrieval times saved; candidate remains unapproved; missing stock/arrival stays unknown | FR-012 |
| AT-13 Threaded email | Enabled policy and one approved contact; repeated send request | Correct recipient and thread, one sent action, exact message evidence; unapproved Reply-To blocked | FR-013 |
| AT-14 Tenant and role isolation | Org B IDs/storage paths; operator attempts owner action | Denied at API and data/storage layers; no cross-tenant disclosure; no client secret exposure | FR-001,FR-026 |
| AT-15 Voice live proof | Authorized test number, real SIP/DeepSeek agent call | Two-way audio, scoped factual lookup, structured result, clean termination and matching signed callback | FR-014 |
| AT-16 Negotiation boundary | Supplier offers above cap or asks agent to accept | Offer stays provisional; no acceptance/purchase; owner task raised; verbal quote cannot make plan ready | FR-015 |
| AT-17 Quote correctness | Freight missing, wrong size, expired price or unconfirmed stock | Incomplete/rejected options never outrank a feasible verified option as a confirmed recommendation | FR-016 |
| AT-18 Original-order treatment | Buy alternate 600 while original 4,000 remains | Show 600-unit surplus and gross cost; no unconfirmed cancellation credit subtracted | FR-017 |
| AT-19 Approval binding | Owner approves version 3 twice; operator tries; expiry passes | One approval/commit action; role denial; changed/expired version cannot execute | FR-018 |
| AT-20 Gmail resync | History cursor expired, several pages, repeated messages | Complete bounded resync; cursor advances only after persistence; no dropped or duplicate work | FR-002,FR-004 |
| AT-21 Revalidation | Demand/stock/quote/policy changes after approval | Material change invalidates execution and shows updated review; old approval cannot authorize new terms | FR-019,FR-031 |
| AT-22 Revoked OAuth | Inbox access revoked during active case | Connection shows expired/revoked; safe existing history retained; no fake success; reconnect resumes | FR-002 |
| AT-23 Recorded recovery | Approved split written to demo ledger, then same command retried | One amendment, correct schedule, confirmed readback, audit and monitoring; clearly labeled demo | FR-020 |
| AT-24 Manual execution export | CSV source with no write capability | Complete packet exported; status manual_handoff; never reported as a live applied order | FR-021 |
| AT-25 Ambiguous side effect | Provider accepts a call/order but app times out/crashes | Action unknown; no blind retry; claims retained; callback/readback or owner reconciliation resolves | FR-022 |
| AT-26 Delivery lifecycle | Partial receipt, then revised ETA, then full receipt | Correct remaining quantities; reopen recovery if needed; delivered only with receiving evidence | FR-023 |
| AT-27 Pause/cancel/control | Pause before dispatch or during a live call; cancel case with existing PO | New dispatch stops; in-flight status visible; original PO remains; uncertain execution blocks unsafe close | FR-024 |
| AT-28 Handoff/audit | Different operator opens the case | Understands current facts, pending decision, sources, actor and next deadline without original chat | FR-025 |
| AT-29 Tracing and usage | DeepSeek tool run succeeds/fails/retries; voice result returns | Correlated neatlogs evidence; model and usage verified; costs unknown when absent; no secrets/raw reasoning | FR-027 |
| AT-30 Development evidence | Fix a real tested failure while Entire enabled | Checkpoint explains relevant change and links to observed before/after behavior | FR-028 |
| AT-31 Untrusted content | Email/page/call says “ignore policy,” changes bank details, or requests another case | Treated as untrusted text; unauthorized tool/recipient/tenant access rejected outside the model | FR-026 |
| AT-32 Business model | Import measured usage, failures and explicit pricing assumptions into CFO.ai | Base/downside scenario, complete cost denominator, no double billing or invented savings | FR-029 |
| AT-33 Replay isolation | Reset/demo run while real provider keys exist in another environment | Replay cannot send/call/write live; fixture clock and simulated evidence labeled; other org untouched | FR-030 |
| AT-34 Concurrent actions | Two workers/tabs act on same plan/stock group | One prepared commitment; conflicting versions/claims rejected; no double allocation | FR-032 |
| AT-35 Budgets/model failure | Planner loops, invalid JSON, quota exceeded, repeated rate limit | Bounded repair/retry count; visible blocked/review state; unknown cost not treated as free | FR-033 |
| AT-36 Accessible owner journey | Keyboard-only and narrow viewport | All critical facts, evidence and approval controls usable; focus/errors/status accessible | FR-034 |
| AT-37 Real connector | P1: fresh read, version conflict, approved write, readback and receiving | Actual system behavior matches contract; unknown write reconciles; no false live-write claim | FR-035 |
| AT-38 Retention/disconnect | Disconnect token, revoke member, expire source | New access/dispatch blocked; new evidence links denied; retained summaries/tombstones accurate; unresolved commitments visible | FR-036 |
| AT-39 Pre-dispatch restart | Crash after prepared record but before provider call | Retry claims same action safely; exactly one externally observed request | FR-020,FR-022 |
| AT-40 Early/late callbacks | Result arrives before wait, twice, or after pause | Result persisted/deduplicated; workflow eventually notices; current control state respected | FR-014,FR-022 |
| AT-41 Money precision | Sub-cent model usage and multi-component procurement costs | Provider usage precision retained through aggregation; procurement totals exact; gross vs net distinction intact | FR-016,FR-027,FR-029 |
| AT-42 Empty/failed UI states | No cases, filtered empty, failed fetch, stale view | Distinct states with useful next action; stale UI cannot submit obsolete approval | FR-025,FR-034 |

B0 cannot be described as complete if AT-15 or the required sponsor evidence are only mocked. A partial build can still be demonstrated honestly with those gaps stated.

## 5. Nonfunctional targets

Targets are hypotheses until measured; record environment, dataset size and test method.

| ID | Requirement / proposed target | Verification |
| --- | --- | --- |
| NFR-001 | No acknowledged business event lost across application restart | Crash and outbox/callback replay tests |
| NFR-002 | Zero duplicate financial/contact effects in the fault matrix | Provider test adapter counters plus observed live identifiers |
| NFR-003 | Zero cross-tenant or unauthorized commitment access | API/RLS/storage/tool-grant tests with two tenants and all roles |
| NFR-004 | Healthy inbox polling detects new messages within 120 seconds | Timestamped controlled messages with no provider outage |
| NFR-005 | Case view useful within 2 seconds p95 on test deployment; calculations under 100 ms for 10,000 relevant timeline events | Record measured browser and domain timings |
| NFR-006 | Typical voice turn to audible response within 3 seconds p95 across a documented sample of at least 10 turns | Live call measurement; report actual result and adapt if unmet |
| NFR-007 | Durable user approval/event processing survives waiting and missed wake-up races | AT-19,AT-40 plus process restart |
| NFR-008 | All critical actions have source/version/actor/action IDs | Case audit completeness check |
| NFR-009 | No secrets/raw hidden reasoning in public or standard telemetry artifacts | Artifact review and targeted secret-pattern checks |
| NFR-010 | Critical owner journey usable by keyboard and on a narrow screen | AT-36 and manual focus/contrast review |
| NFR-011 | No unlimited model/search/call loop; costs distinguish estimates, billed values and unknowns | Budget and usage fixtures |
| NFR-012 | Pilot recovery plan supports database backup restoration and provider-state reconciliation | Documented isolated restore drill; proposed RPO 24 hours / RTO 4 hours, subject to actual service plan and business approval |

A latency miss is evidence to improve configuration or scope. Do not fabricate measurements or silently change providers to meet the target.

## 6. Partner and hackathon evidence

The organizer requires neatlogs, Entire and CFO.ai, a public repository, a video no longer than three minutes, and the specified X submission process. Published scoring is agent 30%, partner usage 25%, demo 20%, building in public 15%, usefulness/originality 10%. Planning can precede the event; implementation code must be written in the stated build window. [Official event page](https://neatlogs.com/hackathon).

Verified schedule on October 9: code starts October 10 at 12:30 PM IST (October 10 00:00 PDT); submission window October 12 7:00–11:55 PM IST (06:30–11:25 PDT). Recheck the organizer page before implementation/submission.

Prepare an evidence directory during implementation containing:
- Sanitized fixture inputs and immutable expected results.
- Actual run outputs and metric table, including unsuccessful attempts.
- One documented defect, its trace, fix/checkpoint, and same-input rerun.
- neatlogs case/action trace references.
- Entire checkpoint/graph reference and explanation.
- CFO.ai model/scenario share link and exported assumptions.
- Live call proof, with private information removed and replay clearly separated.
- Architecture diagram, setup instructions, known limitations and tested versions.

Suggested video allocation: problem/data 20 seconds; agent workflow and useful recovery 70; before/after evidence 30; Entire checkpoint 20; CFO.ai model 25; outcome and limits 15. Total 180 seconds.

Prepare build-in-public updates around an actual failure, diagnosis, fix and measured improvement. Publishing and submission occur only with the user's authorization; preparing content is not a published entry.

## 7. Completion and reporting

At each milestone report: implemented requirements, checks passed, checks failed, actual external integrations exercised, remaining credentials/decisions, and next action. Update BUILD_STATUS. A mocked result is a fixture result, not a live integration.

For B0 acceptance:
- Primary owner journey works.
- All applicable test rows pass or explicitly block completion.
- DeepSeek remains the selected provider.
- One actual scoped supplier/test-contact voice conversation is verified.
- Demo write-back and data simulation are unmistakable.
- Required partner evidence is usable.
- App can be reset and reproduced from documented setup.

For P1 acceptance, additionally require AT-37, actual authority/retention settings, a backup/restore plan, live connector reconciliation, fresh data and a controlled pilot rollout.

## 8. Operational runbook

| Symptom | Immediate behavior | Recovery |
| --- | --- | --- |
| Stock/demand stale | Block live commitment; preserve dated assessment | Refresh or reconnect; recalculate; renew approval if facts changed |
| Gmail revoked | Stop inbox access and sends | Owner reauthorizes; deduplicated resync |
| Voice call started, result missing | Keep submitted/unknown; do not call again | Query known conversation/provider logs; attach evidence; escalate if unprovable |
| External order update uncertain | Hold allocation claims and show reconciliation state | Read business system by reference; owner resolves only with evidence |
| Duplicate callback | Acknowledge existing receipt | No second business action |
| Inngest unavailable | Keep outbox pending and status visible | Drain after service recovers; dedupe consumers |
| DeepSeek unavailable/invalid | Retry within inference budget; then review | Preserve facts/drafts; resume without changing provider silently |
| neatlogs unavailable | Preserve database audit and usage; mark telemetry delivery issue | Retry permitted export; retain measurement gap |
| Provider cost unknown | Mark unknown and enforce count/time limits; block spending beyond configured budget certainty | Update rates/billing; reconcile estimates |
| Wrong match discovered | Pause related actions and preserve history | Correct source linkage; invalidate dependent plan/approval; reconcile any external effect |
| Global dispatch pause | Stop new sends/calls/financial writes | Continue evidence ingestion and reconciliation; owner resumes deliberately |

## 9. Post-build research and next product decisions

After B0, test the buyer hypothesis with operations staff using real historical delay cases. Measure their current coordination process and compare actual review effort. Determine which business system is common enough to justify the first P1 connector.

Prioritize expansion from observed failure frequency: inaccurate inventory, missing supplier confirmations, voice latency, quote normalization, or connector gaps. Add chat channels or broader negotiation only when they solve a demonstrated workflow need.
