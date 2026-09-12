# `@alloc/contracts`

Versioned, runtime-independent contracts for Alloc producers and consumers. The package contains strict Zod schemas, inferred TypeScript types, frozen examples, and draft 2020-12 JSON Schema. It does not connect to MongoDB, expose HTTP, execute policy, or prescribe an OpenClaw transport.

## Use

```ts
import {
  AmendRequestInputSchema,
  type AmendRequestInput,
  EventEnvelopeSchema,
} from "@alloc/contracts";

const command: AmendRequestInput = AmendRequestInputSchema.parse(untrustedJson);
const event = EventEnvelopeSchema.parse(serializedEventFromAnotherProcess);
```

Examples are available from `@alloc/contracts/fixtures`. JSON Schema consumers can load named files from `schemas/`, such as `AmendRequestInputSchema.schema.json`.

## Commands

Run these from `packages/contracts`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
npm run schema:export
npm test
```

`npm run schema:check` regenerates schemas and fails when tracked output differs. The package owns its dependencies and lockfile; root workspace tooling belongs to task 1B.

## Versioning policy

`schemaVersion` and the package major version define the compatibility line. Additive optional fields and new operations/events may ship in a compatible minor release. Removing or renaming fields, changing money/state semantics, tightening previously accepted inputs, or changing event payload meaning requires:

1. a new explicit schema major version;
2. new side-by-side schemas or a coordinated consumer migration;
3. updated frozen fixtures and producer/consumer tests; and
4. a migration note in this catalog.

Consumers must reject unsupported schema versions. Historical records and events retain the version under which they were created.

## Operation catalog

| Operation | Kind | Purpose |
| --- | --- | --- |
| `requests.create` | command | Create and evaluate a purchase request revision |
| `requests.amend` | command | Submit a revised full amount against expected versions |
| `requests.get` | query | Fetch the current request, decisions, and commitment |
| `reviews.decide` | command | Record an authenticated human review decision/grant |
| `postings.record` | command | Record observed spend and an optional commitment match |
| `postings.correct` | command | Add a traceable signed correction |
| `imports.ingest` | command | Accept a source delivery/revision for normalization |
| `memory.query` | query | Retrieve bounded company-wide facts and cited evidence |
| `forecasts.run` | command | Request a deterministic baseline or scenario calculation |
| `forecasts.get` | query | Fetch an immutable forecast snapshot |
| `activity.list` | query | Page through auditable activity summaries |

Commands carry organization, command identity, correlation, causation, and expected record versions. Query metadata carries organization and correlation. Authentication derives the organization and principal at the service boundary; callers cannot use metadata alone as proof of authority.

Event envelopes bind aggregate revision, correlation, causation, time, and schema version to a typed payload. Tool argument schemas are intentionally narrower than API commands. `ToolExecutionContextSchema` documents backend-issued identity, authority, priority, job, and lease context, but that context is separate from model-supplied arguments. A tool adapter must inject it after authentication and must not merge similarly named model fields into it.

## Structural validation versus runtime obligations

These schemas validate representation: IDs, timestamps, revisions, supported currency, safe integer amounts, state names, references, provenance, and unknown fields. They do **not** establish that a caller is authenticated or authorized, a reference exists, a revision is current, a grant still applies, a cap has capacity, or a source/action is unique.

Runtime implementations must independently enforce current authorization and policy epochs, organization isolation, semantic cross-reference integrity, source and command deduplication, conditional expected-version checks, atomic updates to every binding cap/commitment/decision/action intent, exact arithmetic, lease fencing, and provider reconciliation. An `OUTCOME_UNKNOWN` result preserves exposure until explicit reconciliation. JSON Schema acceptance, a model proposal, narrative evidence, or a human grant by itself never authorizes execution.

The Northstar fixture is a contract-level integration/E2E trace, not a live backend pass. It verifies serialization and references for approved $180 → approved $210 → $240 requiring review → authorized human approval → simulated receipt → matched $240 posting. Runtime/MongoDB/OpenClaw/hardware gates remain owned by later tasks.
