"""Standalone HTML diagnostics for variance-forecast and surface research."""

from __future__ import annotations

from html import escape
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .engine import format_blend_formula
from .pricing_models import CRRBinomialModel, PricingInputs, TrinomialModel, convergence_report


MODEL_COLORS = {
    "optimized_blend": "#147d64",
    "sparse_blend": "#0b7285",
    "ewma": "#3155a4",
    "har_rv": "#7550ae",
    "garch_11": "#d9480f",
    "gjr_garch": "#c2255c",
    "simple_ensemble": "#5f3dc4",
    "adaptive_ensemble": "#7048e8",
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
            f"{int(row.observations):,}", _number(row.mse_variance, 6),
            _number(getattr(row, "mean_qlike", None), 5), _number(row.mae_vol, 4),
        ])
    return _table(["Ticker", "Horizon", "Candidate model", "OOS n", "Variance MSE", "QLIKE", "Vol MAE"], rows)


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
<section><h2>All candidate models by ticker and horizon</h2><p class="muted">Every model is scored on the same out-of-sample completed targets. The winner is the lowest variance MSE; QLIKE adds a robust check for noisy realized-variance targets and alternatives show the selection margin.</p>{all_models_table}</section>
<section><h2>Latest blend formulas</h2><p class="muted">The dense optimized blend spreads variance weight across the candidate windows; the sparse blend keeps only the few windows that earn their place (weights below 1e-8 are dropped).</p>{formula_table}</section>
<section><h2>Best forecast by moneyness bucket</h2><p class="muted">A bucket changes the set of dates evaluated; it does not make an underlying-volatility forecast strike-specific.</p>{bucket_table}</section>
<section><h2>Signal reliability by edge threshold</h2><p class="muted">Does a bigger gap between the model forecast and market IV mean a more reliable signal? This sweep answers empirically — it is a forecast-skill diagnostic, not a "safe to buy" threshold.</p>{threshold_section}</section>
<section><h2>Current research queue</h2><p class="muted">Candidates are prioritized for further review, not recommended trades.</p>{candidates_table}</section>
<section class="sources"><h2>Sources and limitations</h2><p><strong>Pricing source:</strong> {escape(source_pdf)}. <strong>Forecast sources:</strong> Bollerslev (1986) GARCH, Glosten-Jagannathan-Runkle (1993) asymmetric GARCH, Corsi (2009) HAR-RV, and Patton (2011) QLIKE evaluation. <strong>Market data:</strong> included Robinhood daily bars, live option quote snapshot, and historical hourly last-trade replay. The replay lacks historical NBBO, so inverted historical IV percentiles are screen-grade rather than execution-grade.</p></section>
</main></body></html>'''
    target.write_text(html, encoding="utf-8")
    return target


def write_pricing_diagnostics_report(
    output_path: str | Path,
    rankings: pd.DataFrame,
    max_contracts: int = 20,
) -> Path:
    """Write an interactive, standalone model-comparison diagnostics page."""

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    frame = rankings.copy()
    if not frame.empty:
        sort_columns = [column for column in ("date", "composite_score") if column in frame]
        ascending = [False] * len(sort_columns)
        if sort_columns:
            frame = frame.sort_values(sort_columns, ascending=ascending)
        frame = frame.head(max_contracts)

    def safe(value: object) -> object:
        if value is None or (not isinstance(value, (dict, list)) and pd.isna(value)):
            return None
        if isinstance(value, (np.integer,)):
            return int(value)
        if isinstance(value, (np.floating,)):
            return float(value)
        if isinstance(value, pd.Timestamp):
            return value.isoformat()
        return value

    contracts: list[dict[str, object]] = []
    for index, row in enumerate(frame.itertuples(index=False)):
        option_type = str(getattr(row, "option_type", "call")).lower()
        style = str(getattr(row, "option_style", "unknown")).lower()
        inputs = PricingInputs(
            spot=float(row.spot), strike=float(row.strike), dte=float(row.dte),
            volatility=float(row.forecast_volatility), rate=float(row.rate), dividend=float(row.dividend),
            option_type=option_type, exercise_style="american" if style == "american" else "european",
        )
        stored_convergence = getattr(row, "tree_convergence_history", None)
        if style == "american" and isinstance(stored_convergence, list):
            binomial_convergence = [{
                **item,
                "difference_from_previous": item.get("difference_from_previous"),
                "stabilized": (
                    item.get("error_estimate") is not None
                    and item.get("error_estimate") <= float(getattr(row, "tree_convergence_tolerance", 0.0025))
                ),
            } for item in stored_convergence]
        else:
            binomial_convergence = convergence_report(CRRBinomialModel, inputs) if style == "american" else []
        trinomial_convergence = convergence_report(TrinomialModel, inputs) if style == "american" else []
        record = {
            "id": index,
            "label": f"{row.ticker} {option_type.upper()} {float(row.strike):g} · {int(row.dte)} DTE",
            "ticker": str(row.ticker),
            "date": safe(getattr(row, "date", None)),
            "expiration": safe(row.expiration),
            "optionType": option_type,
            "strike": safe(row.strike),
            "dte": safe(row.dte),
            "spot": safe(row.spot),
            "bid": safe(row.bid),
            "ask": safe(row.ask),
            "mid": safe(row.market_mid),
            "spreadPct": safe(row.spread_pct),
            "marketIv": safe(row.market_iv),
            "forecastVolatility": safe(row.forecast_volatility),
            "blackScholesIv": safe(row.black_scholes_iv),
            "americanIv": safe(row.american_model_iv),
            "bsMarket": safe(row.bs_market_iv_fair_value),
            "bsForecast": safe(row.bs_forecast_vol_fair_value),
            "binomialMarket": safe(getattr(row, "binomial_market_iv_fair_value", None)),
            "binomialForecast": safe(getattr(row, "binomial_forecast_vol_fair_value", None)),
            "trinomialForecast": safe(getattr(row, "trinomial_forecast_vol_fair_value", None)),
            "approximationForecast": safe(getattr(row, "approximation_forecast_vol_fair_value", None)),
            "selectedFairValue": safe(row.selected_model_fair_value),
            "earlyExercisePremium": safe(row.early_exercise_premium),
            "treeExactPremium": safe(getattr(row, "tree_early_exercise_premium", None)),
            "priceEdgeBs": safe(row.price_edge_bs),
            "priceEdgeAmerican": safe(row.price_edge_american),
            "edgeAfterSpreadBs": safe(row.edge_after_spread_bs),
            "edgeAfterSpreadAmerican": safe(row.edge_after_spread_american),
            "volEdge": safe(row.vol_edge),
            "varianceEdge": safe(row.variance_edge),
            "delta": safe(row.delta),
            "gamma": safe(row.gamma),
            "americanDelta": safe(row.american_delta),
            "americanGamma": safe(row.american_gamma),
            "modelUsed": str(row.model_used),
            "modelReason": str(row.model_reason),
            "modelConfidence": safe(row.model_confidence),
            "treeConvergenceStatus": str(getattr(row, "tree_convergence_status", "not_applicable")),
            "treeConvergenceError": safe(getattr(row, "tree_convergence_error", None)),
            "treeConvergenceTolerance": safe(getattr(row, "tree_convergence_tolerance", None)),
            "treeStepsUsed": safe(getattr(row, "tree_steps_used", None)),
            "treeMaxSteps": safe(getattr(row, "tree_max_steps", None)),
            "treeNumericalMethod": safe(getattr(row, "tree_numerical_method", None)),
            "blackScholesRuntimeMs": safe(getattr(row, "black_scholes_runtime_ms", None)),
            "binomialRuntimeMs": safe(getattr(row, "binomial_runtime_ms", None)),
            "trinomialRuntimeMs": safe(getattr(row, "trinomial_runtime_ms", None)),
            "approximationRuntimeMs": safe(getattr(row, "approximation_runtime_ms", None)),
            "forecastModel": str(row.forecast_model_used),
            "forecastAtmVol": safe(getattr(row, "forecast_atm_vol", None)),
            "tradingDte": safe(getattr(row, "trading_dte", None)),
            "forecastHorizonUsed": str(getattr(row, "forecast_horizon_used", "unavailable")),
            "forecastHorizonMethod": str(getattr(row, "forecast_horizon_method", "unavailable")),
            "forecastHorizonWarning": str(getattr(row, "forecast_horizon_warning", "") or ""),
            "forecastStale": bool(getattr(row, "forecast_stale", True)),
            "forwardPrice": safe(getattr(row, "forward_price", None)),
            "logForwardMoneyness": safe(getattr(row, "log_moneyness", None)),
            "sviStatus": str(getattr(row, "svi_status", "not_fitted")),
            "sviFittedIv": safe(getattr(row, "svi_fitted_iv", None)),
            "sviResidualIv": safe(getattr(row, "svi_residual_iv", None)),
            "sviOutlier": bool(getattr(row, "svi_outlier", False)),
            "sviButterflyFree": bool(getattr(row, "svi_butterfly_arbitrage_free", False)),
            "sviCalendarFree": bool(getattr(row, "svi_calendar_arbitrage_free", True)),
            "sviMinButterflyG": safe(getattr(row, "svi_minimum_butterfly_g", None)),
            "skewAdjustmentMethod": str(getattr(row, "skew_adjustment_method", "unavailable")),
            "surfaceSanityStatus": str(getattr(row, "surface_sanity_status", "unavailable")),
            "surfaceShiftWarning": str(getattr(row, "surface_shift_warning", "") or ""),
            "candidateClassification": str(getattr(row, "candidate_classification", "no_signal")),
            "candidateReason": str(getattr(row, "candidate_reason", "")),
            "dataQualityState": str(getattr(row, "data_quality_state", "unavailable")),
            "dataQualityScore": safe(getattr(row, "data_quality_score", None)),
            "dataQualityPass": bool(getattr(row, "data_quality_pass", False)),
            "scoreComponents": getattr(row, "score_components", None),
            "confidenceComponents": getattr(row, "model_confidence_components", None),
            "rateSource": str(getattr(row, "rate_source", "unavailable")),
            "rateWarning": str(getattr(row, "rate_warning", "") or ""),
            "dividendMethod": str(getattr(row, "dividend_method", "unavailable")),
            "dividendWarning": str(getattr(row, "dividend_warning", "") or ""),
            "eventWarning": str(getattr(row, "event_warning", "") or ""),
            "jumpRiskWarning": str(getattr(row, "jump_risk_warning", "") or ""),
            "pricingWarning": str(row.pricing_warning or ""),
            "dataQualityWarning": str(row.data_quality_warning or ""),
            "binomialConvergence": binomial_convergence,
            "trinomialConvergence": trinomial_convergence,
        }
        contracts.append(record)

    payload = json.dumps(contracts, ensure_ascii=False, allow_nan=False).replace("</", "<\\/")
    html = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FairVal Multi-Model Pricing Diagnostics</title>
<style>
:root{{--ink:#10202b;--muted:#63727b;--paper:#f3f1ea;--card:#fff;--line:#d7dad5;--green:#087a58;--amber:#a45c11;--red:#a6362d;--blue:#315b8f}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 Inter,Segoe UI,Arial,sans-serif}}
main{{max-width:1320px;margin:auto;padding:36px 28px 72px}}header{{display:grid;grid-template-columns:1fr minmax(280px,410px);gap:30px;align-items:end;padding-bottom:25px;border-bottom:2px solid var(--ink)}}
.eyebrow{{font:800 10px/1.2 ui-monospace,monospace;letter-spacing:.14em;color:var(--green)}}h1{{max-width:760px;margin:10px 0 8px;font-size:clamp(36px,5vw,62px);line-height:.98;letter-spacing:-.055em}}header p{{max-width:760px;margin:0;color:var(--muted);font-size:15px}}
label{{display:block;color:var(--muted);font:700 9px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}}select{{width:100%;height:48px;margin-top:8px;padding:0 12px;border:1px solid var(--ink);border-radius:0;background:#fff;color:var(--ink);font:700 12px ui-monospace,monospace}}
.empty{{padding:80px 0;color:var(--muted);text-align:center}}.hero-grid{{display:grid;grid-template-columns:1.15fr .85fr;gap:18px;margin-top:24px}}
.panel{{background:var(--card);border:1px solid var(--line);padding:22px}}.value-card{{position:relative;overflow:hidden;background:var(--ink);color:#fff}}.value-card::after{{content:"";position:absolute;right:-90px;bottom:-130px;width:300px;height:300px;border:46px solid rgba(255,255,255,.045);border-radius:50%}}
.value-card .caption,.metric span{{display:block;color:#aebbc2;font:700 9px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}}.value-card strong{{display:block;margin:8px 0;font:500 58px ui-monospace,monospace;letter-spacing:-.08em}}.model-tag{{display:inline-block;padding:5px 8px;background:#dff5e9;color:#075a42;font:800 9px ui-monospace,monospace}}
.reason{{position:relative;z-index:1;max-width:640px;margin-top:18px;color:#cbd4d8}}.metrics{{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line);border:1px solid var(--line)}}.metric{{min-height:90px;padding:15px;background:#fff}}.metric span{{color:var(--muted)}}.metric strong{{display:block;margin-top:8px;font:650 17px ui-monospace,monospace}}.metric small{{display:block;margin-top:4px;color:var(--muted);font-size:10px}}
.warning{{margin-top:16px;padding:12px 14px;border-left:3px solid var(--amber);background:#fbf0df;color:#6c522f;font-size:11px}}.warning.ok{{border-color:var(--green);background:#e8f5ee;color:#285d4c}}
section{{margin-top:32px}}h2{{margin:0 0 7px;font-size:22px;letter-spacing:-.03em}}section>p{{margin:0 0 14px;color:var(--muted)}}.table-wrap{{overflow:auto;border:1px solid var(--line);background:#fff}}table{{width:100%;border-collapse:collapse;white-space:nowrap}}th,td{{padding:10px 12px;border-bottom:1px solid #e5e7e3;text-align:right;font:11px ui-monospace,monospace}}th{{background:#eceeea;color:#57656d;font-size:9px;letter-spacing:.06em;text-transform:uppercase}}th:first-child,td:first-child{{text-align:left}}tr.selected td{{background:#ebf5f0;font-weight:700}}
.two-col{{display:grid;grid-template-columns:1fr 1fr;gap:18px}}.legend{{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}}.legend span{{padding:4px 7px;border:1px solid var(--line);background:#fff;font:700 9px ui-monospace,monospace}}.foot{{margin-top:40px;padding-top:22px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}}.foot a{{color:var(--green)}}
@media(max-width:850px){{header,.hero-grid,.two-col{{grid-template-columns:1fr}}.value-card strong{{font-size:48px}}main{{padding:24px 16px 50px}}}}
</style></head><body><main>
<header><div><div class="eyebrow">FAIRVAL / MODEL COMPARISON LAB</div><h1>One quote. Multiple conditional values.</h1><p>European Black–Scholes is the baseline. Adaptive American CRR and trinomial trees test early exercise. A value using forecast realized volatility is a physical-volatility scenario—not a uniquely identified risk-neutral fair value.</p></div>
<label>Inspect contract<select id="contract"></select></label></header>
<div id="empty" class="empty" hidden>No ranked contracts were available for this run.</div>
<div id="report" hidden>
<div class="hero-grid"><article class="panel value-card"><span class="caption">Selected realized-volatility scenario value</span><strong id="selectedValue">—</strong><span class="model-tag" id="modelUsed">—</span><p class="reason" id="modelReason"></p></article><div class="metrics" id="metrics"></div></div>
<div id="warning" class="warning"></div>
<section><h2>Price and volatility bridge</h2><p>Market-IV values explain the quote; forecast-volatility values create the research comparison.</p><div id="priceTable" class="table-wrap"></div></section>
<section class="two-col"><div><h2>CRR convergence</h2><p>American lattice values across step counts.</p><div id="binomialTable" class="table-wrap"></div></div><div><h2>Trinomial convergence</h2><p>Independent lattice cross-check.</p><div id="trinomialTable" class="table-wrap"></div></div></section>
<section><h2>Interpretation</h2><div class="legend"><span>Positive price edge: model value above midpoint</span><span>Positive variance edge: implied variance above forecast variance</span><span>Positive executable edge: survives quoted spread</span></div><p>This page identifies a potential pricing discrepancy under model assumptions. It is not a buy/sell instruction, does not estimate execution probability, and contains no order or hedge execution.</p></section>
</div><div class="foot">Method foundations: <a href="https://doi.org/10.1016/0304-405X(79)90015-1">Cox, Ross &amp; Rubinstein (1979)</a>; <a href="https://doi.org/10.1111/j.1540-6261.1987.tb02569.x">Barone-Adesi &amp; Whaley (1987)</a>; exercise-style definitions and risks: <a href="https://www.theocc.com/company-information/documents-and-archives/options-disclosure-document">OCC Options Disclosure Document</a>. Continuous dividend yield is an approximation; no discrete dividend dates are invented.</div>
</main><script>
const contracts={payload};const select=document.getElementById("contract"),report=document.getElementById("report"),empty=document.getElementById("empty");
const money=v=>v==null?"—":new Intl.NumberFormat("en-US",{{style:"currency",currency:"USD",maximumFractionDigits:4}}).format(v);const num=(v,d=3)=>v==null?"—":Number(v).toFixed(d);const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}}[c]));
function table(headers,rows){{return `<table><thead><tr>${{headers.map(x=>`<th>${{esc(x)}}</th>`).join("")}}</tr></thead><tbody>${{rows.map(row=>`<tr>${{row.map(x=>`<td>${{x}}</td>`).join("")}}</tr>`).join("")}}</tbody></table>`}}
function convergence(rows){{return table(["Steps","Price","Δ previous","Runtime ms","Stable"],(rows||[]).map(x=>[x.steps,money(x.price),x.difference_from_previous==null?"—":num(x.difference_from_previous,5),num(x.runtime_ms,2),x.stabilized?"Yes":"No"]))}}
function render(index){{const c=contracts[index];if(!c)return;document.getElementById("selectedValue").textContent=money(c.selectedFairValue);document.getElementById("modelUsed").textContent=c.modelUsed;document.getElementById("modelReason").textContent=c.modelReason;
document.getElementById("metrics").innerHTML=[["Market midpoint",money(c.mid),`Bid ${{money(c.bid)}} / Ask ${{money(c.ask)}}`],["RV-SCN volatility",`${{num(c.forecastVolatility,2)}}%`,`ATM forecast ${{num(c.forecastAtmVol,2)}}% · MKT-Q IV ${{num(c.marketIv,2)}}%`],["Horizon mapping",c.forecastHorizonMethod,`${{c.tradingDte??"—"}} trading DTE · ${{c.forecastHorizonUsed}}`],["Data / confidence",`${{c.dataQualityState}} · ${{num(c.modelConfidence,2)}}`,`data score ${{num(c.dataQualityScore,2)}} · ${{c.candidateClassification}}`],["Adaptive CRR",c.treeConvergenceStatus,`N=${{c.treeStepsUsed??"—"}} · error ${{money(c.treeConvergenceError)}} / tol ${{money(c.treeConvergenceTolerance)}}`],["SVI / skew",c.sviStatus,`${{c.skewAdjustmentMethod}} · ${{c.surfaceSanityStatus}} · butterfly ${{c.sviButterflyFree?"pass":"fail"}}`]].map(x=>`<div class="metric"><span>${{x[0]}}</span><strong>${{x[1]}}</strong><small>${{x[2]}}</small></div>`).join("");
const warning=[c.pricingWarning,c.dataQualityWarning,c.forecastHorizonWarning,c.surfaceShiftWarning,c.rateWarning,c.dividendWarning,c.eventWarning,c.jumpRiskWarning].filter(Boolean).join(" · ");const warningNode=document.getElementById("warning");warningNode.textContent=warning||"No additional warning for this snapshot; RV-SCN remains conditional, not arbitrage fair value.";warningNode.className=warning?"warning":"warning ok";
document.getElementById("priceTable").innerHTML=table(["Model","Market IV value","Forecast-vol value","Midpoint edge","IV from midpoint","Runtime ms"],[["Black–Scholes",money(c.bsMarket),money(c.bsForecast),money(c.priceEdgeBs),`${{num(c.blackScholesIv,2)}}%`,num(c.blackScholesRuntimeMs,3)],["American CRR",money(c.binomialMarket),money(c.binomialForecast),money(c.priceEdgeAmerican),`${{num(c.americanIv,2)}}%`,num(c.binomialRuntimeMs,3)],["American trinomial","—",money(c.trinomialForecast),"—","—",num(c.trinomialRuntimeMs,3)],["BAW approximation","—",money(c.approximationForecast),"—","—",num(c.approximationRuntimeMs,3)]]);
document.getElementById("binomialTable").innerHTML=convergence(c.binomialConvergence);document.getElementById("trinomialTable").innerHTML=convergence(c.trinomialConvergence)}}
if(!contracts.length){{empty.hidden=false;select.disabled=true}}else{{contracts.forEach((c,i)=>select.add(new Option(c.label,i)));report.hidden=false;render(0);select.addEventListener("change",()=>render(Number(select.value)))}}
</script></body></html>'''
    target.write_text(html, encoding="utf-8")
    return target
