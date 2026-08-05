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
    call = s * discount_q * _normal_cdf(d1) - k * discount_r * _normal_cdf(d2)
    put = k * discount_r * _normal_cdf(-d2) - s * discount_q * _normal_cdf(-d1)
    types = np.char.lower(np.asarray(option_type, dtype=str))
    return np.maximum(np.where(types == "put", put, call), 0.0)
