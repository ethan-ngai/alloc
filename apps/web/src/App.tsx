import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  CircleDollarSign,
  FileCheck2,
  Gauge,
  LayoutDashboard,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
  X,
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
  const posting = value.match(/^Posting \S+ posted (\d+) ([A-Z]{3})$/);
  if (posting) return `Posting recorded · ${money({ amountMinor: Number(posting[1]), currency: posting[2] })}`;
  const request = value.match(/^Request \S+ revision (\d+) (.+)$/);
  if (request) return `${data.request.purpose} · revision ${request[1]} · ${request[2].replaceAll("_", " ")}${Number(request[1]) === data.request.revision ? ` · ${money(data.request.fullAmount)}` : ""}`;
  const decision = value.match(/^Decision \S+ (.+) for \S+ revision (\d+)$/);
  if (decision) return `${data.request.purpose} · ${decision[1].replaceAll("_", " ")} · revision ${decision[2]}`;
  return value.replaceAll("_", " ");
}

function TitleBlock({ company, data, view }: { company: CompanyConfig; data: WorkspaceData; view: View }) {
  const title = navItems.find((item) => item.id === view)?.label;
  return (
    <header className="title-block">
      <div>
        <h1>{title}</h1>
        <div className="title-meta">
          <span>{company.name}</span>
          <span aria-hidden="true">·</span>
          <span className="synthetic-mark"><span className="status-dot" />Synthetic mock data</span>
          <span aria-hidden="true">·</span>
          <span>As of {date(data.asOf)}</span>
        </div>
      </div>
      <div className="api-seal" role="status" aria-label="Mock API connected">
        <span className="seal-mark"><Check size={13} strokeWidth={3} /></span>
        <span><strong>Contract valid</strong><small>Mock API · v1.0.0</small></span>
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
          <small>Mock scenario v1 · source rev {data.request.sourceRevision}</small>
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
        <span className="section-label" id="review-title">{needsReview ? "Needs a human" : "No review waiting"}</span>
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
          <small className="authority-note">Authenticated human decision · mocked for demonstration</small>
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

function Overview({ company, data, onApprove, approving }: { company: CompanyConfig; data: WorkspaceData; onApprove: () => void; approving: boolean }) {
  return (
    <>
      <div className="overview-grid">
        <ExposureLedger company={company} data={data} />
        <ReviewSlip company={company} data={data} onApprove={onApprove} busy={approving} />
      </div>
      <div className="lower-registers">
        <ActivityRegister company={company} data={data} compact />
        <ForecastStrip data={data} />
      </div>
    </>
  );
}

function ActivityRegister({ company, data, compact = false }: { company: CompanyConfig; data: WorkspaceData; compact?: boolean }) {
  const [activity, setActivity] = useState(data.activity);
  const [feedState, setFeedState] = useState<"live" | "degraded">("live");
  const items = compact ? activity.slice(0, 5) : activity;
  const [now, setNow] = useState(Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => setActivity(data.activity), [data.activity]);
  useEffect(() => {
    let active = true;
    const interval = window.setInterval(() => {
      loadActivity(company).then((next) => {
        if (active) { setActivity(next); setFeedState("live"); }
      }).catch(() => { if (active) setFeedState("degraded"); });
    }, 5_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [company]);
  if (compact) {
    const groups = ["decision", "request", "posting"].map((type) => ({ type, count: activity.filter((item) => item.type === type).length }));
    const maxCount = Math.max(...groups.map((group) => group.count), 1);
    return (
      <section className="register activity-overview" aria-labelledby="activity-title">
        <div className="register-heading"><div><h2 id="activity-title">Activity</h2><small>{activity.length} contract events in this scenario</small></div><span className={`live-feed ${feedState === "degraded" ? "degraded" : ""}`} role="status"><i />{feedState === "live" ? "Live · 5s" : "Delayed"}</span></div>
        <div className="event-chart" role="img" aria-label={`${groups.map((group) => `${group.count} ${group.type}`).join(", ")} events`}>
          {groups.map((group) => <div key={group.type}><span><i style={{ height: `${Math.max(8, group.count / maxCount * 100)}%` }} /></span><strong>{group.count}</strong><small>{group.type}</small></div>)}
        </div>
        <div className="recent-events">{activity.slice(0, 3).map((item) => <div key={item.id}><i /><span>{activitySummary(item.summary, data)}</span><strong>{relativeTime(item.occurredAt, now)}</strong></div>)}</div>
      </section>
    );
  }
  return (
    <section className="register" aria-labelledby="activity-title">
      <div className="register-heading"><div><h2 id="activity-title">Activity stream</h2><small>Human-readable events with trace detail on demand</small></div><span className={`live-feed ${feedState === "degraded" ? "degraded" : ""}`} role="status"><i />{feedState === "live" ? "Live mock feed · 5s" : "Feed delayed · retrying"}</span></div>
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
            {expandedId === item.id && <div className="activity-detail" id={`trace-${item.id}`}><div><span>Trace ID</span><code>{item.id}</code></div><div><span>Exact timestamp</span><code>{item.occurredAt}</code></div><div><span>Raw contract event</span><code>{item.summary}</code></div><div><span>Source</span><code>Contract-valid mock stream</code></div></div>}
          </div>
        ))}
      </div>
    </section>
  );
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
      <p className="calculation-note"><CircleDollarSign size={15} /> Deterministic mock calculation · no model arithmetic</p>
    </section>
  );
}

function RequestsView({ company, data, onApprove, approving }: { company: CompanyConfig; data: WorkspaceData; onApprove: () => void; approving: boolean }) {
  return (
    <div className="split-page">
      <section className="request-index" aria-labelledby="requests-heading">
        <div className="register-heading"><h2 id="requests-heading">Request register</h2><span>1 current</span></div>
        <article className="request-row active" aria-current="true">
          <span className={`request-state ${data.request.state}`}>{data.request.state.replaceAll("_", " ")}</span>
          <strong>{data.request.purpose}</strong>
          <span>{company.requester} · revision {data.request.revision}</span>
          <b>{money(data.request.fullAmount)}</b>
        </article>
        <div className="empty-ledger"><FileCheck2 size={22} /><p>No more requests in this synthetic scenario.</p></div>
      </section>
      <ReviewSlip company={company} data={data} onApprove={onApprove} busy={approving} />
    </div>
  );
}

function MemoryView({ company, data }: { company: CompanyConfig; data: WorkspaceData }) {
  const [query, setQuery] = useState("Budget");
  const [submittedQuery, setSubmittedQuery] = useState("Budget");
  const facts = data.facts.filter((fact) => fact.label.toLowerCase().includes(submittedQuery.trim().toLowerCase()));
  return (
    <div className="memory-page">
      <form className="memory-query" onSubmit={(event) => { event.preventDefault(); setSubmittedQuery(query); }}>
        <label htmlFor="memory-search">Search company memory</label>
        <div><Search size={18} /><input id="memory-search" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="submit">Search</button></div>
        <p>Bounded to {company.name}. Sources and trust are shown on every result.</p>
      </form>
      <section className="fact-ledger" aria-labelledby="facts-title">
        <div className="register-heading"><h2 id="facts-title">Verified facts</h2><span>{facts.length} records</span></div>
        {facts.map((fact, index) => (
          <article key={`${fact.label}-${index}`}>
            <div><strong>{fact.label}</strong><span>{typeof fact.value === "object" ? money(fact.value as MoneyValue) : String(fact.value)}</span></div>
            <small><ShieldCheck size={13} />{fact.trust} · {fact.source} · synthetic</small>
          </article>
        ))}
        {!facts.length && <div className="empty-ledger"><Search size={20} /><p>No verified facts match “{submittedQuery}”.</p></div>}
      </section>
      <aside className="evidence-leaf">
        <span className="section-label">Cited evidence</span>
        {data.evidence.map((item) => <article key={item.title}><h2>{item.title}</h2><p>{item.content}</p><small>{item.trust} · {item.source}</small></article>)}
        <p className="evidence-warning">Evidence informs context. It does not grant spending authority.</p>
      </aside>
    </div>
  );
}

function ForecastView({ data }: { data: WorkspaceData }) {
  return (
    <div className="forecast-page">
      <section className="forecast-ledger">
        <ForecastChart data={data} />
        <div className="forecast-components">
          {data.forecast.components.map((component) => <div key={component.kind}><span>{component.kind.replaceAll("_", " ")}</span><strong>{money(component.amount)}</strong><small>{component.amount.amountMinor === 0 ? "No adjustment applied" : "Contract-linked input"}</small></div>)}
          <div><span>Available headroom</span><strong>{money(data.budget.available)}</strong><small>Current canonical budget state</small></div>
        </div>
      </section>
      <aside className="calculation-sheet">
        <span className="section-label">Calculation record</span>
        <dl><div><dt>Revision</dt><dd>{data.forecast.revision}</dd></div><div><dt>As-of cutoff</dt><dd>{date(data.forecast.asOf)}</dd></div><div><dt>Confidence</dt><dd>Uncalibrated</dd></div><div><dt>Coverage</dt><dd>{data.forecast.warnings.length ? "Warnings present" : "No mock warnings"}</dd></div></dl>
        <p>The forecast snapshot is immutable mock output. Intermediate chart points are labeled interpolation; the Activity surface independently polls the mock event contract.</p>
      </aside>
    </div>
  );
}

function ErrorState({ error, retry }: { error: ReturnType<typeof describeError>; retry: () => void }) {
  const unavailable = error.code === "DEPENDENCY_UNAVAILABLE";
  return (
    <main className="error-state" id="main-content">
      <div className="errata-slip"><span>ERRATA · {error.code}</span><TriangleAlert size={34} /><h1>{unavailable ? "The mock service is unavailable." : "Workspace data could not be validated."}</h1><p>{unavailable ? "No financial state is shown from cache. Start or reconnect the mock API, then try again." : error.message}</p><dl><div><dt>Retryable</dt><dd>{error.retryable ? "Yes" : "No"}</dd></div><div><dt>Correlation</dt><dd>{error.correlationId}</dd></div></dl><button className="primary-action" onClick={retry}><RefreshCw size={17} />Try again</button></div>
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const company = useMemo(() => companies.find((item) => item.key === companyKey) ?? companies[0], [companyKey]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loadWorkspace(company, demoState).then((next) => {
      if (active) setData(next);
    }).catch((reason) => {
      if (active) setError(describeError(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [company, demoState, reloadKey]);

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
    if (confirmOpen) dialogRef.current?.focus();
  }, [confirmOpen]);

  function closeConfirmation() {
    setConfirmOpen(false);
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

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" tabIndex={confirmOpen ? -1 : undefined}>Skip to content</a>
      <aside inert={confirmOpen ? true : undefined} id="primary-navigation" className={`side-rail ${menuOpen ? "open" : ""}`} aria-label="Primary navigation">
        <div className="brand"><span className="brand-mark" aria-hidden="true">A</span><strong>Alloc</strong><button className="mobile-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}><X /></button></div>
        <nav>{navItems.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setMenuOpen(false); }}><Icon size={19} /><span>{item.label}</span></button>; })}</nav>
        <div className="rail-companies"><span>Companies</span>{companies.map((item) => <button type="button" key={item.key} className={companyKey === item.key ? "active" : ""} onClick={() => { setCompanyKey(item.key); setMenuOpen(false); }}><i />{item.shortName}</button>)}</div>
        <div className="rail-footer"><span className="avatar">{company.approverInitials}</span><span><strong>{company.approver}</strong><small>Mock approver</small></span></div>
      </aside>
      <div className="workspace" inert={confirmOpen ? true : undefined}>
        <div className="utility-bar">
          <button className="menu-button" aria-label="Open navigation" aria-controls="primary-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu /></button>
          <div className="company-control"><Building2 size={15} /><label htmlFor={companySelectId}>Company</label><select id={companySelectId} value={companyKey} onChange={(event) => setCompanyKey(event.target.value as CompanyKey)}>{companies.map((item) => <option value={item.key} key={item.key}>{item.shortName}</option>)}</select><ChevronDown size={14} aria-hidden="true" /></div>
          <button className="command-search" type="button" aria-label="Search memory or jump" onClick={() => { setView("memory"); requestAnimationFrame(() => document.getElementById("memory-search")?.focus()); }}><Search size={14} /><span>Search memory or jump to…</span><kbd>⌘ K</kbd></button>
          <div className="demo-control"><label htmlFor={stateSelectId}>Demo state</label><select id={stateSelectId} value={demoState} onChange={(event) => setDemoState(event.target.value as DemoState)}><option value="review">Needs review</option><option value="baseline">Baseline</option><option value="unavailable">API unavailable</option></select><ChevronDown size={14} aria-hidden="true" /></div>
          <span className="local-model"><span className="status-dot" />Local mode · mock data</span>
        </div>
        {loading ? <main className="loading-sheet" id="main-content" aria-live="polite"><span className="loading-rule" /><h1>Opening the {company.shortName} workspace…</h1><p>Validating mock responses against contract v1.0.0</p></main> : error ? <ErrorState error={error} retry={() => setReloadKey((value) => value + 1)} /> : data ? (
          <main className="main-canvas" id="main-content">
            <TitleBlock company={company} data={data} view={view} />
            {view === "overview" && <Overview company={company} data={data} onApprove={() => setConfirmOpen(true)} approving={approving} />}
            {view === "requests" && <RequestsView company={company} data={data} onApprove={() => setConfirmOpen(true)} approving={approving} />}
            {view === "memory" && <MemoryView company={company} data={data} />}
            {view === "forecast" && <ForecastView data={data} />}
            {view === "activity" && <ActivityRegister company={company} data={data} />}
            <footer className="page-footer"><span>ALLOC · local financial intelligence</span><span>This is synthetic, mock-backed data. Not real financial data.</span><span>{data.scenarioId}</span></footer>
          </main>
        ) : null}
      </div>
      {confirmOpen && data ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={closeConfirmation}>
          <section ref={dialogRef} tabIndex={-1} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="decision-title" onKeyDown={handleDialogKeyDown} onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-head"><div><span>Human decision</span><h2 id="decision-title">Approve revision {data.request.revision}?</h2></div><button type="button" aria-label="Close decision" onClick={closeConfirmation}><X size={18} /></button></div>
            <div className="dialog-warning"><TriangleAlert size={18} /><p><strong>Cumulative amendment limit exceeded.</strong> Confirm the revised full amount and acting authority before recording this mock decision.</p></div>
            <dl className="review-details dialog-details"><div><dt>Request</dt><dd>{data.request.purpose}</dd></div><div><dt>Revised total</dt><dd>{money(data.request.fullAmount)}</dd></div><div><dt>Cumulative change</dt><dd className="danger-ink">+{money(data.request.cumulativeIncrease)}</dd></div><div><dt>Acting approver</dt><dd>{company.approver}</dd></div></dl>
            <p className="dialog-authority"><ShieldCheck size={15} />This records an authenticated human decision in the mock scenario. No model has execution authority.</p>
            <div className="dialog-actions"><button type="button" className="secondary-action" onClick={closeConfirmation}>Cancel</button><button type="button" className="primary-action" disabled={approving} onClick={handleApprove}>{approving ? <><RefreshCw className="spin" size={17} />Recording…</> : <>Approve revision {data.request.revision}<ArrowRight size={16} /></>}</button></div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
