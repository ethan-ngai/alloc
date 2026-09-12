---
name: Alloc
description: Exact financial operations in a quiet, high-legibility operator workspace.
colors:
  warm-canvas: "#f6f5f3"
  work-surface: "#ffffff"
  subtle-surface: "#fafafa"
  hover-surface: "#f3f3f4"
  primary-ink: "#202124"
  secondary-ink: "#5f6269"
  tertiary-ink: "#65686f"
  hairline: "#e1e2e5"
  strong-hairline: "#d3d5d9"
  charcoal-rail: "#202123"
  charcoal-rail-raised: "#292a2d"
  rail-ink: "#ededee"
  rail-muted: "#9c9da2"
  action-green: "#3f7c68"
  action-green-hover: "#356b5a"
  provenance-blue: "#5362c9"
  financial-green: "#2f8065"
  financial-green-soft: "#eaf5f0"
  review-amber: "#a16207"
  review-amber-soft: "#fff8e8"
  error-red: "#b9473c"
  error-red-soft: "#fff1ef"
  focus-indigo: "#6d78df"
typography:
  display:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(20px, 2vw, 29px)"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  title:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.045em"
rounded:
  status: "4px"
  control: "5px"
  action: "6px"
  compact-surface: "7px"
  surface: "8px"
  pill: "99px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.action-green}"
    textColor: "{colors.work-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.action}"
    padding: "0 14px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.action-green-hover}"
    textColor: "{colors.work-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.action}"
    padding: "0 14px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.work-surface}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.action}"
    padding: "0 14px"
    height: "44px"
  field:
    backgroundColor: "{colors.work-surface}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.action}"
    padding: "0 10px"
    height: "38px"
  card:
    backgroundColor: "{colors.work-surface}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.surface}"
    padding: "16px"
  status-pending:
    backgroundColor: "{colors.review-amber-soft}"
    textColor: "{colors.review-amber}"
    typography: "{typography.label}"
    rounded: "{rounded.status}"
    padding: "3px 6px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.rail-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.action}"
    padding: "0 10px"
    height: "36px"
---

# Design System: Alloc

## Overview

**Creative North Star: "The Quiet Operator"**

Alloc is a calm, graph-first financial workspace that lets operators scan exact state, understand the reason behind it, and act without visual ceremony. A warm neutral canvas and cool white work surfaces sit beside a compact charcoal rail; thin structure, concise labels, and selective semantic color keep a dense interface legible. Supabase-inspired report composition gives charts the scale and whitespace to explain current state without turning the product into a generic analytics dashboard.

The system takes interaction discipline and information density from modern operator tools while retaining Alloc's own financial semantics. It explicitly replaces the obsolete field-ledger world: do not restore serif display type, paper textures, ruled sheets, acetate overlays, binder hardware, brass material metaphors, or decorative marginalia.

**Key Characteristics:**

- DM Sans across product, controls, labels, and financial figures.
- Exact, tabular money with an explicit ISO currency suffix.
- A dominant current-state capital bar chart, supported by compact activity and forecast graphics.
- Warm canvas, white work surfaces, charcoal navigation, and thin gray hairlines.
- Semantic green for action and recorded financial state, blue for provenance, amber for review, and red for blocking error.
- Compact 11–13px supporting text that remains readable, paired with restrained 5–8px corners.
- Collapsed-by-default scope details and explicit mock, authority, interpolation, polling, and degraded-state labels.

## Colors

The palette is intentionally quiet: neutral structure carries most of every screen, while semantic hues appear only where they communicate action, provenance, review, financial state, focus, or failure.

### Primary

- **Action Green** (`action-green`): The main decision and retry fill, with a deeper sibling reserved for hover.
- **Financial Green** (`financial-green`): Recorded, approved, connected, and financially positive state; the soft tint supports compact status fields and empty-state marks.

### Secondary

- **Review Amber** (`review-amber`): Pending human review, threshold exceptions, delayed polling, and confirmation warnings. The soft tint carries warning regions without turning the whole surface into an alert.
- **Error Red** (`error-red`): Blocking dependency or validation failure. Use its soft tint only when a broader error region needs separation.

### Tertiary

- **Provenance Blue** (`provenance-blue`): Traceable activity types, source links, evidence navigation, and other routes into provenance.
- **Focus Indigo** (`focus-indigo`): The shared, high-contrast keyboard focus outline; it is interaction infrastructure rather than decoration.

### Neutral

- **Warm Canvas** (`warm-canvas`): The application background behind operational surfaces.
- **Work Surface** (`work-surface`): The canonical background for ledgers, registers, inspectors, dialogs, and controls.
- **Subtle Surface** and **Hover Surface** (`subtle-surface`, `hover-surface`): Low-contrast row grouping, hover feedback, utility controls, and expanded trace detail.
- **Primary, Secondary, and Tertiary Ink** (`primary-ink`, `secondary-ink`, `tertiary-ink`): A deliberate hierarchy for facts, explanation, and metadata.
- **Hairline** and **Strong Hairline** (`hairline`, `strong-hairline`): One-pixel division and slightly stronger control/dialog edges.
- **Charcoal Rail** (`charcoal-rail`): The persistent navigation ground. Its raised neutral, bright ink, and muted ink define active, hover, and secondary states without introducing another accent.

### Named Rules

**The Semantic Color Rule.** Neutral structure does the layout work; green, blue, amber, red, and focus indigo appear only when their operational meaning is present.

**The Non-Color State Rule.** Every colored state includes plain-language text, a shape, a border, or an icon so status never depends on hue alone.

## Typography

**Display Font:** DM Sans (with system sans-serif fallback)

**Body Font:** DM Sans (with system sans-serif fallback)
**Label/Mono Font:** DM Sans for labels; system monospace only for trace IDs, timestamps, and raw contract events

**Character:** A single grotesk family keeps the workspace direct and coherent. Weight, alignment, spacing, and tabular numerals create hierarchy; no serif voice or editorial display layer competes with the data.

### Hierarchy

- **Display** (600, responsive 20–29px, 1 line-height): Exact overview money. Full forecast totals may rise to 34px while keeping the same family, weight, and tight tracking.
- **Headline** (600, 25px, 1.15 line-height): Page titles and top-level operational context.
- **Title** (600, 18px, 1.2 line-height): Dialog, loading, and blocking-state headings.
- **Body** (400–600, 13px, 1.5 line-height): Primary interface copy, controls, and readable explanations. Supporting rows and metadata step down to 12px, never into illegible compression.
- **Label** (600–700, 11px, modest tracking): Column headers, statuses, and compact financial labels; uppercase is limited to terse scan aids.
- **Trace** (system monospace, 11px, 1.4 line-height): Exact IDs, timestamps, revisions, and raw contract events.

### Named Rules

**The Exact Money Rule.** Every financial amount uses tabular numerals, two fractional digits, and a visible ISO currency code; never rely on a currency symbol alone.

**The Legibility Floor Rule.** Supporting interface text stays within the shipped 11–13px scale with sufficient contrast and line height; density is achieved through structure, not microscopic type.

## Layout

The desktop application shell pairs a fixed 220px charcoal rail with a fluid workspace. A sticky 48px utility bar anchors company, search, demo-state, and local-mode controls. Main content is centered within a 1440px maximum canvas with 32px horizontal breathing room, then organized with 16px gaps and shared hairlines.

Operate surfaces prefer report compositions when visual comparison helps. The overview keeps the broad financial work surface beside a 350px review inspector, then places a wider activity report beside a narrower forecast report at a 1.25:0.75 ratio. The capital-position bar chart is the dominant graphic: it follows the four exact headline totals, repeats the allocated amount and authorized cap, and compares recognized, committed, and available state against shared grid lines. Department scope begins collapsed beneath the graph so secondary record detail does not interrupt the first scan.

Requests, memory, and full forecast pages use wider primary panes with narrower detail or calculation panes. The inspector may stay sticky on desktop, but it remains a normal document section on smaller screens.

At 1050px gutters tighten and nonessential utility status recedes. At 820px the rail becomes an off-canvas 240px drawer, split panes stack, and touch targets reach at least 44px. At 560px metrics become a two-column grid, dense activity records recompose as stacked rows with trace detail below, and only genuinely tabular scope data scrolls horizontally.

**The Canonical State First Rule.** Exact financial state receives the widest, earliest position; explanations, provenance, review, and forecast context support it without masquerading as authority.

**The Graph Before Detail Rule.** Show the exact current-state comparison before optional scope rows; collapsed detail may explain the graph but must not compete with it.

**The Useful Stack Rule.** Responsive layouts preserve task order and recompose dense activity into readable stacked records rather than shrinking columns until they fail.

## Elevation & Depth

The system is flat by default. White and subtle-gray tonal layers, one-pixel borders, and sticky positioning carry routine hierarchy. A very low surface shadow reinforces separation without making the workspace look card-heavy; pronounced elevation is reserved for temporary overlays.

### Shadow Vocabulary

- **Surface Hairline Lift** (`0 1px 2px rgb(17 24 39 / 5%)`): Used by operational surfaces and the API validity seal as a nearly imperceptible edge aid.
- **Decision Overlay** (`0 18px 50px rgb(20 21 23 / 18%)`): Used only by the modal confirmation above its dimmed backdrop.
- **Mobile Drawer** (`12px 0 40px rgb(0 0 0 / 20%)`): Separates open navigation from the stacked workspace.

### Named Rules

**The Low-Elevation Rule.** Routine surfaces stay within the hairline lift; larger shadows mean a temporary layer that blocks or covers other work.

## Shapes

Corners are restrained and functional. Status tags use 4px radii, compact controls 5–6px, seals and small cards 7px, and primary surfaces or dialogs 8px. Full pills are reserved for progress bars and true circular marks such as status dots or avatars. Borders are consistently one pixel; a two-pixel semantic top edge may distinguish a review inspector without changing its silhouette.

**The Radius Ceiling Rule.** Operational containers stop at 8px. Do not drift into oversized rounded cards, bubbly navigation, or decorative capsules.

## Components

### Buttons

- **Shape:** Compact, confident controls with a 6px radius and a 44px minimum height for consequential actions.
- **Primary:** White text on action green, 13px semibold type, and 14px inline padding. Hover deepens the fill; disabled state stays recognizable at reduced opacity and uses wait semantics while recording.
- **Hover / Focus:** No lift or scale. All buttons share a 2px focus-indigo outline with a 2px offset.
- **Secondary:** White fill, primary ink, and a strong hairline border. Text actions are transparent and use green or provenance blue according to destination.

### Chips

- **Style:** Compact labels use a 4px radius, 3px by 6px padding, 11px semibold type, and an explicit state word.
- **State:** Amber tint means pending or review, green tint means approved or clear. Chips never substitute for the longer explanation at the point of decision.

### Cards / Containers

- **Corner Style:** Restrained 8px corners.
- **Background:** White for canonical work, subtle gray for hover, grouped metadata, or expanded trace detail.
- **Shadow Strategy:** The surface hairline lift only; dense registers are divided internally instead of broken into nested cards.
- **Border:** One-pixel neutral hairlines; semantic top borders may distinguish pending and clear review inspectors.
- **Internal Padding:** Usually 12–18px, aligned across adjacent headers and rows.

### Inputs / Fields

- **Style:** White or transparent fill, 5–6px corners, compact 12–13px text, and a hairline or strong-hairline boundary.
- **Focus:** Shared focus-indigo outline; never remove focus without an equivalent visible treatment.
- **Error / Disabled:** Keep values readable, add a plain-language message, and preserve the distinction between retryable dependency failure and validation failure.

### Navigation

The rail uses 36px rows on desktop and 44px rows in the mobile drawer. Default items use muted rail ink; hover uses the raised charcoal; active items use bright rail ink with a restrained translucent fill. The utility bar remains white and sticky, and the command-search affordance may disappear when space is insufficient.

### Exact Financial Figure

Money is set in DM Sans with tabular numerals, tight negative tracking, two decimals, and a trailing ISO currency code. Financial figures may scale from 20px in compact metrics to 34px on a forecast page, but exactness and alignment do not change with prominence.

### Capital Position Chart

The primary overview visualization is a 210px current-state bar chart for recognized, committed, and available capital. It uses shared horizontal hairlines, 72px maximum-width bars, exact category labels, and exact money values. The chart is introduced by the combined recognized-plus-committed amount, its percentage of the authorized cap, and the exact cap itself. Recognized uses primary ink, committed uses action green, and available uses the strong neutral hairline; color never replaces the labels or values. On small screens the graph shortens to 180px and preserves labels even when repeated money values must yield.

### Collapsed Scope Details

Department scope is a native disclosure below the capital chart, collapsed by default. Its summary always names the scope and says “not additive”; expanding it reveals record class, view-only status, provenance revision, and the explicit statement that the rows are not another financial total.

### Activity Register

The overview activity report pairs three compact event-count bars—decision, request, and posting—with exactly three recent human-readable rows. Its header states the total contract-event count and exposes five-second polling as “Live · 5s”; degraded polling changes both color and copy to “Delayed.” The full Activity surface retains relative and exact time, event type, recorded state, and on-demand trace detail, using the expanded labels “Live mock feed · 5s” and “Feed delayed · retrying.” The live dot may pulse gently, while the degraded dot remains still.

### Forecast

Forecast surfaces use a restrained green area-and-line chart to distinguish sourced totals from display-only interpolation. The chart labels illustrative interpolation, revision, exact endpoints, and a sentence explaining that intermediate points are not recorded periods. Beneath the path, compact driver bars name and quantify exact actual spend, outstanding commitment, and any remaining driver. Exact totals and deterministic driver amounts remain visually stronger than the illustrative path.

### Confirmation Dialog

Consequential approval opens an accessible modal that traps focus, closes with Escape, restores focus to its trigger, and makes background content inert. It repeats the revision, revised full amount, cumulative change, acting approver, mock status, and lack of model authority before the action is recorded.

### Motion

Motion is minimal and purposeful: a 450ms bottom-origin rise for data bars, a 160ms trace-detail reveal, a 180ms mobile drawer transition, a restrained live-status pulse, and progress-only loading or recording indicators. `prefers-reduced-motion` reduces animations to an effectively immediate duration and a single iteration.

## Do's and Don'ts

### Do:

- **Do** show exact tabular money with two decimals and an ISO currency code at every decision point.
- **Do** make the current-state capital bars the dominant overview visualization and keep their exact labels, values, cap, and percentage adjacent.
- **Do** summarize overview activity with three event-count bars and only the three most recent rows.
- **Do** place exact forecast driver bars beneath the explicitly illustrative area-and-line chart.
- **Do** keep scope details collapsed until requested and label them as non-additive before expansion.
- **Do** label synthetic, mock-backed, live-polling, degraded, unavailable, interpolation, provenance, and human-authority states in words.
- **Do** preserve the warm canvas, white surfaces, charcoal rail, thin hairlines, and restrained 5–8px radius system.
- **Do** let green communicate action and recorded financial state, blue provenance, amber review, red failure, and indigo keyboard focus.
- **Do** stack activity into readable mobile records and preserve expandable trace detail.
- **Do** require an accessible confirmation step before recording a consequential human decision.
- **Do** honor reduced-motion preference for every animation and transition.

### Don't:

- **Don't** restore the field-ledger, serif, paper, acetate, binder, brass, or marginalia direction.
- **Don't** imply that a model, narrative, cached value, mock response, or interpolated chart point carries financial authority.
- **Don't** use proportional digits, omit currency codes, or shorten exact money into ambiguous compact notation.
- **Don't** let optional scope rows precede or visually overpower the current-state graph.
- **Don't** present interpolated forecast points or activity counts without their exact source-state labels.
- **Don't** turn dense registers into a loose wall of floating metric cards or nested elevated panels.
- **Don't** hide polling failure, unavailable data, pending review, or degraded state behind color alone.
- **Don't** add ambient motion, hover lift, spring effects, or animated decoration to routine operator work.
