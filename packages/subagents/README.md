# `@alloc/subagents`

Bounded delegation and result-merging contracts for task 6B. The backend admits a
child by intersecting parent authority, role policy, and requested scopes/tools.
It enforces one delegation level, at most two active children, a parent-bounded
priority, evidence cutoff, expiry, and tool/output/context budgets. Child identities
are issued separately from model-authored requests. Admission has a hard read-only
tool allowlist, so a parent or role misconfiguration cannot grant proposal submission
to a child.

Run from this directory after building `packages/contracts`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

Results require versioned evidence or calculated-result references. Validation
rejects stale parent leases, expired/oversized output, and references outside the
authorized evidence set. Merging is deterministic, preserves source child/role,
and reports conflicting values and missing coverage rather than selecting a fact.
Runtime lifecycle helpers count authorized tool calls, fail at the child deadline,
and apply an explicit parent-termination disposition. Cancellation fences all later
work; detachment preserves the child's original deadline and bounded read authority.

`SingleInferenceSlot` is a synthetic reference for the initial one-generation
global limit. It demonstrates next-slot P0 priority and explicitly does not claim
preemption of an already-running generation. MongoDB artifact persistence, durable
scheduler admission, OpenClaw sessions, real model execution, and live context
authorization remain required before issue #14 can close.
