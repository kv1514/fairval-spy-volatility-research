"""Small vector-friendly Black–Scholes implementation used by the research engine."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd


def _normal_cdf(value: np.ndarray) -> np.ndarray:
    # Abramowitz-Stegun approximation; accurate enough for screening and avoids scipy.
    sign = np.where(value < 0, -1.0, 1.0)
    absolute = np.abs(value) / math.sqrt(2.0)
    t = 1.0 / (1.0 + 0.3275911 * absolute)
    polynomial = (
        (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
        * t
    )
    erf = 1.0 - polynomial * np.exp(-(absolute**2))
    return 0.5 * (1.0 + sign * erf)


def _normal_pdf(value: np.ndarray) -> np.ndarray:
    return np.exp(-0.5 * np.square(value)) / math.sqrt(2.0 * math.pi)


def _black_scholes_terms(
    spot: pd.Series | np.ndarray,
    strike: pd.Series | np.ndarray,
    dte: pd.Series | np.ndarray,
    volatility_percent: pd.Series | np.ndarray,
    rate_percent: pd.Series | np.ndarray | float,
    dividend_percent: pd.Series | np.ndarray | float,
) -> dict[str, np.ndarray]:
    s = np.maximum(np.asarray(spot, dtype=float), 1e-9)
    k = np.maximum(np.asarray(strike, dtype=float), 1e-9)
    t = np.maximum(np.asarray(dte, dtype=float) / 365.0, 1.0 / (365.0 * 24.0 * 60.0))
    sigma = np.maximum(np.asarray(volatility_percent, dtype=float) / 100.0, 1e-6)
    r = np.asarray(rate_percent, dtype=float) / 100.0
    q = np.asarray(dividend_percent, dtype=float) / 100.0
    sqrt_t = np.sqrt(t)
    discount_r = np.exp(-r * t)
    discount_q = np.exp(-q * t)
    d1 = (np.log(s / k) + (r - q + 0.5 * sigma**2) * t) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    return {
        "spot": s,
        "strike": k,
        "time": t,
        "sigma": sigma,
        "discount_r": discount_r,
        "discount_q": discount_q,
        "sqrt_time": sqrt_t,
        "d1": d1,
        "d2": d2,
    }


def black_scholes_price(
    spot: pd.Series | np.ndarray,
    strike: pd.Series | np.ndarray,
    dte: pd.Series | np.ndarray,
    volatility_percent: pd.Series | np.ndarray,
    rate_percent: pd.Series | np.ndarray | float = 0.0,
    dividend_percent: pd.Series | np.ndarray | float = 0.0,
    option_type: pd.Series | np.ndarray | str = "call",
) -> np.ndarray:
    """Return European option prices using calendar-day time and percent inputs."""

    terms = _black_scholes_terms(
        spot, strike, dte, volatility_percent, rate_percent, dividend_percent,
    )
    s, k = terms["spot"], terms["strike"]
    d1, d2 = terms["d1"], terms["d2"]
    call = s * terms["discount_q"] * _normal_cdf(d1) - k * terms["discount_r"] * _normal_cdf(d2)
    put = k * terms["discount_r"] * _normal_cdf(-d2) - s * terms["discount_q"] * _normal_cdf(-d1)
    types = np.char.lower(np.asarray(option_type, dtype=str))
    return np.maximum(np.where(types == "put", put, call), 0.0)


def black_scholes_greeks(
    spot: pd.Series | np.ndarray,
    strike: pd.Series | np.ndarray,
    dte: pd.Series | np.ndarray,
    volatility_percent: pd.Series | np.ndarray,
    rate_percent: pd.Series | np.ndarray | float = 0.0,
    dividend_percent: pd.Series | np.ndarray | float = 0.0,
) -> dict[str, np.ndarray]:
    """Return gamma and vega; vega is dollars per one volatility point."""

    terms = _black_scholes_terms(
        spot, strike, dte, volatility_percent, rate_percent, dividend_percent,
    )
    density = _normal_pdf(terms["d1"])
    gamma = (
        terms["discount_q"] * density
        / (terms["spot"] * terms["sigma"] * terms["sqrt_time"])
    )
    vega = terms["spot"] * terms["discount_q"] * density * terms["sqrt_time"] / 100.0
    return {"gamma": gamma, "vega": vega, "time_years": terms["time"]}


def implied_volatility_percent(
    market_price: float,
    spot: float,
    strike: float,
    dte: float,
    option_type: str,
    rate_percent: float = 0.0,
    dividend_percent: float = 0.0,
    lower: float = 0.01,
    upper: float = 500.0,
    tolerance: float = 1e-7,
    max_iterations: int = 120,
) -> float:
    """Invert Black-Scholes by bisection, rejecting prices outside model bounds."""

    if not all(np.isfinite(value) for value in (market_price, spot, strike, dte)):
        return float("nan")
    if market_price < 0 or spot <= 0 or strike <= 0 or dte <= 0:
        return float("nan")

    def price(volatility: float) -> float:
        return float(np.asarray(black_scholes_price(
            spot, strike, dte, volatility, rate_percent, dividend_percent, option_type,
        )).item())

    low_price, high_price = price(lower), price(upper)
    if market_price < low_price - tolerance or market_price > high_price + tolerance:
        return float("nan")
    low, high = float(lower), float(upper)
    for _ in range(max_iterations):
        middle = 0.5 * (low + high)
        model_price = price(middle)
        if abs(model_price - market_price) <= tolerance:
            return middle
        if model_price < market_price:
            low = middle
        else:
            high = middle
    return 0.5 * (low + high)
