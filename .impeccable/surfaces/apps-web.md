---
version: 1
slug: "apps-web"
primary_target: "apps/web"
related_targets: ["apps/web/index.html","apps/web/src/App.tsx","apps/web/src/styles.css"]
---

## Scope and mode

`apps/web` is the task 8A desktop-first responsive operator application. Mode: Operate.

## Audience, job, and task

Finance and operations leaders and authenticated approvers scan current exposure, review an amendment exception, inspect provenance, and trace forecast and activity implications. The primary action is a deliberate human approval decision on a pending request.

## Content and constraints

The surface consumes the contract-valid mock API and visibly labels all content as synthetic and mock-backed. Exact monetary values use tabular numerals, two decimals, and an ISO currency suffix. Canonical totals lead; category, vendor, location, and project scopes remain explicitly non-additive views. Model output, narrative context, cached state, and illustrative chart points never appear to authorize a financial action.

The implementation covers Overview, Requests, Memory, Forecast, and Activity for all three fixture companies. It includes pending-review, approved/clear, loading, validation failure, API-unavailable, live polling, and polling-degraded states. The forecast identifies illustrative interpolation and says that intermediate points are not recorded periods. Activity polls the mock contract every five seconds, labels a healthy feed, and switches to an amber “Feed delayed · retrying” status on failure.

## Chosen direction and memorable moment

Quiet Operator: a Linear-inspired but Alloc-specific world with a warm-gray canvas, charcoal rail, white operational surfaces, DM Sans, high-legibility 11–13px supporting text, thin hairlines, restrained 5–8px corners, and low elevation. Exact financial state is the visual center; green marks actions and recorded financial state, blue routes to provenance, amber marks human review and degraded polling, red marks blocking failure, and indigo marks keyboard focus.

The first viewport is overview-first: a broad exposure and scope work surface sits beside a narrow sticky review inspector, followed by a live activity register and compact forecast. The memorable interaction is the accessible decision confirmation, which repeats the revision, revised full amount, cumulative change, acting approver, mock status, and lack of model authority before recording.

This direction replaces the obsolete field-ledger concept. Do not restore serif display type, paper texture, ruled sheets, acetate overlays, binder hardware, brass material metaphors, or decorative marginalia.

## Composition and responsive behavior

- Desktop uses a 220px sticky rail, 48px sticky utility bar, centered 1440px canvas, 16px working gaps, and a 350px review inspector.
- At 1050px the canvas gutters tighten and nonessential local-mode text recedes.
- At 820px navigation becomes a 240px off-canvas drawer, split panes stack, the review inspector loses sticky positioning, and interactive rows reach at least 44px.
- At 560px overview metrics become two columns and activity changes from a horizontal register into stacked records with expandable trace detail; only genuinely tabular scope data retains horizontal scrolling.

## Component and state commitments

| Ingredient | Built medium | Commitment |
| --- | --- | --- |
| Charcoal navigation rail | React, semantic HTML, CSS, Lucide icons | Muted default state, restrained filled active state, full-label mobile drawer |
| Exposure work surface | Semantic grid and definition content | Exact tabular money with ISO currency; canonical state first |
| Scope table | Semantic table-like rows | Explicitly non-additive; horizontally scrollable only when necessary |
| Review inspector | Semantic aside and definition list | Amber pending edge and warning, green clear state, explicit human authority |
| Decision confirmation | Accessible modal dialog | Focus trap, Escape close, inert background, trigger-focus restoration, repeated exact decision facts |
| Activity register | Polling React state and responsive rows | Relative plus exact time, on-demand raw trace, live five-second label, degraded retry label |
| Forecast | SVG and deterministic mock data | Exact sourced total, revision label, explicit interpolation disclosure |
| Errors and loading | Centered operational surfaces | No stale cached financial state; retryable and validation failures remain distinguishable |
| Motion | CSS only | 160ms detail reveal, 180ms drawer, restrained live pulse, progress-only indicators, reduced-motion fallback |

## Visual source of truth

- `apps/web/index.html`: approved direction contract.
- `apps/web/src/styles.css`: shipped tokens, layout, responsive behavior, component styling, motion, and reduced-motion handling.
- `apps/web/src/App.tsx`: shipped content hierarchy, semantic states, accessible confirmation, mock polling, provenance detail, and interpolation labels.
- `.impeccable/review/desktop.png`, `.impeccable/review/mobile-overview.png`, `.impeccable/review/activity-live.png`, and `.impeccable/review/decision-confirmation.png`: review evidence for the built surface.

## Unresolved decisions

The frontend is intentionally mock-backed for task 8A. Live backend wiring and real provider/model evidence belong to later integration work; the surface must keep announcing mock and degraded status until those dependencies are real.
