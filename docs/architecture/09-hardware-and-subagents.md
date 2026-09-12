# GB10 capacity and bounded subagents

## Verified hardware versus the assigned machine

Dell specifies the Pro Max with GB10 with a 20-core ARM CPU, Blackwell GPU, 128 GB LPDDR5x unified CPU/GPU memory at 273 GB/s, and NVIDIA DGX OS. Storage options include 2 TB and 4 TB SSDs. These are vendor specifications; the assigned hackathon machine's configuration, available memory, installed runtime, and measured throughput remain uninspected. [Dell specifications](https://www.dell.com/en-my/shop/pcs-desktop-computers/dell-pro-max-with-gb10/spd/dell-pro-max-fcm1253-micro)

Unified memory is shared by inference, MongoDB, search, the operating system, and application processes. Do not allocate the advertised 128 GB entirely to model weights. CPU and GPU work also share memory bandwidth, so large database scans and embedding batches can affect generation latency.

## Initial model and process shape

The user selects Qwen3.8 27B, replacing the earlier Qwen3.8 Flash/125B-class deployment candidate. Pin the exact repository, revision, quantization, and serving format before the capacity gate; “27B” alone does not identify a reproducible artifact or runnable memory footprint.

Use one shared model server. Quantization, context limits, and serving-kernel support are required deployment decisions. This model is not installed in the current workspace environment, and neither its latency nor fit on the assigned GB10 has been measured. Another model is a fallback experiment if necessary, not the selected baseline.

The following arithmetic illustrates raw 4-bit weight storage only, using decimal GB:

| Parameter count | Parameters × 0.5 bytes |
| --- | --- |
| 8 billion | 4 GB |
| 14 billion | 7 GB |
| 27 billion selected model | 13.5 GB |
| 32 billion | 16 GB |
| 70 billion | 35 GB |

These are lower-bound arithmetic estimates, not runnable footprints. Quantization metadata, higher-precision tensors, KV cache, activations, context length, concurrent sequences, and serving buffers add memory. Fit does not establish acceptable interactive latency, and architecture and serving kernels change performance; do not derive token throughput from parameter count or advertised peak compute alone.

The earlier Flash/125B-class weight envelope is withdrawn. Provisional acceptance budgets for the selected 27B model in the 128 GB pool are:

| Consumer | Initial envelope |
| --- | --- |
| OS, application, bounded MongoDB caches | At most 24 GB |
| Resident model weights and quantization metadata | At most 64 GB |
| Model runtime, working buffers, active KV caches | At most 24 GB |
| Uncommitted headroom | At least 16 GB |

These envelopes are a fit test, not a promise that a checkpoint meets them. Ideal uniform 4-bit storage for 27B parameters is 13.5 GB, but the actual artifact can include higher-precision tensors and quantization metadata, while the serving process also needs KV cache, activations, and working buffers. Offloading to CPU RAM does not create another memory pool on unified-memory GB10; SSD-backed/offloaded approaches need separate latency measurements. Keep one active generation, modest initial context, and no separate GPU embedding model or dedicated search service until capacity is demonstrated. Monitor available memory and explicitly tune caches; avoid swap-dependent inference.

The baseline processes are MongoDB, the API, a worker/scheduler, OpenClaw, and one local model server. Add local search/embedding processes only when the measured budget allows. The fictional company itself is small; extensive model contexts and search/runtime caches are more likely to dominate memory than its 5,000 demo financial records.

## When subagents help

Use a specialist child when a task has an independently answerable question and a narrower evidence scope. For example, a company spending investigation can ask one child to inspect Atlas development milestones and another to compare Atlas GPU usage against commitments. The parent combines cited findings.

The benefit is bounded context, separate task state, and overlap of tool I/O. Logical agents can share model weights through one server. Every active generation still consumes inference resources and KV cache. More agents do not multiply the GB10's throughput.

Do not spawn children for the $30 approval, arithmetic, routine source ingestion, or each incoming transaction. These use deterministic code or one short investigation.

## Recommended agent roles

| Role | Task | Tools and authority |
| --- | --- | --- |
| Alloc coordinator | Frame the question, choose bounded investigations, combine evidence, propose next action | Scoped reads, approved calculations, proposal submission |
| Project investigator | Explain milestones, blockers, ownership, and operational context | Project/repository/document reads within assigned scope |
| Spending analyst | Inspect category/vendor changes and measured budget impact | Read-only financial views and deterministic comparison/forecast tools |

These are role profiles, not permanently running model processes. Instantiate children only when needed. The executor and policy evaluator are application services; they are not agents that vote on the coordinator's recommendation. Agreement between models is not financial authorization or independent verification.

## Concurrency and limits

- One coordinator per active user investigation, with admitted investigations subject to global limits.
- At most two child tasks per investigation, one delegation level, no recursive child spawning.
- Initial global cap of one active model generation across all parent and child work.
- Permit child tool I/O to overlap within a small worker limit; measure database contention.
- Bound every child by deadline, tool-call budget, output size, and context size. Configure explicit timeouts rather than inheriting open-ended defaults.
- Parent yields while waiting; it does not consume another generation to poll child status.
- P0 work gets the next inference slot ahead of pending P1/P2 children, subject to the scheduling document's fairness rules.

OpenClaw provides separate subagent sessions and controls for model selection, concurrency, timeouts, and tool access. Explicitly set conservative limits instead of relying on the documented default child concurrency of eight. Session separation alone is not tenant isolation. [OpenClaw subagents](https://docs.openclaw.ai/tools/subagents), [configuration controls](https://docs.openclaw.ai/gateway/config-tools/sessions-and-subagents)

## Delegation contract

The backend admits a child with parent job ID, organization, task type, allowed scopes, permitted tools, expiry, inference priority, evidence cutoff, and output schema. It issues a restricted identity; the model cannot choose arbitrary principal fields or inherit a broader service credential.

A child returns claims with evidence IDs/revisions, calculated-result references, missing context, coverage/truncation, and completion state. The parent rechecks that referenced evidence is in scope. Partial or conflicting results remain visible and cannot silently become authoritative facts.

The effective child permission set is the intersection of parent authority, role policy, and task scope. Scope expansion must come through the application authorization mechanism. Disable generic shell, messaging, arbitrary HTTP, other-session browsing, and spawning for child roles. Task identity and fencing checks apply to children just as they apply to ordinary jobs.

Results are persisted as job artifacts in MongoDB, so a runtime completion announcement is not the sole recovery mechanism. Canceling the parent cancels or detaches children according to an explicit lifecycle rule; detached children retain only their original bounded read authority and cannot produce executable actions.

## One required agent framework

Use OpenClaw for the actual agent run and optional specialist sessions. The backend owns scheduling, context, and finance. NemoClaw/OpenShell can be added for infrastructure containment when useful, but the architecture does not require all three under the user's clarified requirement.

OpenClaw documents local model/provider setup; test the chosen compatible server and tool-calling path before relying on it. Verify that all agent calls use the local endpoint and that no hosted fallback remains. [OpenClaw local models](https://docs.openclaw.ai/gateway/local-models)

## Practical decision

Build and measure the one-agent workflow first. Add the two specialist profiles only if the cross-project investigation improves in evidence coverage or clarity without breaking urgent-request responsiveness. Keep one resident reasoning model initially. Consider a second smaller model or two simultaneous generations only after measuring peak memory, time to first token, completion latency, and tool-call correctness under real concurrent load.
