# `@alloc/agent-tools`

Backend-owned contract tool gateway for task 6A. It keeps model arguments separate
from the authenticated `ToolExecutionContext`, validates strict 1A input and output
schemas, resolves per-job tool allowlists outside the model, checks explicit scope
containment and lease expiry, and requires each domain handler to authorize resolved
entity IDs before executing.

`createReadOperationToolHandlers` adapts the merged typed operation client for the two
read paths that 2C can represent faithfully: current request lookup and scoped evidence
search. Its integration suite runs those calls through 2C's real loopback HTTP server
with the principal injected from backend execution context. It deliberately leaves
`get_context` to 4A's verified relationship traversal and leaves forecasts/proposals to
their owning backend services.

`LocalOnlyJsonTransport` guards the eventual model-provider route. It accepts only an
explicit credential-free numeric-loopback HTTP(S) origin and model identifier,
disables redirects, rejects any request that changes origin, bounds response bytes,
and fails on non-JSON responses. It has no hosted fallback.

Run from this directory after building `packages/contracts` and `packages/mock-api`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

Handlers receive a bounded `AbortSignal` capped by both configured tool duration and
the current job lease. Handlers must cooperate with cancellation and await cleanup;
the gateway cannot safely force-stop arbitrary side effects. Financial handlers must
still recheck current policy, authority, revisions, and caps in their own transaction.

`createAllocToolPlugin` registers those tools with OpenClaw through `defineToolPlugin`,
pinned to `openclaw@2026.9.4`. Model-facing parameter schemas are generated from the
same 1A contracts the gateway enforces, so the two cannot drift.

Job identity never travels through model arguments. The Alloc worker attaches it to
the run as a `toolBindings.alloc` entry, and each tool reads it from the trusted
`toolContext`. A run without that binding is offered no tools at all rather than a
default identity. The binding names only the job, so `resolveExecutionContext` fetches
current authority per call and a renewed or revoked lease is observed immediately
instead of being frozen into the run when it started.

`openclaw` is an optional peer dependency; only a deployment that actually hosts the
agent needs it installed. The repository sets `ignore-scripts=true` because OpenClaw's
postinstall aborts on unsupported Node majors, which would otherwise fail the whole
workspace install for contributors who never run the agent.

Still required for task 6A acceptance: the local Qwen route, real backend handlers for
`get_context` (4A), `run_forecast` and `propose_action` (3B), and offline/no-fallback
evidence from the target machine. This checkpoint has not been run against a live
model.
