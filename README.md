# Alloc

Local financial intelligence connecting company-wide context, deterministic spending controls, and forecasts.

This is the planning and experiment baseline. Application implementation is split into independently owned GitHub issues; the unfinished scaffold from the planning workspace is not included.

- [Contributor instructions](AGENTS.md)
- [Task issues and tracking](docs/architecture/13-issue-map.md)
- [Parallel workstreams: 1A, 2B, 8A, etc.](docs/architecture/12-parallel-workstreams.md)
- [Architecture](docs/architecture/README.md)
- [Verification gates at every stage](docs/architecture/08-delivery-and-validation.md)
- [Reproducible MongoDB POC](experiments/finance-poc/README.md)
- [Agent contract tool gateway](packages/agent-tools/README.md)

Start with shared contracts (1A) and local foundation (1B). GB10 preflight (9A) can run independently when hardware is available. After contracts are defined, frontend mocks, company fixtures, financial rules, and runtime work can proceed in parallel according to their issue dependencies.

## Local development and verification

Requires Node.js 20+ and Docker. Run everything from the repository root; one lockfile covers every workspace.

```sh
npm ci                      # install all workspaces
npm test                    # build + unit tests (contracts and API)
npm run test:integration    # real MongoDB replica set in owned containers
npm run test:e2e            # real API process against a real replica set
npm run verify              # schema check, build, typecheck, unit, integration, E2E
npm run dev                 # workspace-scoped MongoDB + API, with a local dev token
npm start                   # run a built API (MONGO_URI, MONGO_DATABASE, JWT_SECRET, ...)
```

`npm run dev` starts an owned `mongo:8.0.30` single-member replica set in a container named for the
workspace on `CONDUCTOR_PORT + 1`, builds the workspaces, prints a local development token, and removes
its container on exit. Integration and E2E tests start and remove only their own containers and never
connect to an existing MongoDB instance.

The API refuses to start on a standalone MongoDB deployment, requires a JWT secret of at least 32 bytes,
and derives tenant identity only from verified token claims.
