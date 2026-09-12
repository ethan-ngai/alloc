# Alloc backend architecture

Status: approved architecture for implementation, September 12, 2026, with a scoped MongoDB POC completed. The application and agent integration are not implemented. [POC results and reproduction](../../experiments/finance-poc/README.md) distinguish validated backend behavior from untested runtime assumptions.

Alloc is a local financial intelligence application whose persistent company model connects operational spending decisions with forecasts. The backend owns facts, calculations, permissions, and execution. A sandboxed agent investigates context and proposes actions through narrow tools.

## Reading order

1. [System boundaries and deployment shape](01-system-overview.md)
2. [Internal context, graph, and retrieval](02-context-and-retrieval.md)
3. [MongoDB records and consistency](03-data-and-consistency.md)
4. [Deterministic governance and execution](04-governance-and-execution.md)
5. [Priority scheduling and agent lifecycle](05-scheduling-and-runtime.md)
6. [Integrations and the fictional company](06-integrations-and-demo-company.md)
7. [Forecasting and learning](07-forecasting-and-learning.md)
8. [Build sequence, validation, and runtime gates](08-delivery-and-validation.md)
9. [GB10 capacity and bounded subagents](09-hardware-and-subagents.md)
10. [Company-wide financial memory](10-company-wide-memory.md)
11. [Implementation progress](11-implementation-progress.md)
12. [Parallel workstreams and dependencies](12-parallel-workstreams.md)
13. [GitHub issues and shared task state](13-issue-map.md)

## Confirmed constraints

- MongoDB is required.
- Persistent internal context covers company-wide finance: categories, vendors, facilities, food, equipment, software, labor, assets, liabilities, cash, and revenue, with projects as one optional dimension.
- Authoritative spending memory updates atomically with hard-cap enforcement; asynchronous summaries cannot authorize spending.
- Urgent employee requests take precedence over background analysis.
- Financial rules and permissions must be enforced independently of model output, including when retrieved content contains prompt injection.
- The demo should feature a coherent fictional company, including software development activity and financial activity.
- The supplied proposal connects purchases, expenses, policy, forecasts, and leadership observability through shared context.
- The user's clarification is that at least one of OpenClaw, NemoClaw, and OpenShell is required. Design against that clarification: select OpenClaw, with the other two optional. Public listings name all three; this discrepancy is recorded without overriding the user's direction. Local execution on the Dell Pro Max GB10 remains the target. The organizer listing says no cloud API, and the team dashboard was inaccessible.

## Recommended choices

- One TypeScript application codebase, with an API process and a separate durable worker process.
- Local MongoDB configured as a replica set for multi-document transactions. A single member is a demo topology, not high availability.
- A typed entity relationship graph in MongoDB, indexed financial records, and versioned scope summaries. Semantic retrieval supplements these where supported locally.
- One persistent job collection with three priority classes and bounded worker steps.
- OpenClaw as the selected agent framework, one shared local inference server, and optional bounded specialist subagents. Start with one active generation globally; do not load a separate model for each role.
- A deterministic approval path that can finish without inference when all eligibility criteria are available as trusted structured data.
- Synthetic company replay and working local file import as the complete offline demo. A live connector is optional and contingent on event rules and available access.
- Purchase requests as the central demo workflow, with posted expenses and operational events supporting the broader company story.
- Fictional company profiles: Northstar Fieldworks (industrial software), Juniper Table (restaurants), and Forge & Loom (manufacturing), sharing one financial schema with industry-specific sources.
- User-selected model family: Qwen3.8 Flash. The local open-weight candidate is `Qwen/Qwen3.8-Flash-Next`; full checkpoint memory must be validated as described in the hardware document.

## Runtime choices still requiring evidence

The vendor specifications are verified in the hardware document. The assigned machine's SSD configuration, free memory, installed software, and inference performance have not been inspected. The exact local model, inference server, tool-call adapter, MongoDB build, and search deployment must be tested on that machine. No latency claims or ARM64 search compatibility are assumed. Whether live SaaS reads are permitted, or an organizer specifically requires Atlas rather than MongoDB generally, remains unverified. These are deployment gates, not reasons to defer the domain design.

## Sources

- [Cornell event requirements](https://events.cornell.edu/event/dell-x-nvidia-ai-hackathon)
- [Organizer event listing](https://luma.com/builde-pjas)
- [NVIDIA NemoClaw architecture](https://docs.nvidia.com/nemoclaw/user-guide/openclaw/about/how-it-works)
