# `@alloc/scheduler`

Pure scheduling policy for task 5A. The package consumes the shared 1A durable-job
contract and provides deterministic admission, fairness, state-transition, lease,
retry, and coalescing decisions. It also defines the repository port that the 1B
MongoDB implementation will satisfy and provides a single-process in-memory
reference store for synthetic contract tests. Model or source text cannot choose its own priority;
the authenticated producer supplies a validated `DurableJobMessage`.

`SchedulerWorker` claims one bounded step at a time, dispatches only a registered
job-type handler, supports explicit lease renewal, maps allowlisted transient
failures to capped retry, and treats lease loss as fencing rather than allowing a
stale result to overwrite recovered work. It does not claim token-level model
preemption.

Repository cancellation uses an expected job revision and clears any lease so a
running worker is fenced. Deadline sweeping moves nonterminal work to an explicit
failed state before admission and likewise clears active leases. Authorization to
cancel remains an application-service concern rather than a model tool.

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
