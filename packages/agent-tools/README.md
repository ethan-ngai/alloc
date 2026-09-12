# `@alloc/agent-tools`

Backend-owned contract tool gateway for task 6A. It keeps model arguments separate
from the authenticated `ToolExecutionContext`, validates strict 1A input and output
schemas, resolves per-job tool allowlists outside the model, checks explicit scope
containment and lease expiry, and requires each domain handler to authorize resolved
entity IDs before executing.

Run from this directory after building `packages/contracts`:

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
