"""Leakage-safe walk-forward volatility forecasting and option ranking."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from typing import Iterable

import numpy as np
import pandas as pd

from .black_scholes import black_scholes_greeks, black_scholes_price
from .pricing_models import PricingInputs, contract_pricing_diagnostics
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
MODEL_NAMES = (
    "realized_5", "realized_10", "realized_20", "realized_60",
    "fixed_blend", "optimized_blend", "sparse_blend", "ewma",
)


@dataclass(frozen=True)
class ForecastConfig:
    horizons: tuple[int, ...] = DEFAULT_HORIZONS
    min_train_observations: int = 30
    training_window: int | None = 252
    rebalance_every: int = 5
    ewma_default_lambda: float = 0.94
    optimizer_max_iterations: int = 5_000
    optimizer_tolerance: float = 1e-12
    vol_windows: tuple[int, ...] = CANDIDATE_WINDOWS
    sparse_max_terms: int = 3
    weight_zero_threshold: float = 1e-8
    projected_gradient_iterations: int = 400
    projected_gradient_tolerance: float = 1e-13


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
        self.model_selection_history_: pd.DataFrame = pd.DataFrame()
        self.price_features_: pd.DataFrame = pd.DataFrame()

    @property
    def _candidate_windows(self) -> tuple[int, ...]:
        return tuple(sorted({int(window) for window in self.config.vol_windows if int(window) >= 1}))

    @property
    def _all_windows(self) -> tuple[int, ...]:
        return tuple(sorted(set(self._candidate_windows) | set(REPORT_WINDOWS)))

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
        selection_rows: list[dict] = []
        feature_frames: list[pd.DataFrame] = []

        for ticker, ticker_prices in clean.groupby("ticker", sort=True):
            base, lambdas, ewma_paths = self._prepare_ticker(ticker, ticker_prices)
            feature_frames.append(base.copy())
            returns = base["log_return"].to_numpy()
            dates = base["date"].to_numpy()
            candidate_windows = self._candidate_windows
            all_windows = self._all_windows
            for horizon in self.config.horizons:
                panel = base[["ticker", "date", "close", *(f"vol_{window}" for window in all_windows), "fixed_blend"]].copy()
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

                optimized_values: list[float] = []
                optimized_weights: list[dict] = []
                optimized_train_end: list[pd.Timestamp | pd.NaT] = []
                sparse_values: list[float] = []
                sparse_weights_list: list[dict] = []
                sparse_train_end: list[pd.Timestamp | pd.NaT] = []
                ewma_values: list[float] = []
                ewma_lambdas: list[float] = []
                ewma_train_end: list[pd.Timestamp | pd.NaT] = []
                last_weights = _uniform_weights(len(candidate_windows))
                last_sparse_weights = _uniform_weights(len(candidate_windows))
                last_weight_train_end = pd.NaT
                last_lambda = float(self.config.ewma_default_lambda)
                last_lambda_train_end = pd.NaT

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

                panel["optimized_blend"] = optimized_values
                panel["optimized_weights"] = optimized_weights
                panel["optimized_train_end"] = optimized_train_end
                panel["sparse_blend"] = sparse_values
                panel["sparse_weights"] = sparse_weights_list
                panel["sparse_train_end"] = sparse_train_end
                panel["ewma"] = ewma_values
                panel["ewma_lambda"] = ewma_lambdas
                panel["ewma_train_end"] = ewma_train_end

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

                    def _weights_for(model: str) -> dict | None:
                        if model == "optimized_blend":
                            return row["optimized_weights"]
                        if model == "sparse_blend":
                            return row["sparse_weights"]
                        if model == "fixed_blend":
                            return fixed_weights_dict
                        return None

                    def _param_end_for(model: str):
                        if model == "ewma":
                            return row["ewma_train_end"]
                        if model == "optimized_blend":
                            return row["optimized_train_end"]
                        if model == "sparse_blend":
                            return row["sparse_train_end"]
                        return pd.NaT

                    for model in MODEL_NAMES:
                        output_rows.append({
                            **common,
                            "model": model,
                            "model_used": model,
                            "forecast_vol": float(row[model]),
                            "lambda_used": float(row["ewma_lambda"]) if model == "ewma" else np.nan,
                            "weights_used": _weights_for(model),
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
                        "parameter_train_end": row["selection_train_end"],
                    })

        self.lambda_performance_ = pd.DataFrame(lambda_curve_rows)
        self.weights_history_ = pd.DataFrame(weight_rows)
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
    valid["variance_error"] = np.square(valid["forecast_vol"] / 100.0) - np.square(valid["future_realized_vol"] / 100.0)
    metrics = valid.groupby(["model", "horizon"], as_index=False).agg(
        observations=("error", "size"),
        mae=("error", lambda values: float(np.mean(np.abs(values)))),
        rmse=("error", lambda values: float(np.sqrt(np.mean(np.square(values))))),
        mse_variance=("variance_error", lambda values: float(np.mean(np.square(values)))),
    )
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
    models: Iterable[str] = ("optimized_blend", "sparse_blend", "ewma", "realized_20", "realized_60"),
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
    diagnostics = combined.groupby(
        ["ticker", "horizon", "moneyness_bucket", "model"], as_index=False,
    ).agg(
        observations=("variance_error", "size"),
        mse_variance=("variance_error", lambda values: float(np.mean(np.square(values)))),
        mae_variance=("variance_error", lambda values: float(np.mean(np.abs(values)))),
        rmse_variance=("variance_error", lambda values: float(np.sqrt(np.mean(np.square(values))))),
        mae_vol=("vol_error", lambda values: float(np.mean(np.abs(values)))),
        rmse_vol=("vol_error", lambda values: float(np.sqrt(np.mean(np.square(values))))),
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
    tree_steps: int = 75,
    style_map: dict[str, dict[str, str]] | None = None,
) -> pd.DataFrame:
    required = ("ticker", "date", "expiration", "option_type", "strike", "market_iv", "bid", "ask", "volume", "open_interest")
    _validate_columns(options, required, "options")
    ranked = options.copy()
    ranked["ticker"] = ranked["ticker"].astype(str).str.upper().str.strip()
    ranked["date"] = pd.to_datetime(ranked["date"]).dt.normalize()
    ranked["expiration"] = pd.to_datetime(ranked["expiration"]).dt.normalize()
    if "dte" not in ranked:
        ranked["dte"] = (ranked["expiration"] - ranked["date"]).dt.days.clip(lower=1)
    ranked["dte"] = pd.to_numeric(ranked["dte"], errors="raise")
    ranked["forecast_horizon"] = ranked["dte"].map(lambda value: nearest_horizon(value, horizons))
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
    selected_rows: list[pd.Series | None] = []
    for row in ranked.itertuples(index=False):
        group = lookup.get((row.ticker, int(row.forecast_horizon)))
        if group is None or group.empty:
            selected_rows.append(None)
            continue
        eligible = group[group["date"] <= row.date]
        selected_rows.append(eligible.iloc[-1] if not eligible.empty else None)
    ranked["forecast_vol"] = [row["forecast_vol"] if row is not None else np.nan for row in selected_rows]
    ranked["forecast_as_of"] = [row["date"] if row is not None else pd.NaT for row in selected_rows]
    ranked["forecast_model_used"] = [row["model_used"] if row is not None else None for row in selected_rows]
    ranked["lambda_used"] = [row["lambda_used"] if row is not None else np.nan for row in selected_rows]
    ranked["weights_used"] = [row["weights_used"] if row is not None else None for row in selected_rows]
    ranked["future_realized_vol"] = [row["future_realized_vol"] if row is not None else np.nan for row in selected_rows]
    ranked = ranked.dropna(subset=["spot", "strike", "market_iv", "forecast_vol", "market_mid", "bid", "ask"])

    ranked["underlying_price"] = ranked["spot"]
    ranked["last_price"] = pd.to_numeric(ranked["last_price"], errors="coerce") if "last_price" in ranked else np.nan
    ranked["spread"] = ranked["ask"] - ranked["bid"]
    ranked["vol_edge"] = ranked["forecast_vol"] - ranked["market_iv"]

    pricing_rows: list[dict] = []
    for row in ranked.itertuples(index=False):
        pricing_rows.append(contract_pricing_diagnostics(
            ticker=row.ticker,
            market_mid=float(row.market_mid),
            market_iv=float(row.market_iv),
            forecast_volatility=float(row.forecast_vol),
            inputs=PricingInputs(
                spot=float(row.spot), strike=float(row.strike), dte=float(row.dte),
                volatility=float(row.market_iv), rate=float(row.rate), dividend=float(row.dividend),
                option_type=str(row.option_type), exercise_style="european",
            ),
            option_style=getattr(row, "option_style", None),
            instrument_type=getattr(row, "instrument_type", None),
            style_map=style_map,
            tree_steps=tree_steps,
        ))
    pricing_frame = pd.DataFrame(pricing_rows, index=ranked.index)
    # Avoid duplicate source columns (for example instrument_type supplied by a
    # broker) while keeping the pricing resolver's normalized result explicit.
    for column in pricing_frame.columns:
        ranked[column] = pricing_frame[column]

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
    ranked["edge_after_spread_bs"] = np.where(
        ranked["price_edge_bs"] >= 0,
        ranked["bs_forecast_vol_fair_value"] - ranked["ask"],
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
        ranked["price_edge"] >= 0,
        ranked["model_fair_value"] - ranked["ask"],
        ranked["bid"] - ranked["model_fair_value"],
    )
    execution_reference = np.where(ranked["price_edge"] >= 0, ranked["ask"], ranked["bid"])
    ranked["edge_after_bid_ask_pct"] = np.where(
        execution_reference > 0,
        ranked["edge_after_bid_ask"] / execution_reference * 100.0,
        -np.inf,
    )
    ranked["liquidity_pass"] = (
        ((ranked["volume"] >= minimum_volume) | (ranked["open_interest"] >= minimum_open_interest))
        & (ranked["spread_pct"] <= max_spread_percent)
        & (ranked["ask"] >= ranked["bid"])
        & (ranked["market_mid"] >= 0.10)
    )
    def data_warnings(row: pd.Series) -> str:
        items: list[str] = []
        if row["ask"] < row["bid"]:
            items.append("invalid bid/ask")
        if row["spread_pct"] > max_spread_percent:
            items.append("wide bid-ask spread")
        if row["volume"] < minimum_volume:
            items.append("low volume")
        if row["open_interest"] < minimum_open_interest:
            items.append("low open interest")
        if not bool(row["dividend_data_available"]):
            items.append("dividend data unavailable; 0% continuous yield assumed")
        return "; ".join(items)

    ranked["data_quality_warning"] = ranked.apply(data_warnings, axis=1)
    ranked["pricing_warning"] = [
        "; ".join(part for part in (str(pricing or "").strip(), str(data or "").strip()) if part)
        for pricing, data in zip(ranked["pricing_warning"], ranked["data_quality_warning"])
    ]
    # Liquidity and observable-data quality are part of confidence, not an
    # afterthought applied only to the final rank.
    liquidity_confidence = np.where(
        ranked["liquidity_pass"], 1.0,
        np.where(ranked["ask"] >= ranked["bid"], 0.55, 0.0),
    )
    ranked["model_confidence"] = (
        0.75 * ranked["model_confidence"].astype(float) + 0.25 * liquidity_confidence
    ).clip(lower=0.0, upper=1.0)
    ranked["liquidity_score"] = np.log1p(ranked["volume"].clip(lower=0)) + 0.5 * np.log1p(ranked["open_interest"].clip(lower=0))
    ranked["surface_context_pass"] = np.select(
        [
            (ranked["candidate_side"] == "long_vol") & (ranked["iv_percentile"] <= 40.0),
            (ranked["candidate_side"] == "short_vol") & (ranked["iv_percentile"] >= 60.0),
        ],
        [True, True],
        default=False,
    ).astype(bool)
    ranked["surface_context_status"] = np.select(
        [
            ranked["iv_percentile"].isna(),
            ranked["surface_context_pass"],
        ],
        ["historical bucket unavailable", "confirmed relative to historical bucket"],
        default="not extreme versus historical bucket",
    )
    ranked["abs_price_edge"] = ranked["price_edge"].abs()
    ranked["abs_vol_edge"] = ranked["vol_edge"].abs()
    ranked["abs_gamma_weighted_edge"] = ranked["gamma_weighted_edge"].abs()
    grouped = ranked.groupby(["ticker", "date"], group_keys=False)
    ranked["price_edge_score"] = grouped["abs_price_edge"].rank(pct=True)
    ranked["vol_edge_score"] = grouped["abs_vol_edge"].rank(pct=True)
    ranked["executable_edge_score"] = grouped["edge_after_bid_ask"].rank(pct=True)
    ranked["liquidity_rank_score"] = grouped["liquidity_score"].rank(pct=True)
    ranked["gamma_edge_score"] = grouped["abs_gamma_weighted_edge"].rank(pct=True)
    ranked["surface_context_score"] = np.where(
        ranked["candidate_side"] == "long_vol",
        ((50.0 - ranked["iv_percentile"]) / 50.0).clip(lower=0.0, upper=1.0),
        np.where(
            ranked["candidate_side"] == "short_vol",
            ((ranked["iv_percentile"] - 50.0) / 50.0).clip(lower=0.0, upper=1.0),
            0.0,
        ),
    )
    ranked["surface_context_score"] = ranked["surface_context_score"].fillna(0.0)
    ranked["composite_score"] = (
        0.25 * ranked["price_edge_score"]
        + 0.15 * ranked["vol_edge_score"]
        + 0.25 * ranked["executable_edge_score"]
        + 0.15 * ranked["gamma_edge_score"]
        + 0.10 * ranked["surface_context_score"]
        + 0.05 * ranked["liquidity_rank_score"]
        + 0.05 * ranked["model_confidence"]
    )
    ranked["research_bucket"] = np.select(
        [
            ranked["liquidity_pass"] & ranked["surface_context_pass"]
            & ranked["candidate_side"].isin(["long_vol", "short_vol"])
            & (ranked["edge_after_bid_ask"] > 0) & (ranked["composite_score"] >= 0.80),
            ranked["liquidity_pass"] & (ranked["edge_after_bid_ask"] > 0),
            ranked["liquidity_pass"],
        ],
        ["A - strongest research candidate", "B - watchlist / needs trigger", "C - screen flag only"],
        default="Reject",
    )
    ranked["direction_correct_vs_market_iv"] = np.where(
        ranked["future_realized_vol"].notna(),
        np.sign(ranked["vol_edge"]) == np.sign(ranked["future_realized_vol"] - ranked["market_iv"]),
        np.nan,
    )
    ranked["contract_rank"] = grouped["composite_score"].rank(method="first", ascending=False).astype(int)

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
    ]
    extras = [
        "forecast_as_of", "forecast_horizon", "spot", "rate", "dividend", "option_style",
        "style_verified", "instrument_type", "dividend_data_available", "research_direction",
        "edge_after_bid_ask", "edge_after_bid_ask_pct", "liquidity_pass", "composite_score",
        "research_bucket", "contract_rank", "future_realized_vol", "direction_correct_vs_market_iv",
        "dollar_gamma", "gamma_weighted_edge", "vega_normalized_edge",
        "gamma_weighted_edge_contract", "contract_multiplier", "candidate_side",
        "moneyness", "log_moneyness", "moneyness_bucket", "dte_bucket", "atm_iv",
        "contract_iv_minus_atm_iv", "iv_skew_slope_per_10pct_moneyness",
        "atm_iv_1d", "atm_iv_2d", "atm_iv_5d", "atm_iv_10d",
        "term_spread_2d_minus_1d", "term_spread_5d_minus_2d", "term_spread_10d_minus_5d",
        "iv_percentile", "iv_percentile_observations", "historical_bucket_iv_median",
        "iv_minus_historical_bucket_median", "surface_context_pass", "surface_context_status",
        "black_scholes_no_dividend_market_iv_fair_value", "binomial_market_iv_fair_value",
        "trinomial_market_iv_fair_value", "approximation_market_iv_fair_value",
        "binomial_forecast_vol_fair_value", "trinomial_forecast_vol_fair_value",
        "approximation_forecast_vol_fair_value", "binomial_american_iv", "trinomial_american_iv",
        "selected_model_iv", "iv_solver_status", "iv_solver_warning", "tree_early_exercise_premium",
        "tree_model_difference", "tree_convergence_status", "price_edge", "model_fair_value",
        "tree_steps_used", "black_scholes_runtime_ms", "binomial_runtime_ms",
        "trinomial_runtime_ms", "approximation_runtime_ms", "selected_model_runtime_ms",
        "market_iv_fair_value", "forecast_vol",
    ]
    return ranked[required_output + extras].sort_values(["ticker", "date", "contract_rank"]).reset_index(drop=True)


def latest_forecast_payload(
    forecasts: pd.DataFrame,
    surface_history: pd.DataFrame | None = None,
) -> dict:
    _validate_columns(forecasts, ("ticker", "date", "horizon", "model", "forecast_vol", "model_used"), "forecasts")
    best = forecasts[forecasts["model"] == "best_model"].copy()
    best["date"] = pd.to_datetime(best["date"]).dt.normalize()
    latest = best.sort_values("date").groupby(["ticker", "horizon"], as_index=False).tail(1)
    records = []
    for row in latest.itertuples(index=False):
        records.append({
            "ticker": str(row.ticker),
            "as_of_date": pd.Timestamp(row.date).date().isoformat(),
            "horizon": int(row.horizon),
            "forecast_vol": float(row.forecast_vol),
            "model_used": str(row.model_used),
            "lambda_used": None if pd.isna(row.lambda_used) else float(row.lambda_used),
            "weights_used": row.weights_used if isinstance(row.weights_used, dict) else None,
        })
    return {
        "schema": "volatility_forecast.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "volatility_unit": "annualized_percent",
        "variance_unit": "annualized_decimal_squared",
        "horizons": sorted({int(record["horizon"]) for record in records}),
        "records": records,
        "surface_benchmarks": surface_benchmark_records(surface_history) if surface_history is not None else [],
    }


def json_safe_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Return a CSV-friendly copy without mutating the analysis DataFrame."""

    copy = frame.copy()
    for column in copy.columns:
        if copy[column].map(lambda value: isinstance(value, dict)).any():
            copy[column] = copy[column].map(lambda value: json.dumps(value, sort_keys=True) if isinstance(value, dict) else value)
    return copy
