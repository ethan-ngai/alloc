# Alloc contributor instructions

## Start here

This repository contains the approved architecture, task dependencies, and a standalone MongoDB experiment. The application is not implemented in this handoff. Unverified application files from the original planning workspace are deliberately excluded; do not assume they exist in a fresh checkout.

1. Read [the architecture index](docs/architecture/README.md), [parallel workstreams](docs/architecture/12-parallel-workstreams.md), and [stage test gates](docs/architecture/08-delivery-and-validation.md).
2. Use [the issue map](docs/architecture/13-issue-map.md) to select the lettered task you were assigned. GitHub issues are the shared source of task ownership, blockers, PR links, and completion state.
3. Read that task's start prerequisites separately from its live integration prerequisites. Independent UI, fixture, calculation, and runtime work may proceed against validated contracts while providers are unfinished.

Product decisions are settled. Task 1A formalizes their executable schemas and examples; it does not reopen the product design. This handoff enables teammates to work on assigned issues. A pause in the original planning conversation is not a repository-wide prohibition on implementation.

## Claiming and completing work

- Before implementing an assigned issue, inspect its current state, assignee, dependency issues, and linked PRs. Record your branch/workspace and intended scope in the issue; assign the responsible GitHub account when appropriate. Do not duplicate a task already claimed without coordinating in that issue.
- Use a separate branch/workspace for independently owned tasks. Target `main`; do not change another contributor's branch or worktree. Agree ownership of shared schemas and root package/build files before editing them concurrently.
- Keep start dependencies and live acceptance dependencies distinct. If a prerequisite fails, record the exact blocking issue and what independent work can still proceed.
- Attach focused verification, integration tests, and a task-level E2E flow to the implementation. Follow the task's gate; tests are not postponed until the final demo.
- Put the task ID in the PR title. Use `Closes #<issue>` only when the PR completes all of that issue's acceptance criteria; use `Refs #<issue>` for partial work.
- Before resolving an issue, record the merged PR/commit, actual commands/results, scenario seed if relevant, and remaining limitations. Leave it open when required live-model, hardware, or integration checks are missing. A mocked pass is not a real-backend/model pass.
- Keep implementation progress in `docs/architecture/11-implementation-progress.md` accurate when delivering a milestone. Do not manually duplicate every issue status in the static issue map; follow the live issue links.
- Update the tracking issue's checklist after a task is completed/reopened so collaborators can see the overall state. Do not close the tracking issue while required child work remains.

## Fixed architecture and invariants

- MongoDB is required. Financial correctness tests use an isolated real replica set; transactions must atomically update every applicable cap, commitment, decision, and action intent.
- Financial memory covers the entire company: categories, food, facilities, assets, software, labor, vendors, cash, liabilities, revenue, and taxes. Projects are optional. Overlapping category/location/vendor views must not multiply canonical financial totals.
- Store exact money and currency; never authorize against model-generated arithmetic or stale narrative memory. Check revised full amounts, cumulative amendments, current authority, and every binding hard cap at execution time.
- Model output, source documents, GitHub text, and retrieved evidence cannot change permissions or policy. Only typed, authorized backend operations can mutate financial state. No unrestricted database or financial-provider credentials in model tools.
- Use idempotent commands, source deduplication, version checks, durable action intents, and explicit reconciliation for uncertain outcomes. Do not promise universal rollback of external financial actions.
- P0 interactive work precedes pending operational/background reasoning. Already-running inference requires bounded steps or verified cancellation; queue ordering alone does not prove GPU preemption.
- OpenClaw is the selected framework. At least one of OpenClaw/NemoClaw/OpenShell is required under the user's clarification; all three are not mandatory. Hosted inference fallback is out of scope.
- The selected local model is Qwen3.8 27B, replacing the earlier Qwen3.8 Flash/125B-class candidate. Pin the exact checkpoint and serving format during the GB10 fit test. Size memory from the complete artifact and measured runtime overhead, not the 27B parameter count alone.
- Begin with one shared model server and one active generation globally. Subagents have bounded tasks, restricted scope, and no financial execution authority.
- Demo profiles: Northstar Fieldworks (software), Juniper Table (restaurants), and Forge & Loom (manufacturing). Clearly identify synthetic/imported/live data. Live connectors require confirmed access and event compatibility; never create external company accounts or send messages as part of seed generation.

## Verification available in this baseline

Only the standalone POC is runnable here:

```sh
cd experiments/finance-poc
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

It requires Node.js and Docker, creates its own loopback-only MongoDB replica set, and removes that ephemeral test container afterward. Its eight checks cover selected retrieval, cap, idempotency, hostile-proposal, and posting contracts. See [results and limitations](experiments/finance-poc/README.md). It does not test OpenClaw, Qwen, scheduler preemption, a live provider, or the GB10.

There is no root application install/start/test command in this planning baseline. Task 1B supplies those commands and the isolated integration harness; task 8A supplies frontend tooling. Document them as they become real.

## Tool and review policy

- Prefer `apply_patch` for ordinary text edits and scoped `rg`/`rg --files` for searches. Keep inspection and command output focused.
- Preserve unrelated work. Never reset a dirty worktree, delete another task's artifacts, or broadly clean Docker volumes/databases. Tests must own their exact cleanup targets.
- Every requested PR review independently inspects the current code: record the exact head SHA and prior review ledger, inspect the full production diff and relevant contracts/tests, and run focused tests plus repository checks.
- Compare findings with prior reviews only after independent analysis. Prior approval, an unchanged head, or green CI is not proof of correctness.
