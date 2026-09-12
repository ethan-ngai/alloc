# Implementation progress

The stage definitions and acceptance gates are in [delivery and validation](08-delivery-and-validation.md), and lettered task dependencies are in [parallel workstreams](12-parallel-workstreams.md). This file records implementation state, not design intent.

The planning baseline contains documentation and the standalone POC. Task 1A now adds the independently runnable `packages/contracts` package; no application runtime is implied. Unverified application files drafted in the original planning workspace remain excluded. Live task ownership/status is maintained through the [issue map](13-issue-map.md).

| Stage | Status | Evidence |
| --- | --- | --- |
| 1A. Contracts | Implemented; contract gate verified | `packages/contracts`: strict Zod and inferred TypeScript contracts, draft 2020-12 JSON Schema, operation/tool catalog, frozen fixtures, and contract-level Northstar E2E trace. Verified with Node.js `v24.13.1`, npm `11.8.0`: `npm run build`, `npm run typecheck`, `npm run schema:export`, and `npm test` (16 tests). Deterministic scenario `scenario_northstar_amendment_v1`, seed `northstar-contracts-2026-09-12-v1`. This is not a MongoDB, HTTP, model, or hardware pass. |
| 1B. Local foundation | Planned | No application runtime, HTTP service, authentication, or MongoDB integration harness shipped by 1A |
| 2A. Company fixtures | Implemented on `codex/2a-company-fixtures`; fixture gate verified, pending merge | `packages/company-fixtures`: three frozen synthetic profiles, 90 days / 1,080 expense postings each, 200 Northstar development records, source envelopes, company-wide entities/observations/schedules, deterministic clock and replay. `npm test` (9 tests), `npm run check`, and `npm run replay` pass. Seeds: `<northstar\|juniper\|forge>-2026-09-12-v1`. Contract reference and exact-money checks include invalid inputs, source conflicts, stale/duplicate delivery, and commitment-to-spend reconciliation. Fixture-only evidence; no live importer, policy, MongoDB, HTTP, provider, model, or hardware pass. See the [fixture README](../../packages/company-fixtures/README.md). |
| 2B–2C. Imports/mocks | Planned | Application importer and frontend mocks remain to build |
| 3A–3B. Financial core | Planned | POC validates selected financial contracts; no application acceptance gates passed |
| 4A–4B. Context | Planned | POC verified indexed category lookup only; no application graph/summary implementation shipped |
| 5. Durable runtime | Planned | No worker execution yet |
| 6. Local agent | Bounded delegation contracts in progress | `packages/subagents` enforces parent/role/request authority intersection, one level/two-child limits, bounded priority/resources/expiry, current-lease and versioned-evidence result checks, deterministic conflict-visible merging, and a synthetic global inference slot. OpenClaw, Qwen3.8 27B, MongoDB artifacts, real scheduler/context integration, and exact checkpoint remain unverified. |
| 7. Forecasts | Planned | No application forecasts yet |
| 8. Dashboard | Planned | No UI yet |
| 9. GB10 release | Pending target hardware | No GB10/model measurements yet |
