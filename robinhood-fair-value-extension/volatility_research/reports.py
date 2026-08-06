"""Standalone HTML diagnostics for variance-forecast and surface research."""

from __future__ import annotations

from html import escape
from pathlib import Path

import numpy as np
import pandas as pd

from .engine import format_blend_formula


MODEL_COLORS = {
    "optimized_blend": "#147d64",
    "sparse_blend": "#0b7285",
    "ewma": "#3155a4",
    "realized_20": "#9a5b13",
    "realized_60": "#783d8f",
}


def _number(value: object, digits: int = 5) -> str:
    return "-" if value is None or pd.isna(value) else f"{float(value):.{digits}g}"


def _table(headers: list[str], rows: list[list[str]], classes: str = "") -> str:
    head = "".join(f"<th>{escape(header)}</th>" for header in headers)
    body = "".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows)
    return f'<div class="table-wrap"><table class="{escape(classes)}"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def _all_models_table(diagnostics: pd.DataFrame) -> str:
    """Every candidate model's out-of-sample variance error, not just the winner."""

    if diagnostics.empty:
        return '<p class="muted">No completed diagnostic groups.</p>'
    aggregate = diagnostics[diagnostics["moneyness_bucket"] == "all"].copy()
    if aggregate.empty:
        return '<p class="muted">No completed diagnostic groups.</p>'
    rows: list[list[str]] = []
    for row in aggregate.sort_values(["ticker", "horizon", "mse_variance"]).itertuples(index=False):
        color = MODEL_COLORS.get(row.model, "#59636d")
        marker = ' <b style="color:#147d64">◄ best</b>' if bool(row.is_best) else ""
        rows.append([
            escape(str(row.ticker)), str(int(row.horizon)),
            f'<span class="model-pill" style="--pill:{color}">{escape(str(row.model))}</span>{marker}',
            f"{int(row.observations):,}", _number(row.mse_variance, 6), _number(row.mae_vol, 4),
        ])
    return _table(["Ticker", "Horizon", "Candidate model", "OOS n", "Variance MSE", "Vol MAE"], rows)


def _formula_table(weights_history: pd.DataFrame | None) -> str:
    """Latest readable optimized and sparse blend formulas per ticker/horizon."""

    if weights_history is None or weights_history.empty:
        return '<p class="muted">No optimized blend weights were trained in this run.</p>'
    frame = weights_history.copy()
    frame["date"] = pd.to_datetime(frame["date"])
    latest = frame.sort_values("date").groupby(["ticker", "horizon"], as_index=False).tail(1)
    rows: list[list[str]] = []
    for row in latest.sort_values(["ticker", "horizon"]).itertuples(index=False):
        optimized = getattr(row, "optimized_weights", None)
        sparse = getattr(row, "sparse_weights", None)
        rows.append([
            escape(str(row.ticker)), str(int(row.horizon)),
            f'<code>{escape(format_blend_formula(optimized if isinstance(optimized, dict) else None))}</code>',
            f'<code>{escape(format_blend_formula(sparse if isinstance(sparse, dict) else None))}</code>',
        ])
    if not rows:
        return '<p class="muted">No optimized blend weights were trained in this run.</p>'
    return _table(["Ticker", "Horizon", "Optimized blend (dense)", "Sparse blend (selected windows)"], rows)


def _threshold_section(threshold_study: pd.DataFrame | None) -> str:
    """Signal reliability as the volatility gap widens, with an honest verdict."""

    if threshold_study is None or threshold_study.empty:
        return '<p class="muted">Supply a historical option-IV series to study reliability by edge threshold.</p>'
    rows: list[list[str]] = []
    for row in threshold_study.sort_values(["ticker", "min_abs_vol_edge_points"]).itertuples(index=False):
        rows.append([
            escape(str(row.ticker)), f"{float(row.min_abs_vol_edge_points):.0f}",
            f"{int(row.observations):,}", _number(row.coverage_pct, 3),
            _number(getattr(row, "directional_accuracy_vs_market_iv", None), 3),
            _number(getattr(row, "variance_skill_vs_market", None), 3),
        ])
    table = _table(
        ["Ticker", "Min |vol edge| (pts)", "Obs", "Coverage %", "Directional acc. vs mkt IV", "Variance skill vs mkt IV"],
        rows,
    )
    # State the verdict the numbers support rather than implying a buy trigger.
    accuracy = pd.to_numeric(threshold_study["directional_accuracy_vs_market_iv"], errors="coerce").dropna()
    monotone = bool(accuracy.is_monotonic_increasing) if len(accuracy) > 1 else False
    verdict = (
        "Directional accuracy does <strong>not</strong> improve monotonically as the gap widens in this sample, "
        "so the size of the gap alone was not a dependable signal."
        if not monotone else
        "Directional accuracy rises with the gap in this sample, but this is a forecast-skill diagnostic on a "
        "limited history, not evidence of a profitable rule after spreads and costs."
    )
    return (
        f'{table}<p class="muted">Positive variance skill means the model beat simply trusting market IV at that '
        f'gap. Coverage falls as the threshold rises because wide gaps are rare. {verdict} This is a research '
        f'diagnostic, not a buy/sell threshold.</p>'
    )


def write_variance_diagnostics_report(
    output_path: str | Path,
    diagnostics: pd.DataFrame,
    rankings: pd.DataFrame,
    forecast_rows: int,
    weights_history: pd.DataFrame | None = None,
    threshold_study: pd.DataFrame | None = None,
    source_pdf: str = "Martin Haugh, The Black-Scholes Model, equation (24), page 12",
) -> Path:
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    best = diagnostics[diagnostics["is_best"]].copy() if not diagnostics.empty else pd.DataFrame()
    aggregate = best[best["moneyness_bucket"] == "all"] if not best.empty else pd.DataFrame()
    bucketed = best[best["moneyness_bucket"] != "all"] if not best.empty else pd.DataFrame()
    model_counts = aggregate["best_model"].value_counts().to_dict() if not aggregate.empty else {}
    context_coverage = float(rankings["iv_percentile"].notna().mean() * 100.0) if not rankings.empty else 0.0
    strongest = int((rankings["research_bucket"] == "A - strongest research candidate").sum()) if not rankings.empty else 0

    cards = [
        ("Forecast rows", f"{forecast_rows:,}", "All emitted walk-forward model forecasts"),
        ("Variance groups", f"{len(best):,}", "Ticker / horizon / moneyness best-model cells"),
        ("Historical IV coverage", f"{context_coverage:.1f}%", "Ranked contracts with a prior comparable bucket"),
        ("A research candidates", str(strongest), "Requires spread, liquidity, variance and history gates"),
    ]
    card_html = "".join(
        f'<article class="metric"><span>{escape(label)}</span><strong>{escape(value)}</strong><small>{escape(note)}</small></article>'
        for label, value, note in cards
    )

    count_total = max(sum(model_counts.values()), 1)
    bars = "".join(
        f'<div class="bar-row"><span>{escape(model)}</span><div><i style="width:{count/count_total*100:.1f}%;background:{MODEL_COLORS.get(model, "#59636d")}"></i></div><b>{count}</b></div>'
        for model, count in sorted(model_counts.items(), key=lambda item: (-item[1], item[0]))
    ) or '<p class="muted">No completed diagnostic groups.</p>'

    aggregate_rows: list[list[str]] = []
    for row in aggregate.sort_values(["ticker", "horizon"]).itertuples(index=False):
        color = MODEL_COLORS.get(row.best_model, "#59636d")
        aggregate_rows.append([
            escape(str(row.ticker)), str(int(row.horizon)),
            f'<span class="model-pill" style="--pill:{color}">{escape(str(row.best_model))}</span>',
            f"{int(row.observations):,}", _number(row.mse_variance, 6), _number(row.mae_vol, 4),
        ])

    bucket_rows: list[list[str]] = []
    for row in bucketed.sort_values(["ticker", "horizon", "moneyness_bucket"]).itertuples(index=False):
        color = MODEL_COLORS.get(row.best_model, "#59636d")
        bucket_rows.append([
            escape(str(row.ticker)), str(int(row.horizon)), escape(str(row.moneyness_bucket)),
            f'<span class="model-pill" style="--pill:{color}">{escape(str(row.best_model))}</span>',
            f"{int(row.observations):,}", _number(row.mse_variance, 6), _number(row.rmse_vol, 4),
        ])

    candidate_rows: list[list[str]] = []
    candidates = rankings[rankings["research_bucket"] != "Reject"].sort_values(
        ["research_bucket", "composite_score"], ascending=[True, False],
    ).head(20) if not rankings.empty else pd.DataFrame()
    for row in candidates.itertuples(index=False):
        candidate_rows.append([
            escape(str(row.ticker)), escape(str(row.option_type)), _number(row.strike, 7), str(int(row.dte)),
            escape(str(row.candidate_side)), _number(row.market_iv, 4), _number(row.forecast_vol, 4),
            _number(row.variance_edge, 5), _number(row.gamma_weighted_edge_contract, 4),
            _number(row.iv_percentile, 4), escape(str(row.research_bucket)),
        ])

    aggregate_table = _table(
        ["Ticker", "Horizon", "Best variance model", "OOS n", "Variance MSE", "Vol MAE"],
        aggregate_rows,
    )
    bucket_table = _table(
        ["Ticker", "Horizon", "Moneyness bucket", "Best variance model", "OOS n", "Variance MSE", "Vol RMSE"],
        bucket_rows,
    )
    candidates_table = _table(
        ["Ticker", "Type", "Strike", "DTE", "Side", "Market IV", "Forecast", "Variance edge", "$ gamma edge / contract", "IV percentile", "Research bucket"],
        candidate_rows,
    ) if candidate_rows else '<p class="muted">No contracts passed the current research queue gates.</p>'

    all_models_table = _all_models_table(diagnostics)
    formula_table = _formula_table(weights_history)
    threshold_section = _threshold_section(threshold_study)

    html = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Variance Mispricing Diagnostics</title>
<style>
:root{{--ink:#14212b;--muted:#60707a;--paper:#f6f4ee;--card:#fff;--line:#d9ddd9;--green:#147d64;--red:#aa3d36}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 Inter,Segoe UI,Arial,sans-serif}}
main{{max-width:1220px;margin:auto;padding:38px 28px 70px}}header{{border-bottom:2px solid var(--ink);padding-bottom:20px}}
.eyebrow{{font:700 11px/1.2 ui-monospace,monospace;letter-spacing:.13em;color:var(--green)}}h1{{font-size:38px;line-height:1.05;margin:10px 0}}header p{{max-width:850px;color:var(--muted);font-size:16px}}
.metrics{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0}}.metric{{background:var(--card);border:1px solid var(--line);padding:17px}}
.metric span,.metric small{{display:block;color:var(--muted)}}.metric strong{{display:block;font-size:28px;margin:7px 0}}section{{margin-top:34px}}
h2{{font-size:23px;margin:0 0 12px}}h3{{font-size:16px;margin:24px 0 8px}}.callout{{background:#e9f2ee;border-left:4px solid var(--green);padding:16px 18px}}
.formula{{font:600 17px/1.7 ui-monospace,monospace;overflow:auto}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}
.panel{{background:var(--card);border:1px solid var(--line);padding:20px}}.bar-row{{display:grid;grid-template-columns:150px 1fr 35px;gap:10px;align-items:center;margin:11px 0}}
.bar-row div{{height:11px;background:#e5e7e4}}.bar-row i{{display:block;height:100%}}.table-wrap{{overflow:auto;border:1px solid var(--line);background:var(--card)}}
table{{width:100%;border-collapse:collapse;white-space:nowrap}}th,td{{padding:10px 12px;border-bottom:1px solid #e4e6e3;text-align:right}}th{{position:sticky;top:0;background:#eef0ed;font-size:11px;letter-spacing:.04em;text-transform:uppercase}}
th:first-child,td:first-child{{text-align:left}}.model-pill{{display:inline-block;padding:3px 8px;border-radius:999px;color:#fff;background:var(--pill);font-size:11px;font-weight:700}}
.muted{{color:var(--muted)}}.sources{{font-size:12px;color:var(--muted)}}@media(max-width:850px){{.metrics{{grid-template-columns:1fr 1fr}}.grid{{grid-template-columns:1fr}}h1{{font-size:30px}}}}
</style></head><body><main>
<header><div class="eyebrow">VOLATILITY RESEARCH / VARIANCE-FIRST</div><h1>Delta-hedged variance diagnostics</h1>
<p>The scanner now treats Black-Scholes as a variance translator. Contract economics are separated into long-vol and short-vol signs, scaled by market-implied gamma, and conditioned on historical DTE/moneyness buckets before a candidate can enter the strongest research tier.</p></header>
<div class="metrics">{card_html}</div>
<section class="callout"><strong>Haugh sign convention</strong><div class="formula">Short option + delta hedge P&amp;L ≈ 0.5 × S² × Γ × (σ²<sub>imp</sub> - σ²<sub>realized</sub>) × T</div>
<p>Positive variance edge is favorable to the short-vol side under the constant-gamma approximation. The long-vol sign is the inverse. Discrete hedging, jumps, transaction costs, changing gamma, dividends, early exercise and surface dynamics remain outside this approximation.</p></section>
<section><div class="grid"><div class="panel"><h2>Best model count</h2><p class="muted">Winner across ticker/horizon aggregate cells, selected only by past out-of-sample variance MSE.</p>{bars}</div>
<div class="panel"><h2>Interpretation guardrails</h2><ul><li>Variance fields use annualized decimal variance, not squared percentage points.</li><li>High downside-put IV is not an automatic short: the IV percentile must be high versus the same ticker, option type, DTE and moneyness bucket.</li><li>Positive model price edge supports long-option research; positive gamma-weighted edge supports short-vol research.</li><li>Current live quotes are not outcomes. They cannot validate profitability until their future realized window completes.</li></ul></div></div></section>
<section><h2>Best forecast by ticker and horizon</h2>{aggregate_table}</section>
<section><h2>All candidate models by ticker and horizon</h2><p class="muted">Every model is scored on the same out-of-sample completed targets. The winner is the lowest variance MSE; alternatives are shown so the margin is visible.</p>{all_models_table}</section>
<section><h2>Latest blend formulas</h2><p class="muted">The dense optimized blend spreads variance weight across the candidate windows; the sparse blend keeps only the few windows that earn their place (weights below 1e-8 are dropped).</p>{formula_table}</section>
<section><h2>Best forecast by moneyness bucket</h2><p class="muted">A bucket changes the set of dates evaluated; it does not make an underlying-volatility forecast strike-specific.</p>{bucket_table}</section>
<section><h2>Signal reliability by edge threshold</h2><p class="muted">Does a bigger gap between the model forecast and market IV mean a more reliable signal? This sweep answers empirically — it is a forecast-skill diagnostic, not a "safe to buy" threshold.</p>{threshold_section}</section>
<section><h2>Current research queue</h2><p class="muted">Candidates are prioritized for further review, not recommended trades.</p>{candidates_table}</section>
<section class="sources"><h2>Sources and limitations</h2><p><strong>Model source:</strong> {escape(source_pdf)}. <strong>Market data:</strong> included Robinhood daily bars, live option quote snapshot, and historical hourly last-trade replay. The replay lacks historical NBBO, so inverted historical IV percentiles are screen-grade rather than execution-grade.</p></section>
</main></body></html>'''
    target.write_text(html, encoding="utf-8")
    return target
