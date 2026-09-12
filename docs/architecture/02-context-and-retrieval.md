# Internal context and efficient retrieval

## Decision: a graph within MongoDB, with several retrieval paths

Use typed entity and relationship records to model company structure and operational connections. Keep exact financial records separately queryable. Add versioned summaries for broad questions and document search for supporting narrative evidence.

Projects are optional. Equally valid entry points include food, facilities, software, vendors, bank accounts, customers, inventory, payroll, taxes, and physical assets. [Company-wide memory](10-company-wide-memory.md) defines the financial domains and overlapping analytical dimensions. Category/location/vendor clusters are views over canonical records, not independent copies of spend that can be added together.

A graph answers which project, vendor, trip, repository, and budget are connected. Financial queries answer how much is committed or spent. Document search answers what a policy, issue, or project brief says. Each serves a different question; a graph alone would still require processing excessive data for company-wide totals.

## The context layers

| Layer | Examples | Update mechanism |
| --- | --- | --- |
| Source evidence | Import row, GitHub issue revision, invoice text | Ingest a new immutable revision |
| Canonical entities | Employee, department, project, vendor, repository, trip | Validated source mappings and explicit ownership rules |
| Relationships | Employee assigned to project; repo implements project; spend allocated to project | Verified mappings or separately stored candidate assertions |
| Exact financial state | Posted spend, commitments, policy rules, budget capacity | Deterministic application transactions |
| Scope views | Project burn, department trend, quarterly totals | Incremental projection with source watermarks |
| Narrative memory | Project brief, prior decision explanation, trend hypothesis | Versioned summary or claim linked to evidence |

Each evidence record includes organization, source instance, source object ID, revision, event time, ingestion time, data classification, and access scope. A synthetic-data flag is independent of trust: a simulator can supply authoritative facts inside its isolated fictional organization, while those records have no authority over a real organization.

## Relationships and entity resolution

Representative graph:

```text
Maya Chen ──assigned_to──> Project Beacon ──owned_by──> Field Engineering
                              │
                              ├──implemented_by──> field-agent repository
                              ├──funded_by──> Beacon Q3 budget
                              ├──has_trip──> Buffalo pilot visit
                              └──uses_vendor──> GPU compute supplier
```

Use stable IDs and a mapping table keyed by organization, connector instance, source type, and source ID. Do not merge two employees or vendors based only on a similar name. Ambiguous matches remain unresolved and cannot drive automatic financial allocation.

Edges contain `organizationId`, `fromId`, `toId`, `type`, `validFrom`, `validTo`, evidence references, and verification status. Operational membership and financial allocation are distinct edge types. Participation in two projects does not assign 100% of a cost to both. Allocation weights are governed records whose sum is validated.

Model-extracted relationships first enter a candidate-claim store. They can help an analyst investigate, but cannot change approver identity, ownership, permissions, or authoritative cost allocation. Verified edges are written only by the relevant trusted ingestion or administrative workflow.

Maintain scope membership and ancestor IDs for common organization/department/project queries. Validate hierarchy updates against cycles. General relationships may contain cycles, so traversal tracks visited IDs.

## Request-time context assembly

For “Can Maya spend another $30 on the Beacon trip?”:

1. Derive the principal and allowed scopes from authentication. Resolve the referenced request and project using exact IDs when available. Ambiguity requires resolution before mutation.
2. Fetch mandatory authoritative inputs directly: current request revision, approved total, relevant budgets, active policy, actor authority, and prior related increases.
3. Expand only relevant relationship types: request-to-trip, trip-to-project, project-to-owner, trip-to-evidence. Apply authorization on edges and endpoints at every hop.
4. Read current project metrics and the latest authorized scope brief. Fetch scoped document excerpts only if the decision needs more context.
5. Rank optional evidence by relevance, recency, source quality, and diversity. Keep exact facts separate from narrative claims.
6. Return a bounded packet containing facts, evidence IDs and revisions, assumptions, missing fields, source freshness, and projection watermarks.

The application chooses query templates and authorization constraints. The model can request approved tools such as `get_project_context`, `get_request`, `search_evidence`, and `compare_spend`; it cannot submit arbitrary MongoDB pipelines or remove tenant filters.

Suggested initial investigation bounds are two relationship hops, 50 expanded entities, and eight narrative excerpts per context packet. These are tunable caps, not measured optimal settings. Reaching a cap returns `truncated` and an authorized continuation path. Missing mandatory financial evidence never disappears to make a packet fit the token budget; the case remains incomplete.

## Large scopes

A department or company question starts from period-specific aggregates and summaries, then drills into the projects contributing most to a change. Never gather all transactions into the model prompt. Numerical aggregation runs over the complete authorized financial scope, not a top-k semantic sample.

The drill-down axis depends on the question: food spending across locations, software renewals across vendors, physical asset maintenance across sites, or project costs across departments. Never require a project ID to store or retrieve a financial fact. The MongoDB POC retrieves non-project food records for restaurant and manufacturing profiles using an organization/category/time index.

Persist daily and monthly metrics by department, project, category, and currency. Track source coverage, event-time cutoff, and projection version. Late events mark affected periods dirty and trigger recomputation. Summary hierarchy is built from factual views and cited source documents; repeated summarization must not be the only route back to evidence.

Scope membership is not an authorization mechanism by itself. A company-wide summary may contain restricted compensation or project details. Reuse a summary only if its input visibility is compatible with the caller; otherwise construct an authorized view from permitted inputs. Cache keys include organization, scope, access-policy version, data version, and query shape. Access changes invalidate affected entries.

## MongoDB queries and indexes

Begin with explicit indexed one-hop lookups. An illustrative edge index is `(organizationId, fromId, type, validTo)`; add the corresponding reverse index only for demonstrated reverse queries. Financial history queries need organization, scope, and period indexes. Use cursor pagination with a stable timestamp/ID ordering.

MongoDB supports recursive `$graphLookup` with depth and filter controls, but depth limits do not bound fan-out. Prefer application-controlled bounded traversal for broad or permission-sensitive graphs. Use `$graphLookup` only on measured query shapes with suitable scope filters and execution limits. [MongoDB graph traversal](https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/)

Document retrieval can combine lexical and local embedding search with access prefilters. Recheck current access when fetching full evidence because indexes may lag permission changes. Do not send unauthorized candidates to the model or leak them through result counts.

Self-managed MongoDB search uses a separate `mongot` process; local search is not assumed to exist in every `mongod` installation. Validate the actual platform and package first. The initial fallback is indexed metadata plus lexical retrieval, with semantic search explicitly unavailable. No claim of equivalent semantic recall is made. [MongoDB self-managed search](https://www.mongodb.com/docs/search/self-managed/current/)

## Freshness and learning

Updating a source record invalidates dependent projections, summaries, and embeddings using dependency references. The previous version remains available for explaining historical decisions. Job packets record what was known at the time; execution rechecks current authoritative records independently.

“Learning” means retaining observed outcomes, updating measured baselines, and creating evidence-linked hypotheses. It does not mean modifying hard policies or model weights automatically.

Measure retrieval latency, examined versus returned records, evidence recall on known scenarios, stale-result frequency, token usage, and authorization leakage. Test both the small demo company and a generated corpus with many projects. A small demo alone is not evidence of large-scope performance.
