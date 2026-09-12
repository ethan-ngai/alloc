# MongoDB records and consistency

## Collection ownership

Collection names below are proposed domain boundaries, not implemented schemas.

| Collections | Contents | Writer |
| --- | --- | --- |
| `source_events`, `source_objects`, `connector_cursors` | Immutable deliveries, source revisions, ingestion progress | Ingestion service |
| `entities`, `entity_mappings`, `relationships` | Canonical IDs, verified links, effective periods | Validated normalization and administration |
| `evidence_chunks`, `claims`, `scope_summaries` | Searchable evidence and versioned narrative context | Context workers; claims remain non-authoritative |
| `requests`, `policies`, `approval_grants` | Purchase revisions, active rules, human authorization | Financial core and authenticated administrators |
| `budget_accounts`, `commitments`, `financial_entries` | Budget capacity, outstanding exposure, financial movements | Financial core |
| `decisions`, `action_outbox`, `action_receipts` | Evaluations, intended side effects, actual outcomes | Financial core and executor |
| `jobs`, `projection_state`, `metric_buckets` | Durable work, progress, numerical read models | Scheduler and projection workers |
| `forecast_runs`, `scenario_runs` | Immutable calculated forecasts and assumptions | Forecast service |

Every domain key and unique constraint includes organization identity. Connector identity distinguishes two imports or accounts using the same upstream ID. Apply schema validation for required money fields, state enums, revisions, and scope identifiers.

Extend these collections with domain records for receivables, payables, customer/revenue schedules, cash/bank balances, payroll obligations, assets, inventory, liabilities, and tax obligations. Memory coverage is broad even when the first action workflow supports only spending approvals. Restricted domains retain field/scope access controls. See [company-wide financial memory](10-company-wide-memory.md).

## Money and budget semantics

For the demo, use USD minor units as integers with checked arithmetic and storage. In TypeScript, use a safe integer range guard or a BigInt-backed money type; serialize large values as decimal strings where necessary. Never use binary floating-point dollars for financial arithmetic. Reject unsupported currencies rather than implicitly summing them.

The initial budget identity is:

`available = authorized budget - recognized spend - outstanding commitments`

Hard-cap accounts can bind any governed dimension: organization, category, location, employee, vendor, or project. Resolve applicable accounts server-side and update every binding cap in one transaction. A cap below already-incurred exposure blocks new approvals and reports the breach; it does not erase existing spend. Category/location clusters may overlap, so company totals aggregate canonical entries once rather than summing all clusters. The POC reproduces both a naive concurrency overspend and overlapping-cluster double-counting and verifies the corrected transaction/aggregation paths.

Recognized spend here is the demo's operational spending measure, not a claim of a complete general ledger. Track source status explicitly: requested, authorized, posted, refunded, or canceled. Cash forecasting and accrual accounting require separate timing semantics.

A posted charge matched to a commitment increases recognized spend and decreases the matched outstanding commitment in the same transaction. An unmatched charge still increases recognized spend and is surfaced for reconciliation. Refunds create correcting entries and follow explicit capacity-release rules. An observed overspend is recorded even when it makes availability negative; prevention rules govern new actions, not whether inconvenient source facts may be stored.

An amendment from $180 to $210 reserves an additional $30 but evaluates approval rules against the full $210 and relevant cumulative totals. Hierarchical budget checks update every binding account in a stable order within the transaction. Financial allocation across scopes is explicit, so the same cost is not accidentally multiplied in company totals.

## Ingestion and projections

1. Validate the transport and source envelope; durably record the delivery before acknowledging it.
2. Deduplicate by source delivery identity; normalize source object revisions separately so new edits to the same issue are not discarded.
3. Resolve canonical IDs, quarantine invalid or ambiguous records, and apply only permitted domain changes.
4. Record downstream work transactionally with those changes. Persist the connector cursor only after its batch is durably handled.
5. Project aggregates and summaries asynchronously. Financial authorization reads transactional financial state, never a lagging metric bucket.

Store both event time and ingestion time. Source revisions or connector ordering rules decide which state is newer; arrival order alone does not. Maintain tombstones for deletions and invalidate derived evidence. Preserve financial audit entries subject to an explicit retention policy.

Use durable MongoDB jobs/outbox records as the recovery source. Change streams may wake workers later, but a lost wake-up must not lose work.

## Concurrent approvals

Reading a balance and later decrementing it is insufficient. An approval transaction reads the active policy and relevant request, then conditionally updates budget capacity, request revision, commitments, decision, and outbox intent.

All competing approvals write the shared budget-account documents. Conflicts cause bounded retries against current state. The transaction validates the proposed amount, expected request version, cumulative limits, and current authority. A unique command key prevents a client retry from committing a second increase.

Policy changes and authority revocations also need conflict detection. Each policy scope has a guard document containing its active version and authorization epoch. Financial mutations conditionally update that guard as part of their transaction; policy/authority administration updates the same guard. This serializes conflicting changes rather than relying on an earlier read of an unchanged policy document. Scope the guard to the relevant policy domain to avoid an unnecessary company-wide bottleneck.

MongoDB supports single-document conditional atomic writes and multi-document transactions on replica sets. Run the demo database as a local single-member replica set; this enables the required transaction behavior without implying failover capability. [MongoDB atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [transaction deployment requirements](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)

## External side effects

A database transaction cannot atomically commit an operation in a card or procurement provider. Persist an outbox intent alongside the financial reservation, then let the executor deliver it with an idempotency key.

On a network timeout after sending, mark the action `outcome_unknown`. Look up the provider's receipt or reconcile its current state. Do not blindly retry a non-idempotent action or release its reservation. When the provider lacks a reliable idempotency/status contract, require manual reconciliation.

Revalidate before dispatch. Already-dispatched actions are a separate state: subsequent revocation cannot guarantee recall of a remote request. The default demo executor is a local simulated provider with an explicit idempotency contract and controllable failure modes.

## Essential indexes

- Unique source delivery: organization, connector instance, delivery ID.
- Unique source mapping: organization, connector instance, source type, source object ID.
- Unique mutation command: organization, command ID; reject reuse with a different payload hash.
- Unique executor receipt: organization, provider instance, provider operation ID.
- Request lookup: organization, request ID, revision/state as appropriate.
- Financial history: organization, budget account or project, effective date, stable ID.
- Job admission/claim: state, priority class, eligibility time, creation order, with a separate lease-expiry index.

Verify actual access paths with representative queries and `explain`; avoid creating every conceivable index. MongoDB index design depends on equality, sort, and range predicates. [Indexing strategies](https://www.mongodb.com/docs/manual/applications/indexes/)
