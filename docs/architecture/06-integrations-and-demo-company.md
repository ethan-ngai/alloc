# Integrations and Northstar Fieldworks

## Adaptable company profiles

| Company | Shape | Distinct sources and finance questions |
| --- | --- | --- |
| Northstar Fieldworks | 48-person industrial software business | GitHub, cloud usage, field travel, devices, software renewals |
| Juniper Table | Three-location restaurant group | POS exports, ingredient purchasing, food waste, rent, utilities, equipment maintenance, labor |
| Forge & Loom | Two-site light manufacturer | Purchase orders, raw-material inventory, equipment leases, freight, maintenance, customer invoices |

Each uses the same organization/category/vendor/location/time schema and cap evaluator. Projects are optional. Source adapters vary by company; no GitHub connector is required for a restaurant. All names and data are fictional. The implemented POC generates 12,000 financial records per company across 12 categories; POS, inventory, and other named business-specific integrations remain planned fixtures/adapters, not implemented connectors.

## Company identity

Northstar Fieldworks is a fictional 48-person company building inspection software for industrial field teams. It has Product Engineering, Field Engineering, Customer Success, Sales, and Operations departments. Its goals are to launch a customer pilot on time, maintain a defined operating budget, and avoid slowing field staff over small justified expenses.

This business naturally produces software activity, hardware purchases, site travel, cloud/AI usage, subscriptions, and quarterly spending questions.

| Project | Business activity | Connected evidence | Financial signals |
| --- | --- | --- | --- |
| Beacon | Launch an offline inspection pilot | `field-agent` repo, pilot milestones, site-visit brief | Travel, test devices, customer deployment costs |
| Atlas | Train an image defect detector | `defect-models` repo, dataset jobs, training issues | GPU consumption, storage, inference usage |
| Relay | Improve customer reporting | `customer-console` repo, release plan, support issues | SaaS seats, contractor commitments, hosting |

Maya Chen is a Field Engineering employee assigned to Beacon. Her Buffalo pilot trip supplies the recurring “extra $30” example. Names and events are invented and clearly labeled synthetic.

## A coherent simulation

Generate a fixed company manifest first: organization IDs, departments, employees, projects, repository mappings, budgets, vendors, contracts, and policies. Build event producers against those shared IDs. Faker supplies human-readable variety; domain generators control relationships, timing, amounts, and accounting consistency.

Recommended initial fixture size: 90 days of history, roughly 5,000 financial/usage records, 200 issue/PR records, and a small set of policy and project documents. These are seed targets, not performance evidence. A separate stress profile expands project count and history for retrieval testing.

Pin the Faker version, random seed, reference date, and scenario version. Use a simulation clock distinct from processing time. Store generated fixtures for a canonical replay so a library upgrade does not silently change the demonstration. Faker documents both seeding and the need to control reference dates. [Faker usage](https://fakerjs.dev/guide/usage.html)

## Shared ingestion contract

Every adapter produces a validated envelope containing:

```text
organizationId, sourceInstanceId, deliveryId, sourceObjectId,
sourceRevision, eventType, occurredAt, observedAt,
schemaVersion, isSynthetic, payload, provenance
```

The backend derives organization and source authority from the configured connector, not a freely supplied payload field. The simulator writes through a simulator-only source identity in the fictional organization. It cannot impersonate a live financial provider.

All inputs follow the same delivery store, normalization, identity resolution, validation, deduplication, and projection pipeline. Invalid amounts, unknown scopes, and missing mappings produce inspectable ingestion failures. Raw imports do not bypass financial rules by updating budget documents directly.

## Adapter plan

| Adapter | Initial implementation | Future extension |
| --- | --- | --- |
| Purchases | Alloc request API plus simulated spending provider | Procurement/card provider using governed execution |
| Financial history | CSV import with documented columns and row errors | Incremental read-only expense/accounting connector |
| GitHub context | Local JSON issue/PR/repository fixtures and replay | Read-only GitHub connector with cursors and rate limits |
| Usage | Local metering events linked to project/vendor IDs | Cloud/AI billing exports or permitted provider APIs |
| Policies and briefs | Local Markdown/plain-text import with source versions | Document-system connector |
| Market context | Labeled local conference pricing/quote fixtures | Allowlisted read-only retrieval if event rules permit |

A CSV importer is a working import integration; it is not described as a native integration with the system that generated the CSV. Similarly, GitHub-shaped replay exercises an adapter contract but is labeled simulated GitHub until an actual connector has been implemented and verified.

For real GitHub webhooks, validate signatures before accepting the payload and retain delivery identifiers for deduplication. Normalize subsequent edits as distinct source revisions. GitHub's official webhook API exposes event metadata and delivery IDs. [GitHub webhook documentation](https://docs.github.com/en/rest/repos/webhooks)

Prefer read-only polling for a future live demo connector if inbound connectivity is unavailable. Do not create public repositories, send messages, or provision accounts as part of the fictional seed.

## Deliberate scenario timeline

1. Baseline: import company history and calculate spend, commitments, and a quarterly forecast.
2. Small urgent request: Maya amends a $180 trip request to $210. Deterministic rules reserve the additional $30 if eligible.
3. Cumulative exception: a second $30 increase crosses the configured $50 cumulative amendment allowance and requires human review.
4. Operational context: an Atlas training issue records repeated runs; project-tagged GPU usage rises over several days. The agent investigates their possible relationship and cites both sources.
5. Adversarial content: a PR body requests a policy bypass and exfiltration. The financial gate and destination controls reject attempted misuse regardless of the model's response.
6. Leadership view: the forecast shows the verified spending increase and outstanding commitments. The agent explains the likely drivers, distinguishing observed linkage from inferred causality.
7. Recovery: replay a duplicate event or simulate a provider timeout. Show that financial state is not duplicated and uncertainty is visible.

The simulator controls source events, not agent conclusions. Do not insert a prewritten finding or approval result into the production analysis path. A hidden scenario manifest can record expected facts for evaluation, but the agent must obtain those facts through normal retrieval.

## Extending the fictional company

Add new departments, projects, repositories, vendors, and event producers through the manifest and common source contract. Represent changes over time: employees move projects, contracts renew, tasks slip, and subscriptions gain seats. Preserve stable identity while versioning relationships.

New project membership must not grant new access automatically. New sources must declare their authority: GitHub is evidence about development work, not the approver directory or financial ledger. A source outage, stale document, or unresolved vendor identity becomes part of the visible demo state.

## Offline and live modes

The required path is fully local and replayable. Live SaaS reads remain an optional extension pending the event's interpretation of “no cloud API.” Pre-cached external material retains acquisition date and a fixture/import label; it is never presented as a current live quote.
