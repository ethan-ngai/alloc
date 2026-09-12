# Alloc

Local financial intelligence connecting company-wide context, deterministic spending controls, and forecasts.

This is the planning and experiment baseline. Application implementation is split into independently owned GitHub issues; the unfinished scaffold from the planning workspace is not included.

- [Contributor instructions](AGENTS.md)
- [Task issues and tracking](docs/architecture/13-issue-map.md)
- [Parallel workstreams: 1A, 2B, 8A, etc.](docs/architecture/12-parallel-workstreams.md)
- [Architecture](docs/architecture/README.md)
- [Verification gates at every stage](docs/architecture/08-delivery-and-validation.md)
- [Reproducible MongoDB POC](experiments/finance-poc/README.md)
- [Durable scheduler core](packages/scheduler/README.md)

Start with shared contracts (1A) and local foundation (1B). GB10 preflight (9A) can run independently when hardware is available. After contracts are defined, frontend mocks, company fixtures, financial rules, and runtime work can proceed in parallel according to their issue dependencies.
