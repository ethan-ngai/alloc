# Delivery and validation

## Implementation stages and mandatory acceptance gates

Design is settled. This repository handoff enables task-based implementation by collaborators; claim work through the [issue map](13-issue-map.md). The Mac can verify domain logic, MongoDB transactions, HTTP contracts, and recovery. Model execution and GB10 capacity have separate gates. Never present a stubbed model test as passing the actual Qwen3.8 27B integration gate.

Every stage ships its tests with its implementation. Fix upstream failures before accepting dependent live integration. Independent consumers may be built and tested against versioned contract fixtures while the provider is in progress. Re-run relevant earlier checks when a shared contract changes, and run the accumulated local suite before handing off a milestone. Stage E2E means the complete currently available boundary; it does not require waiting for the final dashboard.

The stage numbers group responsibilities; they do not mandate a serial waterfall. [Parallel workstreams](12-parallel-workstreams.md) gives the executable task IDs (1A, 2B, 8A, etc.), start dependencies, live integration dependencies, and individual verification gates. That map is authoritative for sequencing; the table below describes each group's overall acceptance criteria.

| Stage | Build | Focused verification | Integration tests | Stage E2E / exit gate |
| --- | --- | --- | --- | --- |
| 1. Local foundation | TypeScript API, MongoDB replica set, config, auth, health, isolation | Typecheck, startup validation, redacted errors, strict input validation | Real MongoDB commit/abort, indexes, startup on replica set; reject unauthenticated calls | Start actual HTTP server and call health/authenticated company endpoint; restart API against persisted data |
| 2. Company data | Three profiles, finance categories, source records, JSON/CSV imports, mappings | Money/date/category validation, deterministic fixture identities, provenance | Import into real MongoDB; reject invalid batches; replay duplicates; tenant separation | Seed each company, import a file through HTTP, retrieve its facts and updated balances; repeat import without duplicates |
| 3. Financial core | Requests, amendments, caps, review, policy revisions, audit and action intents | Rule table: amounts, cumulative amendments, roles, invalid inputs, stale revisions | Parallel approvals on shared caps, rollback on failure, idempotency payload conflicts, posting reconciliation | Through HTTP: $180 request → +$30 approval → another +$30 review → authorized human decision → posting; inspect audit and exact exposure |
| 4. Context | Typed relationships, scoped retrieval, freshness, evidence packets, summaries | Missing/ambiguous IDs, traversal bounds, source versions, category/location overlap | Indexed queries across companies; graph endpoint authorization; summary invalidation; access revocation | Ask for food/software/site context with no project; retrieve cited evidence and current cap; prove another tenant's IDs return no data |
| 5. Durable runtime | Three priorities, leases, checkpoints, coalescing, simulated action delivery | Priority ordering, retry classification, cancellation and expiry | Multiple workers, stale-lease fencing, crash recovery, duplicate dispatch, final-generation preservation | Restart during approval delivery and a forecast job; resume once; show urgent work precedes pending background work |
| 6. Local agent | OpenClaw, Qwen3.8 27B endpoint, scoped tools, bounded subagents | Tool schema and authorization tests with hostile proposals; output evidence validation | Real OpenClaw→local model→backend call; propagate child authority and global inference priority | Real agent investigates fixture evidence; injected instructions cannot bypass caps; run urgent request during child work; retain traces |
| 7. Forecasts | Exact baseline, commitments, source cutoffs, scenarios, explanations | Known numeric fixtures, recurring-obligation overlap, late data, currencies, sensitivity labels | Financial events update affected snapshots; coalesced runs include final inputs | Approval and posting each update forecast without doubled exposure; corrected source creates a traceable revised snapshot |
| 8. Dashboard and demo | Company switch, requests, reviews, observability, replay controls | UI states, keyboard access, validation, responsive layout | Browser↔API errors/auth, SSE or polling, stale data, worker status | Browser tests run each company's complete story against real API/MongoDB; cold start and outage/recovery rehearsal |
| 9. GB10 release | Pinned runtime/model, local assets, memory and latency limits | Exact artifact sizes, quantization, process limits, no hosted fallback | Repeat accumulated backend/agent suites on GB10; benchmark model alongside database | Cold boot without internet; full demo plus concurrent urgent request; record peak memory and latency distributions |

### Test evidence and failure handling

- Financial integration tests use an isolated real replica set, not an in-memory MongoDB substitute. Each test owns its fixtures and cleanup target.
- HTTP E2E uses a listening server and real requests. Later browser E2E adds the UI to this chain; direct handler injection alone is not labeled full HTTP E2E.
- Failure-path tests include concurrent requests, retries, stale policy/request versions, cross-company IDs, invalid imports, denied authority, and malformed/hostile agent outputs at the stage introducing that contract.
- CI/local commands report skipped or unavailable external/model checks explicitly. An unavailable Qwen3.8 27B artifact or GB10 must not silently count as a pass.
- Capture the seed, software versions, failed boundary, and reproducible command. Extend the regression suite when a defect changes the contract; do not defer upstream defects to the final demo rehearsal.
- Status is recorded in [implementation progress](11-implementation-progress.md), including what was actually run and what remains unimplemented.

## Runtime gates

| Gate | Required evidence | Fallback or response |
| --- | --- | --- |
| MongoDB on GB10 | Compatible build starts, data persists, multi-document transaction commits and aborts correctly | Resolve supported local build before financial implementation |
| Local inference | Model loads within available memory and completes a structured tool workflow | Benchmark another available local model/server |
| OpenClaw integration | Worker can submit/observe a bounded task and authenticate its tools | Use a documented supported adapter; do not invent transport behavior |
| Local semantic search | Correct package/platform support, local embedding generation, working filtered retrieval | Ship indexed scope and lexical retrieval; label semantic retrieval unavailable |
| Priority behavior | Urgent requests remain responsive while background inference is active | Reduce background call budget, use verified cancellation/concurrency, or revise targets |
| Subagent control | Child identity reaches tool authorization and global inference admission; children cannot spawn recursively or widen scope | Keep specialist workflows as sequential worker-managed tasks |
| Live connectors | Event permits access and an actual account/sandbox is available | Complete offline replay and file-import path |

Choose and pin exact versions only after testing the supplied machine. Keep model weights, required packages/images, and fixture data available locally so the demo does not depend on venue downloads.

## Financial correctness acceptance

- A permitted first $30 increase succeeds; a repeated increase crossing a cumulative rule does not.
- Two competing approvals cannot consume the same remaining budget capacity.
- All binding project/department budget constraints are checked atomically.
- A matched posting replaces outstanding exposure without doubling recognized cost.
- An unmatched observed charge is retained even when it reveals overspending.
- Retrying the same command cannot create another approval or provider operation.
- A changed policy, request, or approver authority invalidates stale authorization.
- An ambiguous provider timeout remains unresolved until reconciled; funds are not incorrectly released.

## Context and security acceptance

- Resolve known project/person/vendor IDs across different source adapters.
- Retrieve all mandatory policy and financial fields for a known decision case.
- Return bounded relevant evidence across a large generated project corpus, with truncation visible.
- Neither graph traversal, document search, summary reuse, cache access, nor direct tool IDs reveal unauthorized scope data.
- A source edit invalidates dependent summaries, and historical decisions retain their original evidence versions.
- Malicious source text cannot modify policy, forge an approval grant, call unrestricted tools, or select an unapproved outbound destination.
- A compromised or steered model still cannot execute outside the deterministic permission envelope.

## Recovery acceptance

Restart the worker during investigation, after database approval but before dispatch, and after provider success before receipt persistence. Verify lease fencing, job recovery, idempotency, and reconciliation in each case. Repeat with duplicate/out-of-order source events and a missing connector.

Demonstrate that background forecasting yields between steps when an urgent request arrives. Measure model occupancy separately from job waiting time to identify whether the bottleneck is the scheduler or inference runtime.

## Performance evidence

Record p50/p95 retrieval and request latency, database records examined, context token counts, active model duration, backlog age by priority, and projection freshness. Use at least two fixture scales, including one with many more projects than Northstar's demo. Set acceptance targets after the first GB10 baseline; no unmeasured millisecond or scalability promises are part of this architecture.

## Intentionally deferred

Production payment execution, production high availability, arbitrary policy compilation from prose, autonomous policy activation, model training, comprehensive accounting, and a broad suite of SaaS connectors are outside the initial demo. The architecture defines extension points without claiming those integrations or controls already exist.

## Documentation verification

For this planning deliverable, verify internal links, consistent terminology, and whitespace. Backend tests belong to implementation; documentation checks do not establish runtime correctness.
