# Company-wide financial memory

## Coverage

Memory represents the whole company's financial state. Projects are one optional lens alongside category, vendor, department, location, legal entity, employee, customer, asset, contract, and time. The agent must be able to start at “food costs” or “software obligations” without resolving a project first.

| Financial domain | Canonical records | Example relationships/questions |
| --- | --- | --- |
| Food and employee expenses | Purchases, reimbursements, meal allowances | Category → employee/location/vendor; cumulative allowance |
| Facilities and physical assets | Rent, utilities, assets, depreciation schedules, maintenance | Site → lease/equipment → obligations and costs |
| Software, cloud, and AI | Subscriptions, seats, contracts, metering, renewals | Vendor → contract → departments, usage, commitments |
| Labor | Restricted payroll totals, contractor obligations, benefits | Department/location → labor obligations; visibility controlled |
| Procurement and inventory | Orders, receipts, stock movements, vendor invoices | Material → supplier → delivery → payable |
| Cash and liabilities | Bank observations, loans, repayment schedules | Account/legal entity → liquidity and obligations |
| Revenue and receivables | Customer contracts, invoices, collections, recognition schedules | Customer → receivable → expected/actual cash |
| Taxes and insurance | Obligations, filing periods, coverage, premiums | Legal entity/location → due dates and reserves |
| Governance | Budgets, hard caps, policy versions, approvals, outcomes | Any governed dimension → applicable authority and constraints |

This is the target memory schema coverage, not a claim that the POC implements accounting, payroll, tax calculation, or each connector. Preserve source semantics and timestamps rather than inferring a full general ledger from expense records.

## Clusters are overlapping views

A restaurant refrigerator can belong to equipment, a physical location, a vendor, an asset register, and a financing agreement. Store one canonical financial movement and link those dimensions. Category totals and location totals are alternative views of the same expense; adding both doubles it.

Use a governed category taxonomy for reporting and caps. Semantic clusters can discover related evidence but cannot redefine accounting categories or approval scope. Split allocations explicitly within a dimension and validate allocation totals. Company-wide totals derive from canonical movements once, with currencies and financial measure kept distinct.

## Memory updates and enforcement

On an authorized purchase, the backend atomically writes its commitment, every applicable cap account, decision, outbox intent, and versions. This immediately updates exact financial memory. Narrative briefs, semantic indexes, and trend summaries refresh asynchronously and expose their source version/watermark.

A posted transaction reconciles an existing commitment or records new spend. A refund/correction adds a traceable adjustment. An external overspend is recorded and flagged even if it breaches a cap; hard caps prevent new Alloc-authorized exposure, not activity that occurs outside Alloc's control.

Never ask the model whether a remembered balance is still correct at execution time. Query and conditionally update current authoritative accounts inside the transaction. A stale summary may explain history but cannot authorize spending.

## POC evidence and resulting changes

The local MongoDB experiment used 36,000 records across software, restaurant, and manufacturing companies. Non-project food retrieval returned eight records after examining eight documents per company. It verified category and company hard caps under concurrent requests, idempotent commands, and commitment-to-spend reconciliation.

Two negative controls exposed unsafe alternatives: check-then-write doubled a $300 cap, and summing category/location facets doubled company spend. The architecture therefore requires transactional cap updates and canonical-entry aggregation. Full graph traversal, semantic recall, all-domain connectors, and large-scale throughput remain untested. See [experiment results](../../experiments/finance-poc/README.md).
