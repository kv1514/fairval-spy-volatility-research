"""Volatility-surface context and leakage-safe historical IV percentiles."""

from __future__ import annotations

from typing import Iterable
import math

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
    for column in ("rate", "dividend", "cash_dividend_present_value"):
        local[column] = pd.to_numeric(local[column], errors="coerce").fillna(0.0) if column in local else 0.0
    time_years = local["dte"] / 365.0
    prepaid_forward_spot = (local["spot"] - local["cash_dividend_present_value"]).clip(lower=1e-8)
    inferred_forward = prepaid_forward_spot * np.exp((local["rate"] / 100.0) * time_years)
    if "forward_price" in local:
        supplied_forward = pd.to_numeric(local["forward_price"], errors="coerce")
        local["forward_price"] = supplied_forward.where(supplied_forward > 0, inferred_forward)
    else:
        local["forward_price"] = inferred_forward * np.exp(-(local["dividend"] / 100.0) * time_years)
    local["moneyness"] = local["strike"] / local["forward_price"]
    local["spot_log_moneyness"] = np.log(local["strike"] / local["spot"])
    local["log_moneyness"] = np.log(local["moneyness"])
    local["total_variance"] = np.square(local["market_iv"] / 100.0) * time_years
    local["moneyness_bucket"] = classify_moneyness(local["log_moneyness"])
    local["dte_bucket"] = local["dte"].map(lambda value: nearest_bucket(value, DTE_BUCKETS))
    return local


def svi_total_variance(k: np.ndarray | float, parameters: dict[str, float]) -> np.ndarray:
    values = np.asarray(k, dtype=float)
    x = values - parameters["m"]
    return parameters["a"] + parameters["b"] * (
        parameters["rho"] * x + np.sqrt(np.square(x) + parameters["sigma"] ** 2)
    )


def svi_variance_derivatives(
    k: np.ndarray | float,
    parameters: dict[str, float],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    values = np.asarray(k, dtype=float)
    x = values - parameters["m"]
    root = np.sqrt(np.square(x) + parameters["sigma"] ** 2)
    total = svi_total_variance(values, parameters)
    first = parameters["b"] * (parameters["rho"] + x / root)
    second = parameters["b"] * parameters["sigma"] ** 2 / np.power(root, 3)
    return total, first, second


def svi_butterfly_g(k: np.ndarray | float, parameters: dict[str, float]) -> np.ndarray:
    total, first, second = svi_variance_derivatives(k, parameters)
    safe_total = np.maximum(total, 1e-12)
    values = np.asarray(k, dtype=float)
    return (
        np.square(1.0 - values * first / (2.0 * safe_total))
        - np.square(first) / 4.0 * (1.0 / safe_total + 0.25)
        + second / 2.0
    )


def _svi_linear_parameters(
    k: np.ndarray,
    total_variance: np.ndarray,
    weights: np.ndarray,
    m: float,
    sigma: float,
    rho: float,
) -> tuple[dict[str, float], np.ndarray, float]:
    shape = rho * (k - m) + np.sqrt(np.square(k - m) + sigma * sigma)
    design = np.column_stack([np.ones_like(shape), shape])
    root_weight = np.sqrt(np.maximum(weights, 1e-12))
    coefficients, *_ = np.linalg.lstsq(design * root_weight[:, None], total_variance * root_weight, rcond=None)
    b = max(float(coefficients[1]), 0.0)
    a = float(np.average(total_variance - b * shape, weights=np.maximum(weights, 1e-12)))
    minimum_a = -b * sigma * math.sqrt(max(1.0 - rho * rho, 0.0)) + 1e-10
    a = max(a, minimum_a)
    parameters = {"a": a, "b": b, "rho": float(rho), "m": float(m), "sigma": float(sigma)}
    fitted = svi_total_variance(k, parameters)
    loss = float(np.average(np.square(fitted - total_variance), weights=np.maximum(weights, 1e-12)))
    return parameters, fitted, loss


def fit_svi_slice(
    log_forward_moneyness: np.ndarray,
    total_variance: np.ndarray,
    base_weights: np.ndarray | None = None,
) -> dict[str, object]:
    """Fit raw SVI with deterministic robust weighting and static-arbitrage diagnostics."""

    k = np.asarray(log_forward_moneyness, dtype=float)
    observed = np.asarray(total_variance, dtype=float)
    valid = np.isfinite(k) & np.isfinite(observed) & (observed > 0)
    k = k[valid]
    observed = observed[valid]
    if base_weights is None:
        weights = 1.0 / (1.0 + 8.0 * np.abs(k))
    else:
        weights = np.asarray(base_weights, dtype=float)[valid]
        weights = np.maximum(weights, 1e-8) / (1.0 + 8.0 * np.abs(k))
    if k.size < 5 or np.unique(np.round(k, 8)).size < 5:
        return {"status": "insufficient_points", "parameters": None, "observations": int(k.size)}

    k_range = max(float(np.ptp(k)), 0.05)
    m_values = np.linspace(float(k.min() - 0.35 * k_range), float(k.max() + 0.35 * k_range), 13)
    sigma_values = np.geomspace(0.005, max(0.50, 2.0 * k_range), 12)
    rho_values = np.linspace(-0.95, 0.95, 17)
    best: tuple[float, dict[str, float], np.ndarray] | None = None

    def search(local_weights: np.ndarray, m_grid: np.ndarray, sigma_grid: np.ndarray, rho_grid: np.ndarray) -> tuple[float, dict[str, float], np.ndarray]:
        selected: tuple[float, dict[str, float], np.ndarray] | None = None
        for m in m_grid:
            for sigma in sigma_grid:
                for rho in rho_grid:
                    parameters, fitted, loss = _svi_linear_parameters(k, observed, local_weights, float(m), float(sigma), float(rho))
                    if selected is None or loss < selected[0]:
                        selected = (loss, parameters, fitted)
        assert selected is not None
        return selected

    robust_weights = weights.copy()
    for _ in range(3):
        best = search(robust_weights, m_values, sigma_values, rho_values)
        residual = observed - best[2]
        scale = max(1.4826 * float(np.median(np.abs(residual - np.median(residual)))), 1e-8)
        huber = np.minimum(1.0, 1.5 * scale / np.maximum(np.abs(residual), 1e-12))
        robust_weights = weights * huber
        center = best[1]
        m_step = max(k_range / 5.0, 0.005)
        sigma_step = max(center["sigma"] / 3.0, 0.003)
        rho_step = 0.12
        m_values = np.linspace(center["m"] - m_step, center["m"] + m_step, 7)
        sigma_values = np.linspace(max(0.001, center["sigma"] - sigma_step), center["sigma"] + sigma_step, 7)
        rho_values = np.linspace(max(-0.999, center["rho"] - rho_step), min(0.999, center["rho"] + rho_step), 7)

    assert best is not None
    parameters = best[1]
    fitted = svi_total_variance(k, parameters)
    residual = observed - fitted
    scale = max(1.4826 * float(np.median(np.abs(residual - np.median(residual)))), 1e-8)
    final_robust_weight = np.minimum(1.0, 1.5 * scale / np.maximum(np.abs(residual), 1e-12))
    grid = np.linspace(min(float(k.min()) - 0.25, -0.75), max(float(k.max()) + 0.25, 0.75), 601)
    grid_variance = svi_total_variance(grid, parameters)
    butterfly = svi_butterfly_g(grid, parameters)
    parameter_minimum_variance = parameters["a"] + parameters["b"] * parameters["sigma"] * math.sqrt(max(1 - parameters["rho"] ** 2, 0))
    return {
        "status": "fitted",
        "parameters": parameters,
        "observations": int(k.size),
        "rmse_total_variance": float(np.sqrt(np.mean(np.square(residual)))),
        "minimum_total_variance": float(np.min(grid_variance)),
        "minimum_butterfly_g": float(np.min(butterfly)),
        "parameter_constraint_satisfied": bool(
            parameters["b"] >= 0 and parameters["sigma"] > 0 and abs(parameters["rho"]) < 1
            and parameter_minimum_variance >= -1e-10
        ),
        "butterfly_arbitrage_free": bool(np.min(grid_variance) > 0 and np.min(butterfly) >= -1e-7),
        "input_k": k,
        "fitted_total_variance": fitted,
        "robust_weights": final_robust_weight,
        "residual_scale": scale,
    }


def _add_svi_context(local: pd.DataFrame) -> pd.DataFrame:
    result = local.copy()
    defaults: dict[str, object] = {
        "svi_status": "not_fitted",
        "svi_fitted_iv": np.nan,
        "svi_residual_iv": np.nan,
        "svi_robust_weight": np.nan,
        "svi_outlier": False,
        "svi_a": np.nan,
        "svi_b": np.nan,
        "svi_rho": np.nan,
        "svi_m": np.nan,
        "svi_sigma": np.nan,
        "svi_rmse_total_variance": np.nan,
        "svi_minimum_butterfly_g": np.nan,
        "svi_butterfly_arbitrage_free": False,
        "svi_parameter_constraints_satisfied": False,
        "svi_calendar_arbitrage_free": True,
        "svi_calendar_min_total_variance_change": np.nan,
    }
    for column, value in defaults.items():
        result[column] = value

    fits: dict[tuple[str, pd.Timestamp, pd.Timestamp], dict[str, object]] = {}
    for key, group in result.groupby(["ticker", "date", "expiration"], sort=True):
        by_strike = group.groupby("strike", as_index=False).agg(
            log_moneyness=("log_moneyness", "median"),
            total_variance=("total_variance", "median"),
            dte=("dte", "median"),
        )
        base_weights = 1.0 / (1.0 + 8.0 * np.abs(by_strike["log_moneyness"].to_numpy(dtype=float)))
        fit = fit_svi_slice(
            by_strike["log_moneyness"].to_numpy(dtype=float),
            by_strike["total_variance"].to_numpy(dtype=float),
            base_weights,
        )
        fits[key] = fit
        indices = group.index
        result.loc[indices, "svi_status"] = str(fit["status"])
        if fit.get("parameters") is None:
            continue
        parameters = fit["parameters"]
        time_years = np.maximum(result.loc[indices, "dte"].to_numpy(dtype=float) / 365.0, 1e-12)
        fitted_variance = svi_total_variance(result.loc[indices, "log_moneyness"].to_numpy(dtype=float), parameters)
        fitted_iv = np.sqrt(np.maximum(fitted_variance, 0.0) / time_years) * 100.0
        result.loc[indices, "svi_fitted_iv"] = fitted_iv
        result.loc[indices, "svi_residual_iv"] = result.loc[indices, "market_iv"].to_numpy(dtype=float) - fitted_iv
        scale_iv = max(1.4826 * float(np.median(np.abs(result.loc[indices, "svi_residual_iv"] - result.loc[indices, "svi_residual_iv"].median()))), 0.05)
        result.loc[indices, "svi_robust_weight"] = np.minimum(1.0, 1.5 * scale_iv / np.maximum(np.abs(result.loc[indices, "svi_residual_iv"]), 1e-12))
        result.loc[indices, "svi_outlier"] = np.abs(result.loc[indices, "svi_residual_iv"]) > 3.5 * scale_iv
        for name in ("a", "b", "rho", "m", "sigma"):
            result.loc[indices, f"svi_{name}"] = parameters[name]
        result.loc[indices, "svi_rmse_total_variance"] = fit["rmse_total_variance"]
        result.loc[indices, "svi_minimum_butterfly_g"] = fit["minimum_butterfly_g"]
        result.loc[indices, "svi_butterfly_arbitrage_free"] = fit["butterfly_arbitrage_free"]
        result.loc[indices, "svi_parameter_constraints_satisfied"] = fit["parameter_constraint_satisfied"]

    for (ticker, date), expirations in result.groupby(["ticker", "date"], sort=True):
        ordered = expirations[["expiration", "dte"]].drop_duplicates().sort_values("dte")
        previous_fit: dict[str, object] | None = None
        previous_expiration: pd.Timestamp | None = None
        for row in ordered.itertuples(index=False):
            key = (ticker, date, row.expiration)
            current_fit = fits.get(key)
            if current_fit is None or current_fit.get("parameters") is None:
                previous_fit, previous_expiration = current_fit, row.expiration
                continue
            if previous_fit is not None and previous_fit.get("parameters") is not None:
                grid = np.linspace(-0.50, 0.50, 401)
                change = svi_total_variance(grid, current_fit["parameters"]) - svi_total_variance(grid, previous_fit["parameters"])
                minimum_change = float(np.min(change))
                indices = result.index[
                    (result["ticker"] == ticker) & (result["date"] == date) & (result["expiration"] == row.expiration)
                ]
                result.loc[indices, "svi_calendar_min_total_variance_change"] = minimum_change
                result.loc[indices, "svi_calendar_arbitrage_free"] = minimum_change >= -1e-7
            previous_fit, previous_expiration = current_fit, row.expiration
    return result


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
        svi_status = str(group["svi_status"].iloc[0]) if "svi_status" in group else "not_fitted"
        if svi_status == "fitted":
            parameters = {name: float(group[f"svi_{name}"].iloc[0]) for name in ("a", "b", "rho", "m", "sigma")}
            time_years = max(float(by_strike["dte"].median()) / 365.0, 1e-12)
            svi_atm_variance = float(svi_total_variance(0.0, parameters))
            if svi_atm_variance > 0:
                atm_iv = math.sqrt(svi_atm_variance / time_years) * 100.0
        slope = np.nan
        if len(by_strike) >= 3 and by_strike["log_moneyness"].nunique() >= 3:
            slope = float(np.polyfit(by_strike["log_moneyness"], by_strike["market_iv"], 1)[0] * 0.10)
        rows.append({
            **dict(zip(keys, key, strict=True)),
            "atm_iv": atm_iv,
            "iv_skew_slope_per_10pct_moneyness": slope,
            "expiration_dte": float(by_strike["dte"].median()),
            "atm_iv_source": "svi_forward_atm" if svi_status == "fitted" else "nearest_forward_strike",
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

    local = _add_svi_context(prepare_surface_contracts(options))
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
