# Financial backend POC

Run on September 12, 2026 using actual MongoDB 8.0.30 in an isolated local Docker replica set on macOS ARM64. Eight checks passed. This is a backend experiment, not the full application or a Qwen/GB10 benchmark.

## Reproduce

From this directory, with Node.js and Docker running:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The script starts a uniquely named `mongo:8.0` container on a loopback-only dynamically assigned port, creates a fresh synthetic database, runs assertions, and stops/removes its own container in `finally`. It never connects to an existing database. The downloaded Docker image and ignored npm dependencies remain cached. The observed image ID was `sha256:4a0f30875898413139bec44c73c02a05fed172578de65b644dcdcee143ae7306`; the tag may resolve to a newer patch on subsequent runs.

## Results

| Check | Observed result |
| --- | --- |
| Company-wide retrieval | 36,000 records, 3 company profiles, 12 categories; food queries examined 8 documents for 8 returned, including profiles with no projects |
| Overlapping-cluster negative control | Naive category/location summation produced 119,826,600 minor units versus the correct 59,913,300 |
| Unsafe concurrency negative control | Separate reads followed by increments committed $600 against a $300 cap |
| Correct transactional category caps | For each company, 40 concurrent $30 requests produced exactly 10 approvals and 30 denials against $300 |
| Parent company cap | With $300 food exposure, 25 concurrent $40 software requests admitted 17; company exposure stopped at $980 under its $1,000 cap |
| Idempotency | 12 concurrent identical submissions created one $10 reservation and one outbox action; changed payload reuse was rejected |
| Hostile proposals | Forged approval/role/cap-bypass fields, another tenant, negative and fractional minor-unit amounts could not create an action |
| Financial memory update | Posting moved $10 from commitment to spend without changing total exposure; duplicate posting did nothing; record version changed |

The eight-document retrieval plus separate full-category aggregate took 71/48/39 ms for the three profiles in this run. These are single-run local observations, not p95 latency, GB10 measurements, or scalability guarantees. Category-cap contention checks across all three profiles took about 1.9 seconds total.

## Plan changes

- Company memory now uses category/vendor/location/legal-entity/time and other dimensions; project linkage is optional.
- Cluster views overlap, so authoritative totals aggregate canonical financial entries once.
- Hard caps are current transactional records, updated with commitments and postings; narrative memory is never the execution authority.
- The same backend contract works with Northstar Fieldworks, Juniper Table, and Forge & Loom fixtures. Industry-specific connectors remain planned.
- The selected model is Qwen3.8 27B, replacing the earlier Qwen3.8 Flash/125B-class candidate. Its exact checkpoint, quantization, and serving overhead require a GB10 memory-fit gate; no fit or throughput has been demonstrated here.

## Limits

The test harness supplies trusted principals directly; it does not test HTTP authentication. Hostile proposals test the deterministic boundary directly, not live-model prompt injection resistance. There is no OpenClaw/subagent run, actual model inference, scheduler preemption, graph traversal benchmark, semantic search, real provider side effect, policy-revocation race, or live connector in this experiment. Generated companies share a financial schema; this proves schema reuse, not domain-specific accounting completeness. The commitments are represented by commands/outbox records here; production still needs the fuller schemas in the architecture documents.

The ephemeral container and its synthetic database were removed after the successful run. Re-running regenerates all fixtures.
