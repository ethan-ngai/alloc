# `@alloc/company-fixtures`

Task 2A's offline, synthetic company data and fixture-level replay harness. All records are fictional. No account creation, network connector, database, financial execution, or model is involved. Task 1A contracts are consumed unchanged.

## Run from a fresh checkout

```sh
cd packages/contracts
npm ci --ignore-scripts --no-audit --no-fund
npm run build
cd ../company-fixtures
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run check
npm run replay
```

The package uses native JavaScript ES modules and Node's test runner; its only dependency is the adjacent contracts package. Build contracts first because its public exports resolve to `dist`. There is no root install/start command.

`npm run generate` deliberately rewrites the three frozen JSON files. `npm run check` regenerates in memory and rejects byte-level drift. Change the fixture/generator version and seed when changing canonical scenario meaning. Version 1 uses explicit names and an arithmetic sequence, without Faker or a random-number dependency.

## Profiles and exact totals

| Key | Company | Shape | Baseline expense, USD | Final expense, USD |
| --- | --- | --- | --- | --- |
| `northstar` | Northstar Fieldworks | 48 employees; Beacon, Atlas, Relay; software/development sources | 8,580.60 | 8,820.60 |
| `juniper` | Juniper Table | Three restaurants; POS, ingredients, food waste, facilities, labor | 9,660.60 | 9,900.60 |
| `forge` | Forge & Loom | Two manufacturing sites; orders, inventory, leases, freight, invoices | 10,740.60 | 10,980.60 |

Each company has 90 days of expense history, June 14–September 11, 2026, with 12 categories and 1,080 canonical postings. Category `i` (zero-based), day `d` costs `companyUnit + 100 × (i + 1) + d` USD minor units. Company units are 100, 200, and 300. The independent total is `1080 × companyUnit + 702000 + 48060`. Small synthetic amounts are designed for visible arithmetic, not realistic company valuation.

Northstar also has 200 GitHub-shaped issue/PR deliveries and stable repository/project mappings. Restaurants and manufacturing do not require projects. Every company has food, facilities, assets, software/cloud, restricted labor evidence, inventory, cash, liabilities, revenue/receivables, taxes/insurance, and governance records. Cash/planning observations and recurring schedules are separate from canonical expenses; no full general ledger is claimed.

This initial fixture size is smaller than the architecture's suggested roughly 5,000 financial/usage records per profile. It covers all domains and the 90-day story; a large-project stress profile and performance measurements remain separate work.

## Consumer contract

```js
import { loadCompany, validateCompany, replayCompany } from "@alloc/company-fixtures";

const company = validateCompany(loadCompany("juniper"));
const trace = replayCompany(company);
```

Each `loadCompany` returns a fresh copy. Frozen files can also be read directly from `fixtures/`. Top-level fields are:

| Field | Meaning |
| --- | --- |
| `manifest` | Contract/fixture/generator versions, fixed seed/date, profile, simulator-only identity, repository mappings |
| `entities`, `policies`, `evidence`, `relationships`, `schedules`, `facts` | Records validated by their corresponding 1A schemas |
| `postings` | Canonical baseline expenses; count each once regardless of overlapping category/vendor/location scopes |
| `deliveries` | Baseline `SourceDelivery` envelopes; `fixture.expense` payload contains the corresponding contract-valid `posting` |
| `scenario` | Test-only request, amendment, decision, grant, commitment, action and receipt snapshots, reusing 1A's Northstar trace |
| `budgets` | Final, post-scenario budget snapshots, not baseline balances |
| `runtimeDeliveries`, `runtimeSchedule` | Ordered source inputs and separate delivery simulation times; includes correction, stale revision, hostile evidence, and duplicate |
| `expectations` | Test oracle only: totals, outstanding exposure at each step, source replay outcomes |

**Do not feed `scenario`, `budgets`, or `expectations` into a production analysis path as approvals or conclusions.** Source consumers should read `deliveries` / `runtimeDeliveries`, not the entire fixture bundle. The fixture grants and decisions are test snapshots, never permission credentials. Task 2B must derive organization and authority from a configured simulator identity, validate each envelope and mapping, then use the financial core for writes. Raw source payloads cannot mutate caps.

Expense payloads intentionally mirror canonical postings for producer/consumer verification; they are two representations of one expense, not two financial records. Other `fixture.*` payloads are source-specific observations with `entityIds`, narrative content, and explicit quantities or measures. Their trust is `evidence`, including invoice/quote/POS examples; only normalized expense fixtures are marked authoritative within the synthetic source. Imported or live data is not included or implied.

## Replay and limitations

Seeds are `northstar-2026-09-12-v1`, `juniper-2026-09-12-v1`, and `forge-2026-09-12-v1`; scenario IDs are `scenario_<key>_v1`. Reference time is `2026-09-12T14:00:00.000Z`. The clock accepts explicit timestamps, normalizes offsets to UTC, and rejects backward time; it never reads the wall clock.

Replay consumes the baseline deliveries, then the contract snapshots for $180 → $210 → $240 requiring review → human approval → matched $240 posting. Outstanding exposure is respectively $180, $210, $210, $240, $0. Posting replaces the last commitment without changing total exposure. The same money sequence supports a Buffalo pilot trip, restaurant refrigerator maintenance, and manufacturing machine maintenance.

Source replay expects `accepted, accepted, stale, accepted, duplicate`. Version 1 fixture source revisions are positive integer strings, ordered numerically; real adapters may have opaque revisions and must define their own ordering. Reused delivery IDs with changed content and same-revision content conflicts fail. Hostile source text remains evidence and cannot affect these financial snapshots. This is a fixture oracle, **not a policy engine, importer, security integration test, or durable worker**.

Validation checks schema shape, stable IDs, same-company references and revisions, source/provenance agreement, source-to-posting equality, request/amendment amounts, decisions/grants/commitments, and exact budget totals. Tests include serialization/replay, frozen regeneration, timezone independence, malformed money/currency, duplicate identities, missing references, cross-company records, inconsistent amounts, source conflicts, and backward scheduling. The facet negative control demonstrates why summing category and location totals doubles expense.

Task 2A has no live dependency beyond merged 1A (#2 / PR #24). MongoDB/HTTP import acceptance belongs to 2B and 3B; runtime/provider/model/GB10 gates are unverified here. The small fixture and fake replay do not establish live financial correctness or model behavior.

## Verification recorded September 12, 2026

Test process: Node.js `v25.3.0`, npm `11.11.1`; Docker `28.4.0`, MongoDB `8.0.30` for the separate POC.

- Contracts: clean dependency install, build, typecheck, schema check, and 16 tests passed.
- Company fixtures: clean dependency install, 9 tests passed (including all three complete fixture replays and 18 invalid-fixture mutations); frozen generation check and replay CLI passed.
- Existing `experiments/finance-poc`: clean dependency install and all 8 real replica-set checks passed. Its first run hit the existing 60-second container-start timeout while pulling `mongo:8.0`; after `docker pull mongo:8.0` completed, rerunning `npm test` passed and removed its exact ephemeral container. This POC uses its own seed, not the new fixtures.
- `git diff --cached --check` passed. No shared contracts or root package/build files changed.
