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
npm run agent -- "prompt"  # one isolated OpenClaw turn through the configured model
npm run test:agent:e2e      # live OpenClaw -> DeepSeek smoke (requires DEEPSEEK_API_KEY)
npm start                   # run a built API (MONGO_URI, MONGO_DATABASE, JWT_SECRET, ...)
```

`npm run dev` starts an owned `mongo:8.0.30` single-member replica set in a container named for the
workspace on `CONDUCTOR_PORT + 1`, builds the workspaces, seeds the stable scaffolding for the three
explicitly synthetic company profiles, prints a local development token, and removes its container on
exit. Financial balances start unspent and transaction history is intentionally left to the frontend's
contract-valid mock stream through `POST /v1/organizations/:organizationId/imports`; loopback browser
origins are CORS-enabled for that flow. Integration and E2E tests start and remove only their own
containers and never connect to an existing MongoDB instance.

The API refuses to start on a standalone MongoDB deployment, requires a JWT secret of at least 32 bytes,
and derives tenant identity only from verified token claims.

The temporary agent default is `deepseek/deepseek-v4-flash`. Agent commands keep OpenClaw state under
the gitignored `.context/openclaw` directory, install the pinned official DeepSeek provider on first use,
and expose only OpenClaw's minimal tool profile. Set `ALLOC_AGENT_MODEL` to swap the model later; a local
provider must first be configured in that isolated OpenClaw state. OpenClaw requires Node 24.16+ (below
25) or 26.1+, so `.nvmrc` and the Conductor scripts select Node 24.16.0 without relying on an interactive
shell. API keys stay in the process environment and are never written to repository files.
