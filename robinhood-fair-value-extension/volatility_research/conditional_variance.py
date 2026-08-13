"""Leakage-safe conditional-variance forecasts from daily close returns.

The implementation intentionally keeps the parameter search small and
deterministic.  GARCH parameters are estimated by Gaussian quasi maximum
likelihood on returns available at the forecast origin.  GJR-GARCH adds the
standard negative-shock term.  No option outcome or future realized-volatility
target enters either fit.
"""

from __future__ import annotations

from itertools import product
from typing import Iterable

import numpy as np
import pandas as pd


TRADING_DAYS = 252.0
VARIANCE_FLOOR = 1e-12


def _candidate_parameters(asymmetric: bool) -> np.ndarray:
    """Return a compact stationary parameter grid.

    The grid is expressed through persistence because that is the quantity
    that governs multi-day mean reversion.  For GJR-GARCH the conventional
    symmetric-innovation persistence approximation is alpha + beta + gamma/2.
    """

    alphas = (0.02, 0.04, 0.06, 0.08, 0.10, 0.14, 0.18)
    persistences = (0.82, 0.88, 0.92, 0.95, 0.97, 0.985, 0.995)
    gammas = (0.0,) if not asymmetric else (0.0, 0.03, 0.06, 0.10, 0.16, 0.24)
    rows = []
    for alpha, gamma, persistence in product(alphas, gammas, persistences):
        beta = persistence - alpha - 0.5 * gamma
        if beta < 0.05 or persistence >= 0.999:
            continue
        rows.append((alpha, beta, gamma, persistence))
    return np.asarray(rows, dtype=float)


def _filter_candidates(
    returns: np.ndarray,
    candidates: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Vectorized Gaussian QML losses and next variances for a parameter grid."""

    clean = np.asarray(returns, dtype=float)
    clean = clean[np.isfinite(clean)]
    if clean.size < 2:
        raise ValueError("at least two finite returns are required")
    alpha, beta, gamma, persistence = candidates.T
    long_run = max(float(np.mean(np.square(clean))), VARIANCE_FLOOR)
    omega = np.maximum(long_run * (1.0 - persistence), VARIANCE_FLOOR)
    variance = np.full(len(candidates), long_run, dtype=float)
    loss = np.zeros(len(candidates), dtype=float)
    for index in range(1, len(clean)):
        previous = float(clean[index - 1])
        shock = previous * previous
        variance = omega + alpha * shock + gamma * (previous < 0) * shock + beta * variance
        variance = np.maximum(variance, VARIANCE_FLOOR)
        current = float(clean[index])
        loss += np.log(variance) + current * current / variance
    loss /= max(len(clean) - 1, 1)
    last = float(clean[-1])
    last_shock = last * last
    next_variance = omega + alpha * last_shock + gamma * (last < 0) * last_shock + beta * variance
    return loss, np.maximum(next_variance, VARIANCE_FLOOR), np.full(len(candidates), long_run)


def fit_garch_qmle(returns: Iterable[float], asymmetric: bool = False) -> dict[str, float]:
    """Fit stationary GARCH/GJR-GARCH parameters by deterministic Gaussian QML."""

    clean = np.asarray(tuple(returns), dtype=float)
    clean = clean[np.isfinite(clean)]
    if clean.size < 20:
        raise ValueError("at least 20 finite returns are required for GARCH fitting")
    candidates = _candidate_parameters(asymmetric)
    losses, next_variances, long_runs = _filter_candidates(clean, candidates)
    best = int(np.nanargmin(losses))
    alpha, beta, gamma, persistence = candidates[best]
    long_run = float(long_runs[best])
    return {
        "alpha": float(alpha),
        "beta": float(beta),
        "gamma": float(gamma),
        "persistence": float(persistence),
        "omega": float(max(long_run * (1.0 - persistence), VARIANCE_FLOOR)),
        "long_run_variance": long_run,
        "next_variance": float(next_variances[best]),
        "qml_loss": float(losses[best]),
        "n_train": int(clean.size),
    }


def _default_parameters(returns: np.ndarray, asymmetric: bool) -> dict[str, float]:
    clean = np.asarray(returns, dtype=float)
    clean = clean[np.isfinite(clean)]
    long_run = max(float(np.mean(np.square(clean))) if clean.size else VARIANCE_FLOOR, VARIANCE_FLOOR)
    alpha = 0.05
    gamma = 0.10 if asymmetric else 0.0
    persistence = 0.94
    beta = persistence - alpha - 0.5 * gamma
    omega = long_run * (1.0 - persistence)
    variance = long_run
    for index in range(1, len(clean)):
        previous = float(clean[index - 1])
        variance = omega + alpha * previous**2 + gamma * (previous < 0) * previous**2 + beta * variance
    last = float(clean[-1]) if clean.size else 0.0
    next_variance = omega + alpha * last**2 + gamma * (last < 0) * last**2 + beta * variance
    return {
        "alpha": alpha,
        "beta": beta,
        "gamma": gamma,
        "persistence": persistence,
        "omega": float(max(omega, VARIANCE_FLOOR)),
        "long_run_variance": long_run,
        "next_variance": float(max(next_variance, VARIANCE_FLOOR)),
        "qml_loss": np.nan,
        "n_train": int(clean.size),
    }


def average_forward_variance(parameters: dict[str, float], horizon: int) -> float:
    """Average expected daily variance over the next ``horizon`` sessions."""

    steps = max(int(horizon), 1)
    persistence = float(parameters["persistence"])
    long_run = max(float(parameters["long_run_variance"]), VARIANCE_FLOOR)
    next_variance = max(float(parameters["next_variance"]), VARIANCE_FLOOR)
    path = long_run + np.power(persistence, np.arange(steps, dtype=float)) * (next_variance - long_run)
    return float(max(np.mean(path), VARIANCE_FLOOR))


def walk_forward_garch(
    returns: Iterable[float],
    dates: Iterable[pd.Timestamp],
    horizons: Iterable[int],
    *,
    asymmetric: bool,
    min_train_observations: int,
    training_window: int | None,
    rebalance_every: int,
) -> tuple[dict[int, np.ndarray], list[dict[str, float] | None], list[pd.Timestamp | pd.NaT]]:
    """Produce forecasts whose date-t value never reads a return after date t."""

    values = np.asarray(tuple(returns), dtype=float)
    date_values = [pd.Timestamp(value) for value in dates]
    requested = tuple(sorted({max(int(value), 1) for value in horizons}))
    forecasts = {horizon: np.full(len(values), np.nan, dtype=float) for horizon in requested}
    parameters_by_date: list[dict[str, float] | None] = [None] * len(values)
    train_end_by_date: list[pd.Timestamp | pd.NaT] = [pd.NaT] * len(values)
    active: dict[str, float] | None = None
    active_train_end: pd.Timestamp | pd.NaT = pd.NaT
    cadence = max(int(rebalance_every), 1)

    for index, current_return in enumerate(values):
        history_start = 0 if training_window is None else max(0, index + 1 - int(training_window))
        history = values[history_start : index + 1]
        finite_history = history[np.isfinite(history)]
        created_default = active is None and finite_history.size >= 20
        if created_default:
            active = _default_parameters(finite_history, asymmetric)
        should_rebalance = index % cadence == 0 and finite_history.size >= max(int(min_train_observations), 20)
        if should_rebalance:
            active = fit_garch_qmle(finite_history, asymmetric=asymmetric)
            active_train_end = date_values[index]
        elif active is not None and not created_default and np.isfinite(current_return):
            # ``next_variance`` from the previous origin is today's conditional
            # variance.  Incorporate today's newly observed return to form the
            # variance forecast for t+1 without refitting parameters.
            shock = float(current_return) ** 2
            active = dict(active)
            active["next_variance"] = float(max(
                active["omega"]
                + active["alpha"] * shock
                + active["gamma"] * (float(current_return) < 0) * shock
                + active["beta"] * active["next_variance"],
                VARIANCE_FLOOR,
            ))
        if active is None:
            continue
        snapshot = dict(active)
        parameters_by_date[index] = snapshot
        train_end_by_date[index] = active_train_end
        for horizon in requested:
            forecasts[horizon][index] = np.sqrt(average_forward_variance(snapshot, horizon) * TRADING_DAYS) * 100.0
    return forecasts, parameters_by_date, train_end_by_date
