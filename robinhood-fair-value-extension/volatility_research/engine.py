"""Leakage-safe walk-forward volatility forecasting and option ranking."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
from typing import Iterable

import numpy as np
import pandas as pd

from .black_scholes import black_scholes_greeks, black_scholes_price
from .conditional_variance import walk_forward_garch
from .pricing_models import PricingInputs, contract_pricing_diagnostics
from .research_controls import (
    classify_signal,
    data_quality_diagnostics,
    executable_edge_diagnostics,
    interpolate_variance_forecast,
    map_horizon,
    shift_strike_volatility,
    trading_day_dte,
)
from .surface import add_volatility_surface_context, prepare_surface_contracts, surface_benchmark_records


TRADING_DAYS = 252.0
# Named baseline realized-vol windows kept for reporting, the fixed blend, and
# the realized_N models. These are a small, human-recognizable subset.
REPORT_WINDOWS = (5, 10, 20, 60)
# Broad, configurable candidate set the blends may draw from. It spans very
# short (1D) to roughly a quarter (60D). Fine granularity at the short end lets
# the sparse model test whether recent volatility dominates the 1D/2D horizons.
# The optimizer/sparse selector decide which windows are actually useful out of
# sample; the set is configurable (extendable toward 100D) via ForecastConfig.
CANDIDATE_WINDOWS = (1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 45, 60)
VOL_WINDOWS = REPORT_WINDOWS  # backwards-compatible alias for the baseline set
DEFAULT_HORIZONS = (1, 2, 3, 5, 10)
FIXED_WEIGHTS = np.array([0.40, 0.30, 0.20, 0.10], dtype=float)
BASE_MODEL_NAMES = (
    "realized_5", "realized_10", "realized_20", "realized_60",
    "fixed_blend", "optimized_blend", "sparse_blend", "ewma", "har_rv",
    "garch_11", "gjr_garch",
)
ENSEMBLE_COMPONENTS = (
    "realized_20", "realized_60", "optimized_blend", "ewma", "har_rv", "garch_11", "gjr_garch",
)
MODEL_NAMES = (*BASE_MODEL_NAMES, "simple_ensemble", "adaptive_ensemble")
HAR_WINDOWS = (1, 5, 20)


@dataclass(frozen=True)
class ForecastConfig:
    horizons: tuple[int, ...] = DEFAULT_HORIZONS
    min_train_observations: int = 252
    training_window: int | None = 756
    rebalance_every: int = 21
    ewma_default_lambda: float = 0.94
    optimizer_max_iterations: int = 5_000
    optimizer_tolerance: float = 1e-12
    vol_windows: tuple[int, ...] = CANDIDATE_WINDOWS
    sparse_max_terms: int = 3
    weight_zero_threshold: float = 1e-8
    projected_gradient_iterations: int = 400
    projected_gradient_tolerance: float = 1e-13
    har_ridge_penalty: float = 1e-3
    ensemble_shrinkage: float = 0.10


def _validate_columns(frame: pd.DataFrame, required: Iterable[str], label: str) -> None:
    missing = sorted(set(required) - set(frame.columns))
    if missing:
        raise ValueError(f"{label} is missing required columns: {', '.join(missing)}")


def _normalize_percent(values: pd.Series) -> pd.Series:
    numeric = pd.to_numeric(values, errors="coerce").astype(float)
    finite = numeric[np.isfinite(numeric)]
    if not finite.empty and finite.abs().median() <= 1.5:
        numeric = numeric * 100.0
    return numeric


def _project_simplex(values: np.ndarray) -> np.ndarray:
    """Euclidean projection onto nonnegative weights that sum to one."""

    vector = np.asarray(values, dtype=float)
    if vector.ndim != 1 or vector.size == 0:
        raise ValueError("simplex projection expects a nonempty one-dimensional vector")
    sorted_values = np.sort(vector)[::-1]
    cumulative = np.cumsum(sorted_values) - 1.0
    indices = np.arange(1, vector.size + 1)
    positive = sorted_values - cumulative / indices > 0
    rho = np.nonzero(positive)[0][-1]
    theta = cumulative[rho] / float(rho + 1)
    projected = np.maximum(vector - theta, 0.0)
    return projected / projected.sum()


def _variance_design(
    volatility_features: np.ndarray,
    target_volatility: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Return finite variance-space design matrix and target (percent -> decimal)."""

    x = np.square(np.asarray(volatility_features, dtype=float) / 100.0)
    y = np.square(np.asarray(target_volatility, dtype=float) / 100.0)
    mask = np.isfinite(x).all(axis=1) & np.isfinite(y)
    return x[mask], y[mask]


def _equality_constrained_weights(gram_active: np.ndarray, rhs_active: np.ndarray) -> np.ndarray | None:
    """Least-squares weights on the active columns constrained to sum to one.

    Works from a precomputed Gram matrix (XᵀX) and cross term (Xᵀy) sliced to the
    active columns. Returns None when the solution is materially negative, so the
    caller can fall back to a projection.
    """

    columns = gram_active.shape[0]
    kkt = np.block([
        [gram_active, np.ones((columns, 1))],
        [np.ones((1, columns)), np.zeros((1, 1))],
    ])
    solution = np.linalg.lstsq(kkt, np.append(rhs_active, 1.0), rcond=None)[0][:columns]
    if np.any(solution < -1e-9):
        return None
    return np.maximum(solution, 0.0)


def _uniform_weights(feature_count: int) -> np.ndarray:
    return np.full(feature_count, 1.0 / feature_count, dtype=float)


def _optimize_variance_weights(
    volatility_features: np.ndarray,
    target_volatility: np.ndarray,
    config: ForecastConfig,
) -> np.ndarray:
    """Dense simplex-constrained variance blend over all candidate windows.

    Minimizes mean squared error in annualized variance by projected gradient
    descent onto the probability simplex. Projected gradient scales to a broad
    candidate set (unlike an exhaustive 2^k active-set search) and is fully
    deterministic given the training slice, preserving the walk-forward
    leakage guarantee.
    """

    x, y = _variance_design(volatility_features, target_volatility)
    feature_count = volatility_features.shape[1]
    if x.shape[0] < 2:
        return _uniform_weights(feature_count)
    # Precompute the Hessian A = (2/n) XᵀX and b = (2/n) Xᵀy once. The gradient
    # is then A·w - b, a tiny k×k matvec per iteration instead of an O(n·k)
    # product, which keeps the walk-forward run fast over a broad window set.
    scale = 2.0 / x.shape[0]
    hessian = scale * (x.T @ x)
    linear = scale * (x.T @ y)
    largest_eigenvalue = float(np.linalg.eigvalsh(hessian)[-1])
    if not np.isfinite(largest_eigenvalue) or largest_eigenvalue <= 1e-18:
        return _uniform_weights(feature_count)
    step = 1.0 / largest_eigenvalue
    weights = _uniform_weights(feature_count)
    for _ in range(max(config.projected_gradient_iterations, 1)):
        gradient = hessian @ weights - linear
        moved = _project_simplex(weights - step * gradient)
        if np.max(np.abs(moved - weights)) < config.projected_gradient_tolerance:
            weights = moved
            break
        weights = moved
    return weights


def _sparse_variance_weights(
    volatility_features: np.ndarray,
    target_volatility: np.ndarray,
    config: ForecastConfig,
) -> np.ndarray:
    """Greedy forward-selected sparse variance blend.

    Starting from no windows, repeatedly add the single candidate window that
    most reduces training variance MSE, refitting simplex-constrained weights on
    the chosen subset each step. Selection stops at ``sparse_max_terms`` windows
    or when no window materially improves the fit. Weights below
    ``weight_zero_threshold`` are dropped so unused windows carry exactly zero
    weight. Deterministic given the training slice.
    """

    x, y = _variance_design(volatility_features, target_volatility)
    feature_count = volatility_features.shape[1]
    if x.shape[0] < 2:
        return _uniform_weights(feature_count)
    # Precompute the Gram matrix and cross term once so each candidate fit is a
    # small sliced solve and each loss is a quadratic form, not an O(n·k) product.
    gram = x.T @ x
    cross = x.T @ y
    yty = float(y @ y)
    rows = x.shape[0]

    def _loss(weights: np.ndarray) -> float:
        return float((weights @ gram @ weights - 2.0 * weights @ cross + yty) / rows)

    max_terms = max(1, min(config.sparse_max_terms, feature_count))
    chosen: list[int] = []
    best_weights = _uniform_weights(feature_count)
    best_loss = float("inf")
    while len(chosen) < max_terms:
        step_best_loss = best_loss
        step_best_index: int | None = None
        step_best_weights: np.ndarray | None = None
        for candidate_index in range(feature_count):
            if candidate_index in chosen:
                continue
            active = np.array(sorted(chosen + [candidate_index]), dtype=int)
            solution = _equality_constrained_weights(gram[np.ix_(active, active)], cross[active])
            weights = np.zeros(feature_count, dtype=float)
            weights[active] = solution if solution is not None else _project_simplex(np.ones(len(active)))
            loss = _loss(weights)
            if loss < step_best_loss - 1e-15:
                step_best_loss = loss
                step_best_index = candidate_index
                step_best_weights = weights
        if step_best_index is None or step_best_weights is None:
            break
        chosen.append(step_best_index)
        best_loss = step_best_loss
        best_weights = step_best_weights
    zeroed = np.where(best_weights < config.weight_zero_threshold, 0.0, best_weights)
    if zeroed.sum() <= 0:
        return _uniform_weights(feature_count)
    return zeroed / zeroed.sum()


def _weights_dict(windows: Iterable[int], weights: np.ndarray, threshold: float = 1e-8) -> dict[str, float]:
    """Return only the non-negligible window weights, keyed by window string."""

    return {
        str(int(window)): float(weight)
        for window, weight in zip(windows, np.asarray(weights, dtype=float))
        if float(weight) > threshold
    }


def format_blend_formula(weights: dict[str, float] | None, threshold: float = 1e-8) -> str:
    """Render a readable variance-blend formula, e.g. sqrt(0.55*vol_60² + ...)."""

    if not weights:
        return "-"
    terms = sorted(
        ((str(window), float(weight)) for window, weight in weights.items() if float(weight) > threshold),
        key=lambda item: item[1],
        reverse=True,
    )
    if not terms:
        return "-"
    body = " + ".join(f"{weight:.2f}*vol_{window}²" for window, weight in terms)
    return f"sqrt({body})"


def _future_realized_vol(returns: np.ndarray, start_index: int, horizon: int) -> float:
    future = np.asarray(returns[start_index + 1 : start_index + horizon + 1], dtype=float)
    if future.size != horizon or not np.isfinite(future).all():
        return np.nan
    # A one-observation sample standard deviation is undefined. Absolute one-day
    # return is the standard realized-volatility proxy for the h=1 target.
    if horizon == 1:
        return float(abs(future[0]) * np.sqrt(TRADING_DAYS) * 100.0)
    return float(np.std(future, ddof=1) * np.sqrt(TRADING_DAYS) * 100.0)


def _ewma_volatility_paths(returns: np.ndarray, lambdas: np.ndarray) -> np.ndarray:
    """Return date-by-lambda annualized EWMA vol; each row uses returns through that row."""

    result = np.full((len(returns), len(lambdas)), np.nan, dtype=float)
    finite = np.asarray(returns, dtype=float)
    first = np.flatnonzero(np.isfinite(finite))
    if not first.size:
        return result
    initial_index = int(first[0])
    variance = np.full(len(lambdas), finite[initial_index] ** 2, dtype=float)
    result[initial_index] = np.sqrt(np.maximum(variance, 0.0) * TRADING_DAYS) * 100.0
    for index in range(initial_index + 1, len(finite)):
        if not np.isfinite(finite[index]):
            continue
        variance = lambdas * variance + (1.0 - lambdas) * finite[index] ** 2
        result[index] = np.sqrt(np.maximum(variance, 0.0) * TRADING_DAYS) * 100.0
    return result


def _fit_har_variance_model(training: pd.DataFrame, config: ForecastConfig) -> dict[str, np.ndarray] | None:
    """Fit a leakage-safe log-HAR variance forecast with a downside-return term.

    The daily/weekly/monthly components follow the parsimonious HAR-RV idea. A
    downside-return variance feature lets the model learn SPY's asymmetric
    volatility response without forcing it. Ridge shrinkage stabilizes the
    small rolling samples; the intercept is deliberately not penalized.
    """

    variance_columns = [np.square(training[f"vol_{window}"].to_numpy(float) / 100.0) for window in HAR_WINDOWS]
    leverage = np.where(
        training["log_return"].to_numpy(float) < 0,
        np.square(training["log_return"].to_numpy(float)) * TRADING_DAYS,
        0.0,
    )
    raw_x = np.column_stack([*(np.log(np.maximum(values, 1e-10)) for values in variance_columns), leverage])
    target = np.log(np.maximum(np.square(training["target_future_vol"].to_numpy(float) / 100.0), 1e-10))
    mask = np.isfinite(raw_x).all(axis=1) & np.isfinite(target)
    raw_x = raw_x[mask]
    target = target[mask]
    if len(target) < max(config.min_train_observations, raw_x.shape[1] + 2):
        return None
    mean = raw_x.mean(axis=0)
    scale = raw_x.std(axis=0)
    scale = np.where(scale > 1e-12, scale, 1.0)
    design = np.column_stack([np.ones(len(raw_x)), (raw_x - mean) / scale])
    penalty = np.eye(design.shape[1]) * max(float(config.har_ridge_penalty), 0.0)
    penalty[0, 0] = 0.0
    coefficients = np.linalg.solve(design.T @ design + penalty, design.T @ target)
    return {"mean": mean, "scale": scale, "coefficients": coefficients}


def _predict_har_volatility(model: dict[str, np.ndarray] | None, row: pd.Series) -> float:
    if model is None:
        return float(row["fixed_blend"])
    variance_values = [max(float(row[f"vol_{window}"]) / 100.0, 1e-5) ** 2 for window in HAR_WINDOWS]
    log_return = float(row["log_return"])
    leverage = log_return * log_return * TRADING_DAYS if log_return < 0 else 0.0
    raw = np.array([*(np.log(np.maximum(variance_values, 1e-10))), leverage], dtype=float)
    standardized = (raw - model["mean"]) / model["scale"]
    log_variance = float(np.dot(np.append(1.0, standardized), model["coefficients"]))
    variance = float(np.exp(np.clip(log_variance, np.log(1e-10), np.log(25.0))))
    return float(np.sqrt(variance) * 100.0)


def _training_rows(history: pd.DataFrame, origin_date: pd.Timestamp, config: ForecastConfig) -> pd.DataFrame:
    eligible = history[
        history["target_future_vol"].notna()
        & history["target_end_date"].notna()
        & (history["target_end_date"] <= origin_date)
    ]
    if config.training_window is not None:
        eligible = eligible.tail(config.training_window)
    return eligible


def nearest_horizon(dte: float, horizons: Iterable[int] = DEFAULT_HORIZONS) -> int:
    available = sorted({int(value) for value in horizons if int(value) > 0})
    if not available:
        raise ValueError("at least one positive forecast horizon is required")
    target = max(float(dte), 1.0)
    return min(available, key=lambda value: (abs(value - target), -value))


class VolatilityResearchEngine:
    """Create leakage-safe forecasts for each ticker, date, and requested horizon."""

    def __init__(self, config: ForecastConfig | None = None):
        self.config = config or ForecastConfig()
        self.lambda_performance_: pd.DataFrame = pd.DataFrame()
        self.weights_history_: pd.DataFrame = pd.DataFrame()
        self.ensemble_weights_history_: pd.DataFrame = pd.DataFrame()
        self.garch_parameters_: pd.DataFrame = pd.DataFrame()
        self.model_selection_history_: pd.DataFrame = pd.DataFrame()
        self.price_features_: pd.DataFrame = pd.DataFrame()

    @property
    def _candidate_windows(self) -> tuple[int, ...]:
        return tuple(sorted({int(window) for window in self.config.vol_windows if int(window) >= 1}))

    @property
    def _all_windows(self) -> tuple[int, ...]:
        return tuple(sorted(set(self._candidate_windows) | set(REPORT_WINDOWS) | set(HAR_WINDOWS)))

    def _prepare_ticker(self, ticker: str, frame: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
        local = frame.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True).copy()
        local["log_return"] = np.log(local["close"] / local["close"].shift(1))
        for window in self._all_windows:
            if window <= 1:
                # A one-observation sample standard deviation is undefined; the
                # absolute daily return is the standard 1-day realized-vol proxy
                # (the same convention used for the h=1 forecast target).
                local[f"vol_{window}"] = local["log_return"].abs() * np.sqrt(TRADING_DAYS) * 100.0
            else:
                local[f"vol_{window}"] = local["log_return"].rolling(window).std(ddof=1) * np.sqrt(TRADING_DAYS) * 100.0
        local["fixed_blend"] = np.sqrt(sum(
            weight * np.square(local[f"vol_{window}"])
            for weight, window in zip(FIXED_WEIGHTS, REPORT_WINDOWS, strict=True)
        ))
        all_lambdas = np.round(np.arange(0.700, 0.9901, 0.001), 3)
        paths = _ewma_volatility_paths(local["log_return"].to_numpy(), all_lambdas)
        local["ticker"] = ticker
        return local, all_lambdas, paths

    def fit_predict(self, prices: pd.DataFrame) -> pd.DataFrame:
        _validate_columns(prices, ("ticker", "date", "close"), "prices")
        clean = prices[["ticker", "date", "close"]].copy()
        clean["ticker"] = clean["ticker"].astype(str).str.upper().str.strip()
        clean["date"] = pd.to_datetime(clean["date"], errors="raise").dt.normalize()
        clean["close"] = pd.to_numeric(clean["close"], errors="raise")
        if clean["close"].le(0).any():
            raise ValueError("all close prices must be positive")

        output_rows: list[dict] = []
        lambda_curve_rows: list[dict] = []
        weight_rows: list[dict] = []
        ensemble_weight_rows: list[dict] = []
        garch_parameter_rows: list[dict] = []
        selection_rows: list[dict] = []
        feature_frames: list[pd.DataFrame] = []

        for ticker, ticker_prices in clean.groupby("ticker", sort=True):
            base, lambdas, ewma_paths = self._prepare_ticker(ticker, ticker_prices)
            feature_frames.append(base.copy())
            returns = base["log_return"].to_numpy()
            dates = base["date"].to_numpy()
            garch_paths, garch_parameters, garch_train_ends = walk_forward_garch(
                returns,
                dates,
                self.config.horizons,
                asymmetric=False,
                min_train_observations=self.config.min_train_observations,
                training_window=self.config.training_window,
                rebalance_every=self.config.rebalance_every,
            )
            gjr_paths, gjr_parameters, gjr_train_ends = walk_forward_garch(
                returns,
                dates,
                self.config.horizons,
                asymmetric=True,
                min_train_observations=self.config.min_train_observations,
                training_window=self.config.training_window,
                rebalance_every=self.config.rebalance_every,
            )
            for index, origin_value in enumerate(dates):
                for model_name, parameters, train_end in (
                    ("garch_11", garch_parameters[index], garch_train_ends[index]),
                    ("gjr_garch", gjr_parameters[index], gjr_train_ends[index]),
                ):
                    if parameters is None:
                        continue
                    garch_parameter_rows.append({
                        "ticker": ticker,
                        "date": pd.Timestamp(origin_value),
                        "model": model_name,
                        "parameter_train_end": train_end,
                        **parameters,
                    })
            candidate_windows = self._candidate_windows
            all_windows = self._all_windows
            for horizon in self.config.horizons:
                panel = base[["ticker", "date", "close", "log_return", *(f"vol_{window}" for window in all_windows), "fixed_blend"]].copy()
                panel["horizon"] = int(horizon)
                panel["target_future_vol"] = [
                    _future_realized_vol(returns, index, int(horizon)) for index in range(len(panel))
                ]
                panel["target_start_date"] = pd.NaT
                panel["target_end_date"] = pd.NaT
                for index in range(len(panel)):
                    if index + int(horizon) < len(panel):
                        panel.at[index, "target_start_date"] = pd.Timestamp(dates[index + 1])
                        panel.at[index, "target_end_date"] = pd.Timestamp(dates[index + int(horizon)])
                panel = panel.dropna(subset=[*(f"vol_{window}" for window in all_windows)]).reset_index(drop=True)
                for window in REPORT_WINDOWS:
                    panel[f"realized_{window}"] = panel[f"vol_{window}"]
                position_by_date = {pd.Timestamp(value): position for position, value in enumerate(base["date"])}
                original_indices = [position_by_date[pd.Timestamp(value)] for value in panel["date"]]
                panel["ewma_paths"] = pd.Series(
                    [ewma_paths[index] for index in original_indices],
                    index=panel.index,
                    dtype=object,
                )
                panel["garch_11"] = [garch_paths[int(horizon)][index] for index in original_indices]
                panel["garch_parameters"] = pd.Series(
                    [garch_parameters[index] for index in original_indices], index=panel.index, dtype=object,
                )
                panel["garch_train_end"] = [garch_train_ends[index] for index in original_indices]
                panel["gjr_garch"] = [gjr_paths[int(horizon)][index] for index in original_indices]
                panel["gjr_parameters"] = pd.Series(
                    [gjr_parameters[index] for index in original_indices], index=panel.index, dtype=object,
                )
                panel["gjr_train_end"] = [gjr_train_ends[index] for index in original_indices]

                optimized_values: list[float] = []
                optimized_weights: list[dict] = []
                optimized_train_end: list[pd.Timestamp | pd.NaT] = []
                sparse_values: list[float] = []
                sparse_weights_list: list[dict] = []
                sparse_train_end: list[pd.Timestamp | pd.NaT] = []
                ewma_values: list[float] = []
                ewma_lambdas: list[float] = []
                ewma_train_end: list[pd.Timestamp | pd.NaT] = []
                har_values: list[float] = []
                har_train_end: list[pd.Timestamp | pd.NaT] = []
                last_weights = _uniform_weights(len(candidate_windows))
                last_sparse_weights = _uniform_weights(len(candidate_windows))
                last_weight_train_end = pd.NaT
                last_lambda = float(self.config.ewma_default_lambda)
                last_lambda_train_end = pd.NaT
                last_har_model: dict[str, np.ndarray] | None = None
                last_har_train_end = pd.NaT

                for position, row in panel.iterrows():
                    origin = pd.Timestamp(row["date"])
                    training = _training_rows(panel.iloc[:position], origin, self.config)
                    rebalance = position % max(self.config.rebalance_every, 1) == 0
                    if rebalance and len(training) >= self.config.min_train_observations:
                        features = training[[f"vol_{window}" for window in candidate_windows]].to_numpy(dtype=float)
                        targets = training["target_future_vol"].to_numpy(dtype=float)
                        last_weights = _optimize_variance_weights(features, targets, self.config)
                        last_sparse_weights = _sparse_variance_weights(features, targets, self.config)
                        last_weight_train_end = pd.Timestamp(training["target_end_date"].max())
                    feature_vector = row[[f"vol_{window}" for window in candidate_windows]].to_numpy(dtype=float)
                    optimized_values.append(float(np.sqrt(np.dot(last_weights, np.square(feature_vector)))))
                    sparse_values.append(float(np.sqrt(np.dot(last_sparse_weights, np.square(feature_vector)))))
                    optimized_weights.append(_weights_dict(candidate_windows, last_weights))
                    sparse_weights_list.append(_weights_dict(candidate_windows, last_sparse_weights))
                    optimized_train_end.append(last_weight_train_end)
                    sparse_train_end.append(last_weight_train_end)
                    weight_rows.append({
                        "ticker": ticker,
                        "date": origin,
                        "horizon": int(horizon),
                        **{f"w{window}": float(weight) for window, weight in zip(candidate_windows, last_weights, strict=True)},
                        "optimized_weights": _weights_dict(candidate_windows, last_weights),
                        "sparse_weights": _weights_dict(candidate_windows, last_sparse_weights),
                        "sparse_n_terms": int(np.count_nonzero(last_sparse_weights > self.config.weight_zero_threshold)),
                        "parameter_train_end": last_weight_train_end,
                        "n_train": len(training),
                    })

                    if rebalance and len(training) >= self.config.min_train_observations:
                        training_paths = np.vstack(training["ewma_paths"].to_numpy())
                        target_variance = np.square(training["target_future_vol"].to_numpy(dtype=float) / 100.0)
                        coarse_lambdas = np.round(np.arange(0.70, 1.00, 0.01), 2)
                        coarse_columns = np.array([int(np.argmin(np.abs(lambdas - candidate))) for candidate in coarse_lambdas])
                        coarse_variances = np.square(training_paths[:, coarse_columns] / 100.0)
                        coarse_loss_values = np.mean(np.square(coarse_variances - target_variance[:, None]), axis=0)
                        losses: dict[float, float] = {}
                        for candidate, loss_value in zip(coarse_lambdas, coarse_loss_values, strict=True):
                            loss = float(loss_value)
                            losses[float(candidate)] = loss
                            lambda_curve_rows.append({
                                "ticker": ticker, "date": origin, "horizon": int(horizon), "stage": "coarse",
                                "lambda": float(candidate), "mse_variance": loss, "n_train": len(training),
                            })
                        coarse_best = min(losses, key=losses.get)
                        fine_lambdas = lambdas[np.abs(lambdas - coarse_best) <= 0.0100001]
                        fine_columns = np.array([int(np.argmin(np.abs(lambdas - candidate))) for candidate in fine_lambdas])
                        fine_variances = np.square(training_paths[:, fine_columns] / 100.0)
                        fine_loss_values = np.mean(np.square(fine_variances - target_variance[:, None]), axis=0)
                        fine_losses: dict[float, float] = {}
                        for candidate, loss_value in zip(fine_lambdas, fine_loss_values, strict=True):
                            loss = float(loss_value)
                            fine_losses[float(candidate)] = loss
                            lambda_curve_rows.append({
                                "ticker": ticker, "date": origin, "horizon": int(horizon), "stage": "fine",
                                "lambda": float(candidate), "mse_variance": loss, "n_train": len(training),
                            })
                        last_lambda = min(fine_losses, key=fine_losses.get)
                        last_lambda_train_end = pd.Timestamp(training["target_end_date"].max())
                    lambda_column = int(np.argmin(np.abs(lambdas - last_lambda)))
                    ewma_values.append(float(row["ewma_paths"][lambda_column]))
                    ewma_lambdas.append(float(last_lambda))
                    ewma_train_end.append(last_lambda_train_end)
                    if rebalance and len(training) >= self.config.min_train_observations:
                        fitted_har = _fit_har_variance_model(training, self.config)
                        if fitted_har is not None:
                            last_har_model = fitted_har
                            last_har_train_end = pd.Timestamp(training["target_end_date"].max())
                    har_values.append(_predict_har_volatility(last_har_model, row))
                    har_train_end.append(last_har_train_end)

                panel["optimized_blend"] = optimized_values
                panel["optimized_weights"] = optimized_weights
                panel["optimized_train_end"] = optimized_train_end
                panel["sparse_blend"] = sparse_values
                panel["sparse_weights"] = sparse_weights_list
                panel["sparse_train_end"] = sparse_train_end
                panel["ewma"] = ewma_values
                panel["ewma_lambda"] = ewma_lambdas
                panel["ewma_train_end"] = ewma_train_end
                panel["har_rv"] = har_values
                panel["har_train_end"] = har_train_end
                component_count = len(ENSEMBLE_COMPONENTS)
                simple_weights = _uniform_weights(component_count)
                panel["simple_ensemble"] = np.sqrt(np.mean(
                    np.square(panel[list(ENSEMBLE_COMPONENTS)].to_numpy(dtype=float)), axis=1,
                ))
                adaptive_values: list[float] = []
                adaptive_weights_values: list[dict] = []
                adaptive_train_ends: list[pd.Timestamp | pd.NaT] = []
                last_ensemble_weights = simple_weights.copy()
                last_ensemble_train_end = pd.NaT
                shrinkage = float(np.clip(self.config.ensemble_shrinkage, 0.0, 1.0))
                for position, row in panel.iterrows():
                    origin = pd.Timestamp(row["date"])
                    training = _training_rows(panel.iloc[:position], origin, self.config)
                    rebalance = position % max(self.config.rebalance_every, 1) == 0
                    if rebalance and len(training) >= self.config.min_train_observations:
                        fitted = _optimize_variance_weights(
                            training[list(ENSEMBLE_COMPONENTS)].to_numpy(dtype=float),
                            training["target_future_vol"].to_numpy(dtype=float),
                            self.config,
                        )
                        # Shrink the regression toward the simple combination.
                        # Highly correlated volatility forecasts make unrestricted
                        # combination weights unstable in small rolling samples.
                        last_ensemble_weights = (1.0 - shrinkage) * fitted + shrinkage * simple_weights
                        last_ensemble_weights = last_ensemble_weights / last_ensemble_weights.sum()
                        last_ensemble_train_end = pd.Timestamp(training["target_end_date"].max())
                    current = row[list(ENSEMBLE_COMPONENTS)].to_numpy(dtype=float)
                    adaptive_values.append(float(np.sqrt(np.dot(last_ensemble_weights, np.square(current)))))
                    weight_dict = {
                        model: float(weight)
                        for model, weight in zip(ENSEMBLE_COMPONENTS, last_ensemble_weights, strict=True)
                    }
                    adaptive_weights_values.append(weight_dict)
                    adaptive_train_ends.append(last_ensemble_train_end)
                    ensemble_weight_rows.append({
                        "ticker": ticker,
                        "date": origin,
                        "horizon": int(horizon),
                        "parameter_train_end": last_ensemble_train_end,
                        "n_train": len(training),
                        "shrinkage": shrinkage,
                        **{f"weight_{model}": weight for model, weight in weight_dict.items()},
                    })
                panel["adaptive_ensemble"] = adaptive_values
                panel["adaptive_ensemble_weights"] = adaptive_weights_values
                panel["adaptive_ensemble_train_end"] = adaptive_train_ends

                selected_models: list[str] = []
                selected_train_end: list[pd.Timestamp | pd.NaT] = []
                last_model = "fixed_blend"
                last_model_train_end = pd.NaT
                for position, row in panel.iterrows():
                    origin = pd.Timestamp(row["date"])
                    training = _training_rows(panel.iloc[:position], origin, self.config)
                    rebalance = position % max(self.config.rebalance_every, 1) == 0
                    if rebalance and len(training) >= self.config.min_train_observations:
                        target_variance = np.square(training["target_future_vol"] / 100.0)
                        model_errors = {
                            model: float(np.mean(np.square(
                                np.square(training[model] / 100.0) - target_variance,
                            )))
                            for model in MODEL_NAMES
                        }
                        last_model = min(model_errors, key=model_errors.get)
                        last_model_train_end = pd.Timestamp(training["target_end_date"].max())
                        selection_rows.extend({
                            "ticker": ticker,
                            "date": origin,
                            "horizon": int(horizon),
                            "model": model,
                            "training_mse_variance": error,
                            "selected": model == last_model,
                            "parameter_train_end": last_model_train_end,
                            "n_train": len(training),
                        } for model, error in model_errors.items())
                    selected_models.append(last_model)
                    selected_train_end.append(last_model_train_end)
                panel["selected_model"] = selected_models
                panel["selection_train_end"] = selected_train_end

                for _, row in panel.iterrows():
                    common = {
                        "ticker": ticker,
                        "date": pd.Timestamp(row["date"]),
                        "horizon": int(horizon),
                        "forecast_input_end": pd.Timestamp(row["date"]),
                        "target_start_date": row["target_start_date"],
                        "target_end_date": row["target_end_date"],
                        "future_realized_vol": row["target_future_vol"],
                    }
                    fixed_weights_dict = {
                        str(window): float(weight)
                        for window, weight in zip(REPORT_WINDOWS, FIXED_WEIGHTS, strict=True)
                    }
                    simple_ensemble_weights = {
                        model: float(weight)
                        for model, weight in zip(ENSEMBLE_COMPONENTS, _uniform_weights(len(ENSEMBLE_COMPONENTS)), strict=True)
                    }

                    def _weights_for(model: str) -> dict | None:
                        if model == "optimized_blend":
                            return row["optimized_weights"]
                        if model == "sparse_blend":
                            return row["sparse_weights"]
                        if model == "fixed_blend":
                            return fixed_weights_dict
                        if model == "simple_ensemble":
                            return simple_ensemble_weights
                        if model == "adaptive_ensemble":
                            return row["adaptive_ensemble_weights"]
                        return None

                    def _parameters_for(model: str) -> dict | None:
                        if model == "garch_11":
                            return row["garch_parameters"]
                        if model == "gjr_garch":
                            return row["gjr_parameters"]
                        return None

                    def _param_end_for(model: str):
                        if model == "ewma":
                            return row["ewma_train_end"]
                        if model == "optimized_blend":
                            return row["optimized_train_end"]
                        if model == "sparse_blend":
                            return row["sparse_train_end"]
                        if model == "har_rv":
                            return row["har_train_end"]
                        if model == "garch_11":
                            return row["garch_train_end"]
                        if model == "gjr_garch":
                            return row["gjr_train_end"]
                        if model == "adaptive_ensemble":
                            return row["adaptive_ensemble_train_end"]
                        return pd.NaT

                    for model in MODEL_NAMES:
                        output_rows.append({
                            **common,
                            "model": model,
                            "model_used": model,
                            "forecast_vol": float(row[model]),
                            "lambda_used": float(row["ewma_lambda"]) if model == "ewma" else np.nan,
                            "weights_used": _weights_for(model),
                            "parameters_used": _parameters_for(model),
                            "parameter_train_end": _param_end_for(model),
                        })
                    selected = str(row["selected_model"])
                    output_rows.append({
                        **common,
                        "model": "best_model",
                        "model_used": selected,
                        "forecast_vol": float(row[selected]),
                        "lambda_used": float(row["ewma_lambda"]) if selected == "ewma" else np.nan,
                        "weights_used": _weights_for(selected),
                        "parameters_used": _parameters_for(selected),
                        "parameter_train_end": row["selection_train_end"],
                    })

        self.lambda_performance_ = pd.DataFrame(lambda_curve_rows)
        self.weights_history_ = pd.DataFrame(weight_rows)
        self.ensemble_weights_history_ = pd.DataFrame(ensemble_weight_rows)
        self.garch_parameters_ = pd.DataFrame(garch_parameter_rows)
        self.model_selection_history_ = pd.DataFrame(selection_rows)
        self.price_features_ = pd.concat(feature_frames, ignore_index=True) if feature_frames else pd.DataFrame()
        result = pd.DataFrame(output_rows).sort_values(["ticker", "date", "horizon", "model"]).reset_index(drop=True)
        return result


def evaluate_forecasts(
    forecasts: pd.DataFrame,
    market_iv: pd.DataFrame | None = None,
    horizons: Iterable[int] = DEFAULT_HORIZONS,
) -> pd.DataFrame:
    _validate_columns(forecasts, ("ticker", "date", "horizon", "model", "forecast_vol", "future_realized_vol"), "forecasts")
    valid = forecasts.dropna(subset=["forecast_vol", "future_realized_vol"]).copy()
    valid["error"] = valid["forecast_vol"] - valid["future_realized_vol"]
    valid["forecast_variance"] = np.square(valid["forecast_vol"] / 100.0)
    valid["realized_variance"] = np.square(valid["future_realized_vol"] / 100.0)
    valid["variance_error"] = valid["forecast_variance"] - valid["realized_variance"]
    ratio = np.maximum(valid["realized_variance"], 1e-12) / np.maximum(valid["forecast_variance"], 1e-12)
    valid["qlike"] = ratio - np.log(ratio) - 1.0
    metrics = valid.groupby(["model", "horizon"], as_index=False).agg(
        observations=("error", "size"),
        mae=("error", lambda values: float(np.mean(np.abs(values)))),
        rmse=("error", lambda values: float(np.sqrt(np.mean(np.square(values))))),
        mse_variance=("variance_error", lambda values: float(np.mean(np.square(values)))),
        variance_bias=("variance_error", "mean"),
        mean_qlike=("qlike", "mean"),
    )
    calibration_rows = []
    for (model, horizon), group in valid.groupby(["model", "horizon"], sort=True):
        forecast_variance = group["forecast_variance"].to_numpy(dtype=float)
        realized_variance = group["realized_variance"].to_numpy(dtype=float)
        design = np.column_stack([np.ones(len(group)), forecast_variance])
        coefficients = np.linalg.lstsq(design, realized_variance, rcond=None)[0]
        fitted = design @ coefficients
        denominator = float(np.sum(np.square(realized_variance - realized_variance.mean())))
        r_squared = 1.0 - float(np.sum(np.square(realized_variance - fitted))) / denominator if denominator > 0 else np.nan
        calibration_rows.append({
            "model": model,
            "horizon": int(horizon),
            "mz_intercept": float(coefficients[0]),
            "mz_slope": float(coefficients[1]),
            "mz_r_squared": r_squared,
        })
    metrics = metrics.merge(pd.DataFrame(calibration_rows), on=["model", "horizon"], how="left")
    metrics["directional_accuracy_vs_market_iv"] = np.nan
    metrics["directional_observations"] = 0
    if market_iv is None or market_iv.empty:
        return metrics

    _validate_columns(market_iv, ("ticker", "date", "dte", "market_iv"), "market_iv")
    quotes = market_iv[["ticker", "date", "dte", "market_iv"]].copy()
    quotes["ticker"] = quotes["ticker"].astype(str).str.upper().str.strip()
    quotes["date"] = pd.to_datetime(quotes["date"]).dt.normalize()
    quotes["market_iv"] = _normalize_percent(quotes["market_iv"])
    quotes["horizon"] = quotes["dte"].map(lambda value: nearest_horizon(value, horizons))
    joined = valid.merge(quotes, on=["ticker", "date", "horizon"], how="inner")
    joined["direction_correct"] = (
        np.sign(joined["forecast_vol"] - joined["market_iv"])
        == np.sign(joined["future_realized_vol"] - joined["market_iv"])
    )
    directional = joined.groupby(["model", "horizon"], as_index=False).agg(
        directional_accuracy_vs_market_iv=("direction_correct", "mean"),
        directional_observations=("direction_correct", "size"),
    )
    return metrics.drop(columns=["directional_accuracy_vs_market_iv", "directional_observations"]).merge(
        directional, on=["model", "horizon"], how="left",
    ).fillna({"directional_observations": 0})


def diagnose_models_by_moneyness(
    forecasts: pd.DataFrame,
    option_history: pd.DataFrame | None = None,
    models: Iterable[str] = (
        "optimized_blend", "sparse_blend", "ewma", "har_rv", "garch_11", "gjr_garch",
        "simple_ensemble", "adaptive_ensemble", "realized_20", "realized_60",
    ),
    horizons: Iterable[int] = DEFAULT_HORIZONS,
) -> pd.DataFrame:
    """Compare requested models on out-of-sample variance loss by ticker/horizon/bucket."""

    _validate_columns(
        forecasts,
        ("ticker", "date", "horizon", "model", "forecast_vol", "future_realized_vol"),
        "forecasts",
    )
    selected_models = tuple(models)
    valid = forecasts[
        forecasts["model"].isin(selected_models)
        & forecasts["forecast_vol"].notna()
        & forecasts["future_realized_vol"].notna()
    ].copy()
    valid["date"] = pd.to_datetime(valid["date"]).dt.normalize()

    datasets: list[pd.DataFrame] = [valid.assign(moneyness_bucket="all")]
    if option_history is not None and not option_history.empty:
        contracts = prepare_surface_contracts(option_history)
        contracts["horizon"] = contracts["dte"].map(lambda value: nearest_horizon(value, horizons))
        available = contracts[["ticker", "date", "horizon", "moneyness_bucket"]].drop_duplicates()
        by_bucket = valid.merge(available, on=["ticker", "date", "horizon"], how="inner")
        datasets.append(by_bucket)
    combined = pd.concat(datasets, ignore_index=True)
    if combined.empty:
        return pd.DataFrame()
    combined["vol_error"] = combined["forecast_vol"] - combined["future_realized_vol"]
    combined["variance_error"] = (
        np.square(combined["forecast_vol"] / 100.0)
        - np.square(combined["future_realized_vol"] / 100.0)
    )
    forecast_variance = np.maximum(np.square(combined["forecast_vol"] / 100.0), 1e-12)
    realized_variance = np.maximum(np.square(combined["future_realized_vol"] / 100.0), 1e-12)
    qlike_ratio = realized_variance / forecast_variance
    combined["qlike"] = qlike_ratio - np.log(qlike_ratio) - 1.0
    diagnostics = combined.groupby(
        ["ticker", "horizon", "moneyness_bucket", "model"], as_index=False,
    ).agg(
        observations=("variance_error", "size"),
        mse_variance=("variance_error", lambda values: float(np.mean(np.square(values)))),
        mae_variance=("variance_error", lambda values: float(np.mean(np.abs(values)))),
        rmse_variance=("variance_error", lambda values: float(np.sqrt(np.mean(np.square(values))))),
        mae_vol=("vol_error", lambda values: float(np.mean(np.abs(values)))),
        rmse_vol=("vol_error", lambda values: float(np.sqrt(np.mean(np.square(values))))),
        mean_qlike=("qlike", "mean"),
    )
    group_columns = ["ticker", "horizon", "moneyness_bucket"]
    best = diagnostics.loc[
        diagnostics.groupby(group_columns)["mse_variance"].idxmin(),
        group_columns + ["model"],
    ].rename(columns={"model": "best_model"})
    diagnostics = diagnostics.merge(best, on=group_columns, how="left")
    diagnostics["is_best"] = diagnostics["model"] == diagnostics["best_model"]
    return diagnostics.sort_values(group_columns + ["mse_variance"]).reset_index(drop=True)


DEFAULT_EDGE_THRESHOLDS = (0.0, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0)


def threshold_sensitivity_study(
    forecasts: pd.DataFrame,
    market_iv: pd.DataFrame,
    thresholds: Iterable[float] = DEFAULT_EDGE_THRESHOLDS,
    horizons: Iterable[int] = DEFAULT_HORIZONS,
) -> pd.DataFrame:
    """Measure how forecast reliability changes as the volatility gap widens.

    This is a forecast-skill study, not a trading rule. For each minimum
    ``|forecast_vol - market_iv|`` gap (in volatility points) it reports, over
    the strictly out-of-sample completed targets:

    - how many observations clear the gap and what share of all observations
      that is (larger gaps are rarer);
    - directional accuracy: how often the sign of the forecast-vs-market gap
      matched the sign of realized-vs-market volatility;
    - variance skill: mean squared variance error using market IV as the
      forecast minus the same using the model forecast (positive means the
      model beat simply trusting market IV at that gap).

    Historical market IV is aligned to each forecast origin by ticker, date and
    nearest horizon; multiple quotes per origin are reduced to their median so
    the comparison is an at-the-money-style level, not a single strike. Only
    tickers with supplied historical option IV appear. A widening gap that does
    not raise directional accuracy or variance skill is itself the finding:
    the size of the gap alone would not have been a dependable signal.
    """

    _validate_columns(
        forecasts, ("ticker", "date", "horizon", "model", "forecast_vol", "future_realized_vol"), "forecasts",
    )
    _validate_columns(market_iv, ("ticker", "date", "dte", "market_iv"), "market_iv")
    best = forecasts[forecasts["model"] == "best_model"].dropna(subset=["future_realized_vol"]).copy()
    best["date"] = pd.to_datetime(best["date"]).dt.normalize()

    quotes = market_iv[["ticker", "date", "dte", "market_iv"]].copy()
    quotes["ticker"] = quotes["ticker"].astype(str).str.upper().str.strip()
    quotes["date"] = pd.to_datetime(quotes["date"]).dt.normalize()
    quotes["market_iv"] = _normalize_percent(quotes["market_iv"])
    quotes["horizon"] = quotes["dte"].map(lambda value: nearest_horizon(value, horizons))
    aligned = quotes.groupby(["ticker", "date", "horizon"], as_index=False)["market_iv"].median()

    joined = best.merge(aligned, on=["ticker", "date", "horizon"], how="inner")
    if joined.empty:
        return pd.DataFrame()
    joined["vol_edge"] = joined["forecast_vol"] - joined["market_iv"]
    realized_variance = np.square(joined["future_realized_vol"] / 100.0)
    joined["forecast_variance_error"] = np.square(joined["forecast_vol"] / 100.0) - realized_variance
    joined["market_variance_error"] = np.square(joined["market_iv"] / 100.0) - realized_variance
    joined["direction_correct"] = (
        np.sign(joined["vol_edge"]) == np.sign(joined["future_realized_vol"] - joined["market_iv"])
    )

    rows: list[dict] = []
    total_by_ticker = joined.groupby("ticker").size().to_dict()
    for ticker, group in joined.groupby("ticker"):
        total = int(total_by_ticker.get(ticker, len(group)))
        for threshold in sorted({float(value) for value in thresholds}):
            subset = group[group["vol_edge"].abs() >= threshold]
            n = int(len(subset))
            if n == 0:
                rows.append({
                    "ticker": ticker, "min_abs_vol_edge_points": float(threshold), "observations": 0,
                    "coverage_pct": 0.0, "directional_accuracy_vs_market_iv": np.nan,
                    "mean_abs_vol_edge": np.nan, "forecast_variance_mse": np.nan,
                    "market_variance_mse": np.nan, "variance_skill_vs_market": np.nan,
                })
                continue
            forecast_mse = float(np.mean(np.square(subset["forecast_variance_error"])))
            market_mse = float(np.mean(np.square(subset["market_variance_error"])))
            rows.append({
                "ticker": ticker,
                "min_abs_vol_edge_points": float(threshold),
                "observations": n,
                "coverage_pct": float(n / total * 100.0),
                "directional_accuracy_vs_market_iv": float(subset["direction_correct"].mean()),
                "mean_abs_vol_edge": float(subset["vol_edge"].abs().mean()),
                "forecast_variance_mse": forecast_mse,
                "market_variance_mse": market_mse,
                "variance_skill_vs_market": market_mse - forecast_mse,
            })
    return pd.DataFrame(rows).sort_values(["ticker", "min_abs_vol_edge_points"]).reset_index(drop=True)


def _forecast_lookup(forecasts: pd.DataFrame) -> dict[tuple[str, int], pd.DataFrame]:
    best = forecasts[forecasts["model"] == "best_model"].copy()
    best["date"] = pd.to_datetime(best["date"]).dt.normalize()
    return {
        (ticker, int(horizon)): group.sort_values("date").reset_index(drop=True)
        for (ticker, horizon), group in best.groupby(["ticker", "horizon"])
    }


def rank_option_contracts(
    options: pd.DataFrame,
    forecasts: pd.DataFrame,
    prices: pd.DataFrame | None = None,
    surface_history: pd.DataFrame | None = None,
    horizons: Iterable[int] = DEFAULT_HORIZONS,
    max_spread_percent: float = 20.0,
    minimum_volume: int = 10,
    minimum_open_interest: int = 100,
    tree_steps: int = 400,
    tree_tolerance: float = 0.0025,
    style_map: dict[str, dict[str, str]] | None = None,
    surface_shift_method: str = "total_variance_shift",
) -> pd.DataFrame:
    required = ("ticker", "date", "expiration", "option_type", "strike", "market_iv", "bid", "ask", "volume", "open_interest")
    _validate_columns(options, required, "options")
    ranked = options.copy()
    ranked["ticker"] = ranked["ticker"].astype(str).str.upper().str.strip()
    ranked["date"] = pd.to_datetime(ranked["date"]).dt.normalize()
    ranked["expiration"] = pd.to_datetime(ranked["expiration"]).dt.normalize()
    if "dte" not in ranked:
        ranked["dte"] = (ranked["expiration"] - ranked["date"]).dt.days.clip(lower=0)
    ranked["dte"] = pd.to_numeric(ranked["dte"], errors="raise")
    trading_details = [trading_day_dte(origin, expiration) for origin, expiration in zip(ranked["date"], ranked["expiration"])]
    ranked["trading_dte"] = [item[0] for item in trading_details]
    ranked["trading_calendar_warning"] = [item[1] or "" for item in trading_details]
    horizon_mappings = [map_horizon(value, horizons) for value in ranked["trading_dte"]]
    ranked["forecast_horizon"] = [mapping.trading_dte for mapping in horizon_mappings]
    ranked["forecast_horizon_method"] = [mapping.method for mapping in horizon_mappings]
    ranked["forecast_horizon_lower"] = [mapping.lower_horizon for mapping in horizon_mappings]
    ranked["forecast_horizon_upper"] = [mapping.upper_horizon for mapping in horizon_mappings]
    ranked["forecast_horizon_interpolation_weight"] = [mapping.interpolation_weight for mapping in horizon_mappings]
    ranked["forecast_horizon_ranking_eligible"] = [mapping.ranking_eligible for mapping in horizon_mappings]
    ranked["forecast_horizon_warning"] = [mapping.warning or "" for mapping in horizon_mappings]
    ranked["forecast_horizon_used"] = [
        f"{mapping.lower_horizon}D" if mapping.lower_horizon == mapping.upper_horizon
        else f"{mapping.lower_horizon}-{mapping.upper_horizon}D"
        for mapping in horizon_mappings
    ]
    ranked["market_iv"] = _normalize_percent(ranked["market_iv"])
    for column in ("strike", "bid", "ask", "volume", "open_interest"):
        ranked[column] = pd.to_numeric(ranked[column], errors="coerce")
    if "market_mid" not in ranked:
        ranked["market_mid"] = (ranked["bid"] + ranked["ask"]) / 2.0
    ranked["market_mid"] = pd.to_numeric(ranked["market_mid"], errors="coerce")
    # These columns are explicit annualized percent inputs (for example, 4.25),
    # so do not guess whether a small value was intended as a decimal.
    ranked["rate"] = pd.to_numeric(ranked["rate"], errors="coerce") if "rate" in ranked else 0.0
    dividend_data_available = "dividend" in ranked
    ranked["dividend"] = pd.to_numeric(ranked["dividend"], errors="coerce") if dividend_data_available else 0.0
    ranked["dividend_data_available"] = dividend_data_available

    if "spot" not in ranked:
        if prices is None:
            raise ValueError("options must contain spot, or prices must be provided")
        _validate_columns(prices, ("ticker", "date", "close"), "prices")
        spot = prices[["ticker", "date", "close"]].copy()
        spot["ticker"] = spot["ticker"].astype(str).str.upper().str.strip()
        spot["date"] = pd.to_datetime(spot["date"]).dt.normalize()
        ranked = ranked.merge(spot.rename(columns={"close": "spot"}), on=["ticker", "date"], how="left")
    ranked["spot"] = pd.to_numeric(ranked["spot"], errors="coerce")
    if "contract_multiplier" not in ranked:
        ranked["contract_multiplier"] = 100.0
    ranked["contract_multiplier"] = pd.to_numeric(ranked["contract_multiplier"], errors="coerce").fillna(100.0)
    ranked = add_volatility_surface_context(ranked, history=surface_history)

    lookup = _forecast_lookup(forecasts)
    selected_records: list[dict[str, object] | None] = []
    for row in ranked.itertuples(index=False):
        lower_horizon = int(row.forecast_horizon_lower)
        upper_horizon = int(row.forecast_horizon_upper)
        component_rows: list[pd.Series] = []
        for component_horizon in sorted({lower_horizon, upper_horizon}):
            group = lookup.get((row.ticker, component_horizon))
            if group is None or group.empty:
                available_horizons = sorted(horizon for (ticker, horizon) in lookup if ticker == row.ticker)
                fallback_horizon = min(available_horizons, key=lambda value: (abs(value - component_horizon), -value)) if available_horizons else None
                group = lookup.get((row.ticker, fallback_horizon)) if fallback_horizon is not None else None
            if group is None or group.empty:
                component_rows = []
                break
            eligible = group[group["date"] <= row.date]
            if eligible.empty:
                component_rows = []
                break
            component_rows.append(eligible.iloc[-1])
        if not component_rows:
            selected_records.append(None)
            continue
        if len(component_rows) == 1:
            forecast_vol = float(component_rows[0]["forecast_vol"])
            future_vol = float(component_rows[0].get("future_realized_vol", np.nan))
        else:
            weight = float(row.forecast_horizon_interpolation_weight)
            forecast_vol = interpolate_variance_forecast(
                float(component_rows[0]["forecast_vol"]), float(component_rows[1]["forecast_vol"]), weight,
            )
            future_components = [float(component.get("future_realized_vol", np.nan)) for component in component_rows]
            future_vol = interpolate_variance_forecast(*future_components, weight) if np.isfinite(future_components).all() else np.nan
        selected_records.append({
            "forecast_vol": forecast_vol,
            "forecast_as_of": min(pd.Timestamp(component["date"]) for component in component_rows),
            "forecast_model_used": " + ".join(dict.fromkeys(str(component["model_used"]) for component in component_rows)),
            "lambda_used": component_rows[0].get("lambda_used") if len(component_rows) == 1 else np.nan,
            "weights_used": component_rows[0].get("weights_used") if len(component_rows) == 1 else {
                str(int(component["horizon"])): component.get("weights_used") for component in component_rows
            },
            "parameters_used": component_rows[0].get("parameters_used") if len(component_rows) == 1 else {
                str(int(component["horizon"])): component.get("parameters_used") for component in component_rows
            },
            "future_realized_vol": future_vol,
        })
    ranked["forecast_atm_vol"] = [record["forecast_vol"] if record is not None else np.nan for record in selected_records]
    ranked["forecast_as_of"] = [record["forecast_as_of"] if record is not None else pd.NaT for record in selected_records]
    ranked["forecast_model_used"] = [record["forecast_model_used"] if record is not None else None for record in selected_records]
    ranked["lambda_used"] = [record["lambda_used"] if record is not None else np.nan for record in selected_records]
    ranked["weights_used"] = [record["weights_used"] if record is not None else None for record in selected_records]
    ranked["parameters_used"] = [record["parameters_used"] if record is not None else None for record in selected_records]
    ranked["future_realized_vol"] = [record["future_realized_vol"] if record is not None else np.nan for record in selected_records]
    surface_shifts = [
        shift_strike_volatility(
            float(row.svi_fitted_iv) if row.svi_status == "fitted" and np.isfinite(row.svi_fitted_iv) else float(row.market_iv),
            float(row.atm_iv),
            float(row.forecast_atm_vol),
            time_years=max(float(row.dte) / 365.0, 1e-12),
            method=surface_shift_method,
        )
        for row in ranked.itertuples(index=False)
    ]
    ranked["forecast_vol"] = [item["volatility"] for item in surface_shifts]
    ranked["skew_adjustment_method"] = [item["method"] for item in surface_shifts]
    ranked["surface_sanity_status"] = [item["status"] for item in surface_shifts]
    ranked["surface_shift_warning"] = [item["warning"] for item in surface_shifts]
    ranked = ranked.dropna(subset=["spot", "strike", "market_iv", "forecast_vol", "market_mid", "bid", "ask"])

    ranked["underlying_price"] = ranked["spot"]
    ranked["last_price"] = pd.to_numeric(ranked["last_price"], errors="coerce") if "last_price" in ranked else np.nan
    ranked["spread"] = ranked["ask"] - ranked["bid"]
    ranked["vol_edge"] = ranked["forecast_vol"] - ranked["market_iv"]

    pricing_rows: list[dict] = []
    for row in ranked.itertuples(index=False):
        raw_dividends = getattr(row, "discrete_dividends", None)
        if isinstance(raw_dividends, str) and raw_dividends.strip():
            try:
                raw_dividends = json.loads(raw_dividends)
            except json.JSONDecodeError:
                raw_dividends = []
        discrete_dividends = tuple(
            (float(item.get("days")), float(item.get("amount")))
            for item in (raw_dividends or [])
            if isinstance(item, dict) and item.get("days") is not None and item.get("amount") is not None
        )
        pricing_rows.append(contract_pricing_diagnostics(
            ticker=row.ticker,
            market_mid=float(row.market_mid),
            market_iv=float(row.market_iv),
            forecast_volatility=float(row.forecast_vol),
            inputs=PricingInputs(
                spot=float(row.spot), strike=float(row.strike), dte=float(row.dte),
                volatility=float(row.market_iv), rate=float(row.rate), dividend=float(row.dividend),
                option_type=str(row.option_type), exercise_style="european",
                discrete_dividends=discrete_dividends,
            ),
            option_style=getattr(row, "option_style", None),
            instrument_type=getattr(row, "instrument_type", None),
            style_map=style_map,
            tree_steps=tree_steps,
            tree_tolerance=tree_tolerance,
            market_bid=float(row.bid),
            market_ask=float(row.ask),
        ))
    pricing_frame = pd.DataFrame(pricing_rows, index=ranked.index)
    # Avoid duplicate source columns (for example instrument_type supplied by a
    # broker) while keeping the pricing resolver's normalized result explicit.
    ranked = pd.concat([
        ranked.drop(columns=[column for column in pricing_frame.columns if column in ranked], errors="ignore"),
        pricing_frame,
    ], axis=1).copy()

    # Backwards-compatible aliases now point to the selected forecast-volatility
    # model, never to the circular market-IV diagnostic.
    ranked["model_fair_value"] = ranked["selected_model_fair_value"]
    ranked["market_iv_fair_value"] = ranked["bs_market_iv_fair_value"]
    ranked["forecast_volatility"] = ranked["forecast_vol"]
    ranked["price_edge_bs"] = ranked["bs_forecast_vol_fair_value"] - ranked["market_mid"]
    ranked["price_edge_american"] = ranked["american_forecast_vol_fair_value"] - ranked["market_mid"]
    ranked["price_edge_american"] = ranked["price_edge_american"].where(
        ranked["american_forecast_vol_fair_value"].notna(), ranked["price_edge_bs"],
    )
    ranked["price_edge"] = ranked["selected_model_fair_value"] - ranked["market_mid"]
    ranked["implied_variance"] = np.square(ranked["market_iv"] / 100.0)
    ranked["forecast_variance"] = np.square(ranked["forecast_vol"] / 100.0)
    # Haugh equation (24) uses implied variance minus realized variance for the
    # short-option + delta-hedge P&L sign convention.
    ranked["variance_edge"] = ranked["implied_variance"] - ranked["forecast_variance"]
    greeks = black_scholes_greeks(
        ranked["spot"], ranked["strike"], ranked["dte"], ranked["market_iv"],
        ranked["rate"], ranked["dividend"], ranked["option_type"],
    )
    ranked["dollar_gamma"] = 0.5 * np.square(ranked["spot"]) * ranked["gamma"]
    ranked["gamma_weighted_edge"] = (
        ranked["dollar_gamma"] * ranked["variance_edge"] * greeks["time_years"]
    )
    ranked["gamma_weighted_edge_contract"] = (
        ranked["gamma_weighted_edge"] * ranked["contract_multiplier"]
    )
    ranked["vega_normalized_edge"] = np.where(
        ranked["vega"] > 1e-12,
        ranked["price_edge"] / ranked["vega"],
        np.nan,
    )
    ranked["spread_pct"] = np.where(
        ranked["market_mid"] > 0,
        ranked["spread"] / ranked["market_mid"] * 100.0,
        np.inf,
    )
    executable_rows = [
        executable_edge_diagnostics(row.selected_model_fair_value, row.market_mid, row.bid, row.ask)
        for row in ranked.itertuples(index=False)
    ]
    ranked["midpoint_edge"] = [item.get("midpoint_edge", np.nan) for item in executable_rows]
    ranked["long_executable_edge"] = [item.get("long_executable_edge", np.nan) for item in executable_rows]
    ranked["short_executable_edge"] = [item.get("short_executable_edge", np.nan) for item in executable_rows]
    ranked["minimum_edge_threshold"] = [item.get("minimum_edge", np.nan) for item in executable_rows]
    ranked["long_minimum_edge_threshold_passed"] = [bool(item.get("long_threshold_passed", False)) for item in executable_rows]
    ranked["short_minimum_edge_threshold_passed"] = [bool(item.get("short_threshold_passed", False)) for item in executable_rows]
    ranked["edge_to_spread_ratio_long"] = [item.get("long_edge_to_spread_ratio", np.nan) for item in executable_rows]
    ranked["edge_to_spread_ratio_short"] = [item.get("short_edge_to_spread_ratio", np.nan) for item in executable_rows]
    ranked["edge_after_spread_bs"] = np.where(
        ranked["price_edge_bs"] >= 0, ranked["bs_forecast_vol_fair_value"] - ranked["ask"],
        ranked["bid"] - ranked["bs_forecast_vol_fair_value"],
    )
    ranked["edge_after_spread_american"] = np.where(
        ranked["price_edge_american"] >= 0,
        ranked["american_forecast_vol_fair_value"].fillna(ranked["bs_forecast_vol_fair_value"]) - ranked["ask"],
        ranked["bid"] - ranked["american_forecast_vol_fair_value"].fillna(ranked["bs_forecast_vol_fair_value"]),
    )
    ranked["research_direction"] = np.where(ranked["price_edge"] >= 0, "below-model", "above-model")
    ranked["candidate_side"] = np.select(
        [
            (ranked["price_edge"] > 0) & (ranked["forecast_vol"] > ranked["market_iv"]),
            (ranked["price_edge"] < 0) & (ranked["market_iv"] > ranked["forecast_vol"]),
            ranked["price_edge"] > 0,
            ranked["price_edge"] < 0,
        ],
        ["long_vol", "short_vol", "mixed_long_price", "mixed_short_price"],
        default="neutral",
    )
    ranked["edge_after_bid_ask"] = np.where(
        ranked["candidate_side"] == "long_vol", ranked["long_executable_edge"],
        np.where(ranked["candidate_side"] == "short_vol", ranked["short_executable_edge"],
                 np.maximum(ranked["long_executable_edge"], ranked["short_executable_edge"])),
    )
    execution_reference = np.where(ranked["candidate_side"] == "long_vol", ranked["ask"], ranked["bid"])
    ranked["edge_after_bid_ask_pct"] = np.where(
        execution_reference > 0,
        ranked["edge_after_bid_ask"] / execution_reference * 100.0,
        -np.inf,
    )
    ranked["liquidity_pass"] = (
        ((ranked["volume"] >= minimum_volume) | (ranked["open_interest"] >= minimum_open_interest))
        & (ranked["spread_pct"] <= max_spread_percent)
        & (ranked["ask"] > ranked["bid"])
        & (ranked["market_mid"] >= 0.10)
        & (ranked["vega"] >= 0.01)
    )
    quality_rows = [data_quality_diagnostics(row) for _, row in ranked.iterrows()]
    for column in (
        "data_quality_state", "data_quality_score", "data_quality_warning", "data_quality_pass",
        "quote_timestamp_available", "underlying_timestamp_available", "quote_freshness_basis",
    ):
        ranked[column] = [item[column] for item in quality_rows]
    ranked["forecast_age_days"] = (ranked["date"] - pd.to_datetime(ranked["forecast_as_of"])).dt.days
    ranked["forecast_stale"] = ranked["forecast_age_days"].isna() | (ranked["forecast_age_days"] > 4)
    ranked["forecast_freshness_warning"] = np.where(
        ranked["forecast_stale"], "Forecast file/record is stale for the contract date.", "",
    )
    ranked["rate_source"] = ranked["rate_source"] if "rate_source" in ranked else "unspecified_treasury_or_manual_proxy"
    ranked["rate_timestamp"] = pd.to_datetime(ranked["rate_timestamp"], errors="coerce", utc=True) if "rate_timestamp" in ranked else pd.NaT
    ranked["rate_for_expiration"] = ranked["rate"]
    ranked["rate_warning"] = ranked["rate_warning"] if "rate_warning" in ranked else "Rate provenance unavailable; treat as a proxy input."
    ranked["dividend_method"] = ranked["dividend_method"] if "dividend_method" in ranked else ranked["dividend_model"]
    ranked["dividend_schedule"] = ranked["discrete_dividends"] if "discrete_dividends" in ranked else None
    ranked["dividend_warning"] = ranked["dividend_warning"] if "dividend_warning" in ranked else np.where(
        ranked["dividend_data_available"], "", "Dividend data unavailable; 0% continuous yield assumed.",
    )
    ranked["carry_estimate_method"] = ranked["carry_estimate_method"] if "carry_estimate_method" in ranked else "input dividend/cash-flow schedule"
    ranked["double_counting_guard"] = np.where(ranked["discrete_dividend_count"] > 0, "continuous dividend yield must be zero", "not_applicable")
    ranked["event_risk_flag"] = ranked["event_risk_flag"] if "event_risk_flag" in ranked else False
    ranked["event_type"] = ranked["event_type"] if "event_type" in ranked else None
    ranked["event_date"] = ranked["event_date"] if "event_date" in ranked else pd.NaT
    ranked["event_data_source"] = ranked["event_data_source"] if "event_data_source" in ranked else "unavailable"
    ranked["event_warning"] = ranked["event_warning"] if "event_warning" in ranked else "Scheduled event calendar unavailable; high IV is not automatically rich."
    ranked["jump_risk_warning"] = "Forecast-vol scenario does not fully price jump risk."
    ranked["liquidity_score"] = np.log1p(ranked["volume"].clip(lower=0)) + 0.5 * np.log1p(ranked["open_interest"].clip(lower=0))
    ranked["surface_numerical_pass"] = (
        (ranked["surface_sanity_status"] == "pass")
        & ((ranked["svi_status"] != "fitted")
        | (
            ~ranked["svi_outlier"].astype(bool)
            & ranked["svi_butterfly_arbitrage_free"].astype(bool)
            & ranked["svi_calendar_arbitrage_free"].astype(bool)
            & ranked["svi_parameter_constraints_satisfied"].astype(bool)
        ))
    )
    ranked["surface_context_pass"] = np.select(
        [
            (ranked["candidate_side"] == "long_vol") & (ranked["iv_percentile"] <= 40.0),
            (ranked["candidate_side"] == "short_vol") & (ranked["iv_percentile"] >= 60.0),
        ],
        [True, True],
        default=False,
    ).astype(bool) & ranked["surface_numerical_pass"]
    ranked["surface_context_status"] = np.select(
        [
            ranked["iv_percentile"].isna(),
            ~ranked["surface_numerical_pass"],
            ranked["surface_context_pass"],
        ],
        ["historical bucket unavailable", "SVI outlier/static-arbitrage diagnostic failed", "confirmed relative to historical bucket"],
        default="not extreme versus historical bucket",
    )
    model_pass = (
        (ranked["option_style"] == "european")
        | ranked["tree_convergence_status"].eq("converged")
        | ranked["model_reason"].str.contains("premium is below", case=False, na=False)
    )
    classifications = [
        classify_signal(
            row.forecast_vol, row.market_iv, executable_rows[position],
            data_pass=bool(row.data_quality_pass and row.forecast_horizon_ranking_eligible and not row.forecast_stale),
            model_pass=bool(model_pass.iloc[position]),
            surface_pass=bool(row.surface_numerical_pass),
        )
        for position, row in enumerate(ranked.itertuples(index=False))
    ]
    ranked["candidate_classification"] = [item[0] for item in classifications]
    ranked["candidate_reason"] = [item[1] for item in classifications]
    ranked["minimum_edge_threshold_passed"] = np.where(
        ranked["candidate_side"] == "long_vol", ranked["long_minimum_edge_threshold_passed"],
        np.where(ranked["candidate_side"] == "short_vol", ranked["short_minimum_edge_threshold_passed"], False),
    )
    ranked["edge_to_spread_ratio"] = np.where(
        ranked["candidate_side"] == "long_vol", ranked["edge_to_spread_ratio_long"],
        np.where(ranked["candidate_side"] == "short_vol", ranked["edge_to_spread_ratio_short"], np.nan),
    )
    ranked["edge_to_vega_ratio"] = np.where(ranked["vega"] > 1e-12, ranked["edge_after_bid_ask"] / ranked["vega"], np.nan)
    ranked["edge_to_option_price_ratio"] = np.where(ranked["market_mid"] > 0, ranked["edge_after_bid_ask"] / ranked["market_mid"], np.nan)

    historical_confidence = np.minimum(ranked["iv_percentile_observations"].fillna(0) / 60.0, 1.0)
    horizon_confidence = ranked["forecast_horizon_method"].map({"exact": 1.0, "interpolated": 0.85, "extrapolated": 0.35, "unavailable": 0.0}).fillna(0.0)
    surface_confidence = np.where(ranked["surface_numerical_pass"], np.where(ranked["svi_status"] == "fitted", 0.95, 0.65), 0.15)
    forecast_validation_confidence = 0.55  # until live artifact carries per-record validation/stability metrics
    rate_confidence = np.where(ranked["rate_timestamp"].notna(), 0.8, 0.45)
    dividend_confidence = np.where(ranked["dividend_data_available"], 0.7, 0.3)
    event_confidence = np.where(ranked["event_data_source"] != "unavailable", 0.8, 0.0)
    confidence_components = []
    combined_confidence = []
    for position, row in enumerate(ranked.itertuples(index=False)):
        components = {
            "data_quality": float(row.data_quality_score),
            "forecast_freshness": 0.0 if row.forecast_stale else 1.0,
            "horizon_match": float(horizon_confidence.iloc[position]),
            "forecast_validation": forecast_validation_confidence,
            "surface_quality": float(surface_confidence[position]),
            "historical_context": float(historical_confidence.iloc[position]),
            "pricing_stability": float(row.model_confidence),
            "rate_quality": float(rate_confidence[position]),
            "dividend_quality": float(dividend_confidence[position]),
            "event_coverage": float(event_confidence[position]),
        }
        weights = {"data_quality": .28, "forecast_freshness": .10, "horizon_match": .10, "forecast_validation": .12,
                   "surface_quality": .10, "historical_context": .08, "pricing_stability": .10,
                   "rate_quality": .04, "dividend_quality": .04, "event_coverage": .04}
        value = sum(components[name] * weights[name] for name in weights)
        confidence_components.append({name: {"value": components[name], "weight": weights[name]} for name in weights})
        combined_confidence.append(min(max(value, 0.0), 1.0))
    ranked["pricing_model_confidence"] = ranked["model_confidence"]
    ranked["model_confidence"] = combined_confidence
    ranked["model_confidence_components"] = confidence_components
    ranked["model_confidence_calibrated"] = False

    ranked["directional_price_edge"] = np.maximum(np.where(
        ranked["candidate_side"] == "long_vol", ranked["long_executable_edge"],
        np.where(ranked["candidate_side"] == "short_vol", ranked["short_executable_edge"], 0.0),
    ), 0.0)
    ranked["directional_vol_edge"] = np.maximum(np.where(
        ranked["candidate_side"] == "long_vol", ranked["vol_edge"],
        np.where(ranked["candidate_side"] == "short_vol", -ranked["vol_edge"], 0.0),
    ), 0.0)
    ranked["directional_gamma_edge"] = np.maximum(np.where(
        ranked["candidate_side"] == "short_vol", ranked["gamma_weighted_edge"],
        np.where(ranked["candidate_side"] == "long_vol", -ranked["gamma_weighted_edge"], 0.0),
    ), 0.0)
    directional_group = ranked.groupby(["ticker", "date", "candidate_side"], group_keys=False)
    ranked["price_edge_score"] = directional_group["directional_price_edge"].rank(pct=True).fillna(0.0)
    ranked["vol_edge_score"] = directional_group["directional_vol_edge"].rank(pct=True).fillna(0.0)
    ranked["executable_edge_score"] = directional_group["edge_after_bid_ask"].rank(pct=True).fillna(0.0)
    ranked["liquidity_rank_score"] = directional_group["liquidity_score"].rank(pct=True).fillna(0.0)
    ranked["gamma_edge_score"] = directional_group["directional_gamma_edge"].rank(pct=True).fillna(0.0)
    ranked["surface_context_score"] = np.where(
        ranked["candidate_side"] == "long_vol",
        ((50.0 - ranked["iv_percentile"]) / 50.0).clip(lower=0.0, upper=1.0),
        np.where(
            ranked["candidate_side"] == "short_vol",
            ((ranked["iv_percentile"] - 50.0) / 50.0).clip(lower=0.0, upper=1.0),
            0.0,
        ),
    )
    ranked["surface_context_score"] = ranked["surface_context_score"].fillna(0.0) * historical_confidence
    ranked["raw_heuristic_score"] = (
        0.25 * ranked["price_edge_score"]
        + 0.15 * ranked["vol_edge_score"]
        + 0.25 * ranked["executable_edge_score"]
        + 0.15 * ranked["gamma_edge_score"]
        + 0.10 * ranked["surface_context_score"]
        + 0.05 * ranked["liquidity_rank_score"]
        + 0.05 * ranked["model_confidence"]
    )
    ranked["data_penalty"] = ranked["data_quality_score"] * np.where(ranked["data_quality_pass"], 1.0, 0.35)
    ranked["liquidity_penalty"] = np.where(ranked["liquidity_pass"], 1.0, 0.25)
    ranked["direction_penalty"] = np.where(ranked["candidate_classification"].isin(["long_vol_candidate", "short_vol_candidate"]), 1.0, 0.0)
    ranked["composite_score"] = (
        ranked["raw_heuristic_score"] * ranked["model_confidence"] * ranked["data_penalty"] *
        ranked["liquidity_penalty"] * ranked["direction_penalty"]
    )
    ranked["ranking_score_calibrated"] = False
    ranked["ranking_score_warning"] = "Heuristic weights are not validated on a sufficient quote-level walk-forward outcome sample."
    ranked["score_components"] = [
        {
            "price_edge": float(row.price_edge_score), "vol_edge": float(row.vol_edge_score),
            "executable_edge": float(row.executable_edge_score), "gamma_edge": float(row.gamma_edge_score),
            "surface_context": float(row.surface_context_score), "liquidity": float(row.liquidity_rank_score),
            "confidence": float(row.model_confidence), "data_penalty": float(row.data_penalty),
            "liquidity_penalty": float(row.liquidity_penalty), "direction_penalty": float(row.direction_penalty),
        }
        for row in ranked.itertuples(index=False)
    ]
    ranked["research_bucket"] = np.select(
        [
            ranked["liquidity_pass"] & ranked["data_quality_pass"] & ranked["surface_context_pass"]
            & ranked["candidate_classification"].isin(["long_vol_candidate", "short_vol_candidate"])
            & (ranked["model_confidence"] >= 0.70) & (ranked["composite_score"] >= 0.50),
            ranked["liquidity_pass"] & ranked["data_quality_pass"]
            & ranked["candidate_classification"].isin(["long_vol_candidate", "short_vol_candidate"]),
            ranked["liquidity_pass"] & ranked["candidate_side"].isin(["long_vol", "short_vol"]),
        ],
        ["A - strongest research candidate", "B - watchlist / needs trigger", "C - screen flag only"],
        default="Reject",
    )
    ranked["direction_correct_vs_market_iv"] = np.where(
        ranked["future_realized_vol"].notna(),
        np.sign(ranked["vol_edge"]) == np.sign(ranked["future_realized_vol"] - ranked["market_iv"]),
        np.nan,
    )
    ranked["rh_iv"] = ranked["market_iv"]
    ranked["edge_after_spread"] = ranked["edge_after_bid_ask"]
    rank_group = ranked.groupby(["ticker", "date", "candidate_side"], group_keys=False)
    ranked["contract_rank"] = rank_group["composite_score"].rank(method="first", ascending=False).astype(int)

    required_output = [
        "ticker", "underlying_price", "date", "expiration", "dte", "option_type", "strike",
        "bid", "ask", "market_mid", "last_price", "market_iv", "black_scholes_iv",
        "american_model_iv", "forecast_volatility", "bs_market_iv_fair_value",
        "bs_forecast_vol_fair_value", "american_market_iv_fair_value",
        "american_forecast_vol_fair_value", "selected_model_fair_value", "early_exercise_premium",
        "price_edge_bs", "price_edge_american", "edge_after_spread_bs", "edge_after_spread_american",
        "vol_edge", "implied_variance", "forecast_variance", "variance_edge", "delta", "gamma",
        "theta", "vega", "rho", "american_delta", "american_gamma", "spread", "spread_pct",
        "volume", "open_interest", "model_used", "model_reason", "model_confidence",
        "pricing_warning", "data_quality_warning", "forecast_model_used", "lambda_used", "weights_used",
        "parameters_used",
    ]
    extras = [
        "forecast_as_of", "forecast_horizon", "forecast_atm_vol", "trading_dte",
        "forecast_horizon_used", "forecast_horizon_method", "forecast_horizon_lower",
        "forecast_horizon_upper", "forecast_horizon_interpolation_weight", "forecast_horizon_ranking_eligible",
        "forecast_horizon_warning", "trading_calendar_warning", "forecast_age_days", "forecast_stale",
        "forecast_freshness_warning", "spot", "rate", "dividend", "option_style",
        "style_verified", "instrument_type", "dividend_data_available", "research_direction",
        "midpoint_edge", "long_executable_edge", "short_executable_edge", "edge_after_spread",
        "edge_after_bid_ask", "edge_after_bid_ask_pct", "edge_to_spread_ratio", "edge_to_vega_ratio",
        "edge_to_option_price_ratio", "minimum_edge_threshold", "minimum_edge_threshold_passed",
        "liquidity_pass", "composite_score", "raw_heuristic_score", "score_components",
        "ranking_score_calibrated", "ranking_score_warning", "data_penalty", "liquidity_penalty", "direction_penalty",
        "research_bucket", "contract_rank", "future_realized_vol", "direction_correct_vs_market_iv",
        "dollar_gamma", "gamma_weighted_edge", "vega_normalized_edge",
        "gamma_weighted_edge_contract", "contract_multiplier", "candidate_side", "candidate_classification", "candidate_reason",
        "moneyness", "log_moneyness", "moneyness_bucket", "dte_bucket", "atm_iv",
        "spot_log_moneyness", "forward_price", "atm_iv_source",
        "contract_iv_minus_atm_iv", "iv_skew_slope_per_10pct_moneyness",
        "atm_iv_1d", "atm_iv_2d", "atm_iv_5d", "atm_iv_10d",
        "term_spread_2d_minus_1d", "term_spread_5d_minus_2d", "term_spread_10d_minus_5d",
        "iv_percentile", "iv_percentile_observations", "historical_bucket_iv_median",
        "iv_minus_historical_bucket_median", "surface_context_pass", "surface_context_status",
        "surface_numerical_pass", "surface_sanity_status", "surface_shift_warning", "skew_adjustment_method",
        "svi_status", "svi_fitted_iv", "svi_residual_iv",
        "svi_robust_weight", "svi_outlier", "svi_a", "svi_b", "svi_rho", "svi_m", "svi_sigma",
        "svi_rmse_total_variance", "svi_minimum_butterfly_g", "svi_butterfly_arbitrage_free",
        "svi_parameter_constraints_satisfied", "svi_calendar_arbitrage_free",
        "svi_calendar_min_total_variance_change",
        "black_scholes_no_dividend_market_iv_fair_value", "binomial_market_iv_fair_value",
        "trinomial_market_iv_fair_value", "approximation_market_iv_fair_value",
        "binomial_forecast_vol_fair_value", "trinomial_forecast_vol_fair_value",
        "approximation_forecast_vol_fair_value", "binomial_american_iv", "trinomial_american_iv",
        "rh_iv", "calc_bs_iv", "calc_selected_model_iv", "american_iv",
        "selected_model_iv", "iv_solver_status", "iv_solver_iterations", "iv_solver_warning",
        "black_scholes_iv_solver_status", "black_scholes_iv_solver_iterations", "black_scholes_iv_solver_warning",
        "american_iv_solver_status", "american_iv_solver_iterations", "american_iv_solver_warning",
        "tree_early_exercise_premium", "early_exercise_materiality_threshold", "early_exercise_threshold_components",
        "tree_model_difference", "tree_convergence_status", "price_edge", "model_fair_value",
        "tree_steps_used", "tree_max_steps", "tree_convergence_error", "tree_convergence_tolerance",
        "tree_numerical_method", "tree_convergence_history", "dividend_model",
        "cash_dividend_present_value", "discrete_dividend_count", "black_scholes_runtime_ms", "binomial_runtime_ms",
        "trinomial_runtime_ms", "approximation_runtime_ms", "selected_model_runtime_ms",
        "market_iv_fair_value", "forecast_vol", "pricing_model_confidence", "model_confidence_components",
        "model_confidence_calibrated", "data_quality_state", "data_quality_score", "data_quality_pass",
        "quote_timestamp_available", "underlying_timestamp_available", "quote_freshness_basis",
        "rate_source", "rate_timestamp", "rate_for_expiration", "rate_warning", "dividend_method",
        "dividend_schedule", "dividend_warning", "carry_estimate_method", "double_counting_guard",
        "event_risk_flag", "event_type", "event_date", "event_warning", "event_data_source", "jump_risk_warning",
    ]
    return ranked[required_output + extras].sort_values(["ticker", "date", "contract_rank"]).reset_index(drop=True)


def latest_forecast_payload(
    forecasts: pd.DataFrame,
    surface_history: pd.DataFrame | None = None,
    diagnostics: pd.DataFrame | None = None,
    model_selection_history: pd.DataFrame | None = None,
    price_features: pd.DataFrame | None = None,
    config: ForecastConfig | None = None,
) -> dict:
    _validate_columns(forecasts, ("ticker", "date", "horizon", "model", "forecast_vol", "model_used"), "forecasts")
    best = forecasts[forecasts["model"] == "best_model"].copy()
    best["date"] = pd.to_datetime(best["date"]).dt.normalize()
    latest = best.sort_values("date").groupby(["ticker", "horizon"], as_index=False).tail(1)
    effective_config = config or ForecastConfig()
    generated_at = datetime.now(timezone.utc)
    records = []
    for row in latest.itertuples(index=False):
        group = best[(best["ticker"] == row.ticker) & (best["horizon"] == row.horizon)].sort_values("date")
        completed = group[group["future_realized_vol"].notna()] if "future_realized_vol" in group else group.iloc[0:0]
        recent_models = group["model_used"].dropna().astype(str).tail(12)
        stability = float((recent_models == str(row.model_used)).mean()) if not recent_models.empty else math.nan
        leaderboard: list[dict[str, object]] = []
        selected_diagnostic: dict[str, object] | None = None
        if diagnostics is not None and not diagnostics.empty:
            diagnostic_slice = diagnostics[
                (diagnostics["ticker"] == row.ticker)
                & (diagnostics["horizon"] == row.horizon)
                & (diagnostics["moneyness_bucket"] == "all")
            ].sort_values("mse_variance")
            leaderboard = [
                {
                    "model": str(item.model),
                    "mse_variance": float(item.mse_variance),
                    "mae_vol": float(item.mae_vol),
                    "rmse_vol": float(item.rmse_vol),
                    "mean_qlike": None if pd.isna(item.mean_qlike) else float(item.mean_qlike),
                    "variance_bias": None if pd.isna(getattr(item, "variance_bias", None)) else float(item.variance_bias),
                    "observations": int(item.observations),
                }
                for item in diagnostic_slice.head(8).itertuples(index=False)
            ]
            selected_match = diagnostic_slice[diagnostic_slice["model"] == str(row.model_used)]
            if not selected_match.empty:
                item = selected_match.iloc[0]
                selected_diagnostic = {
                    "mse_variance": float(item["mse_variance"]),
                    "mae_vol": float(item["mae_vol"]),
                    "rmse_vol": float(item["rmse_vol"]),
                    "mean_qlike": None if pd.isna(item.get("mean_qlike")) else float(item["mean_qlike"]),
                    "variance_bias": None if pd.isna(item.get("variance_bias")) else float(item["variance_bias"]),
                    "calibration_intercept": None if pd.isna(item.get("mz_intercept")) else float(item["mz_intercept"]),
                    "calibration_slope": None if pd.isna(item.get("mz_slope")) else float(item["mz_slope"]),
                }
        rebalance_dates: list[str] = []
        if model_selection_history is not None and not model_selection_history.empty:
            history_slice = model_selection_history[
                (model_selection_history["ticker"] == row.ticker)
                & (model_selection_history["horizon"] == row.horizon)
            ]
            rebalance_dates = [pd.Timestamp(value).date().isoformat() for value in history_slice["date"].drop_duplicates().tail(24)]
        records.append({
            "ticker": str(row.ticker),
            "as_of_date": pd.Timestamp(row.date).date().isoformat(),
            "horizon": int(row.horizon),
            "forecast_vol": float(row.forecast_vol),
            "model_used": str(row.model_used),
            "lambda_used": None if pd.isna(row.lambda_used) else float(row.lambda_used),
            "weights_used": row.weights_used if isinstance(row.weights_used, dict) else None,
            "parameters_used": row.parameters_used if isinstance(row.parameters_used, dict) else None,
            "training_rows": int(min(len(completed), effective_config.training_window or len(completed))),
            "validation_rows": int(len(completed)),
            "minimum_training_rows": int(effective_config.min_train_observations),
            "maximum_training_rows": effective_config.training_window,
            "rebalance_every": int(effective_config.rebalance_every),
            "rebalancing_dates": rebalance_dates,
            "selected_model_stability_last_12": None if pd.isna(stability) else stability,
            "selected_model_diagnostics": selected_diagnostic,
            "candidate_model_leaderboard": leaderboard,
            "parameter_train_end": None if pd.isna(getattr(row, "parameter_train_end", pd.NaT)) else pd.Timestamp(row.parameter_train_end).isoformat(),
            "stale_at_generation": (generated_at.date() - pd.Timestamp(row.date).date()).days > 4,
        })
    jump_diagnostics: list[dict[str, object]] = []
    if price_features is not None and not price_features.empty and "log_return" in price_features:
        for ticker, group in price_features.groupby("ticker"):
            values = pd.to_numeric(group.sort_values("date")["log_return"], errors="coerce").dropna().tail(756)
            reference = values.tail(252)
            scale = float(reference.std(ddof=1)) if len(reference) >= 20 else math.nan
            threshold = 3.0 * scale if math.isfinite(scale) else math.nan
            jumps = values[np.abs(values - values.median()) >= threshold] if math.isfinite(threshold) and threshold > 0 else values.iloc[0:0]
            jump_diagnostics.append({
                "ticker": str(ticker), "method": "absolute return >= 3 rolling-standard-deviations",
                "observations": int(len(values)), "reference_scale": scale,
                "jump_threshold": threshold, "jump_count": int(len(jumps)),
                "jump_frequency": float(len(jumps) / len(values)) if len(values) else None,
                "mean_absolute_jump": float(np.abs(jumps).mean()) if len(jumps) else None,
                "warning": "Historical jump statistic is diagnostic; scheduled event risk is not modeled.",
            })
    return {
        "schema": "volatility_forecast.v1",
        "generated_at": generated_at.isoformat(),
        "volatility_unit": "annualized_percent",
        "variance_unit": "annualized_decimal_squared",
        "horizons": sorted({int(record["horizon"]) for record in records}),
        "records": records,
        "surface_benchmarks": surface_benchmark_records(surface_history) if surface_history is not None else [],
        "forecast_configuration": {
            "min_train_observations": effective_config.min_train_observations,
            "training_window": effective_config.training_window,
            "rebalance_every": effective_config.rebalance_every,
            "horizons": list(effective_config.horizons),
        },
        "jump_diagnostics": jump_diagnostics,
        "event_calendar": {"status": "unavailable", "warning": "No CPI/FOMC/jobs/earnings calendar is bundled; event risk is not inferred."},
        "intraday_model": {"status": "unavailable", "warning": "Daily close-to-close forecasts cannot support high-confidence 0DTE ranking."},
    }


def json_safe_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Return a CSV-friendly copy without mutating the analysis DataFrame."""

    copy = frame.copy()
    for column in copy.columns:
        if copy[column].map(lambda value: isinstance(value, (dict, list))).any():
            copy[column] = copy[column].map(
                lambda value: json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else value
            )
    return copy
