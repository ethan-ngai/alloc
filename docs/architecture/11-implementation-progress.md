# Implementation progress

The stage definitions and acceptance gates are in [delivery and validation](08-delivery-and-validation.md), and lettered task dependencies are in [parallel workstreams](12-parallel-workstreams.md). This file records implementation state, not design intent.

The planning baseline contains documentation and the standalone POC. Task 1A now adds the independently runnable `packages/contracts` package; no application runtime is implied. Unverified application files drafted in the original planning workspace remain excluded. Live task ownership/status is maintained through the [issue map](13-issue-map.md).

| Stage | Status | Evidence |
| --- | --- | --- |
| 1A. Contracts | Implemented; contract gate verified | `packages/contracts`: strict Zod and inferred TypeScript contracts, draft 2020-12 JSON Schema, operation/tool catalog, frozen fixtures, and contract-level Northstar E2E trace. Verified with Node.js `v24.13.1`, npm `11.8.0`: `npm run build`, `npm run typecheck`, `npm run schema:export`, and `npm test` (16 tests). Deterministic scenario `scenario_northstar_amendment_v1`, seed `northstar-contracts-2026-09-12-v1`. This is not a MongoDB, HTTP, model, or hardware pass. |
| 1B. Local foundation | Planned | No application runtime, HTTP service, authentication, or MongoDB integration harness shipped by 1A |
| 2A. Company fixtures | Implemented on `codex/2a-company-fixtures`; fixture gate verified, pending merge | `packages/company-fixtures`: three frozen synthetic profiles, 90 days / 1,080 expense postings each, 200 Northstar development records, source envelopes, company-wide entities/observations/schedules, deterministic clock and replay. `npm test` (9 tests), `npm run check`, and `npm run replay` pass. Seeds: `<northstar\|juniper\|forge>-2026-09-12-v1`. Contract reference and exact-money checks include invalid inputs, source conflicts, stale/duplicate delivery, and commitment-to-spend reconciliation. Fixture-only evidence; no live importer, policy, MongoDB, HTTP, provider, model, or hardware pass. See the [fixture README](../../packages/company-fixtures/README.md). |
| 2B. Importer | In progress (issue #5) | No application source-ingestion pipeline merged in this baseline; 2C mocks the `imports.ingest` contract only |
| 2C. Mock API | Implemented; frontend mock gate verified | `packages/mock-api`: independently runnable mock of the eleven catalogued operations, browser-safe typed client, and 25 generated response fixtures, all validated by the 1A schemas. Verified with Node.js `v22.22.3`, npm `10.9.8`: `npm run typecheck`, `npm run build`, `npm run fixtures:check` (exit 0, no drift), `npm test` (6 suites, 23 tests over real HTTP), and a live `node dist/serve.js --port 4310` curl smoke for 18_000 → 21_000 → review-required → `finance_manager` approval; the 1A suite stays green (16 tests). No browser tests: 8A owns full browser coverage. Provisional packs sit behind the `MockApiOptions.packs` seam and do not yet consume 2A's `packages/company-fixtures` manifests. Mocked only: no MongoDB, backend HTTP, model, or hardware pass. |
| 3A–3B. Financial core | Planned | POC validates selected financial contracts; no application acceptance gates passed |
| 4A–4B. Context | Planned | POC verified indexed category lookup only; no application graph/summary implementation shipped |
| 5. Durable runtime | Planned | No worker execution yet |
| 6. Local agent | Planned | Qwen3.8 27B and OpenClaw not configured locally; exact checkpoint remains to be pinned |
| 7. Forecasts | Planned | No application forecasts yet |
| 8. Dashboard | Planned | No UI yet |
| 9. GB10 release | Pending target hardware | No GB10/model measurements yet |
