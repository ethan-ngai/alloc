# Priority scheduling and persistent agent work

## Three priority classes

Use one durable MongoDB job collection with three logical service classes. Separate physical queues are optional later; the important behavior is admission, resource allocation, and bounded execution.

| Class | Examples | Behavior |
| --- | --- | --- |
| P0: interactive | Extra $30 request, time-sensitive approval, user waiting for an answer | Immediate admission; deterministic checks execute directly when possible |
| P1: operational | New transactions, anomaly investigation, normal forecast refresh | Continuous processing with bounded concurrency |
| P2: background | Broad scenarios, summary rebuilding, historical analysis | Short resumable steps; starts when higher-priority pressure permits |

Priority comes from authenticated action type, operator policy, and service deadlines. A model or source document cannot promote itself by saying “urgent.” Some tasks, such as a scheduled expensive executive analysis, may be interactive but still receive a bounded compute budget.

## Fast path and investigation path

The API durably records an incoming request before returning its accepted status. Eligible deterministic cases complete through the financial core without a model queue. Interpretation-dependent cases create P0 jobs and expose progress immediately through the UI.

Human-review cases enter an approval state rather than holding a worker or model slot. Model generation and evidence retrieval never run inside a MongoDB financial transaction.

## Queue priority is not compute preemption

If a background generation already occupies the only inference slot, a P0 arrival cannot necessarily interrupt it. Bound background generation length, tool-call count, and step duration. Pause between steps and prefer a high-priority request for the next slot.

If the chosen server supports safe cancellation, use it to cancel restartable background generation and persist a checkpoint. Do not promise token-level preemption without runtime verification. If one model cannot meet measured interactive latency, evaluate supported concurrent scheduling or a smaller interactive model, subject to GB10 memory constraints. Keeping spare application workers alone does not reserve GPU capacity.

Start with a single inference admission slot and bounded background calls until the real runtime is measured. Report interactive delay honestly; “always on” does not guarantee immediate generative answers under overload.

All main-agent and subagent generations pass through the same application-controlled inference admission layer. Job identity determines priority. Validate compatible endpoint routing and propagation of job/session identity with the actual OpenClaw runtime. If direct routing cannot carry that identity, keep workflow steps under worker control and serialize generation there; do not claim global priority enforcement while allowing native child calls to bypass it. See [hardware and subagents](09-hardware-and-subagents.md).

## Durable job lifecycle

Jobs record organization, origin principal, service identity, scope, priority, deadline, input versions, deduplication key, current step, checkpoint, attempts, eligibility time, and lease information.

Workers claim an eligible job with a conditional atomic update, receive a lease generation, and renew only while they own it. Job transitions require that generation; expired workers cannot mark newer work complete. Mutating tools also validate the active job lease and use a stable action command ID. Lease recovery is allowed to repeat analysis, but never duplicate a financial action.

```text
pending → running → completed
                 → waiting_for_approval
                 → waiting_for_retry
                 → failed
                 → canceled
```

A restart reclaims expired leases and resumes at a checkpoint. If evidence or permissions changed, rebuild the context packet before continuing. Checkpoints store artifact references and completed steps; they do not store a stale permission grant as current authority.

## Fairness and backpressure

Give P0 precedence while reserving periodic capacity for essential P1 ingestion/reconciliation so the financial state does not become stale. Apply per-principal admission limits and coalesce repeated background updates for the same scope.

When a project changes ten times during a forecast run, record that a newer generation is pending and schedule one follow-up run. Do not drop the last change when a deduplication key collides with an already running job.

Age P1/P2 work into bounded service opportunities without allowing a long P2 run to monopolize the GPU. Under sustained overload, defer optional scenarios, expose delays, and keep financial ingestion and deterministic checks responsive.

Retry transient failures with capped backoff. Invalid inputs, denied permissions, and policy rejection are terminal outcomes, not retry conditions. Exhausted jobs move to an inspectable failure state.

## Agent integration contract

The worker must be able to submit a bounded task to OpenClaw, associate calls with job identity, observe completion/failure, and resume or retry safely. The actual supported mechanism is a deployment validation item. Do not invent an OpenClaw API based on assumptions.

The agent receives tools such as `get_request`, `get_scope_metrics`, `get_project_context`, `search_evidence`, `run_forecast`, and `propose_action`. Tool authority is issued by the backend and rechecked server-side. Financial mutations use the governed action path; context tools have no hidden write side effects.

## Operational visibility

Measure accepted-to-start and accepted-to-complete latency per class, active inference duration, oldest eligible work, lease recoveries, retries, source lag, and paused background work. Show states such as checking policy, gathering context, waiting for approval, and reconciling. Do not imply an accepted request is approved.
