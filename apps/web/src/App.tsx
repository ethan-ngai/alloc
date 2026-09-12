import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  CircleAlert,
  CircleDollarSign,
  DatabaseZap,
  FileCheck2,
  Gauge,
  LayoutDashboard,
  Menu,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  approveReview,
  companies,
  describeError,
  loadActivity,
  loadWorkspace,
  type CompanyConfig,
  type CompanyKey,
  type DemoState,
  type MoneyValue,
  type WorkspaceData,
} from "./data";
import { advanceSyntheticStream, ingestSyntheticTick, seedSyntheticHistory } from "./demo-stream";
import "./styles.css";

type View = "overview" | "requests" | "memory" | "forecast" | "activity";

const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "requests", label: "Requests", icon: FileCheck2 },
  { id: "memory", label: "Memory", icon: BookOpen },
  { id: "forecast", label: "Forecast", icon: Gauge },
  { id: "activity", label: "Activity", icon: Activity },
];

function money(value: MoneyValue | undefined) {
  if (!value) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: 2,
  }).format(value.amountMinor / 100) + ` ${value.currency}`;
}

function time(value: string) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(value));
}

function date(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

function relativeTime(value: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 15) return "Now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date(value);
}

function activitySummary(value: string, data: WorkspaceData) {
  const posting = value.match(/^Posting \S+ posted (\d+) ([A-Z]{3})(?: · (.+))?$/);
  if (posting) return `${posting[3] ?? "Posting"} · ${money({ amountMinor: Number(posting[1]), currency: posting[2] })}`;
  const request = value.match(/^Request \S+ revision (\d+) (.+?)(?: · (.+))?$/);
  if (request) return `${request[3] ?? data.request.purpose} · ${request[2].replaceAll("_", " ")}`;
  const decision = value.match(/^Decision \S+ (.+) for \S+ revision (\d+)$/);
  if (decision) return `${data.request.purpose} · ${decision[1].replaceAll("_", " ")} · revision ${decision[2]}`;
  return value.replaceAll("_", " ");
}

function sourceLabel(source: string) {
  return source.replace("source_mock_simulator", "synthetic_finance_simulator").replaceAll("_", " ");
}

function syntheticRecordMetadata(company: CompanyConfig, area: string, index: number, asOf: string) {
  const records = company.key === "northstar"
    ? { "Travel": ["Trailhead Air", "PO-NF-2408", "FIELD-TRAVEL"], "Cloud services": ["Northern Arc Compute", "PO-NF-2414", "ENG-CLOUD"], "Field equipment": ["Ridgeway Field Supply", "PO-NF-2421", "FIELD-ASSETS"] }
    : company.key === "juniper"
      ? { "Food cost": ["Harvest Ledger Foods", "PO-JT-1806", "KITCHEN-FOOD"], Labor: ["Shiftwell Services", "PO-JT-1813", "KITCHEN-LABOR"], "Rent & utilities": ["Harborline Utilities", "PO-JT-1820", "FACILITIES"] }
      : { "Raw materials": ["Millstone Alloy", "PO-FL-3104", "PROD-MATERIALS"], Freight: ["Northline Freight", "PO-FL-3111", "LOGISTICS"], "Equipment leases": ["Foundry Leaseworks", "PO-FL-3118", "PROD-ASSETS"] };
  const [counterparty, purchaseOrder, costCenter] = records[area as keyof typeof records] ?? ["Atlas Operating Services", `PO-${company.shortName.slice(0, 2).toUpperCase()}-${2400 + index}`, company.departmentId.toUpperCase()];
  return { counterparty, purchaseOrder, costCenter, receivedAt: `${date(asOf)} · ${time(asOf)} UTC` };
}

function TitleBlock({ company, data, view }: { company: CompanyConfig; data: WorkspaceData; view: View }) {
  const title = navItems.find((item) => item.id === view)?.label;
  const simulationActive = data.scenarioId.startsWith("faker-stream");
  return (
    <header className="title-block">
      <div>
        <h1>{title}</h1>
        <div className="title-meta">
          <span>{company.name}</span>
          <span aria-hidden="true">·</span>
          <span className="synthetic-mark"><span className="status-dot" />Synthetic data</span>
          <span aria-hidden="true">·</span>
          <span>As of {date(data.asOf)} · {time(data.asOf)} UTC</span>
        </div>
      </div>
      <div className="api-seal" role="status" aria-label={simulationActive ? "Synthetic finance simulation active" : "Data service connected"}>
        <span className="seal-mark"><Check size={13} strokeWidth={3} /></span>
        <span>{simulationActive ? <><strong>Simulation active</strong><small>Synthetic baseline + live stream</small></> : <><strong>Contract valid</strong><small>Data service · v1.0.0</small></>}</span>
      </div>
    </header>
  );
}

function Metric({ label, value, detail }: { label: string; value: MoneyValue; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{money(value)}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ExposureLedger({ company, data }: { company: CompanyConfig; data: WorkspaceData }) {
  const { budget } = data;
  const total = Math.max(budget.authorized.amountMinor, 1);
  const recognized = Math.max(0, budget.recognized.amountMinor / total * 100);
  const committed = Math.max(0, budget.committed.amountMinor / total * 100);
  const available = Math.max(0, Math.min(100, budget.available.amountMinor / total * 100));
  const allocated = budget.recognized.amountMinor + budget.committed.amountMinor;
  return (
    <section className="ledger-sheet" aria-labelledby="ledger-title">
      <div className="ledger-heading">
        <div><span className="section-label" id="ledger-title">Budget &amp; exposure</span><span className="ledger-number">Canonical organization total · current snapshot</span></div>
        <div className="ledger-filters"><span>{company.departmentName}</span><span>Current snapshot</span></div>
      </div>
      <div className="metric-row">
        <Metric label="Authorized" value={budget.authorized} detail="Binding hard cap" />
        <Metric label="Recognized" value={budget.recognized} detail="Posted transactions" />
        <Metric label="Committed" value={budget.committed} detail="Approved, not spent" />
        <Metric label="Available" value={budget.available} detail="Remaining headroom" />
      </div>
      <div className="allocation" aria-label="Allocation of authorized budget">
        <div className="allocation-title"><div><span>Capital position</span><strong>{money({ amountMinor: allocated, currency: budget.authorized.currency })}</strong><small>{Math.round(recognized + committed)}% of the authorized cap is recognized or committed</small></div><span>{money(budget.authorized)} cap</span></div>
        <div className="allocation-plot" aria-label="Bar chart of recognized, committed, and available budget">
          <i className="plot-grid grid-a" /><i className="plot-grid grid-b" /><i className="plot-grid grid-c" />
          <div><span className="recognized" style={{ height: `${recognized}%` }} /><strong>Recognized</strong><small>{money(budget.recognized)}</small></div>
          <div><span className="committed" style={{ height: `${committed}%` }} /><strong>Committed</strong><small>{money(budget.committed)}</small></div>
          <div><span className="available" style={{ height: `${available}%` }} /><strong>Available</strong><small>{money(budget.available)}</small></div>
        </div>
      </div>
      <details className="scope-overlay">
        <summary><span><strong>{company.departmentName}</strong><small>Scope view · not additive</small></span><span>View details <ChevronDown size={15} /></span></summary>
        <div className="overlay-head">
          <div><span>{company.departmentName}</span><strong>Records included in this view</strong></div>
          <small>Synthetic scenario · source rev {data.request.sourceRevision}</small>
        </div>
        <span className="scroll-hint">Scroll for more →</span>
        <div className="scope-table" role="table" tabIndex={0} aria-label={`${company.departmentName} scope view`}>
          <div className="scope-row scope-labels" role="row"><span role="columnheader">Category</span><span role="columnheader">Record class</span><span role="columnheader">Scope</span><span role="columnheader">Note</span></div>
          {company.categories.map((category, index) => (
            <div className="scope-row" role="row" key={category}>
              <span role="cell">{category}</span>
              <span role="cell">Cost category</span>
              <span role="cell">View only</span>
              <span role="cell">{index === 0 ? data.request.purpose : index === 1 ? "Recurring operations" : "Scheduled reserve"}</span>
            </div>
          ))}
        </div>
        <p className="overlay-note"><ShieldCheck size={15} /> This overlay is a scoped view of canonical records. It is not another financial total.</p>
      </details>
    </section>
  );
}

function ReviewSlip({ company, data, onApprove, busy }: { company: CompanyConfig; data: WorkspaceData; onApprove: () => void; busy: boolean }) {
  const needsReview = data.request.state === "review_required";
  return (
    <aside className={`review-slip ${needsReview ? "pending" : "clear"}`} aria-labelledby="review-title">
      <div className="review-head">
        <span className="section-label" id="review-title">{needsReview ? "One-off request" : "No request waiting"}</span>
        <span className={`state-stamp ${needsReview ? "is-pending" : "is-approved"}`}>{needsReview ? "PENDING" : "CLEAR"}</span>
      </div>
      {needsReview ? (
        <>
          <div className="review-warning"><TriangleAlert size={24} /><div><strong>Cumulative amendment limit exceeded</strong><p>The request remains at its last approved exposure until a human decides.</p></div></div>
          <dl className="review-details">
            <div><dt>Requester</dt><dd>{company.requester}</dd></div>
            <div><dt>Request</dt><dd>{data.request.purpose}</dd></div>
            <div><dt>Revised total</dt><dd>{money(data.request.fullAmount)}</dd></div>
            <div><dt>Cumulative change</dt><dd className="danger-ink">+{money(data.request.cumulativeIncrease)}</dd></div>
            <div><dt>Submitted</dt><dd>{date(data.request.submittedAt)} · {time(data.request.submittedAt)}</dd></div>
            <div><dt>Policy signal</dt><dd>{data.decisionReason.replaceAll("_", " ").toLowerCase()}</dd></div>
          </dl>
          <button className="primary-action review-trigger" type="button" onClick={onApprove} disabled={busy}>
            {busy ? <><RefreshCw className="spin" size={17} />Recording decision…</> : <>Review request <ArrowRight size={17} /></>}
          </button>
          <small className="authority-note">Authenticated human decision · simulation only</small>
        </>
      ) : (
        <div className="review-empty">
          <span><Check size={28} /></span>
          <h2>The queue is clear.</h2>
          <p>{data.request.purpose} is {data.request.state.replaceAll("_", " ")} at revision {data.request.revision}.</p>
        </div>
      )}
    </aside>
  );
}

function FinancialPulse({ company, data }: { company: CompanyConfig; data: WorkspaceData }) {
  const needsReview = data.request.state === "review_required";
  const signals = [
    { label: "Human review", metric: needsReview ? "1" : "0", state: needsReview ? "Needs decision" : "Clear", tone: needsReview ? "watch" : "healthy" },
    { label: "Forecast", metric: data.forecast.warnings.length ? "Watch" : "Ready", state: data.forecast.warnings.length ? "Check inputs" : "No warnings", tone: data.forecast.warnings.length ? "watch" : "healthy" },
    { label: "Focus", metric: company.projectName ?? company.departmentName, state: "Operating area", tone: "neutral" },
  ];
  return (
    <section className="financial-pulse" aria-labelledby="pulse-title">
      <div className="pulse-head">
        <h2 id="pulse-title">Executive monitor</h2>
        <span><DatabaseZap size={15} />Live signals</span>
      </div>
      <div className="pulse-signals">
        {signals.map((signal) => <article key={signal.label} className={signal.tone}><span>{signal.label}</span><strong>{signal.metric}</strong><small>{signal.state}</small></article>)}
      </div>
    </section>
  );
}

type Initiative = { title: string; direction: string; area: string; summary: string; why: string };

function initiativesFor(company: CompanyConfig, data: WorkspaceData): Initiative[] {
  if (company.key === "northstar") return [{ title: "Increase field equipment envelope", direction: "Increase", area: "Field equipment", summary: "Add capacity for the next Beacon pilot deployment milestone.", why: "Northstar expanded Beacon from three to six field sites. The next deployment batch needs three additional instrument kits before the October commissioning window; review the controlled increase with Field Engineering." }, { title: "Hold company trips envelope", direction: "Hold", area: "Travel", summary: "Keep field visits at the current planning level.", why: "Northstar expanded the Beacon pilot from three to six field sites. Keep travel at the approved commissioning plan until site leads confirm which visits are essential." }, { title: "Decrease cloud tooling envelope", direction: "Decrease", area: "Cloud services", summary: "Remove capacity made redundant by the shared telemetry environment.", why: "The Beacon telemetry rollout now has one shared data environment. Reduce duplicate tooling capacity while the field expansion proves whether a second production cluster is required." }];
  if (company.key === "juniper") return [{ title: "Increase utilities allocation", direction: "Increase", area: "Rent & utilities", summary: "Fund the first full operating cycle for two new kitchens.", why: "Two kitchen openings moved utility usage into a new operating pattern. Add a controlled allocation for the first full billing cycle." }, { title: "Hold labor plan", direction: "Hold", area: "Labor", summary: "Keep staffing stable until the next forecast refresh.", why: "The new delivery kitchens are still in their first staffing cycle. Hold the labor plan until shift coverage and order volume stabilize." }, { title: "Decrease food cost target", direction: "Decrease", area: "Food cost", summary: "Protect margin through tighter purchasing.", why: "Juniper added two delivery kitchens, shifting volume to a smaller vendor set. Reduce the food envelope around the new purchasing mix before the next menu cycle." }];
  return [{ title: "Increase material buffer", direction: "Increase", area: "Raw materials", summary: "Protect planned line work from supply gaps.", why: "Forge & Loom moved the line retrofit into a second production shift. Add a controlled materials buffer so the launch schedule is not exposed to supplier lead times." }, { title: "Hold lease exposure", direction: "Hold", area: "Equipment leases", summary: "Keep equipment lease growth paused.", why: "The line retrofit is still validating throughput on the first shift. Hold new lease exposure until the operating plan confirms the second-shift equipment need." }, { title: "Decrease freight budget", direction: "Decrease", area: "Freight", summary: "Remove expedited capacity after the retrofit delivery peak.", why: "The largest retrofit component batches have landed. Reduce the premium freight envelope while remaining deliveries move to the scheduled carrier plan." }];
}

function ExecutivePriorities({ company, data, onOpenRequests, onOpenForecast }: { company: CompanyConfig; data: WorkspaceData; onOpenRequests: () => void; onOpenForecast: () => void }) {
  const reviewRequired = data.request.state === "review_required";
  const strategic = initiativesFor(company, data);
  return <section className="executive-priorities" aria-labelledby="priorities-title"><div className="register-heading"><div><h2 id="priorities-title">Strategic proposals</h2><small>Big-picture changes for human review</small></div><span>Scenario guidance</span></div><div>{strategic.map((proposal) => <article key={proposal.title}><span className="proposal-direction">{proposal.direction}</span><div><strong>{proposal.title}</strong><p>WHY: {proposal.why}</p></div><button type="button" onClick={onOpenForecast}>Inspect why</button></article>)}</div><footer>{reviewRequired ? "A separate one-off request is waiting for a human decision." : "No one-off purchase decision is waiting."}<button type="button" onClick={onOpenRequests}>{reviewRequired ? "Open request" : "Requests"}</button></footer></section>;
}

function DecisionTrace({ company, data }: { company: CompanyConfig; data: WorkspaceData }) {
  const hasReview = data.request.state === "review_required";
  return (
    <section className="decision-trace" aria-labelledby="decision-trace-title">
      <div className="register-heading"><h2 id="decision-trace-title">Decision path</h2><span>Traceable</span></div>
      <ol>
        <li title={`${money(data.budget.available)} available under the canonical cap`}><span className="trace-step recorded"><Check size={14} /></span><strong>Cap</strong></li>
        <li title={data.decisionReason.replaceAll("_", " ")}><span className="trace-step recorded"><Check size={14} /></span><strong>Policy</strong></li>
        <li title={`${data.evidence.length} cited sources in Memory`}><span className="trace-step evidence"><ScanSearch size={14} /></span><strong>Evidence</strong></li>
        <li title={hasReview ? `${company.approver} must decide` : "Human decision recorded"}><span className={`trace-step ${hasReview ? "pending" : "recorded"}`}>{hasReview ? <CircleAlert size={14} /> : <Check size={14} />}</span><strong>{hasReview ? "Review" : "Recorded"}</strong></li>
      </ol>
    </section>
  );
}

function PortfolioScope({ company, data }: { company: CompanyConfig; data: WorkspaceData }) {
  return <section className="portfolio-scope" aria-label="Executive budget scope"><span>Company cap <strong>{money(data.budget.authorized)}</strong></span><span>Department <strong>{company.departmentName}</strong></span><span>Project <strong>{company.projectName ?? "—"}</strong><em>{company.projectName ? "No cap" : "Not used"}</em></span></section>;
}

function Overview({ company, data, onApprove, onOpenRequests, onOpenForecast, approving, streaming }: { company: CompanyConfig; data: WorkspaceData; onApprove: () => void; onOpenRequests: () => void; onOpenForecast: () => void; approving: boolean; streaming: boolean }) {
  return (
    <>
      <FinancialPulse company={company} data={data} />
      <div className="overview-grid executive-grid">
        <ExecutivePriorities company={company} data={data} onOpenRequests={onOpenRequests} onOpenForecast={onOpenForecast} />
        <ReviewSlip company={company} data={data} onApprove={onApprove} busy={approving} />
      </div>
      <div className="lower-registers">
          <ActivityRegister company={company} data={data} compact streaming={streaming} />
        <ForecastStrip data={data} />
      </div>
      <DecisionTrace company={company} data={data} />
    </>
  );
}

function ActivityRegister({ company, data, compact = false, streaming = false, historyFocus }: { company: CompanyConfig; data: WorkspaceData; compact?: boolean; streaming?: boolean; historyFocus?: string | null }) {
  const [activity, setActivity] = useState(data.activity);
  const [feedState, setFeedState] = useState<"live" | "degraded">("live");
  const focusedActivity = historyFocus ? activity.filter((item) => item.summary.toLowerCase().includes(historyFocus.toLowerCase())) : activity;
  const items = compact ? focusedActivity.slice(0, 5) : focusedActivity;
  const [now, setNow] = useState(Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => setActivity(data.activity), [data.activity]);
  useEffect(() => {
    if (streaming) return;
    let active = true;
    const interval = window.setInterval(() => {
      loadActivity(company).then((next) => {
        if (active) { setActivity(next); setFeedState("live"); }
      }).catch(() => { if (active) setFeedState("degraded"); });
    }, 5_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [company, streaming]);
  if (compact) {
    const groups = ["decision", "request", "posting"].map((type) => ({ type, count: activity.filter((item) => item.type === type).length }));
    const maxCount = Math.max(...groups.map((group) => group.count), 1);
    return (
      <section className="register activity-overview" aria-labelledby="activity-title">
          <div className="register-heading"><div><h2 id="activity-title">Activity</h2><small>{activity.length} events</small></div><span className={`live-feed ${feedState === "degraded" ? "degraded" : ""}`} role="status"><i />{streaming ? "Faker · 1.2s" : feedState === "live" ? "Live · 5s" : "Delayed"}</span></div>
        <div className="event-chart" role="img" aria-label={`${groups.map((group) => `${group.count} ${group.type}`).join(", ")} events`}>
          {groups.map((group) => <div key={group.type}><span><i style={{ height: `${Math.max(8, group.count / maxCount * 100)}%` }} /></span><strong>{group.count}</strong><small>{group.type}</small></div>)}
        </div>
        <PortfolioScope company={company} data={data} />
        <div className="recent-events">{activity.slice(0, 3).map((item) => <div key={item.id}><i /><span>{activitySummary(item.summary, data)}</span><strong>{relativeTime(item.occurredAt, now)}</strong></div>)}</div>
      </section>
    );
  }
  return (
    <section className="register" aria-labelledby="activity-title">
      <div className="register-heading"><div><h2 id="activity-title">{historyFocus ? `${historyFocus} financial history` : "Activity stream"}</h2><small>{items.length} {historyFocus ? "linked records" : "signals"}</small></div><span className={`live-feed ${feedState === "degraded" ? "degraded" : ""}`} role="status"><i />{streaming ? "Synthetic · 1.2s" : feedState === "live" ? "Live feed · 5s" : "Feed delayed · retrying"}</span></div>
      <ActivityLens activity={activity} />
      <span className="scroll-hint">Scroll for more →</span>
      <div className="register-table" role="table" tabIndex={0} aria-label="Scrollable activity records">
        <div className="register-row register-labels" role="row"><span role="columnheader">When</span><span role="columnheader">Event</span><span role="columnheader">Summary</span><span role="columnheader">State</span></div>
        {items.map((item) => (
          <div className="activity-entry" key={item.id}>
            <div className="register-row" role="row">
              <span role="cell"><strong className="relative-time">{relativeTime(item.occurredAt, now)}</strong><small>{time(item.occurredAt)}</small></span>
              <span role="cell" className="activity-type">{item.type}</span>
              <span role="cell">{activitySummary(item.summary, data)}</span>
              <span role="cell" className="verified"><Check size={12} />Recorded<button type="button" aria-expanded={expandedId === item.id} aria-controls={`trace-${item.id}`} onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}>{expandedId === item.id ? "Hide" : "Details"}</button></span>
            </div>
            {expandedId === item.id && <div className="activity-detail" id={`trace-${item.id}`}><div><span>Trace ID</span><code>{item.id}</code></div><div><span>Exact timestamp</span><code>{item.occurredAt}</code></div><div><span>Raw contract event</span><code>{item.summary}</code></div><div><span>Source</span><code>Contract-valid synthetic stream</code></div></div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityLens({ activity }: { activity: WorkspaceData["activity"] }) {
  const types = ["decision", "request", "posting"];
  const counts = types.map((type) => ({ type, count: activity.filter((item) => item.type === type).length }));
  const max = Math.max(...counts.map((item) => item.count), 1);
  return <div className="activity-lens" aria-label="Activity by event type">{counts.map((item) => <div key={item.type}><span>{item.type}</span><i><b style={{ width: `${item.count / max * 100}%` }} /></i><strong>{item.count}</strong></div>)}</div>;
}

function ForecastChart({ data, compact = false }: { data: WorkspaceData; compact?: boolean }) {
  const actual = data.forecast.components.find((component) => component.kind === "actual_spend")?.amount.amountMinor ?? 0;
  const total = Math.max(data.forecast.total.amountMinor, 1);
  const points = Array.from({ length: 7 }, (_, index) => actual + ((total - actual) * index) / 6);
  const coordinates = points.map((value, index) => `${44 + index * 96},${190 - (value / total) * 142}`).join(" ");
  const area = `44,190 ${coordinates} 620,190`;
  return (
    <div className={`forecast-chart ${compact ? "compact" : ""}`}>
      <div className="chart-head"><div><span>Projected exposure</span><strong>{money(data.forecast.total)}</strong></div><span>Illustrative interpolation · revision {data.forecast.revision}</span></div>
      <svg viewBox="0 0 664 220" role="img" aria-labelledby={`forecast-chart-title-${compact ? "compact" : "full"}`}>
        <title id={`forecast-chart-title-${compact ? "compact" : "full"}`}>Projected exposure rises from {money({ amountMinor: actual, currency: data.forecast.total.currency })} to {money(data.forecast.total)}</title>
        {[48, 95, 142, 190].map((y) => <line key={y} x1="44" x2="620" y1={y} y2={y} className="chart-grid" />)}
        <polygon points={area} className="chart-area" />
        <polyline points={coordinates} className="chart-line" />
        {points.map((value, index) => <circle key={index} cx={44 + index * 96} cy={190 - (value / total) * 142} r={index === 0 || index === 6 ? 4 : 2.5} className="chart-point" />)}
        {!compact && <><text x="44" y="212">Now</text><text x="620" y="212" textAnchor="end">{date(data.forecast.horizonEnd)}</text><text x="48" y="42">{money(data.forecast.total)}</text><text x="48" y="184">$0.00 {data.forecast.total.currency}</text></>}
      </svg>
      {compact && <div className="compact-axis"><span>Now</span><span>{date(data.forecast.horizonEnd)}</span></div>}
      <p className="chart-disclaimer">Intermediate points interpolate between current actuals and the sourced horizon total; they are not recorded periods.</p>
    </div>
  );
}

function SpendLimitChart({ data, area, onOpenHistory }: { data: WorkspaceData; area: string; onOpenHistory: () => void }) {
  const [snapshot] = useState(data);
  const [zoom, setZoom] = useState(1);
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null);
  const history = snapshot.activity.filter((item) => item.summary.toLowerCase().includes(area.toLowerCase())).slice(0, 8).reverse();
  const isIncrease = area === "Field equipment";
  const currentSpend = isIncrease ? Math.round(snapshot.budget.recognized.amountMinor * .42) : snapshot.budget.recognized.amountMinor;
  const profile = isIncrease ? [.18, .34, .27, .54, .46, .76, .67, 1] : [.31, .42, .37, .55, .49, .70, .64, 1];
  const points = history.map((item, index) => {
    const profileIndex = Math.round(index * (profile.length - 1) / Math.max(history.length - 1, 1));
    const spend = Math.round(currentSpend * profile[profileIndex]);
    const prior = index ? Math.round(currentSpend * profile[Math.round((index - 1) * (profile.length - 1) / Math.max(history.length - 1, 1))]) : Math.round(currentSpend * .26);
    return { item, amount: Math.abs(spend - prior), spend, x: 64 + index * (600 / Math.max(history.length - 1, 1)) };
  });
  const limit = Math.max(isIncrease ? Math.round(currentSpend * .88) : snapshot.budget.authorized.amountMinor, 1);
  const coordinate = (spend: number) => 262 - Math.min(spend / (limit / zoom), 1) * 182;
  const path = points.map((point) => `${point.x},${coordinate(point.spend)}`).join(" ");
  const largest = points.reduce<typeof points[number] | null>((current, point) => !current || point.amount > current.amount ? point : current, null);
  const organizationalChange: Record<string, string> = {
    "Field equipment": "Beacon expansion: 3 to 6 sites",
    Travel: "New-site commissioning plan",
    "Cloud services": "Shared telemetry environment",
    "Food cost": "Two delivery kitchens opened",
    Labor: "New kitchen staffing cycle",
    "Rent & utilities": "New-site billing cycle",
    "Raw materials": "Second-shift retrofit launch",
    Freight: "Larger retrofit component batches",
    "Equipment leases": "Throughput validation in progress",
  };
  const changeLabel = organizationalChange[area] ?? `${area} operating plan`;
  const activePoint = hoveredPoint === null ? null : points[hoveredPoint];
  const tooltipX = activePoint && activePoint.x > 440 ? activePoint.x - 176 : (activePoint?.x ?? 0) + 12;
  const tooltipY = activePoint ? Math.max(143, coordinate(activePoint.spend) - 52) : 0;
  const calloutX = (largest?.x ?? 0) > 400 ? 54 : 378;
  const calloutEdge = calloutX === 54 ? calloutX + 278 : calloutX;
  return <section className="spend-limit-chart" aria-labelledby="spend-limit-title">
    <div className="register-heading"><div><h3 id="spend-limit-title">Spend against limit</h3><small>Fixed synthetic spend history with refunds and timing variation.</small></div><div className="chart-actions"><div className="chart-zoom" aria-label="Chart zoom"><button type="button" aria-label="Zoom out" disabled={zoom <= .75} onClick={() => setZoom((value) => Math.max(.75, value - .25))}><ZoomOut size={14} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom in" disabled={zoom >= 1.25} onClick={() => setZoom((value) => Math.min(1.25, value + .25))}><ZoomIn size={14} /></button></div><button type="button" onClick={onOpenHistory}>Open {area} history <ArrowRight size={14} /></button></div></div>
    <div className="chart-key"><span><i className="spend-key" />{isIncrease ? "Equipment spend" : "Recorded spend"} <strong>{money({ amountMinor: currentSpend, currency: snapshot.budget.authorized.currency })}</strong></span><span><i className="limit-key" />{isIncrease ? "Equipment envelope" : "Company limit"} <strong>{money({ amountMinor: limit, currency: snapshot.budget.authorized.currency })}</strong></span></div>
    {history.length ? <svg viewBox="0 0 728 320" role="img" aria-label={`${isIncrease ? "Equipment spend" : "Recorded spend"} of ${money({ amountMinor: currentSpend, currency: snapshot.budget.authorized.currency })} against a limit of ${money({ amountMinor: limit, currency: snapshot.budget.authorized.currency })}`}><line x1="64" x2="680" y1="80" y2="80" className="chart-grid" /><line x1="64" x2="680" y1="171" y2="171" className="chart-grid" /><line x1="64" x2="680" y1="262" y2="262" className="chart-grid" /><line x1="64" x2="680" y1="80" y2="80" className="limit-line" /><text x="680" y="72" textAnchor="end" className="limit-label">{isIncrease ? "Equipment envelope" : "Company limit"}</text><polyline points={path} className="spend-line" />{points.map((point, index) => <circle key={point.item.id} tabIndex={0} role="button" aria-label={`${time(point.item.occurredAt)} recorded spend ${money({ amountMinor: point.spend, currency: snapshot.budget.authorized.currency })}`} cx={point.x} cy={coordinate(point.spend)} r={point === largest ? 9 : 7} className={point === largest ? "spend-point highlighted interactive" : "spend-point interactive"} onMouseEnter={() => setHoveredPoint(index)} onMouseLeave={() => setHoveredPoint(null)} onFocus={() => setHoveredPoint(index)} onBlur={() => setHoveredPoint(null)} />)}{activePoint && <g className="point-tooltip"><rect x={tooltipX} y={tooltipY} width="164" height="43" rx="4" /><text x={tooltipX + 9} y={tooltipY + 17}>{time(activePoint.item.occurredAt)}</text><text x={tooltipX + 9} y={tooltipY + 34}>{money({ amountMinor: activePoint.spend, currency: snapshot.budget.authorized.currency })}</text></g>}{largest && <g className="chart-callout"><path d={`M ${calloutEdge} 146 L ${largest.x} ${coordinate(largest.spend) - 12}`} /><rect x={calloutX} y="34" width="296" height="112" rx="4" /><text x={calloutX + 14} y="60" className="callout-title">Why this changed</text><text x={calloutX + 14} y="88" className="callout-detail">Largest movement: {money({ amountMinor: largest.amount, currency: snapshot.budget.authorized.currency })}</text><text x={calloutX + 14} y="116" className="callout-detail">{changeLabel}</text></g>}<text x="64" y="294">Start</text><text x="680" y="294" textAnchor="end">Current</text></svg> : <p className="history-empty">No area-tagged entries are available yet. The next recorded posting will appear here.</p>}
  </section>;
}

function ForecastStrip({ data }: { data: WorkspaceData }) {
  const max = Math.max(...data.forecast.components.map((component) => Math.abs(component.amount.amountMinor)), 1);
  return (
    <section className="forecast-strip" aria-labelledby="forecast-strip-title">
      <div className="register-heading"><h2 id="forecast-strip-title">Forecast horizon</h2><span>Revision {data.forecast.revision}</span></div>
      <div className="forecast-total"><span>Projected through {date(data.forecast.horizonEnd)}</span><strong>{money(data.forecast.total)}</strong></div>
      <ForecastChart data={data} compact />
      <div className="component-bars">
        {data.forecast.components.map((component) => (
          <div key={component.kind}><span>{component.kind.replaceAll("_", " ")}</span><i><b style={{ width: `${Math.abs(component.amount.amountMinor) / max * 100}%` }} /></i><em>{money(component.amount)}</em></div>
        ))}
      </div>
      <p className="calculation-note"><CircleDollarSign size={15} /> Deterministic calculation · no model arithmetic</p>
    </section>
  );
}

function projectLimitProposal(company: CompanyConfig, data: WorkspaceData) {
  const initiative = initiativesFor(company, data).find((item) => item.direction === "Increase") ?? initiativesFor(company, data)[0];
  const currentLimit = Math.round(data.budget.authorized.amountMinor * .22);
  const proposedLimit = Math.round(currentLimit * 1.45);
  const currency = data.budget.authorized.currency;
  return { initiative, currentLimit: { amountMinor: currentLimit, currency }, proposedLimit: { amountMinor: proposedLimit, currency }, change: { amountMinor: proposedLimit - currentLimit, currency } };
}

function RequestsView({ company, data, onInvestigate, onOpenForecast, onDeny, onApproveLimit, notice, approved }: { company: CompanyConfig; data: WorkspaceData; onInvestigate: () => void; onOpenForecast: () => void; onDeny: () => void; onApproveLimit: () => void; notice: string | null; approved: boolean }) {
  const proposal = projectLimitProposal(company, data);
  return (
    <div className="split-page">
      <section className="request-index" aria-labelledby="requests-heading">
        <div className="register-heading"><h2 id="requests-heading">Request register</h2><span>1 current</span></div>
        <article className="request-row active" aria-current="true">
          <span className={`request-state ${approved ? "approved" : "review_required"}`}>{approved ? "approved" : "project limit change"}</span>
          <strong>{proposal.initiative.title}</strong>
          <span>{company.projectName ?? company.departmentName} · linked to {proposal.initiative.area}</span>
          <b>+{money(proposal.change)}</b>
          </article>
          <ProjectLimitImpact proposal={proposal} projectName={company.projectName ?? company.departmentName} />
          <section className="request-actions" aria-labelledby="request-actions-title"><div><h3 id="request-actions-title">Decide this project limit</h3><p>WHY: {proposal.initiative.why} This proposal changes a project envelope, not an individual purchase.</p></div><div><button type="button" onClick={onInvestigate}>Investigate evidence</button><button type="button" onClick={onOpenForecast}>Open linked initiative</button><button type="button" className="deny-action" onClick={onDeny} disabled={approved}>Decline limit change</button><button type="button" className="primary-action" onClick={onApproveLimit} disabled={approved}>{approved ? "Limit approved" : "Approve limit change"}</button></div>{notice && <p className="request-notice" role="status">{notice}</p>}</section>
          <div className="empty-ledger"><FileCheck2 size={22} /><p>No more requests in this synthetic scenario.</p></div>
      </section>
      <aside className="project-limit-card"><span>Linked initiative</span><h2>{proposal.initiative.title}</h2><p>{proposal.initiative.summary}</p><dl><div><dt>Current project limit</dt><dd>{money(proposal.currentLimit)}</dd></div><div><dt>Proposed project limit</dt><dd>{money(proposal.proposedLimit)}</dd></div><div><dt>Change requested</dt><dd>+{money(proposal.change)}</dd></div><div><dt>Decision owner</dt><dd>{company.approver}</dd></div></dl><small>{approved ? "Approved in this synthetic scenario" : "Proposal only · requires an explicit human decision"}</small></aside>
    </div>
  );
}

function ProjectLimitImpact({ proposal, projectName }: { proposal: ReturnType<typeof projectLimitProposal>; projectName: string }) {
  const cap = Math.max(proposal.proposedLimit.amountMinor, 1);
  const lanes = [
    { label: "Current project limit", amount: proposal.currentLimit, tone: "committed" },
    { label: "Limit increase", amount: proposal.change, tone: "request" },
    { label: "Proposed project limit", amount: proposal.proposedLimit, tone: "available" },
  ];
  return <section className="request-impact" aria-labelledby="request-impact-title"><div><h3 id="request-impact-title">Project limit change</h3><span>{projectName}</span></div>{lanes.map((lane) => <div className="impact-lane" key={lane.label}><span>{lane.label}</span><i><b className={lane.tone} style={{ width: `${Math.min(100, lane.amount.amountMinor / cap * 100)}%` }} /></i><strong>{money(lane.amount)}</strong></div>)}</section>;
}

function MemoryView({ company, data, focusArea, focusEvidence }: { company: CompanyConfig; data: WorkspaceData; focusArea?: string | null; focusEvidence?: string | null }) {
  const [query, setQuery] = useState("Budget");
  const [submittedQuery, setSubmittedQuery] = useState("Budget");
  const [selectedNode, setSelectedNode] = useState("company");
  const [graphZoom, setGraphZoom] = useState(1);
  const graphViewportRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const facts = data.facts.filter((fact) => fact.label.toLowerCase().includes(submittedQuery.trim().toLowerCase()));
  const graphNodes = [
    { id: "company", label: company.shortName, kind: "Company", x: 50, y: 50, size: "root" },
    { id: "department", label: company.departmentName, kind: "Department", x: 25, y: 24, size: "large" },
    ...(company.projectName ? [{ id: "project", label: company.projectName, kind: "Project", x: 25, y: 76, size: "large" }] : []),
    ...company.categories.slice(0, 3).map((label, index) => ({ id: `area-${index}`, label, kind: "Area", x: 76, y: [22, 50, 78][index] ?? 50, size: "area" })),
  ];
  const selected = graphNodes.find((node) => node.id === selectedNode) ?? graphNodes[0];
  const selectedArea = Number(selectedNode.replace("area-", ""));
  const selectedFacts = selectedNode === "company" || Number.isNaN(selectedArea) ? facts : facts.filter((_, index) => index % Math.max(company.categories.length, 1) === selectedArea);
  const relatedTrace = data.activity.filter((item, index) => selectedNode === "company" || index % Math.max(company.categories.length, 1) === selectedArea).slice(0, 3);
  useEffect(() => {
    const viewport = graphViewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
    viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
  }, [company.key, graphZoom]);
  useEffect(() => {
    if (!focusArea) return;
    const categoryIndex = company.categories.findIndex((category) => category.toLowerCase() === focusArea.toLowerCase());
    if (categoryIndex >= 0) setSelectedNode(`area-${categoryIndex}`);
    setQuery(focusArea);
    setSubmittedQuery(focusArea);
  }, [company.categories, focusArea]);
  return (
    <div className="memory-page">
      <form className="memory-query" onSubmit={(event) => { event.preventDefault(); setSubmittedQuery(query); }}>
        <label htmlFor="memory-search">Search company memory</label>
        <div><Search size={18} /><input id="memory-search" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="submit">Search</button></div>
        <p>Bounded to {company.name}. Sources and trust are shown on every result.</p>
        </form>
        <section className="memory-graph" aria-labelledby="memory-graph-title"><div className="register-heading"><div><h2 id="memory-graph-title">Financial memory graph</h2><small>Drag the canvas or use controls to explore connected context</small></div><div className="graph-tools" aria-label="Graph view controls"><button type="button" aria-label="Zoom out" onClick={() => setGraphZoom((value) => Math.max(.75, value - .15))}><ZoomOut size={15} /></button><span>{Math.round(graphZoom * 100)}%</span><button type="button" aria-label="Zoom in" onClick={() => setGraphZoom((value) => Math.min(1.4, value + .15))}><ZoomIn size={15} /></button><button type="button" onClick={() => { setGraphZoom(1); requestAnimationFrame(() => { const viewport = graphViewportRef.current; if (viewport) { viewport.scrollLeft = 230; viewport.scrollTop = 140; } }); }}>Center</button></div></div><div ref={graphViewportRef} className="graph-viewport" role="group" aria-label="Scrollable company financial memory" onPointerDown={(event) => { if ((event.target as Element).closest("button")) return; const viewport = graphViewportRef.current; if (!viewport) return; dragStartRef.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; viewport.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const viewport = graphViewportRef.current; const drag = dragStartRef.current; if (!viewport || !drag) return; viewport.scrollLeft = drag.left - (event.clientX - drag.x); viewport.scrollTop = drag.top - (event.clientY - drag.y); }} onPointerUp={() => { dragStartRef.current = null; }}><div className="graph-canvas" style={{ width: `${1100 * graphZoom}px`, height: `${640 * graphZoom}px` }}><svg className="graph-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{graphNodes.filter((node) => node.id !== "company").map((node) => <line key={`edge-${node.id}`} x1="50" y1="50" x2={node.x} y2={node.y} />)}</svg>{graphNodes.map((node) => <button type="button" key={node.id} className={`graph-node ${node.size} ${selectedNode === node.id ? "selected" : ""}`} style={{ left: `${node.x}%`, top: `${node.y}%` }} aria-pressed={selectedNode === node.id} onClick={() => setSelectedNode(node.id)}><strong>{node.label}</strong><small>{node.kind}</small></button>)}</div></div></section>
        <MemoryCoverage data={data} />
        <section className="fact-ledger" aria-labelledby="facts-title">
        <div className="register-heading"><div><h2 id="facts-title">{selected.label}</h2><small>Verified context connected to this node</small></div><span>{selectedFacts.length} records</span></div>
        {selectedFacts.map((fact, index) => {
          const metadata = syntheticRecordMetadata(company, selected.label, index, data.asOf);
          return <article key={`${fact.label}-${index}`}>
            <div><strong>{fact.label}</strong><span>{typeof fact.value === "object" ? money(fact.value as MoneyValue) : String(fact.value)}</span></div>
            <small><ShieldCheck size={13} />{fact.trust} · {sourceLabel(fact.source)} · synthetic</small>
            <dl className="fact-metadata"><div><dt>Counterparty</dt><dd>{metadata.counterparty}</dd></div><div><dt>Purchase order</dt><dd>{metadata.purchaseOrder}</dd></div><div><dt>Cost center</dt><dd>{metadata.costCenter}</dd></div><div><dt>Observed</dt><dd>{metadata.receivedAt}</dd></div></dl>
          </article>;
        })}
        <section className="memory-trace" aria-labelledby="memory-trace-title"><div><h3 id="memory-trace-title">Related trace</h3><span>{relatedTrace.length} events</span></div>{relatedTrace.map((item) => <button type="button" key={item.id} onClick={() => setSelectedNode("company")}><time>{time(item.occurredAt)}</time><span>{activitySummary(item.summary, data)}</span><code>{item.id}</code></button>)}</section>
        {!selectedFacts.length && <div className="empty-ledger"><Search size={20} /><p>No verified facts match this node and search.</p></div>}
      </section>
      <aside className="evidence-leaf">
        <span className="section-label">Cited evidence</span>
        {data.evidence.map((item) => <article key={item.title} className={focusEvidence === item.source ? "focused-evidence" : ""}><h2>{item.title}</h2><p>{item.content}</p><small>{item.trust} · {sourceLabel(item.source)}</small></article>)}
        <p className="evidence-warning">Evidence informs context. It does not grant spending authority.</p>
      </aside>
    </div>
  );
}

function MemoryCoverage({ data }: { data: WorkspaceData }) {
  const trusted = data.facts.filter((fact) => fact.trust === "authoritative").length;
  const total = Math.max(data.facts.length + data.evidence.length, 1);
  const sources = [...new Set([...data.facts.map((fact) => fact.source), ...data.evidence.map((item) => item.source)])];
  return <section className="memory-coverage" aria-labelledby="memory-coverage-title"><div><h2 id="memory-coverage-title">Context coverage</h2><span>{sources.length} connected source{sources.length === 1 ? "" : "s"}</span></div><div className="coverage-meter" aria-label={`${trusted} authoritative facts and ${data.evidence.length} cited evidence items`}><i style={{ width: `${trusted / total * 100}%` }} /><b style={{ width: `${data.evidence.length / total * 100}%` }} /></div><dl><div><dt>Verified facts</dt><dd>{data.facts.length}</dd></div><div><dt>Cited evidence</dt><dd>{data.evidence.length}</dd></div><div><dt>Scope</dt><dd>Company</dd></div></dl></section>;
}

function InitiativeBoard({ company, data, onOpenRequests, onOpenMemory, onOpenActivity }: { company: CompanyConfig; data: WorkspaceData; onOpenRequests: () => void; onOpenMemory: (area?: string, evidence?: string) => void; onOpenActivity: (focus?: string) => void }) {
  const [selected, setSelected] = useState(0);
  const [rationaleOpen, setRationaleOpen] = useState(false);
  const initiatives = initiativesFor(company, data);
  const initiative = initiatives[selected];
  const evidence = data.evidence[0];
  const linkedHistory = data.activity.filter((item) => item.summary.toLowerCase().includes(initiative.area.toLowerCase())).slice(0, 6);
  if (rationaleOpen) return <section className="initiative-rationale" aria-labelledby="rationale-title"><header><button type="button" onClick={() => setRationaleOpen(false)}>← Initiatives</button><span>{initiative.direction} proposal</span></header><div className="rationale-intro"><h2 id="rationale-title">{initiative.title}</h2><p>{initiative.summary}</p></div><dl><div><dt>Why now</dt><dd>{initiative.why}</dd></div><div><dt>Decision owner</dt><dd>Finance lead with area owner</dd></div><div><dt>Next step</dt><dd>Review linked requests before changing a budget.</dd></div></dl><section className="rationale-evidence" aria-labelledby="connected-data-title"><div className="register-heading"><div><h3 id="connected-data-title">Connected data</h3><small>Open the underlying context before deciding.</small></div><span>{linkedHistory.length} linked events</span></div><div className="rationale-links"><button type="button" onClick={() => onOpenMemory(initiative.area)}><span>Area context</span><strong>{initiative.area}</strong><small>Open the selected area records</small><ArrowRight size={15} /></button><button type="button" onClick={() => onOpenActivity(initiative.area)}><span>Financial history</span><strong>{linkedHistory.length} linked events</strong><small>Open timestamped entries for this area</small><ArrowRight size={15} /></button><button type="button" onClick={onOpenRequests}><span>Related request</span><strong>{data.request.state}</strong><small>{money(data.request.fullAmount)} · {data.request.revision}</small><ArrowRight size={15} /></button><button type="button" onClick={() => onOpenMemory(undefined, evidence?.source)}><span>Evidence source</span><strong>{sourceLabel(evidence?.source ?? "Connected source")}</strong><small>{evidence?.title ?? "Open cited evidence"}</small><ArrowRight size={15} /></button></div></section><SpendLimitChart data={data} area={initiative.area} onOpenHistory={() => onOpenActivity(initiative.area)} /><section className="rationale-map" aria-labelledby="rationale-map-title"><div className="register-heading"><div><h3 id="rationale-map-title">Decision path</h3><small>Each node opens its supporting financial record.</small></div><span>Revision {data.forecast.revision}</span></div><div className="rationale-graph" role="group" aria-label={`Linked data for ${initiative.title}`}><svg viewBox="0 0 1000 300" preserveAspectRatio="none"><path d="M500 150 L195 70 M500 150 L195 235 M500 150 L805 70 M500 150 L805 235" /></svg><button type="button" className="rationale-node area-node" onClick={() => onOpenMemory(initiative.area)}><small>Area records</small><strong>{initiative.area}</strong></button><button type="button" className="rationale-node evidence-node" onClick={() => onOpenMemory(undefined, evidence?.source)}><small>Evidence source</small><strong>{sourceLabel(evidence?.source ?? "Source")}</strong></button><span className="rationale-node initiative-node"><small>Initiative</small><strong>{initiative.title}</strong></span><button type="button" className="rationale-node forecast-node" onClick={() => onOpenActivity(initiative.area)}><small>History records</small><strong>{linkedHistory.length} events</strong></button><button type="button" className="rationale-node request-node" onClick={onOpenRequests}><small>Request record</small><strong>{data.request.revision}</strong></button></div></section><footer><span>Proposal only · no budget is changed here</span><button type="button" onClick={onOpenRequests}>Open related requests</button></footer></section>;
  return <section className="initiative-board" aria-labelledby="initiatives-title"><div className="register-heading"><div><h2 id="initiatives-title">Initiatives</h2><small>Strategic budget proposals; not automatic changes.</small></div><span>Human decision required</span></div><div className="initiative-list">{initiatives.map((item, index) => <button type="button" key={item.title} className={selected === index ? "selected" : ""} aria-pressed={selected === index} onClick={() => { setSelected(index); setRationaleOpen(true); }}><span>{item.direction}</span><div><strong>{item.title}</strong><small>{item.summary}</small></div><ArrowRight size={16} /></button>)}</div></section>;
}

function ForecastView({ company, data, onOpenRequests, onOpenMemory, onOpenActivity }: { company: CompanyConfig; data: WorkspaceData; onOpenRequests: () => void; onOpenMemory: (area?: string, evidence?: string) => void; onOpenActivity: (focus?: string) => void }) {
  const [scenario, setScenario] = useState<"baseline" | "controlled" | "growth">("baseline");
  const adjustment = scenario === "controlled" ? -0.08 : scenario === "growth" ? 0.12 : 0;
  const scenarioTotal = { ...data.forecast.total, amountMinor: Math.round(data.forecast.total.amountMinor * (1 + adjustment)) };
  return (
    <div className="forecast-page">
      <InitiativeBoard company={company} data={data} onOpenRequests={onOpenRequests} onOpenMemory={onOpenMemory} onOpenActivity={onOpenActivity} />
        <aside className="calculation-sheet scenario-sheet">
          <h2>Planning lens</h2>
          <p>Compare one assumption. This never changes the recorded forecast or a budget.</p>
          <div className="scenario-options" role="radiogroup" aria-label="Planning scenario">
            <button type="button" role="radio" aria-checked={scenario === "baseline"} className={scenario === "baseline" ? "selected" : ""} onClick={() => setScenario("baseline")}><span>Baseline</span><small>Recorded snapshot</small></button>
            <button type="button" role="radio" aria-checked={scenario === "controlled"} className={scenario === "controlled" ? "selected" : ""} onClick={() => setScenario("controlled")}><span>Conserve</span><small>8% lower exposure</small></button>
            <button type="button" role="radio" aria-checked={scenario === "growth"} className={scenario === "growth" ? "selected" : ""} onClick={() => setScenario("growth")}><span>Growth</span><small>12% higher exposure</small></button>
          </div>
          <div className="scenario-result"><span><SlidersHorizontal size={14} />Illustrative planning total</span><strong>{money(scenarioTotal)}</strong><small>{adjustment === 0 ? "Matches the current recorded forecast." : `${adjustment > 0 ? "+" : ""}${Math.round(adjustment * 100)}% from the recorded forecast; not a budget change.`}</small></div>
          <div className="calculation-divider" />
          <h2 className="record-heading">Calculation record</h2>
          <dl><div><dt>Revision</dt><dd>{data.forecast.revision}</dd></div><div><dt>As-of cutoff</dt><dd>{date(data.forecast.asOf)}</dd></div><div><dt>Confidence</dt><dd>Uncalibrated</dd></div><div><dt>Coverage</dt><dd>{data.forecast.warnings.length ? "Warnings present" : "No warnings"}</dd></div></dl>
          <p>Immutable synthetic snapshot. Recommendations inform a human decision; they do not approve or change spend.</p>
      </aside>
    </div>
  );
}

function ErrorState({ error, retry }: { error: ReturnType<typeof describeError>; retry: () => void }) {
  const unavailable = error.code === "DEPENDENCY_UNAVAILABLE";
  return (
    <main className="error-state" id="main-content">
      <div className="errata-slip"><span>ERRATA · {error.code}</span><TriangleAlert size={34} /><h1>{unavailable ? "The data service is unavailable." : "Workspace data could not be validated."}</h1><p>{unavailable ? "No financial state is shown from cache. Start or reconnect the data service, then try again." : error.message}</p><dl><div><dt>Retryable</dt><dd>{error.retryable ? "Yes" : "No"}</dd></div><div><dt>Correlation</dt><dd>{error.correlationId}</dd></div></dl><button className="primary-action" onClick={retry}><RefreshCw size={17} />Try again</button></div>
    </main>
  );
}

export default function App() {
  const companySelectId = useId();
  const stateSelectId = useId();
  const [companyKey, setCompanyKey] = useState<CompanyKey>("northstar");
  const [demoState, setDemoState] = useState<DemoState>("review");
  const [view, setView] = useState<View>("overview");
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState<ReturnType<typeof describeError> | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [projectLimitConfirmOpen, setProjectLimitConfirmOpen] = useState(false);
  const [projectLimitApproved, setProjectLimitApproved] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [denyNotice, setDenyNotice] = useState<string | null>(null);
  const [projectLimitNotice, setProjectLimitNotice] = useState<string | null>(null);
  const [memoryFocus, setMemoryFocus] = useState<{ area?: string; evidence?: string } | null>(null);
  const [historyFocus, setHistoryFocus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const company = useMemo(() => companies.find((item) => item.key === companyKey) ?? companies[0], [companyKey]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
      loadWorkspace(company, demoState).then((next) => {
        if (active) setData(streamEnabled ? seedSyntheticHistory(next, company) : next);
    }).catch((reason) => {
      if (active) setError(describeError(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [company, demoState, reloadKey, streamEnabled]);

  useEffect(() => {
    if (!streamEnabled || demoState === "unavailable") return;
    let tick = 0;
    const interval = window.setInterval(() => {
      tick += 1;
      const occurredAt = new Date().toISOString();
      setData((current) => {
        if (!current) return current;
        void ingestSyntheticTick(company, tick, current.budget.authorized.currency, occurredAt).catch((reason) => console.warn("Synthetic delivery was not mirrored to the local API", reason));
        return advanceSyntheticStream(current, company, tick, occurredAt);
      });
    }, 1_200);
    return () => window.clearInterval(interval);
  }, [company, demoState, reloadKey, streamEnabled]);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setView("memory");
        requestAnimationFrame(() => document.getElementById("memory-search")?.focus());
      }
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  useEffect(() => {
    if (confirmOpen || projectLimitConfirmOpen) dialogRef.current?.focus();
  }, [confirmOpen, projectLimitConfirmOpen]);

  function closeConfirmation() {
    setConfirmOpen(false);
    setProjectLimitConfirmOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".review-trigger")?.focus());
  }

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeConfirmation();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function handleApprove() {
    if (!data) return;
    setApproving(true);
    try {
      await approveReview(company, data.request.revision);
      closeConfirmation();
      setDemoState("baseline");
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setApproving(false);
    }
  }

  function handleProjectLimitApprove() {
    setProjectLimitApproved(true);
    setProjectLimitConfirmOpen(false);
    setProjectLimitNotice(`Approved by ${company.approver} in this synthetic scenario. A policy-backed command still records the canonical project limit.`);
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" tabIndex={confirmOpen || projectLimitConfirmOpen ? -1 : undefined}>Skip to content</a>
      <aside inert={confirmOpen || projectLimitConfirmOpen ? true : undefined} id="primary-navigation" className={`side-rail ${menuOpen ? "open" : ""}`} aria-label="Primary navigation">
        <div className="brand"><span className="brand-mark" aria-hidden="true">A</span><strong>Alloc</strong><button className="mobile-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}><X /></button></div>
        <nav>{navItems.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setMenuOpen(false); }}><Icon size={19} /><span>{item.label}</span></button>; })}</nav>
        <div className="rail-companies"><span>Companies</span>{companies.map((item) => <button type="button" key={item.key} className={companyKey === item.key ? "active" : ""} onClick={() => { setCompanyKey(item.key); setMenuOpen(false); }}><i />{item.shortName}</button>)}</div>
        <div className="rail-footer"><span className="avatar">{company.approverInitials}</span><span><strong>{company.approver}</strong><small>Finance approver</small></span></div>
      </aside>
      <div className="workspace" inert={confirmOpen || projectLimitConfirmOpen ? true : undefined}>
        <div className="utility-bar">
          <button className="menu-button" aria-label="Open navigation" aria-controls="primary-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu /></button>
          <div className="company-control"><Building2 size={15} /><label htmlFor={companySelectId}>Company</label><select id={companySelectId} value={companyKey} onChange={(event) => setCompanyKey(event.target.value as CompanyKey)}>{companies.map((item) => <option value={item.key} key={item.key}>{item.shortName}</option>)}</select><ChevronDown size={14} aria-hidden="true" /></div>
          <button className="command-search" type="button" aria-label="Search memory or jump" onClick={() => { setView("memory"); requestAnimationFrame(() => document.getElementById("memory-search")?.focus()); }}><Search size={14} /><span>Search memory or jump to…</span><kbd>⌘ K</kbd></button>
            <div className="demo-control"><label htmlFor={stateSelectId}>Demo state</label><select id={stateSelectId} value={demoState} onChange={(event) => setDemoState(event.target.value as DemoState)}><option value="review">Needs review</option><option value="baseline">Baseline</option><option value="unavailable">API unavailable</option></select><ChevronDown size={14} aria-hidden="true" /></div>
            <button className={`stream-control ${streamEnabled ? "on" : ""}`} type="button" aria-pressed={streamEnabled} onClick={() => setStreamEnabled((enabled) => !enabled)}><span className="status-dot" />{streamEnabled ? "Faker stream" : "Stream paused"}</button>
        </div>
        {loading ? <main className="loading-sheet" id="main-content" aria-live="polite"><span className="loading-rule" /><h1>Opening the {company.shortName} workspace…</h1><p>Validating responses against contract v1.0.0</p></main> : error ? <ErrorState error={error} retry={() => setReloadKey((value) => value + 1)} /> : data ? (
          <main className="main-canvas" id="main-content">
            <TitleBlock company={company} data={data} view={view} />
            {view === "overview" && <Overview company={company} data={data} onApprove={() => setConfirmOpen(true)} onOpenRequests={() => setView("requests")} onOpenForecast={() => setView("forecast")} approving={approving} streaming={streamEnabled} />}
            {view === "requests" && <RequestsView company={company} data={data} onInvestigate={() => setView("memory")} onOpenForecast={() => setView("forecast")} onDeny={() => setProjectLimitNotice("Decline is staged for human confirmation. This project envelope remains unchanged until a typed decision command is connected.")} onApproveLimit={() => setProjectLimitConfirmOpen(true)} notice={projectLimitNotice ?? denyNotice} approved={projectLimitApproved} />}
            {view === "memory" && <MemoryView company={company} data={data} focusArea={memoryFocus?.area} focusEvidence={memoryFocus?.evidence} />}
            {view === "forecast" && <ForecastView company={company} data={data} onOpenRequests={() => setView("requests")} onOpenMemory={(area, evidence) => { setMemoryFocus({ area, evidence }); setView("memory"); }} onOpenActivity={(focus) => { setHistoryFocus(focus ?? null); setView("activity"); }} />}
            {view === "activity" && <ActivityRegister company={company} data={data} streaming={streamEnabled} historyFocus={historyFocus} />}
            <footer className="page-footer"><span>ALLOC · synthetic finance simulation</span><span>{data.scenarioId}</span></footer>
          </main>
        ) : null}
      </div>
      {confirmOpen && data ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={closeConfirmation}>
          <section ref={dialogRef} tabIndex={-1} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="decision-title" onKeyDown={handleDialogKeyDown} onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-head"><div><span>Human decision</span><h2 id="decision-title">Approve revision {data.request.revision}?</h2></div><button type="button" aria-label="Close decision" onClick={closeConfirmation}><X size={18} /></button></div>
            <div className="dialog-warning"><TriangleAlert size={18} /><p><strong>Cumulative amendment limit exceeded.</strong> Confirm the revised full amount and acting authority before recording this decision.</p></div>
            <dl className="review-details dialog-details"><div><dt>Request</dt><dd>{data.request.purpose}</dd></div><div><dt>Revised total</dt><dd>{money(data.request.fullAmount)}</dd></div><div><dt>Cumulative change</dt><dd className="danger-ink">+{money(data.request.cumulativeIncrease)}</dd></div><div><dt>Acting approver</dt><dd>{company.approver}</dd></div></dl>
            <p className="dialog-authority"><ShieldCheck size={15} />This records an authenticated human decision in the synthetic scenario. No model has execution authority.</p>
            <div className="dialog-actions"><button type="button" className="secondary-action" onClick={closeConfirmation}>Cancel</button><button type="button" className="primary-action" disabled={approving} onClick={handleApprove}>{approving ? <><RefreshCw className="spin" size={17} />Recording…</> : <>Approve revision {data.request.revision}<ArrowRight size={16} /></>}</button></div>
          </section>
        </div>
      ) : null}
      {projectLimitConfirmOpen && data ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={closeConfirmation}>
          <section ref={dialogRef} tabIndex={-1} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="limit-decision-title" onKeyDown={handleDialogKeyDown} onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-head"><div><span>Human decision</span><h2 id="limit-decision-title">Approve project limit?</h2></div><button type="button" aria-label="Close decision" onClick={closeConfirmation}><X size={18} /></button></div>
            <div className="dialog-warning"><TriangleAlert size={18} /><p><strong>Project envelope change.</strong> Confirm the operating milestone, proposed limit, and acting authority before recording this decision.</p></div>
            <dl className="review-details dialog-details"><div><dt>Initiative</dt><dd>{projectLimitProposal(company, data).initiative.title}</dd></div><div><dt>Current limit</dt><dd>{money(projectLimitProposal(company, data).currentLimit)}</dd></div><div><dt>Proposed limit</dt><dd>{money(projectLimitProposal(company, data).proposedLimit)}</dd></div><div><dt>Acting approver</dt><dd>{company.approver}</dd></div></dl>
            <p className="dialog-authority"><ShieldCheck size={15} />This records a human decision in the synthetic scenario. No model has execution authority.</p>
            <div className="dialog-actions"><button type="button" className="secondary-action" onClick={closeConfirmation}>Cancel</button><button type="button" className="primary-action" onClick={handleProjectLimitApprove}>Approve limit change<ArrowRight size={16} /></button></div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
