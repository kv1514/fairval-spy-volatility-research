"""Executable-outcome analysis for FairVal's exported local paper recorder.

This module never changes an option fair value.  It asks a separate empirical
question: conditional on a recorded model discrepancy, did the subsequent
executable bid/ask outcome support the signal after a simple delta hedge?
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd


FEATURE_COLUMNS = (
    "varianceEdge", "gammaWeightedEdge", "vegaNormalizedEdge", "edgePercent",
    "spreadPct", "marketIv", "forecastAtmIv", "logMoneynessAbs", "days",
    "logVolume", "logOpenInterest", "directionSign",
)


def _records_frame(records: Iterable[dict] | pd.DataFrame) -> pd.DataFrame:
    frame = records.copy() if isinstance(records, pd.DataFrame) else pd.DataFrame(list(records))
    required = {"contractKey", "observedAt", "flagDirection", "bid", "ask"}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"paper records are missing required columns: {', '.join(missing)}")
    frame["observedAt"] = pd.to_numeric(frame["observedAt"], errors="coerce")
    return frame.dropna(subset=["contractKey", "observedAt"]).sort_values("observedAt").reset_index(drop=True)


def build_forward_outcomes(
    records: Iterable[dict] | pd.DataFrame,
    horizon_minutes: int = 60,
) -> pd.DataFrame:
    """Pair each flagged snapshot with the first later executable snapshot."""

    frame = _records_frame(records)
    horizon_ms = max(int(horizon_minutes), 1) * 60_000
    tolerance_ms = max(horizon_ms // 2, 2 * 60_000)
    rows: list[dict] = []
    for _, group in frame.groupby("contractKey", sort=False):
        ordered = group.sort_values("observedAt").reset_index(drop=True)
        times = ordered["observedAt"].to_numpy(dtype=float)
        for index, signal in ordered.iterrows():
            direction = signal.get("flagDirection")
            if direction not in {"below-model", "above-model"}:
                continue
            target = float(signal["observedAt"]) + horizon_ms
            candidates = np.flatnonzero((times >= target) & (times <= target + tolerance_ms))
            candidates = candidates[candidates > index]
            if not candidates.size:
                continue
            outcome = ordered.iloc[int(candidates[0])]
            long_option = direction == "below-model"
            entry = float(signal["ask"] if long_option else signal["bid"])
            exit_price = float(outcome["bid"] if long_option else outcome["ask"])
            if not np.isfinite(entry) or not np.isfinite(exit_price) or entry <= 0 or exit_price < 0:
                continue
            position_sign = 1.0 if long_option else -1.0
            option_pnl = position_sign * (exit_price - entry) * 100.0
            delta = pd.to_numeric(pd.Series([signal.get("marketDelta")]), errors="coerce").iloc[0]
            entry_spot = pd.to_numeric(pd.Series([signal.get("spot")]), errors="coerce").iloc[0]
            exit_spot = pd.to_numeric(pd.Series([outcome.get("spot")]), errors="coerce").iloc[0]
            hedge_shares = -position_sign * float(delta) * 100.0 if np.isfinite(delta) else np.nan
            hedge_pnl = hedge_shares * (float(exit_spot) - float(entry_spot)) if np.isfinite(hedge_shares) and np.isfinite(entry_spot) and np.isfinite(exit_spot) else np.nan
            underlying_move = float(exit_spot) - float(entry_spot) if np.isfinite(entry_spot) and np.isfinite(exit_spot) else np.nan
            signal_iv = pd.to_numeric(pd.Series([signal.get("marketIv")]), errors="coerce").iloc[0]
            outcome_iv = pd.to_numeric(pd.Series([outcome.get("marketIv")]), errors="coerce").iloc[0]
            iv_change = float(outcome_iv - signal_iv) if np.isfinite(signal_iv) and np.isfinite(outcome_iv) else np.nan
            strike = pd.to_numeric(pd.Series([signal.get("strike")]), errors="coerce").iloc[0]
            log_moneyness = abs(np.log(float(strike) / float(entry_spot))) if np.isfinite(strike) and np.isfinite(entry_spot) and strike > 0 and entry_spot > 0 else np.nan
            bid = float(signal["bid"])
            ask = float(signal["ask"])
            mark = pd.to_numeric(pd.Series([signal.get("mark")]), errors="coerce").iloc[0]
            spread_pct = (ask - bid) / float(mark) * 100.0 if np.isfinite(mark) and mark > 0 else np.nan
            outcome_bid = pd.to_numeric(pd.Series([outcome.get("bid")]), errors="coerce").iloc[0]
            outcome_ask = pd.to_numeric(pd.Series([outcome.get("ask")]), errors="coerce").iloc[0]
            spread_change = (float(outcome_ask - outcome_bid) - (ask - bid)) if np.isfinite(outcome_bid) and np.isfinite(outcome_ask) else np.nan
            elapsed_days = (float(outcome["observedAt"]) - float(signal["observedAt"])) / 86_400_000.0
            theta = pd.to_numeric(pd.Series([signal.get("marketTheta")]), errors="coerce").iloc[0]
            theta_decay_estimate = float(theta * elapsed_days * 100.0 * position_sign) if np.isfinite(theta) else np.nan
            realized_variance_proxy = (
                float(np.log(float(exit_spot) / float(entry_spot)) ** 2 / elapsed_days * 365.0)
                if np.isfinite(entry_spot) and np.isfinite(exit_spot) and entry_spot > 0 and exit_spot > 0 and elapsed_days > 0
                else np.nan
            )
            row = signal.to_dict()
            row.update({
                "signalTime": pd.to_datetime(float(signal["observedAt"]), unit="ms", utc=True),
                "exitTime": pd.to_datetime(float(outcome["observedAt"]), unit="ms", utc=True),
                "horizonMinutes": int(horizon_minutes),
                "entryExecutable": entry,
                "exitExecutable": exit_price,
                "optionPnlContract": option_pnl,
                "hedgeShares": hedge_shares,
                "hedgePnlContract": hedge_pnl,
                "deltaHedgedPnlContract": option_pnl + hedge_pnl if np.isfinite(hedge_pnl) else np.nan,
                "underlyingMove": underlying_move,
                "marketIvChange": iv_change,
                "spreadChange": spread_change,
                "thetaDecayEstimate": theta_decay_estimate,
                "realizedVarianceProxy": realized_variance_proxy,
                "spreadPct": spread_pct,
                "logMoneynessAbs": log_moneyness,
                "logVolume": np.log1p(max(float(signal.get("volume") or 0), 0.0)),
                "logOpenInterest": np.log1p(max(float(signal.get("openInterest") or 0), 0.0)),
                "directionSign": position_sign,
            })
            rows.append(row)
    return pd.DataFrame(rows).sort_values("signalTime").reset_index(drop=True) if rows else pd.DataFrame()


def build_multi_horizon_outcomes(
    records: Iterable[dict] | pd.DataFrame,
    horizons: Iterable[int] = (5, 15, 30, 60),
) -> pd.DataFrame:
    """Build executable outcomes for standard research horizons without midpoint fills."""

    frames = [build_forward_outcomes(records, horizon_minutes=int(horizon)) for horizon in horizons]
    available = [frame for frame in frames if not frame.empty]
    return pd.concat(available, ignore_index=True).sort_values(["signalTime", "horizonMinutes"]).reset_index(drop=True) if available else pd.DataFrame()


def outcome_dashboard(outcomes: pd.DataFrame) -> pd.DataFrame:
    """Transparent outcome slices; no score weights are fitted in this report."""

    if outcomes.empty:
        return pd.DataFrame(columns=["horizonMinutes", "signalType", "scoreDecile", "observations", "hitRate", "meanPnl", "medianPnl", "p10Pnl"])
    local = outcomes.copy()
    local["signalType"] = np.where(local["flagDirection"] == "below-model", "long", "short")
    score = pd.to_numeric(local.get("modelConfidence", local.get("edgePercent")), errors="coerce")
    local["scoreDecile"] = 0
    finite = score.notna()
    if finite.sum() >= 10:
        local.loc[finite, "scoreDecile"] = pd.qcut(score[finite].rank(method="first"), 10, labels=False, duplicates="drop") + 1
    rows = []
    for keys, group in local.groupby(["horizonMinutes", "signalType", "scoreDecile"], dropna=False):
        pnl = pd.to_numeric(group["deltaHedgedPnlContract"], errors="coerce").dropna()
        if pnl.empty:
            pnl = pd.to_numeric(group["optionPnlContract"], errors="coerce").dropna()
        rows.append({
            "horizonMinutes": int(keys[0]), "signalType": str(keys[1]), "scoreDecile": int(keys[2]),
            "observations": int(len(pnl)), "hitRate": float((pnl > 0).mean()) if len(pnl) else np.nan,
            "meanPnl": float(pnl.mean()) if len(pnl) else np.nan,
            "medianPnl": float(pnl.median()) if len(pnl) else np.nan,
            "p10Pnl": float(pnl.quantile(0.10)) if len(pnl) else np.nan,
        })
    return pd.DataFrame(rows)


def edge_calibration_dashboard(outcomes: pd.DataFrame) -> pd.DataFrame:
    """Compare transparent signal/context deciles with executable outcomes."""

    columns = [
        "horizonMinutes", "signalType", "metric", "bucket", "observations",
        "metricMin", "metricMax", "hitRate", "meanPnl", "medianPnl", "p10Pnl",
    ]
    if outcomes.empty:
        return pd.DataFrame(columns=columns)
    local = outcomes.copy()
    local["signalType"] = np.where(local["flagDirection"] == "below-model", "long", "short")
    hedged = pd.to_numeric(local.get("deltaHedgedPnlContract"), errors="coerce")
    option = pd.to_numeric(local.get("optionPnlContract"), errors="coerce")
    local["evaluationPnl"] = hedged.where(hedged.notna(), option)
    metric_sources = {
        "model_edge": ("edgePercent", "priceEdge"),
        "vol_edge": ("volEdge", "vol_edge"),
        "iv_percentile": ("ivPercentile", "iv_percentile"),
        "spread_adjusted_edge": ("edgeToSpreadRatio", "edge_to_spread_ratio"),
    }
    rows: list[dict[str, object]] = []
    for metric, candidates in metric_sources.items():
        source = next((name for name in candidates if name in local), None)
        if source is None:
            continue
        values = pd.to_numeric(local[source], errors="coerce")
        eligible = local.loc[values.notna() & local["evaluationPnl"].notna()].copy()
        if eligible.empty:
            continue
        eligible["metricValue"] = values.loc[eligible.index]
        eligible["bucket"] = 0
        for _, index in eligible.groupby(["horizonMinutes", "signalType"]).groups.items():
            group_values = eligible.loc[index, "metricValue"]
            if len(group_values) >= 10 and group_values.nunique() >= 2:
                eligible.loc[index, "bucket"] = (
                    pd.qcut(group_values.rank(method="first"), 10, labels=False, duplicates="drop") + 1
                ).astype(int)
        for keys, group in eligible.groupby(["horizonMinutes", "signalType", "bucket"], dropna=False):
            pnl = group["evaluationPnl"]
            rows.append({
                "horizonMinutes": int(keys[0]), "signalType": str(keys[1]), "metric": metric,
                "bucket": int(keys[2]), "observations": int(len(group)),
                "metricMin": float(group["metricValue"].min()), "metricMax": float(group["metricValue"].max()),
                "hitRate": float((pnl > 0).mean()), "meanPnl": float(pnl.mean()),
                "medianPnl": float(pnl.median()), "p10Pnl": float(pnl.quantile(0.10)),
            })
    return pd.DataFrame(rows, columns=columns)


def false_positive_dashboard(outcomes: pd.DataFrame) -> pd.DataFrame:
    """Summarize losing executable signals without relabeling them as trades."""

    columns = [
        "horizonMinutes", "classification", "observations", "positiveOutcomes",
        "falsePositives", "falsePositiveRate", "meanFalsePositivePnl",
        "medianFalsePositivePnl", "p10FalsePositivePnl",
    ]
    if outcomes.empty:
        return pd.DataFrame(columns=columns)
    local = outcomes.copy()
    classification = local.get("candidateClassification")
    if classification is None:
        classification = pd.Series(np.where(
            local["flagDirection"] == "below-model", "long_vol_candidate", "short_vol_candidate",
        ), index=local.index)
    local["classification"] = classification.fillna("unknown").astype(str)
    hedged = pd.to_numeric(local.get("deltaHedgedPnlContract"), errors="coerce")
    option = pd.to_numeric(local.get("optionPnlContract"), errors="coerce")
    local["evaluationPnl"] = hedged.where(hedged.notna(), option)
    rows: list[dict[str, object]] = []
    for keys, group in local.dropna(subset=["evaluationPnl"]).groupby(["horizonMinutes", "classification"]):
        pnl = group["evaluationPnl"]
        false_positive = pnl[pnl <= 0]
        rows.append({
            "horizonMinutes": int(keys[0]), "classification": str(keys[1]),
            "observations": int(len(pnl)), "positiveOutcomes": int((pnl > 0).sum()),
            "falsePositives": int(len(false_positive)), "falsePositiveRate": float((pnl <= 0).mean()),
            "meanFalsePositivePnl": float(false_positive.mean()) if len(false_positive) else np.nan,
            "medianFalsePositivePnl": float(false_positive.median()) if len(false_positive) else np.nan,
            "p10FalsePositivePnl": float(false_positive.quantile(0.10)) if len(false_positive) else np.nan,
        })
    return pd.DataFrame(rows, columns=columns)


def _fit_ridge(training: pd.DataFrame, target_column: str, ridge_penalty: float) -> dict | None:
    usable = training.dropna(subset=[target_column]).copy()
    if usable.empty:
        return None
    raw = usable.reindex(columns=FEATURE_COLUMNS).apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    medians = np.nanmedian(raw, axis=0)
    medians = np.where(np.isfinite(medians), medians, 0.0)
    raw = np.where(np.isfinite(raw), raw, medians)
    mean = raw.mean(axis=0)
    scale = raw.std(axis=0)
    scale = np.where(scale > 1e-12, scale, 1.0)
    design = np.column_stack([np.ones(len(raw)), (raw - mean) / scale])
    target = usable[target_column].to_numpy(dtype=float)
    penalty = np.eye(design.shape[1]) * max(float(ridge_penalty), 0.0)
    penalty[0, 0] = 0.0
    coefficients = np.linalg.solve(design.T @ design + penalty, design.T @ target)
    return {"medians": medians, "mean": mean, "scale": scale, "coefficients": coefficients}


def walk_forward_signal_regression(
    outcomes: pd.DataFrame,
    *,
    target_column: str = "deltaHedgedPnlContract",
    min_train_observations: int = 100,
    training_window: int | None = 1_000,
    rebalance_every: int = 25,
    ridge_penalty: float = 10.0,
) -> pd.DataFrame:
    """Predict outcome reliability using only outcomes resolved before each signal."""

    if outcomes.empty:
        return outcomes.copy()
    frame = outcomes.sort_values("signalTime").reset_index(drop=True).copy()
    frame["predictedPnlContract"] = np.nan
    frame["regressionTrainEnd"] = pd.Series(pd.NaT, index=frame.index, dtype="datetime64[ns, UTC]")
    frame["regressionNTrain"] = 0
    fitted: dict | None = None
    fitted_train_end = pd.NaT
    fitted_n = 0
    cadence = max(int(rebalance_every), 1)
    for position, row in frame.iterrows():
        signal_time = pd.Timestamp(row["signalTime"])
        eligible = frame.iloc[:position]
        eligible = eligible[pd.to_datetime(eligible["exitTime"], utc=True) < signal_time]
        if training_window is not None:
            eligible = eligible.tail(int(training_window))
        if (fitted is None or position % cadence == 0) and len(eligible.dropna(subset=[target_column])) >= int(min_train_observations):
            fitted = _fit_ridge(eligible, target_column, ridge_penalty)
            fitted_train_end = pd.Timestamp(eligible["exitTime"].max())
            fitted_n = int(len(eligible.dropna(subset=[target_column])))
        if fitted is None:
            continue
        raw = row.reindex(FEATURE_COLUMNS).apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
        raw = np.where(np.isfinite(raw), raw, fitted["medians"])
        design = np.append(1.0, (raw - fitted["mean"]) / fitted["scale"])
        frame.at[position, "predictedPnlContract"] = float(design @ fitted["coefficients"])
        frame.at[position, "regressionTrainEnd"] = fitted_train_end
        frame.at[position, "regressionNTrain"] = fitted_n
    return frame


def evaluate_signal_regression(outcomes: pd.DataFrame, target_column: str = "deltaHedgedPnlContract") -> pd.DataFrame:
    valid = outcomes.dropna(subset=["predictedPnlContract", target_column]).copy()
    if valid.empty:
        return pd.DataFrame([{"observations": 0}])
    error = valid["predictedPnlContract"] - valid[target_column]
    correlation = valid[["predictedPnlContract", target_column]].corr().iloc[0, 1]
    cutoff = float(valid["predictedPnlContract"].quantile(0.8))
    top = valid[valid["predictedPnlContract"] >= cutoff]
    return pd.DataFrame([{
        "observations": len(valid),
        "mae": float(np.mean(np.abs(error))),
        "rmse": float(np.sqrt(np.mean(np.square(error)))),
        "directional_accuracy": float(np.mean(np.sign(valid["predictedPnlContract"]) == np.sign(valid[target_column]))),
        "prediction_outcome_correlation": float(correlation) if np.isfinite(correlation) else np.nan,
        "top_quintile_observations": len(top),
        "top_quintile_mean_actual_pnl": float(top[target_column].mean()) if not top.empty else np.nan,
        "all_mean_actual_pnl": float(valid[target_column].mean()),
    }])


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze exported FairVal paper-tracker outcomes")
    parser.add_argument("export", help="fair-value-paper-study-YYYY-MM-DD.json")
    parser.add_argument("--output-dir", default="paper-backtest-output")
    parser.add_argument("--horizon-minutes", type=int, default=60)
    parser.add_argument("--min-train", type=int, default=100)
    args = parser.parse_args()
    payload = json.loads(Path(args.export).read_text(encoding="utf-8"))
    outcomes = build_forward_outcomes(payload.get("records", []), horizon_minutes=args.horizon_minutes)
    multi_horizon = build_multi_horizon_outcomes(payload.get("records", []))
    dashboard = outcome_dashboard(multi_horizon)
    calibration = edge_calibration_dashboard(multi_horizon)
    false_positives = false_positive_dashboard(multi_horizon)
    predictions = walk_forward_signal_regression(outcomes, min_train_observations=args.min_train)
    diagnostics = evaluate_signal_regression(predictions)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    predictions.to_csv(output / "paper_outcomes.csv", index=False)
    multi_horizon.to_csv(output / "paper_outcomes_multi_horizon.csv", index=False)
    dashboard.to_csv(output / "paper_outcome_dashboard.csv", index=False)
    calibration.to_csv(output / "paper_edge_calibration_dashboard.csv", index=False)
    false_positives.to_csv(output / "paper_false_positive_dashboard.csv", index=False)
    diagnostics.to_csv(output / "paper_regression_diagnostics.csv", index=False)
    print(diagnostics.to_string(index=False))


if __name__ == "__main__":
    main()
