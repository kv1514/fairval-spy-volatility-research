"""Leakage-safe walk-forward volatility forecasting and option ranking."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from typing import Iterable

import numpy as np
import pandas as pd

from .black_scholes import black_scholes_price


TRADING_DAYS = 252.0
VOL_WINDOWS = (5, 10, 20, 60)
DEFAULT_HORIZONS = (1, 2, 3, 5, 10)
FIXED_WEIGHTS = np.array([0.40, 0.30, 0.20, 0.10], dtype=float)
MODEL_NAMES = ("realized_5", "realized_10", "realized_20", "realized_60", "fixed_blend", "optimized_blend", "ewma")


@dataclass(frozen=True)
class ForecastConfig:
    horizons: tuple[int, ...] = DEFAULT_HORIZONS
    min_train_observations: int = 30
    training_window: int | None = 252
    rebalance_every: int = 5
    ewma_default_lambda: float = 0.94
    optimizer_max_iterations: int = 5_000
    optimizer_tolerance: float = 1e-12


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


def _optimize_variance_weights(
    volatility_features: np.ndarray,
    target_volatility: np.ndarray,
    config: ForecastConfig,
) -> np.ndarray:
    """Minimize training MSE in annualized variance under simplex constraints."""

    x = np.square(np.asarray(volatility_features, dtype=float) / 100.0)
    y = np.square(np.asarray(target_volatility, dtype=float) / 100.0)
    mask = np.isfinite(x).all(axis=1) & np.isfinite(y)
    x = x[mask]
    y = y[mask]
    if x.shape[0] < 2:
        return FIXED_WEIGHTS.copy()
    # Four features permit an exact active-set search over all 15 nonempty
    # subsets. Each subset solves equality-constrained least squares; infeasible
    # negative solutions are discarded. This is deterministic and much faster
    # than thousands of projected-gradient iterations at every rebalance.
    best_weights = FIXED_WEIGHTS.copy()
    best_loss = float(np.mean(np.square(x @ best_weights - y)))
    feature_count = x.shape[1]
    for mask in range(1, 1 << feature_count):
        active = np.array([index for index in range(feature_count) if mask & (1 << index)], dtype=int)
        local = x[:, active]
        gram = local.T @ local
        rhs = local.T @ y
        kkt = np.block([
            [gram, np.ones((len(active), 1))],
            [np.ones((1, len(active))), np.zeros((1, 1))],
        ])
        solution = np.linalg.lstsq(kkt, np.append(rhs, 1.0), rcond=None)[0][:-1]
        if np.any(solution < -config.optimizer_tolerance):
            continue
        candidate = np.zeros(feature_count, dtype=float)
        candidate[active] = np.maximum(solution, 0.0)
        candidate = _project_simplex(candidate)
        loss = float(np.mean(np.square(x @ candidate - y)))
        if loss < best_loss:
            best_loss = loss
            best_weights = candidate
    return best_weights


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

    def _prepare_ticker(self, ticker: str, frame: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
        local = frame.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True).copy()
        local["log_return"] = np.log(local["close"] / local["close"].shift(1))
        for window in VOL_WINDOWS:
            local[f"vol_{window}"] = local["log_return"].rolling(window).std(ddof=1) * np.sqrt(TRADING_DAYS) * 100.0
        local["fixed_blend"] = np.sqrt(sum(
            weight * np.square(local[f"vol_{window}"])
            for weight, window in zip(FIXED_WEIGHTS, VOL_WINDOWS, strict=True)
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
            for horizon in self.config.horizons:
                panel = base[["ticker", "date", "close", *(f"vol_{window}" for window in VOL_WINDOWS), "fixed_blend"]].copy()
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
                panel = panel.dropna(subset=[*(f"vol_{window}" for window in VOL_WINDOWS)]).reset_index(drop=True)
                for window in VOL_WINDOWS:
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
                ewma_values: list[float] = []
                ewma_lambdas: list[float] = []
                ewma_train_end: list[pd.Timestamp | pd.NaT] = []
                last_weights = FIXED_WEIGHTS.copy()
                last_weight_train_end = pd.NaT
                last_lambda = float(self.config.ewma_default_lambda)
                last_lambda_train_end = pd.NaT

                for position, row in panel.iterrows():
                    origin = pd.Timestamp(row["date"])
                    training = _training_rows(panel.iloc[:position], origin, self.config)
                    rebalance = position % max(self.config.rebalance_every, 1) == 0
                    if rebalance and len(training) >= self.config.min_train_observations:
                        features = training[[f"vol_{window}" for window in VOL_WINDOWS]].to_numpy(dtype=float)
                        targets = training["target_future_vol"].to_numpy(dtype=float)
                        last_weights = _optimize_variance_weights(features, targets, self.config)
                        last_weight_train_end = pd.Timestamp(training["target_end_date"].max())
                    feature_vector = row[[f"vol_{window}" for window in VOL_WINDOWS]].to_numpy(dtype=float)
                    optimized_values.append(float(np.sqrt(np.dot(last_weights, np.square(feature_vector)))))
                    weight_dict = {str(window): float(weight) for window, weight in zip(VOL_WINDOWS, last_weights, strict=True)}
                    optimized_weights.append(weight_dict)
                    optimized_train_end.append(last_weight_train_end)
                    weight_rows.append({
                        "ticker": ticker,
                        "date": origin,
                        "horizon": int(horizon),
                        **{f"w{window}": float(weight) for window, weight in zip(VOL_WINDOWS, last_weights, strict=True)},
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
                        model_errors = {
                            model: float(np.mean(np.abs(training[model] - training["target_future_vol"])))
                            for model in MODEL_NAMES
                        }
                        last_model = min(model_errors, key=model_errors.get)
                        last_model_train_end = pd.Timestamp(training["target_end_date"].max())
                        selection_rows.extend({
                            "ticker": ticker,
                            "date": origin,
                            "horizon": int(horizon),
                            "model": model,
                            "training_mae": error,
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
                    for model in MODEL_NAMES:
                        record = {
                            **common,
                            "model": model,
                            "model_used": model,
                            "forecast_vol": float(row[model]),
                            "lambda_used": float(row["ewma_lambda"]) if model == "ewma" else np.nan,
                            "weights_used": row["optimized_weights"] if model == "optimized_blend" else (
                                {str(window): float(weight) for window, weight in zip(VOL_WINDOWS, FIXED_WEIGHTS, strict=True)}
                                if model == "fixed_blend" else None
                            ),
                            "parameter_train_end": row["ewma_train_end"] if model == "ewma" else (
                                row["optimized_train_end"] if model == "optimized_blend" else pd.NaT
                            ),
                        }
                        output_rows.append(record)
                    selected = str(row["selected_model"])
                    output_rows.append({
                        **common,
                        "model": "best_model",
                        "model_used": selected,
                        "forecast_vol": float(row[selected]),
                        "lambda_used": float(row["ewma_lambda"]) if selected == "ewma" else np.nan,
                        "weights_used": row["optimized_weights"] if selected == "optimized_blend" else (
                            {str(window): float(weight) for window, weight in zip(VOL_WINDOWS, FIXED_WEIGHTS, strict=True)}
                            if selected == "fixed_blend" else None
                        ),
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
    horizons: Iterable[int] = DEFAULT_HORIZONS,
    max_spread_percent: float = 20.0,
    minimum_volume: int = 10,
    minimum_open_interest: int = 100,
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
    ranked["dividend"] = pd.to_numeric(ranked["dividend"], errors="coerce") if "dividend" in ranked else 0.0

    if "spot" not in ranked:
        if prices is None:
            raise ValueError("options must contain spot, or prices must be provided")
        _validate_columns(prices, ("ticker", "date", "close"), "prices")
        spot = prices[["ticker", "date", "close"]].copy()
        spot["ticker"] = spot["ticker"].astype(str).str.upper().str.strip()
        spot["date"] = pd.to_datetime(spot["date"]).dt.normalize()
        ranked = ranked.merge(spot.rename(columns={"close": "spot"}), on=["ticker", "date"], how="left")
    ranked["spot"] = pd.to_numeric(ranked["spot"], errors="coerce")

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
    ranked["model_used"] = [row["model_used"] if row is not None else None for row in selected_rows]
    ranked["lambda_used"] = [row["lambda_used"] if row is not None else np.nan for row in selected_rows]
    ranked["weights_used"] = [row["weights_used"] if row is not None else None for row in selected_rows]
    ranked["future_realized_vol"] = [row["future_realized_vol"] if row is not None else np.nan for row in selected_rows]
    ranked = ranked.dropna(subset=["spot", "strike", "market_iv", "forecast_vol", "market_mid", "bid", "ask"])

    ranked["vol_edge"] = ranked["forecast_vol"] - ranked["market_iv"]
    ranked["model_fair_value"] = black_scholes_price(
        ranked["spot"], ranked["strike"], ranked["dte"], ranked["forecast_vol"],
        ranked["rate"], ranked["dividend"], ranked["option_type"],
    )
    ranked["market_iv_fair_value"] = black_scholes_price(
        ranked["spot"], ranked["strike"], ranked["dte"], ranked["market_iv"],
        ranked["rate"], ranked["dividend"], ranked["option_type"],
    )
    ranked["price_edge"] = ranked["model_fair_value"] - ranked["market_mid"]
    ranked["spread_pct"] = np.where(
        ranked["market_mid"] > 0,
        (ranked["ask"] - ranked["bid"]) / ranked["market_mid"] * 100.0,
        np.inf,
    )
    ranked["research_direction"] = np.where(ranked["price_edge"] >= 0, "below-model", "above-model")
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
    ranked["liquidity_score"] = np.log1p(ranked["volume"].clip(lower=0)) + 0.5 * np.log1p(ranked["open_interest"].clip(lower=0))
    ranked["abs_price_edge"] = ranked["price_edge"].abs()
    ranked["abs_vol_edge"] = ranked["vol_edge"].abs()
    grouped = ranked.groupby(["ticker", "date"], group_keys=False)
    ranked["price_edge_score"] = grouped["abs_price_edge"].rank(pct=True)
    ranked["vol_edge_score"] = grouped["abs_vol_edge"].rank(pct=True)
    ranked["executable_edge_score"] = grouped["edge_after_bid_ask"].rank(pct=True)
    ranked["liquidity_rank_score"] = grouped["liquidity_score"].rank(pct=True)
    ranked["composite_score"] = (
        0.35 * ranked["price_edge_score"]
        + 0.25 * ranked["vol_edge_score"]
        + 0.30 * ranked["executable_edge_score"]
        + 0.10 * ranked["liquidity_rank_score"]
    )
    ranked["research_bucket"] = np.select(
        [
            ranked["liquidity_pass"] & (ranked["edge_after_bid_ask"] > 0) & (ranked["composite_score"] >= 0.80),
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
        "ticker", "date", "expiration", "dte", "option_type", "strike", "market_iv", "forecast_vol",
        "vol_edge", "market_mid", "model_fair_value", "market_iv_fair_value", "price_edge", "bid", "ask",
        "spread_pct", "volume", "open_interest", "model_used", "lambda_used", "weights_used",
    ]
    extras = [
        "forecast_as_of", "forecast_horizon", "spot", "rate", "dividend", "research_direction",
        "edge_after_bid_ask", "edge_after_bid_ask_pct", "liquidity_pass", "composite_score",
        "research_bucket", "contract_rank", "future_realized_vol", "direction_correct_vs_market_iv",
    ]
    return ranked[required_output + extras].sort_values(["ticker", "date", "contract_rank"]).reset_index(drop=True)


def latest_forecast_payload(forecasts: pd.DataFrame) -> dict:
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
        "horizons": sorted({int(record["horizon"]) for record in records}),
        "records": records,
    }


def json_safe_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Return a CSV-friendly copy without mutating the analysis DataFrame."""

    copy = frame.copy()
    for column in copy.columns:
        if copy[column].map(lambda value: isinstance(value, dict)).any():
            copy[column] = copy[column].map(lambda value: json.dumps(value, sort_keys=True) if isinstance(value, dict) else value)
    return copy
