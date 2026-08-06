"""Small vector-friendly Black–Scholes implementation used by the research engine."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd


# Full double-precision error function (math.erf is correct to ~1e-16), applied
# elementwise. This replaces the earlier Abramowitz-Stegun approximation whose
# error near ~1e-7 was the dominant source of price/greek/IV inaccuracy.
_vector_erf = np.vectorize(math.erf, otypes=[float])


def _normal_cdf(value: np.ndarray) -> np.ndarray:
    array = np.asarray(value, dtype=float)
    return 0.5 * (1.0 + _vector_erf(array / math.sqrt(2.0)))


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
    option_type: pd.Series | np.ndarray | str = "call",
) -> dict[str, np.ndarray]:
    """Return the standard European greeks.

    Conventions: gamma and vega are identical for a call and a put, so they are
    returned type-independently. Vega is dollars per one volatility point (a 1%
    move in sigma). Theta is dollars of value lost per calendar day. Rho is
    dollars per one percentage-point move in the rate. Delta, theta and rho
    depend on the option type supplied.
    """

    terms = _black_scholes_terms(
        spot, strike, dte, volatility_percent, rate_percent, dividend_percent,
    )
    s, k = terms["spot"], terms["strike"]
    t, sigma = terms["time"], terms["sigma"]
    d1, d2 = terms["d1"], terms["d2"]
    discount_r, discount_q = terms["discount_r"], terms["discount_q"]
    sqrt_t = terms["sqrt_time"]
    density = _normal_pdf(d1)
    r = np.asarray(rate_percent, dtype=float) / 100.0
    q = np.asarray(dividend_percent, dtype=float) / 100.0

    gamma = discount_q * density / (s * sigma * sqrt_t)
    vega = s * discount_q * density * sqrt_t / 100.0

    is_put = np.char.lower(np.asarray(option_type, dtype=str)) == "put"
    call_delta = discount_q * _normal_cdf(d1)
    put_delta = -discount_q * _normal_cdf(-d1)
    delta = np.where(is_put, put_delta, call_delta)

    # Per-year theta, then converted to per-calendar-day (÷365) to match the
    # calendar-time pricing convention used throughout the engine.
    theta_common = -(s * discount_q * density * sigma) / (2.0 * sqrt_t)
    call_theta = (
        theta_common
        - r * k * discount_r * _normal_cdf(d2)
        + q * s * discount_q * _normal_cdf(d1)
    ) / 365.0
    put_theta = (
        theta_common
        + r * k * discount_r * _normal_cdf(-d2)
        - q * s * discount_q * _normal_cdf(-d1)
    ) / 365.0
    theta = np.where(is_put, put_theta, call_theta)

    call_rho = k * t * discount_r * _normal_cdf(d2) / 100.0
    put_rho = -k * t * discount_r * _normal_cdf(-d2) / 100.0
    rho = np.where(is_put, put_rho, call_rho)

    return {
        "gamma": gamma,
        "vega": vega,
        "delta": delta,
        "theta": theta,
        "rho": rho,
        "time_years": t,
    }


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
    tolerance: float = 1e-8,
    max_iterations: int = 120,
) -> float:
    """Invert Black-Scholes for implied volatility (percent).

    Uses safeguarded Newton iteration driven by vega, and falls back to a
    bisection step whenever a Newton step would leave the bracket or stall.
    Prices outside the model's arbitrage bounds are rejected as NaN. Combining
    Newton with a maintained bracket keeps the fast quadratic convergence of
    Newton's method without the divergence risk of unsafeguarded Newton.
    """

    if not all(np.isfinite(value) for value in (market_price, spot, strike, dte)):
        return float("nan")
    if market_price < 0 or spot <= 0 or strike <= 0 or dte <= 0:
        return float("nan")

    def price(volatility: float) -> float:
        return float(np.asarray(black_scholes_price(
            spot, strike, dte, volatility, rate_percent, dividend_percent, option_type,
        )).item())

    def vega_per_point(volatility: float) -> float:
        return float(np.asarray(black_scholes_greeks(
            spot, strike, dte, volatility, rate_percent, dividend_percent,
        )["vega"]).item())

    low, high = float(lower), float(upper)
    low_price, high_price = price(low), price(high)
    # The price is monotone increasing in volatility, so a target outside
    # [price(lower), price(upper)] has no implied volatility on the grid.
    if market_price < low_price - tolerance or market_price > high_price + tolerance:
        return float("nan")

    # A volatility-agnostic starting guess (Brenner-Subrahmanyam) close to ATM.
    guess = max(min(math.sqrt(2.0 * math.pi / (dte / 365.0)) * market_price / spot * 100.0, high), low)
    for _ in range(max_iterations):
        model_price = price(guess)
        difference = model_price - market_price
        if abs(difference) <= tolerance:
            return guess
        # Maintain the bracket around the root as new information arrives.
        if difference < 0:
            low = guess
        else:
            high = guess
        slope = vega_per_point(guess)
        newton = guess - difference / slope if slope > 1e-12 else float("inf")
        # Accept the Newton step only if it stays strictly inside the bracket;
        # otherwise bisect. This is the classic safeguarded-Newton hybrid.
        if low < newton < high:
            guess = newton
        else:
            guess = 0.5 * (low + high)
    return guess
