# `@alloc/scheduler`

Pure scheduling policy for task 5A. The package consumes the shared 1A durable-job
contract and provides deterministic admission, fairness, state-transition, lease,
retry, and coalescing decisions. Model or source text cannot choose its own priority;
the authenticated producer supplies a validated `DurableJobMessage`.

Run from this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

The current package is the contract-level scheduler core and uses synthetic job
records. Task 1B still owns the root runtime and isolated MongoDB replica-set
harness. After 1B lands, task 5A must add conditional MongoDB claims, monotonically
increasing lease generations, renewal and expired-lease recovery, checkpoint
persistence, multi-worker fencing, and restart E2E coverage before issue #11 can
close. These pure checks do not establish database atomicity or compute preemption.
