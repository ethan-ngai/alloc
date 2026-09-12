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

This checkpoint is the issue-authorized contract server, not a live OpenClaw/model
pass. OpenClaw's current Plugin SDK is experimental, so the adapter must pin and test
the actual host version before using its documented `defineToolPlugin` registration.
The plugin manifest, local Qwen route, runtime allowlist, real backend handlers, and
offline/no-fallback evidence remain required for task 6A acceptance.
