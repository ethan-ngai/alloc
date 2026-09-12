# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Inferred for task 8A from the repository's browser-safe TypeScript mock client and the user's direction to start building: React, TypeScript, Vite, and npm. The frontend remains an independently owned package and does not introduce a root application command.

## Users

Primary users are company owners, finance and operations leaders, and authenticated human approvers who need to understand current financial state and act on purchase requests. Employees also need a clear view of their requests and the evidence behind decisions.

## Product Purpose

Alloc is a local financial intelligence application that connects operational spending decisions to company-wide financial memory and forecasts. Success means an operator can understand exposure, review an exception, inspect provenance, and see the forecast impact without mistaking narrative or stale data for financial authority.

## Positioning

Alloc joins exact, policy-governed spending state with cited operational context: the backend owns arithmetic and authority, while a restricted local agent investigates and explains without receiving financial execution power.

## Operating Context

The interface is used as an operational desktop dashboard during purchase review, budget monitoring, forecast analysis, and audit follow-up. It must work across the three synthetic demo profiles: Northstar Fieldworks, Juniper Table, and Forge & Loom. Purchase requests are the central demo workflow; memory, forecast, and activity views explain the broader company story.

## Capabilities and Constraints

- Show company views, purchase requests and human review, company-wide memory, forecast snapshots, and auditable activity.
- Consume the versioned `@alloc/mock-api` browser client and contract-valid response fixtures for 8A; live backend wiring belongs to 8B.
- Clearly label synthetic, mock-backed, imported, live, stale, pending, unavailable, and error states.
- Never imply that model output, narrative evidence, or cached state authorizes a financial action.
- Display exact money and currency. Overlapping category, vendor, project, and location facets are views, not additive canonical totals.
- The demo must cover all three companies plus pending review and API failure states.
- This initial stack choice is inferred from repository evidence and the user's instruction to begin, not a durable user-confirmed preference.

## Brand Commitments

The application uses a Linear-inspired “Quiet Operator” visual direction selected by the user: muted navigation, predictable header bars, warm crisp neutrals, compact information density, restrained separators, and task-first hierarchy. Cursor-like split panes and inspectors may support drill-down, but financial state—not the agent—remains the center of attention. DM Sans is the product typeface, with supporting interface copy kept legible rather than compressed. This reference is a quality and interaction standard, not permission to copy third-party branding or trade dress.

## Evidence on Hand

- Approved architecture under `docs/architecture/`.
- Versioned contracts and frozen examples under `packages/contracts/`.
- Synthetic company fixtures and deterministic seeds under `packages/company-fixtures/`.
- Contract-valid mock API, typed browser client, response fixtures, and injected error modes under `packages/mock-api/`.
- No real customer, provider, model, hardware, or live-backend evidence is represented by this frontend milestone.

## Product Principles

- Exact state before explanation.
- Provenance is visible where decisions are made.
- Human review is explicit, calm, and recoverable.
- Company-wide context must not double-count canonical financial totals.
- Degraded or synthetic data announces itself instead of pretending to be live certainty.

## Accessibility & Inclusion

Keyboard-complete workflows, visible focus, semantic landmarks, non-color status cues, reduced-motion support, and WCAG AA contrast are required for the operator surface.
