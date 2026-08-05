"""Volatility-surface context and leakage-safe historical IV percentiles."""

from __future__ import annotations

from typing import Iterable

import numpy as np
import pandas as pd


DTE_BUCKETS = (1, 2, 3, 5, 10, 20, 30, 60, 90, 180, 365)
TERM_BUCKETS = (1, 2, 5, 10)
MONEYNESS_LABELS = ("downside_deep", "downside", "atm", "upside", "upside_deep")


def _require(frame: pd.DataFrame, required: Iterable[str], label: str) -> None:
    missing = sorted(set(required) - set(frame.columns))
    if missing:
        raise ValueError(f"{label} is missing required columns: {', '.join(missing)}")


def normalize_iv_percent(values: pd.Series) -> pd.Series:
    numeric = pd.to_numeric(values, errors="coerce").astype(float)
    finite = numeric[np.isfinite(numeric)]
    if not finite.empty and finite.abs().median() <= 1.5:
        numeric = numeric * 100.0
    return numeric


def nearest_bucket(value: float, buckets: Iterable[int]) -> int:
    available = sorted({int(bucket) for bucket in buckets})
    target = max(float(value), 1.0)
    # A boundary DTE belongs to the longer-horizon bucket (for example, 4D -> 5D),
    # which avoids comparing a multi-day contract with the shorter 3D regime.
    return min(available, key=lambda bucket: (abs(bucket - target), -bucket))


def classify_moneyness(log_moneyness: pd.Series | np.ndarray) -> np.ndarray:
    values = np.asarray(log_moneyness, dtype=float)
    return np.select(
        [values <= -0.10, values <= -0.03, values < 0.03, values < 0.10],
        MONEYNESS_LABELS[:-1],
        default=MONEYNESS_LABELS[-1],
    )


def prepare_surface_contracts(options: pd.DataFrame) -> pd.DataFrame:
    _require(
        options,
        ("ticker", "date", "option_type", "strike", "market_iv", "spot"),
        "surface options",
    )
    local = options.copy()
    local["ticker"] = local["ticker"].astype(str).str.upper().str.strip().replace({"SPXW": "SPX"})
    local["date"] = pd.to_datetime(local["date"], errors="raise").dt.normalize()
    local["option_type"] = local["option_type"].astype(str).str.lower().str.strip()
    for column in ("strike", "spot"):
        local[column] = pd.to_numeric(local[column], errors="coerce")
    local["market_iv"] = normalize_iv_percent(local["market_iv"])
    if "dte" not in local:
        _require(local, ("expiration",), "surface options")
        local["expiration"] = pd.to_datetime(local["expiration"], errors="raise").dt.normalize()
        local["dte"] = (local["expiration"] - local["date"]).dt.days.clip(lower=1)
    local["dte"] = pd.to_numeric(local["dte"], errors="coerce").clip(lower=1)
    if "expiration" not in local:
        local["expiration"] = local["date"] + pd.to_timedelta(local["dte"], unit="D")
    local["expiration"] = pd.to_datetime(local["expiration"], errors="coerce").dt.normalize()
    local = local.dropna(subset=["strike", "spot", "market_iv", "dte"])
    local = local[(local["strike"] > 0) & (local["spot"] > 0) & (local["market_iv"] > 0)]
    local["moneyness"] = local["strike"] / local["spot"]
    local["log_moneyness"] = np.log(local["moneyness"])
    local["moneyness_bucket"] = classify_moneyness(local["log_moneyness"])
    local["dte_bucket"] = local["dte"].map(lambda value: nearest_bucket(value, DTE_BUCKETS))
    return local


def _expiration_statistics(local: pd.DataFrame) -> pd.DataFrame:
    keys = ["ticker", "date", "expiration"]
    rows: list[dict] = []
    for key, group in local.groupby(keys, sort=True):
        by_strike = group.groupby("strike", as_index=False).agg(
            market_iv=("market_iv", "median"),
            log_moneyness=("log_moneyness", "median"),
            dte=("dte", "median"),
        )
        distance = by_strike["log_moneyness"].abs()
        minimum = float(distance.min())
        atm_iv = float(by_strike.loc[distance <= minimum + 0.0025, "market_iv"].median())
        slope = np.nan
        if len(by_strike) >= 3 and by_strike["log_moneyness"].nunique() >= 3:
            slope = float(np.polyfit(by_strike["log_moneyness"], by_strike["market_iv"], 1)[0] * 0.10)
        rows.append({
            **dict(zip(keys, key, strict=True)),
            "atm_iv": atm_iv,
            "iv_skew_slope_per_10pct_moneyness": slope,
            "expiration_dte": float(by_strike["dte"].median()),
        })
    return pd.DataFrame(rows)


def _term_structure(expiration_stats: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict] = []
    for (ticker, date), group in expiration_stats.groupby(["ticker", "date"], sort=True):
        assigned = group.copy()
        assigned["term_bucket"] = assigned["expiration_dte"].map(
            lambda value: nearest_bucket(value, TERM_BUCKETS),
        )
        medians = assigned.groupby("term_bucket")["atm_iv"].median().to_dict()
        record: dict[str, object] = {"ticker": ticker, "date": date}
        for bucket in TERM_BUCKETS:
            record[f"atm_iv_{bucket}d"] = medians.get(bucket, np.nan)
        record["term_spread_2d_minus_1d"] = record["atm_iv_2d"] - record["atm_iv_1d"]
        record["term_spread_5d_minus_2d"] = record["atm_iv_5d"] - record["atm_iv_2d"]
        record["term_spread_10d_minus_5d"] = record["atm_iv_10d"] - record["atm_iv_5d"]
        rows.append(record)
    return pd.DataFrame(rows)


def add_volatility_surface_context(
    options: pd.DataFrame,
    history: pd.DataFrame | None = None,
    minimum_history: int = 20,
) -> pd.DataFrame:
    """Add current smile/term context and strictly prior bucket IV percentiles."""

    local = prepare_surface_contracts(options)
    expiration_stats = _expiration_statistics(local)
    local = local.merge(expiration_stats, on=["ticker", "date", "expiration"], how="left")
    local["contract_iv_minus_atm_iv"] = local["market_iv"] - local["atm_iv"]
    term = _term_structure(expiration_stats)
    local = local.merge(term, on=["ticker", "date"], how="left")

    reference = prepare_surface_contracts(history) if history is not None and not history.empty else local
    group_columns = ["ticker", "option_type", "dte_bucket", "moneyness_bucket"]
    reference_groups = {
        key: group[["date", "market_iv"]].sort_values("date").reset_index(drop=True)
        for key, group in reference.groupby(group_columns, sort=False)
    }
    percentiles: list[float] = []
    observations: list[int] = []
    historical_medians: list[float] = []
    for row in local.itertuples(index=False):
        key = (row.ticker, row.option_type, int(row.dte_bucket), row.moneyness_bucket)
        group = reference_groups.get(key)
        if group is None:
            past = np.array([], dtype=float)
        else:
            past = group.loc[group["date"] < row.date, "market_iv"].to_numpy(dtype=float)
            past = past[np.isfinite(past)]
        count = int(past.size)
        observations.append(count)
        historical_medians.append(float(np.median(past)) if count else np.nan)
        if count < minimum_history:
            percentiles.append(np.nan)
        else:
            below = float(np.count_nonzero(past < row.market_iv))
            equal = float(np.count_nonzero(np.isclose(past, row.market_iv)))
            percentiles.append((below + 0.5 * equal) / count * 100.0)
    local["iv_percentile"] = percentiles
    local["iv_percentile_observations"] = observations
    local["historical_bucket_iv_median"] = historical_medians
    local["iv_minus_historical_bucket_median"] = local["market_iv"] - local["historical_bucket_iv_median"]
    return local


def surface_benchmark_records(history: pd.DataFrame, minimum_observations: int = 10) -> list[dict]:
    """Compact quantile table for the extension's historical-skew gate."""

    if history is None or history.empty:
        return []
    prepared = prepare_surface_contracts(history)
    group_columns = ["ticker", "option_type", "dte_bucket", "moneyness_bucket"]
    records: list[dict] = []
    for key, group in prepared.groupby(group_columns, sort=True):
        values = group["market_iv"].dropna().to_numpy(dtype=float)
        if values.size < minimum_observations:
            continue
        quantiles = np.quantile(values, [0.10, 0.25, 0.50, 0.75, 0.90])
        records.append({
            **dict(zip(group_columns, key, strict=True)),
            "observations": int(values.size),
            "p10": float(quantiles[0]),
            "p25": float(quantiles[1]),
            "p50": float(quantiles[2]),
            "p75": float(quantiles[3]),
            "p90": float(quantiles[4]),
        })
    return records
