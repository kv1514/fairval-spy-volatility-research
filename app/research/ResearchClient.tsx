"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type TrajectoryPoint = { time: string; close: number; high: number };
type Candidate = {
  id: string;
  occ: string;
  ticker: string;
  date: string;
  expiration: string;
  phase: "calibration" | "holdout";
  optionType: "call" | "put";
  strike: number;
  dte: number;
  signalTime: string;
  entryTime?: string;
  signalPrice: number;
  entryPrice?: number;
  marketIv: number;
  forecastVol: number;
  fairIv: number;
  volEdge: number;
  fairValue: number;
  priceEdge: number;
  edgePercent: number;
  estimatedCost?: number;
  entryStatus: string;
  actionable: boolean;
  closeHit?: boolean;
  closeHitTime?: string | null;
  netPnl?: number;
  netContractDollars?: number;
  netReturnPercent?: number;
  highHit?: boolean;
  optimisticNetPnl?: number;
  finalObservedTime?: string;
  finalObservedPrice?: number;
  modelUsed: string;
  trajectory?: TrajectoryPoint[];
};

type DailyRow = {
  date: string;
  phase: "calibration" | "holdout";
  dte: number;
  expiration: string;
  contractsObserved: number;
  largeGapCandidates: number;
  actionableCandidates: number;
  noLargeGap: boolean;
  gapClosedBeforeEntry: number;
  closeHitRate: number | null;
  optimisticHitRate: number | null;
  meanNetPnl: number | null;
  totalNetContractDollars: number;
};

type DteRow = {
  dte: number;
  dataAvailable: boolean;
  observedContracts: number;
  candidates: number;
  actionable: number;
  closeHitRate: number | null;
  optimisticHitRate: number | null;
  meanNetPnl: number | null;
  meanNetContractDollars: number | null;
  winRate: number | null;
};

export type StudyData = {
  generatedAt: string;
  title: string;
  status: string;
  coverage: {
    ticker: string;
    start: string;
    end: string;
    tradingDays: number;
    expirations: string[];
    trainingExpirations: string[];
    holdoutExpirations: string[];
    uniqueContracts: number;
    maximumContractsPerDay: number;
    requestedDailyTarget: number;
    dteAvailable: number[];
    dteMissing: number[];
  };
  method: Record<string, string>;
  caveats: string[];
  policy: {
    largeGapPercent: number;
    minimumAbsoluteGap: number;
    costRate: number;
    minimumRoundTripCost: number;
  };
  selectedForecast: string;
  forecastValidation: Record<string, {
    training: { n: number; mae: number; varianceMse: number };
    holdout: { n: number; mae: number; varianceMse: number };
  }>;
  summary: {
    allActionable: { n: number; mean: number | null; median: number | null; winRate: number | null; total: number | null };
    holdoutActionable: { n: number; mean: number | null; median: number | null; winRate: number | null; total: number | null };
    allCandidates: number;
    actionableCandidates: number;
    holdoutCandidates: number;
    holdoutActionableCandidates: number;
    noLargeGapDays: number;
    closeTargetHitRate: number | null;
    holdoutCloseTargetHitRate: number | null;
    optimisticTargetHitRate: number | null;
    holdoutOptimisticTargetHitRate: number | null;
  };
  dailySummary: DailyRow[];
  dteSummary: DteRow[];
  thresholdSensitivity: Array<{ threshold: number; signals: number; uniqueDays: number }>;
  cumulative: Array<{ date: string; value: number; phase: string }>;
  candidates: Candidate[];
};

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const shortMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const percent = (value: number | null | undefined, digits = 1) => value == null
  ? "—"
  : `${(value * 100).toFixed(digits)}%`;
const signedMoney = (value: number | null | undefined) => value == null
  ? "—"
  : `${value >= 0 ? "+" : "−"}${money.format(Math.abs(value))}`;
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
}).format(new Date(`${date}T12:00:00Z`));
const candidateKey = (candidate: Candidate) => `${candidate.id}|${candidate.date}`;

function PricePathChart({ candidate }: { candidate: Candidate }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const path = candidate.trajectory ?? [];
    if (!canvas || !path.length || candidate.entryPrice == null) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * scale));
      canvas.height = Math.max(1, Math.floor(rect.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      const width = rect.width;
      const height = rect.height;
      const padding = { top: 24, right: 20, bottom: 28, left: 50 };
      const values = path.flatMap((point) => [point.close, point.high]);
      values.push(candidate.fairValue, candidate.entryPrice ?? 0);
      const minimum = Math.max(0, Math.min(...values) * 0.88);
      const maximum = Math.max(...values) * 1.08;
      const x = (index: number) => padding.left + (index / Math.max(path.length - 1, 1)) * (width - padding.left - padding.right);
      const y = (value: number) => padding.top + ((maximum - value) / Math.max(maximum - minimum, 0.01)) * (height - padding.top - padding.bottom);

      context.clearRect(0, 0, width, height);
      context.strokeStyle = "rgba(219,229,226,.11)";
      context.fillStyle = "#879994";
      context.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
      context.lineWidth = 1;
      for (let line = 0; line <= 4; line += 1) {
        const value = minimum + ((maximum - minimum) * line) / 4;
        const lineY = y(value);
        context.beginPath();
        context.moveTo(padding.left, lineY);
        context.lineTo(width - padding.right, lineY);
        context.stroke();
        context.fillText(`$${value.toFixed(2)}`, 4, lineY + 3);
      }
      context.setLineDash([6, 5]);
      context.strokeStyle = "#f1b24b";
      context.beginPath();
      context.moveTo(padding.left, y(candidate.fairValue));
      context.lineTo(width - padding.right, y(candidate.fairValue));
      context.stroke();
      context.fillStyle = "#f1b24b";
      context.fillText("FIXED FV TARGET", Math.max(padding.left, width - 116), y(candidate.fairValue) - 7);

      context.strokeStyle = "#9aa9a5";
      context.beginPath();
      context.moveTo(padding.left, y(candidate.entryPrice));
      context.lineTo(width - padding.right, y(candidate.entryPrice));
      context.stroke();
      context.setLineDash([]);

      context.strokeStyle = "#4ee5a5";
      context.lineWidth = 2.5;
      context.beginPath();
      path.forEach((point, index) => {
        if (index === 0) context.moveTo(x(index), y(point.close));
        else context.lineTo(x(index), y(point.close));
      });
      context.stroke();
      context.fillStyle = "#dbe5e2";
      context.fillText(dateLabel(path[0].time.slice(0, 10)), padding.left, height - 8);
      const endLabel = dateLabel(path.at(-1)?.time.slice(0, 10) ?? candidate.expiration);
      context.fillText(endLabel, Math.max(padding.left, width - 58), height - 8);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [candidate]);

  return (
    <div className="path-chart">
      <canvas ref={canvasRef} role="img" aria-label={`Observed price path for ${candidate.occ}; entry ${money.format(candidate.entryPrice ?? 0)}, fixed fair-value target ${money.format(candidate.fairValue)}.`} />
      <div className="chart-legend" aria-hidden="true">
        <span><i className="legend-close" />Hourly close</span>
        <span><i className="legend-target" />Fixed FV target</span>
        <span><i className="legend-entry" />Next-hour entry</span>
      </div>
    </div>
  );
}

export default function ResearchClient({ study }: { study: StudyData }) {
  const initialCandidate = study.candidates.find((candidate) => candidate.phase === "holdout" && candidate.actionable)
    ?? study.candidates.find((candidate) => candidate.actionable)
    ?? study.candidates[0];
  const [selectedId, setSelectedId] = useState(initialCandidate ? candidateKey(initialCandidate) : "");
  const [phase, setPhase] = useState<"holdout" | "all">("holdout");
  const [dte, setDte] = useState<"all" | number>("all");
  const selected = study.candidates.find((candidate) => candidateKey(candidate) === selectedId) ?? initialCandidate;
  const rows = useMemo(() => study.candidates
    .filter((candidate) => candidate.actionable)
    .filter((candidate) => phase === "all" || candidate.phase === "holdout")
    .filter((candidate) => dte === "all" || candidate.dte === dte)
    .sort((a, b) => b.edgePercent - a.edgePercent), [dte, phase, study.candidates]);
  const maxDaily = Math.max(...study.dailySummary.map((day) => day.largeGapCandidates), 1);
  const holdoutMean = study.summary.holdoutActionable.mean ?? 0;
  const allMean = study.summary.allActionable.mean ?? 0;
  const noGapDays = study.dailySummary.filter((day) => day.noLargeGap).map((day) => dateLabel(day.date));

  return (
    <main className="research-page">
      <header className="research-header">
        <a className="research-brand" href="/">
          <span>ƒ</span>
          <strong>FairVal Lab</strong>
        </a>
        <div className="research-header-meta">
          <span>SPY · MAY–JUL 2026</span>
          <a href="/">Live workbench</a>
        </div>
      </header>

      <section className="research-hero">
        <div>
          <p className="research-kicker">OUTCOME STUDY / V1 PILOT</p>
          <h1>Did the “cheap” options<br /><em>ever reach fair value?</em></h1>
          <p className="research-deck">
            A no-look-ahead replay of large positive model gaps. Each option is screened once,
            entered one hour later, and tracked against its original American-tree fair-value target.
          </p>
        </div>
        <aside className="verdict-card">
          <span className="verdict-label">READ THIS FIRST</span>
          <strong>Interesting holdout.<br />Not proven.</strong>
          <p>
            The untouched four-expiration holdout averaged <b>{signedMoney(holdoutMean * 100)}</b> per
            contract after the cost haircut, but the full sample averaged <b>{signedMoney(allMean * 100)}</b>.
            The positive holdout is small, clustered, and not executable-quote evidence.
          </p>
        </aside>
      </section>

      <section className="research-kpis" aria-label="Study headline statistics">
        <div><span>HOLDOUT ENTRIES</span><strong>{study.summary.holdoutActionableCandidates}</strong><small>across 4 expirations</small></div>
        <div><span>CLOSE-TARGET HIT</span><strong>{percent(study.summary.holdoutCloseTargetHitRate)}</strong><small>conservative definition</small></div>
        <div><span>AVG NET / CONTRACT</span><strong className={holdoutMean >= 0 ? "good" : "bad"}>{signedMoney(holdoutMean * 100)}</strong><small>holdout, correlated rows</small></div>
        <div><span>NO-GAP DAYS</span><strong>{study.summary.noLargeGapDays}/{study.coverage.tradingDays}</strong><small>{((study.summary.noLargeGapDays / study.coverage.tradingDays) * 100).toFixed(0)}% of observed days</small></div>
        <div className="capacity-kpi"><span>DAILY CAPACITY</span><strong>{study.coverage.maximumContractsPerDay}<i>/50</i></strong><small>historical universe limit</small></div>
      </section>

      <section className="research-section activity-section">
        <div className="section-intro">
          <div>
            <p className="research-kicker">01 / WHEN GAPS APPEARED</p>
            <h2>Most days had nothing to buy.</h2>
          </div>
          <p>
            A large gap means the tree value was at least {study.policy.largeGapPercent}% and
            ${study.policy.minimumAbsoluteGap.toFixed(2)} above the observed trade, with forecast volatility above market IV.
            Blank bars are valid no-gap days—not missing results.
          </p>
        </div>
        <div className="daily-chart" aria-label="Daily large-gap candidate counts">
          {study.dailySummary.map((day) => (
            <div className="daily-column" key={day.date} title={`${day.date}: ${day.largeGapCandidates} flagged, ${day.actionableCandidates} entered`}>
              <span
                className={`${day.phase} ${day.noLargeGap ? "is-empty" : ""}`}
                style={{ height: `${Math.max(4, (day.largeGapCandidates / maxDaily) * 100)}%` }}
              />
              {day.dte === 0 && <i>{dateLabel(day.date)}</i>}
            </div>
          ))}
        </div>
        <div className="chart-axis-note"><span>Calibration</span><span>Untouched holdout begins Jul 6 →</span></div>
        <details className="no-gap-list">
          <summary>Show all {noGapDays.length} no-large-gap days</summary>
          <p>{noGapDays.join(" · ")}</p>
        </details>
      </section>

      <section className="research-section">
        <div className="section-intro">
          <div>
            <p className="research-kicker">02 / DTE SCORECARD</p>
            <h2>0–10 DTE, with the holes left visible.</h2>
          </div>
          <p>
            The current archive only covers 0–4 DTE. A real 50-per-day study needs a wider OPRA/NBBO archive;
            5–10 DTE are marked unavailable instead of silently treated as zero signals.
          </p>
        </div>
        <div className="dte-grid">
          {study.dteSummary.map((row) => (
            <article key={row.dte} className={row.dataAvailable ? "" : "missing"}>
              <div><span>{row.dte}</span><small>DTE</small></div>
              {row.dataAvailable ? (
                <>
                  <strong>{row.actionable}</strong>
                  <p>entries · {percent(row.closeHitRate)} target hit</p>
                  <em className={(row.meanNetContractDollars ?? 0) >= 0 ? "good" : "bad"}>
                    {signedMoney(row.meanNetContractDollars)} avg
                  </em>
                </>
              ) : (
                <><strong>—</strong><p>no archive coverage</p><em>needs collection</em></>
              )}
            </article>
          ))}
        </div>
      </section>

      {selected && (
        <section className="research-section explorer-section">
          <div className="section-intro explorer-heading">
            <div>
              <p className="research-kicker">03 / CONTRACT EXPLORER</p>
              <h2>Follow every flagged option.</h2>
            </div>
            <label>
              <span>CONTRACT</span>
              <select value={candidateKey(selected)} onChange={(event) => setSelectedId(event.target.value)}>
                {study.candidates.filter((candidate) => candidate.actionable).map((candidate) => (
                  <option key={candidateKey(candidate)} value={candidateKey(candidate)}>
                    {candidate.date} · {candidate.dte}DTE · {candidate.optionType.toUpperCase()} {candidate.strike} · {candidate.edgePercent.toFixed(0)}% gap
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="contract-strip">
            <div><span>CONTRACT</span><strong>{selected.optionType.toUpperCase()} ${selected.strike}</strong><small>{selected.date} · {selected.dte} DTE · {selected.phase}</small></div>
            <div><span>NEXT-HOUR ENTRY</span><strong>{money.format(selected.entryPrice ?? 0)}</strong><small>signal trade {money.format(selected.signalPrice)}</small></div>
            <div><span>FIXED FV TARGET</span><strong>{money.format(selected.fairValue)}</strong><small>{selected.edgePercent.toFixed(1)}% signal gap</small></div>
            <div><span>CLOSE TARGET</span><strong className={selected.closeHit ? "good" : "bad"}>{selected.closeHit ? "HIT" : "MISSED"}</strong><small>{selected.closeHitTime ? dateLabel(selected.closeHitTime.slice(0, 10)) : `last ${money.format(selected.finalObservedPrice ?? 0)}`}</small></div>
            <div><span>NET / CONTRACT</span><strong className={(selected.netContractDollars ?? 0) >= 0 ? "good" : "bad"}>{signedMoney(selected.netContractDollars)}</strong><small>10% / $0.05 cost rule</small></div>
          </div>
          <PricePathChart candidate={selected} />
          <p className="path-note">
            The green line is hourly closing trades, not an executable bid. The amber target is frozen at signal time;
            actual fair value changes with spot, time, and volatility.
          </p>
        </section>
      )}

      <section className="research-section candidate-section">
        <div className="section-intro">
          <div>
            <p className="research-kicker">04 / CANDIDATE TAPE</p>
            <h2>Inspect the rows, not just the average.</h2>
          </div>
          <div className="table-actions">
            <div className="filter-group" role="group" aria-label="Candidate phase">
              <button className={phase === "holdout" ? "active" : ""} onClick={() => setPhase("holdout")}>Holdout</button>
              <button className={phase === "all" ? "active" : ""} onClick={() => setPhase("all")}>All</button>
            </div>
            <label><span>DTE</span><select value={dte} onChange={(event) => setDte(event.target.value === "all" ? "all" : Number(event.target.value))}><option value="all">All</option>{[0,1,2,3,4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <a href="/research/candidate-outcomes.csv" download>Download CSV</a>
          </div>
        </div>
        <div className="research-table-wrap">
          <table className="research-table">
            <thead><tr><th>Date</th><th>Contract</th><th>DTE</th><th>Entry</th><th>FV target</th><th>Vol edge</th><th>Gap</th><th>Target</th><th>Net / contract</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={candidateKey(row)} onClick={() => setSelectedId(candidateKey(row))}>
                  <td>{dateLabel(row.date)}<small>{row.phase}</small></td>
                  <td><b>{row.optionType[0].toUpperCase()} {row.strike}</b><small>exp {dateLabel(row.expiration)}</small></td>
                  <td>{row.dte}</td>
                  <td>{money.format(row.entryPrice ?? 0)}</td>
                  <td>{money.format(row.fairValue)}</td>
                  <td>{row.volEdge >= 0 ? "+" : ""}{row.volEdge.toFixed(1)} pt</td>
                  <td>{row.edgePercent.toFixed(0)}%</td>
                  <td className={row.closeHit ? "good" : "bad"}>{row.closeHit ? "Hit" : "Miss"}</td>
                  <td className={(row.netContractDollars ?? 0) >= 0 ? "good" : "bad"}>{signedMoney(row.netContractDollars)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="empty-table">No actionable candidates in this slice.</p>}
        </div>
      </section>

      <section className="research-section methods-section">
        <div className="section-intro">
          <div><p className="research-kicker">05 / WHAT THIS PROVES</p><h2>A screen, not an arbitrage claim.</h2></div>
          <p>The model found episodes worth researching. It did not prove guaranteed profits or a Robinhood-executable strategy.</p>
        </div>
        <div className="evidence-grid">
          <article className="positive-evidence">
            <span>WHAT SURVIVED</span>
            <strong>{study.summary.holdoutActionableCandidates} holdout entries</strong>
            <p>{percent(study.summary.holdoutCloseTargetHitRate)} later closed at the fixed target; optimistic high-touch reached {percent(study.summary.holdoutOptimisticTargetHitRate)}.</p>
          </article>
          <article className="negative-evidence">
            <span>FIRST REJECTION</span>
            <strong>Full sample lost {shortMoney.format(Math.abs((study.summary.allActionable.total ?? 0) * 100))}</strong>
            <p>Calibration plus holdout averaged {signedMoney((study.summary.allActionable.mean ?? 0) * 100)} per contract, and 4 DTE was negative overall.</p>
          </article>
          <article>
            <span>WHAT WOULD MAKE IT INVESTABLE</span>
            <strong>Executable OPRA quotes</strong>
            <p>At least 6–12 months of timestamped bid/ask, depth, volume, and 0–10 DTE chains; then a fresh untouched test.</p>
          </article>
          <article>
            <span>WHAT KILLS IT</span>
            <strong>Edge disappears at the ask</strong>
            <p>If the next-hour ask plus fees removes the gap, or the fresh holdout turns negative, the long-vol rule fails.</p>
          </article>
        </div>
        <div className="method-list">
          {Object.entries(study.method).map(([name, description], index) => (
            <div key={name}><span>{String(index + 1).padStart(2, "0")}</span><strong>{name.replaceAll(/([A-Z])/g, " $1")}</strong><p>{description}</p></div>
          ))}
        </div>
        <div className="caveat-block">
          <strong>NON-NEGOTIABLE LIMITATIONS</strong>
          <ul>{study.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
        </div>
      </section>

      <footer className="research-footer">
        <div><strong>FairVal Lab · outcome study</strong><p>Generated {new Date(study.generatedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}</p></div>
        <div><a href="/research/daily-summary.csv" download>Daily CSV</a><a href="/research/dte-summary.csv" download>DTE CSV</a><a href="/">Return to live model</a></div>
      </footer>
    </main>
  );
}
