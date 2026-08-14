"""Shared, auditable controls for horizon, surface, data, and signal decisions.

These helpers intentionally contain no order or execution side effects.  They
convert contract metadata into diagnostics used by the offline research ranker.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable

import numpy as np
import pandas as pd


SUPPORTED_HORIZONS = (1, 2, 3, 5, 10)
SURFACE_SHIFT_METHODS = (
    "additive_iv", "multiplicative_iv", "variance_shift", "total_variance_shift",
)


@dataclass(frozen=True)
class HorizonMapping:
    trading_dte: int
    method: str
    lower_horizon: int | None
    upper_horizon: int | None
    interpolation_weight: float | None
    ranking_eligible: bool
    warning: str | None


def trading_day_dte(origin: object, expiration: object, holidays: Iterable[object] | None = None) -> tuple[int, str]:
    """Count close-to-close trading-return opportunities with an explicit calendar status."""

    start = pd.Timestamp(origin).normalize()
    end = pd.Timestamp(expiration).normalize()
    if end <= start:
        return 0, "0DTE requires an intraday model; daily close-to-close forecast is diagnostic only."
    holiday_values = np.array(
        [np.datetime64(pd.Timestamp(value).date(), "D") for value in (holidays or [])],
        dtype="datetime64[D]",
    )
    kwargs = {"holidays": holiday_values} if holiday_values.size else {}
    count = int(np.busday_count(np.datetime64(start.date(), "D"), np.datetime64(end.date(), "D"), **kwargs))
    warning = None if holiday_values.size else "Official holiday/early-close calendar unavailable; weekday trading DTE used."
    return max(count, 0), warning


def map_horizon(trading_dte: int | float, horizons: Iterable[int] = SUPPORTED_HORIZONS) -> HorizonMapping:
    available = sorted({int(value) for value in horizons if int(value) > 0})
    if not available:
        raise ValueError("at least one positive forecast horizon is required")
    target = int(max(float(trading_dte), 0))
    if target <= 0:
        return HorizonMapping(target, "unavailable", available[0], available[0], 0.0, False, "0DTE disabled for high-confidence ranking: intraday model unavailable.")
    if target in available:
        short = target <= 1
        return HorizonMapping(
            target, "exact", target, target, 0.0, not short,
            "Daily close-to-close forecast used for 1DTE; intraday and event risk are unmodeled." if short else None,
        )
    lower = max((value for value in available if value < target), default=None)
    upper = min((value for value in available if value > target), default=None)
    if lower is not None and upper is not None:
        weight = (target - lower) / (upper - lower)
        return HorizonMapping(target, "interpolated", lower, upper, float(weight), True, None)
    nearest = lower if lower is not None else upper
    return HorizonMapping(target, "extrapolated", nearest, nearest, 0.0, False, f"No bracketing horizon; {nearest}D forecast used for {target} trading days.")


def interpolate_variance_forecast(
    lower_vol: float,
    upper_vol: float,
    weight: float,
) -> float:
    """Linear interpolation of annualized variance, returned as annualized percent vol."""

    fraction = min(max(float(weight), 0.0), 1.0)
    variance = (1.0 - fraction) * (float(lower_vol) / 100.0) ** 2 + fraction * (float(upper_vol) / 100.0) ** 2
    return math.sqrt(max(variance, 0.0)) * 100.0


def shift_strike_volatility(
    market_strike_vol: float,
    market_atm_vol: float,
    forecast_atm_vol: float,
    *,
    time_years: float,
    method: str = "total_variance_shift",
    minimum_vol: float = 0.01,
    maximum_vol: float = 500.0,
    warning_low: float = 5.0,
    warning_high: float = 200.0,
) -> dict[str, object]:
    strike = float(market_strike_vol)
    market_atm = float(market_atm_vol)
    forecast_atm = float(forecast_atm_vol)
    years = max(float(time_years), 1e-12)
    if not all(np.isfinite([strike, market_atm, forecast_atm])) or min(strike, market_atm, forecast_atm) <= 0:
        return {"volatility": np.nan, "status": "invalid_inputs", "warning": "Positive strike, market ATM, and forecast ATM volatility are required.", "method": method}
    selected = method if method in SURFACE_SHIFT_METHODS else "total_variance_shift"
    if selected == "additive_iv":
        raw = strike + forecast_atm - market_atm
    elif selected == "multiplicative_iv":
        raw = strike * forecast_atm / market_atm
    elif selected == "variance_shift":
        raw = math.sqrt(max(strike ** 2 + forecast_atm ** 2 - market_atm ** 2, 0.0))
    else:
        total_variance = (strike / 100.0) ** 2 * years
        market_atm_total = (market_atm / 100.0) ** 2 * years
        forecast_atm_total = (forecast_atm / 100.0) ** 2 * years
        raw = math.sqrt(max((total_variance + forecast_atm_total - market_atm_total) / years, 0.0)) * 100.0
    bounded = min(max(raw, float(minimum_vol)), float(maximum_vol))
    warnings: list[str] = []
    if not np.isfinite(raw) or raw <= 0:
        warnings.append("Surface transform produced nonpositive variance and was floored.")
    if not math.isclose(raw, bounded, rel_tol=0.0, abs_tol=1e-12):
        warnings.append(f"Surface transform was clamped to {bounded:.2f}%.")
    if bounded < warning_low:
        warnings.append("Forecast strike volatility is unusually low.")
    if bounded > warning_high:
        warnings.append("Forecast strike volatility is unusually high.")
    return {
        "volatility": bounded,
        "raw_volatility": raw,
        "status": "warning" if warnings else "pass",
        "warning": " ".join(warnings),
        "method": selected,
    }


def executable_edge_diagnostics(
    model_value: float,
    market_mid: float,
    bid: float,
    ask: float,
    *,
    tick_size: float = 0.01,
    estimated_fees: float = 0.02,
) -> dict[str, float | bool | str]:
    values = np.asarray([model_value, market_mid, bid, ask], dtype=float)
    if not np.isfinite(values).all() or bid <= 0 or market_mid <= 0 or ask <= bid:
        return {"valid": False, "warning": "Executable edges require a valid unlocked bid/ask."}
    spread = float(ask - bid)
    minimum = max(float(tick_size), float(estimated_fees), 0.5 * spread, 0.01 * max(float(market_mid), 0.0))
    long_edge = float(model_value - ask)
    short_edge = float(bid - model_value)
    return {
        "valid": True,
        "midpoint_edge": float(model_value - market_mid),
        "long_executable_edge": long_edge,
        "short_executable_edge": short_edge,
        "spread": spread,
        "spread_pct": spread / market_mid * 100.0 if market_mid > 0 else np.inf,
        "minimum_edge": minimum,
        "long_threshold_passed": long_edge >= minimum,
        "short_threshold_passed": short_edge >= minimum,
        "long_edge_to_spread_ratio": long_edge / max(spread, tick_size),
        "short_edge_to_spread_ratio": short_edge / max(spread, tick_size),
    }


def data_quality_diagnostics(row: pd.Series, *, max_age_seconds: int = 120) -> dict[str, object]:
    warnings: list[str] = []
    bid, ask, mid = (pd.to_numeric(pd.Series([row.get(name)]), errors="coerce").iloc[0] for name in ("bid", "ask", "market_mid"))
    valid_bid_ask = bool(np.isfinite([bid, ask, mid]).all() and bid > 0 and ask > bid and mid > 0)
    quote_timestamp = pd.to_datetime(row.get("quote_timestamp"), errors="coerce", utc=True)
    underlying_timestamp = pd.to_datetime(row.get("underlying_timestamp"), errors="coerce", utc=True)
    observation_timestamp = pd.to_datetime(row.get("observation_timestamp"), errors="coerce", utc=True)
    quote_timestamp_available = not pd.isna(quote_timestamp)
    underlying_timestamp_available = not pd.isna(underlying_timestamp)
    capture_timestamp_available = not pd.isna(observation_timestamp)
    capture_fresh = bool(
        quote_timestamp_available and capture_timestamp_available and
        abs((observation_timestamp - quote_timestamp).total_seconds()) <= max_age_seconds
    )
    underlying_fresh = bool(
        underlying_timestamp_available and capture_timestamp_available and
        abs((observation_timestamp - underlying_timestamp).total_seconds()) <= max_age_seconds
    )
    session = str(row.get("market_session", "unknown"))
    mixed_session = session not in {"regular", "historical_regular_close"}
    volume_present = pd.notna(row.get("volume"))
    oi_present = pd.notna(row.get("open_interest"))
    volume = float(row.get("volume")) if volume_present else np.nan
    oi = float(row.get("open_interest")) if oi_present else np.nan
    liquid = bool((volume_present and volume >= 10) or (oi_present and oi >= 100))
    partial = str(row.get("scan_status", "complete")) in {"running", "partial", "aborted"}
    parse_warning = bool(str(row.get("dom_parse_warning", "")).strip())

    if not valid_bid_ask:
        warnings.append("Bid/ask is missing, locked, crossed, or invalid.")
    if not quote_timestamp_available:
        warnings.append("Option source timestamp unavailable; historical snapshot is not execution-grade.")
    elif not capture_fresh:
        warnings.append("Option quote timestamp is stale relative to observation timestamp.")
    if not underlying_timestamp_available:
        warnings.append("Underlying source timestamp unavailable.")
    elif not underlying_fresh:
        warnings.append("Underlying quote timestamp is stale relative to observation timestamp.")
    if mixed_session:
        warnings.append("Market session is unknown or mixed.")
    if not volume_present and not oi_present:
        warnings.append("Volume and open interest are missing.")
    elif not liquid:
        warnings.append("Liquidity gate failed.")
    if partial:
        warnings.append("Visible chain scan was incomplete.")
    if parse_warning:
        warnings.append(str(row.get("dom_parse_warning")))

    if not valid_bid_ask:
        state = "invalid_bid_ask"
    elif quote_timestamp_available and not capture_fresh:
        state = "stale_option_quote"
    elif underlying_timestamp_available and not underlying_fresh:
        state = "stale_underlying_quote"
    elif mixed_session:
        state = "mixed_session_warning"
    elif partial:
        state = "partial_scan"
    elif not liquid:
        state = "missing_liquidity"
    elif not quote_timestamp_available or not underlying_timestamp_available or parse_warning:
        state = "dom_parse_warning"
    else:
        state = "fresh_exact"

    score = (
        0.20 + 0.18 * valid_bid_ask + 0.12 * capture_fresh +
        0.14 * (not mixed_session) + 0.10 * underlying_fresh +
        0.12 * liquid + 0.07 * (not partial) + 0.07 * (not parse_warning)
    )
    eligible = bool(
        valid_bid_ask and capture_fresh and underlying_fresh and
        not mixed_session and liquid and not partial and not parse_warning
    )
    return {
        "data_quality_state": state,
        "data_quality_score": min(max(float(score), 0.0), 1.0),
        "data_quality_warning": " ".join(warnings),
        "data_quality_pass": eligible,
        "quote_timestamp_available": quote_timestamp_available,
        "underlying_timestamp_available": underlying_timestamp_available,
        "underlying_timestamp_fresh": underlying_fresh,
        "quote_freshness_basis": "source_timestamp" if quote_timestamp_available else "unavailable",
    }


def classify_signal(
    forecast_vol: float,
    market_iv: float,
    edges: dict[str, object],
    *,
    data_pass: bool,
    model_pass: bool,
    surface_pass: bool,
    minimum_vol_edge: float = 0.25,
) -> tuple[str, str]:
    if not data_pass:
        return "data_warning", "Data-quality gate failed."
    if not bool(edges.get("valid")):
        return "liquidity_warning", str(edges.get("warning", "Executable quote unavailable."))
    if not model_pass:
        return "model_warning", "Pricing model stability gate failed."
    if not surface_pass:
        return "surface_warning", "Surface sanity gate failed."
    vol_edge = float(forecast_vol) - float(market_iv)
    if vol_edge >= minimum_vol_edge and bool(edges.get("long_threshold_passed")):
        return "long_vol_candidate", "Forecast volatility and ask-based scenario edge agree."
    if vol_edge <= -minimum_vol_edge and bool(edges.get("short_threshold_passed")):
        return "short_vol_candidate", "Forecast volatility and bid-based scenario edge agree."
    if (vol_edge >= minimum_vol_edge and bool(edges.get("short_threshold_passed"))) or (
        vol_edge <= -minimum_vol_edge and bool(edges.get("long_threshold_passed"))
    ):
        return "mixed_signal", "Volatility and executable-price directions disagree."
    return "no_signal", "Edge does not clear volatility and executable-cost thresholds."
