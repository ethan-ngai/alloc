# @alloc/mock-api

Runnable mock of the eleven catalogued operations for frontend development (task **2C**, issue #6).

The frontend (8A) can build and test every screen before any backend exists. Every response the
server emits is parsed by the frozen [1A contracts](../contracts) before it leaves the process, so
the mock cannot drift from the schema without failing its own tests.

## Purpose and limits

- **Provisional data only.** All three company packs are synthetic (`provenance.kind: "synthetic"`)
  and marked `provisional: true` in `fixtures/manifest.json`. 2A's `packages/company-fixtures`
  manifests (merged in `14ad9fc`) are not consumed here: these are 2C-owned labels mirroring the same
  scenario, and `MockApiOptions.packs` is the seam that replaces them.
- **No MongoDB, no persistence.** State lives in one in-memory store per process. `POST
  /admin/reset` restores the seeded state. Atomicity across caps, commitments, decisions, and action
  intents is a real-backend (3B) obligation this mock does not prove.
- **Not a policy engine.** `src/policy.ts` is a deterministic fixture evaluator that produces the
  approved / review_required / denied states the UI must render. It never claims to validate policy;
  the 3A rules engine owns that.
- **No browser tests.** 8A owns full browser coverage; this package covers the HTTP surface, the
  typed client, and the five required client flows over real HTTP.
- **No SSE or websockets.** 8A polls (`activity.list`, `forecasts.get`, `requests.get`).
- **Mocked, not a backend pass.** Nothing here exercises MongoDB, a live provider, a model, or the
  GB10.

## Commands

```sh
cd packages/contracts && npm ci --ignore-scripts --no-audit --no-fund && npm run build   # prerequisite
cd ../mock-api
npm install --ignore-scripts --no-audit --no-fund   # first run only; creates package-lock.json
npm run typecheck          # tsc -p tsconfig.json --noEmit
npm test                   # vitest run (six suites)
npm run build              # tsc -p tsconfig.build.json
npm run serve              # build + node dist/serve.js
npm run fixtures:export    # regenerate fixtures/ in src/export-fixtures.ts order
npm run fixtures:check     # regenerate and fail if fixtures/ drifted
```

`@alloc/contracts` is a `file:../contracts` dependency resolved through that package's `dist`, so
`npm run build` in `packages/contracts` must run before this package resolves or typechecks.

## Running it for the frontend

```sh
npm run serve
# alloc-mock-api listening on http://127.0.0.1:4310 clock=2026-09-12T14:00:00Z organizations=org_northstar,org_juniper_table,org_forge_loom
```

CLI flags: `--port`, `--host`, `--clock`, `--quiet`, `--help`; env `MOCK_API_PORT`, `MOCK_API_HOST`,
`MOCK_CLOCK`. Unknown flags exit `2`. The default bind is `127.0.0.1:4310`.

Client (browser-safe entry, no `node:*` in its graph — a test enforces this):

```ts
import { createContractClient } from "@alloc/mock-api";

const client = createContractClient({ baseUrl: "http://127.0.0.1:4310" });
const result = await client.call("requests.get", {
  meta: { schemaVersion: "1.0.0", organizationId: "org_northstar", correlationId: "correlation_ui_get" },
  payload: { requestId: "request_buffalo_trip" },
});
// or: await client.expect(...) — returns the ok payload and throws ContractClientError otherwise
```

Options: `principalId` (sends `x-alloc-mock-principal`), `fault` (sends `x-alloc-mock-fault` to
inject a specific error code), `fetchImpl`, `timeoutMs` (default 10_000; a transport failure or
timeout surfaces as `DEPENDENCY_UNAVAILABLE`, `status: 0`).

HTTP surface:

| Route | Behaviour |
| --- | --- |
| `POST /operations/<operationName>` | One of the eleven operations; returns the contract envelope |
| `GET /health` | `{ status, schemaVersion, clock, organizations, scenarioIds, provisional: true }` |
| `POST /admin/reset` | Body `{ organizationId? }`; reseeds state and clears that ledger; `NOT_FOUND` for an unknown organization |
| `OPTIONS <any>` | `204` + CORS headers |

CORS (`*`, `GET, POST, OPTIONS`, `content-type` + both mock headers) is set on every response so a
Vite dev origin can call the mock directly. Bodies over 1 MiB are rejected with
`VALIDATION_FAILED` / `requestBodyTooLarge` before the socket is destroyed. Routes match exactly: a
trailing slash, an unknown path, or a non-POST operation request returns the `NOT_FOUND` envelope
with `no operation route for <METHOD> <path>`.

## Errors

| code | status | retryable | typical cause |
| --- | --- | --- | --- |
| `VALIDATION_FAILED` | 400 | no | schema failure, malformed JSON, unregistered reference, oversized body, unknown fault code |
| `ACCESS_DENIED` | 403 | no | unknown organization, unregistered principal, scope outside the organization |
| `AUTHORITY_DENIED` | 403 | no | `reviews.decide` without `finance_manager` authority in scope |
| `NOT_FOUND` | 404 | no | unknown operation, request, commitment, posting, or forecast |
| `STALE_VERSION` | 409 | no | expectation or `requestRevision` mismatch |
| `IDEMPOTENCY_CONFLICT` | 409 | no | same `commandId` with a different payload, or a duplicate `postingId` |
| `POLICY_DENIED` | 409 | no | amending a denied request, deciding a request that is not awaiting review |
| `SOURCE_DUPLICATE` / `SOURCE_CONFLICT` | 409 | no | fault injection only |
| `REVIEW_REQUIRED` | 422 | no | fault injection only |
| `CAPACITY_EXCEEDED` | 422 | no | approval would exceed a hard cap (`details { available, required }`) |
| `INTERNAL_ERROR` | 500 | yes | unexpected mock failure; never leaks a stack |
| `OUTCOME_UNKNOWN` | 502 | no | fault injection only |
| `DEPENDENCY_UNAVAILABLE` | 503 | yes | fault injection, or an unreachable mock in the client |

`x-alloc-mock-fault: <CODE>` short-circuits an operation with that code (status from the table,
`details { injected: true, operation }`). Codes that no data-driven rule reaches
(`REVIEW_REQUIRED`, `SOURCE_DUPLICATE`, `SOURCE_CONFLICT`, `OUTCOME_UNKNOWN`) are reachable only
this way.

Mutation semantics worth knowing when wiring screens:

- Idempotency is central: a replayed command with an equal payload returns the memoized `data` and
  the current `correlationId`; a different payload is an `IDEMPOTENCY_CONFLICT`. Failed commands are
  not memoized.
- `requests.create` requires empty `expectedVersions`; `requests.amend`, `postings.record` (when it
  names a commitment), and `postings.correct` require exactly one entry for the ref being mutated.
- Only an `approved` evaluation reserves budget and creates/updates the commitment. A
  `review_required` revision keeps its verdict after a human decision: the human outcome lives in
  `decisions`, so a screen must read both.
- Budget availability is derived (`authorized − recognizedSpend − outstandingCommitments`) and can be
  negative; the seeded hard-capped account starts at 50_000 / 12_000 / 18_000 → 20_000 available.
- Decisions never carry `approvalGrantRef`: no catalogued operation can resolve a grant, so the mock
  does not emit a dangling ref. They do reference the pack's seeded `evidence_trip_active` record.
- `postings.correct` moves only recognized spend; corrections emit no activity item (the activity
  templates cover request, decision, posting, source, job, and forecast).

## Fixture catalog

`fixtures/manifest.json` lists every fixture with its operation, variant, and `ok` flag.
25 response fixtures cover all eleven operations:

| group | files |
| --- | --- |
| `northstar/` | `requests.create.{approved,denied}`, `requests.amend.{approved,review_required}`, `requests.get.{approved,review_required,denied}`, `reviews.decide.{approved,denied}`, `postings.record.matched`, `postings.correct`, `imports.ingest.{accepted,duplicate,quarantined}`, `memory.query`, `forecasts.run.baseline`, `forecasts.get.{baseline,scenario}`, `activity.list` |
| `errors/` | `stale-version`, `authority-denied`, `not-found`, `validation-failed`, `dependency-unavailable`, `idempotency-conflict` |

They are generated by driving the real server over HTTP in a fixed order
(`src/export-fixtures.ts`), so `npm test` can regenerate them in memory and fail on drift;
`npm run fixtures:check` does the same against the working tree.

## Replacing the provisional packs (2A seam)

```ts
import { createMockApi, type CompanyPack } from "@alloc/mock-api/server";

const api = createMockApi({ clock: "2026-09-12T14:00:00Z", packs: myPacks satisfies CompanyPack[] });
```

`createCompanyPack(identity)` builds one pack from an identity (organization, department, optional
project, requester, approver, categories, vendor, budget account, request, commitment) and derives
the whole seeded timeline, so all three demo companies stay the same scenario with per-industry
labels. Packs are treated as immutable templates: the store deep-clones them before mutating.

What a pack must contain for the mock to behave: exactly one budget account per organization
referenced by `identity.budgetAccountId`, one seeded request revision plus its decision, one
commitment, one seeded posting, one evidence record (`evidence_trip_active`, authoritative for
`trip_active`), one baseline forecast for the department scope, and one requester plus one
`finance_manager` approver.

Server entry (`@alloc/mock-api/server`): `createMockApi`, `createMockStore`, `createCompanyPack(s)`,
`northstarPack` / `juniperPack` / `forgePack`, `dispatch`, `exportFixtures`, `MockContractError`,
`ERROR_STATUS`, `DEFAULT_MOCK_CLOCK`, `DEFAULT_MOCK_PORT`.
