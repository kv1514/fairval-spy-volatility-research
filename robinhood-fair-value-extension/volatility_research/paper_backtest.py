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
            strike = pd.to_numeric(pd.Series([signal.get("strike")]), errors="coerce").iloc[0]
            log_moneyness = abs(np.log(float(strike) / float(entry_spot))) if np.isfinite(strike) and np.isfinite(entry_spot) and strike > 0 and entry_spot > 0 else np.nan
            bid = float(signal["bid"])
            ask = float(signal["ask"])
            mark = pd.to_numeric(pd.Series([signal.get("mark")]), errors="coerce").iloc[0]
            spread_pct = (ask - bid) / float(mark) * 100.0 if np.isfinite(mark) and mark > 0 else np.nan
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
                "spreadPct": spread_pct,
                "logMoneynessAbs": log_moneyness,
                "logVolume": np.log1p(max(float(signal.get("volume") or 0), 0.0)),
                "logOpenInterest": np.log1p(max(float(signal.get("openInterest") or 0), 0.0)),
                "directionSign": position_sign,
            })
            rows.append(row)
    return pd.DataFrame(rows).sort_values("signalTime").reset_index(drop=True) if rows else pd.DataFrame()


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
    predictions = walk_forward_signal_regression(outcomes, min_train_observations=args.min_train)
    diagnostics = evaluate_signal_regression(predictions)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    predictions.to_csv(output / "paper_outcomes.csv", index=False)
    diagnostics.to_csv(output / "paper_regression_diagnostics.csv", index=False)
    print(diagnostics.to_string(index=False))


if __name__ == "__main__":
    main()
