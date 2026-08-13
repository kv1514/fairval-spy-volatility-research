"""Leakage and numerical tests for the walk-forward volatility engine."""

from __future__ import annotations

import math
import re
import sys
from pathlib import Path
import unittest

import numpy as np
import pandas as pd


EXTENSION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXTENSION_ROOT))

from volatility_research.black_scholes import (  # noqa: E402
    black_scholes_greeks,
    black_scholes_price,
    implied_volatility_percent,
)
from volatility_research.engine import (  # noqa: E402
    ForecastConfig,
    VolatilityResearchEngine,
    _ewma_volatility_paths,
    _future_realized_vol,
    _sparse_variance_weights,
    diagnose_models_by_moneyness,
    evaluate_forecasts,
    format_blend_formula,
    rank_option_contracts,
    threshold_sensitivity_study,
)
from volatility_research.conditional_variance import (  # noqa: E402
    average_forward_variance,
    fit_garch_qmle,
    walk_forward_garch,
)
from volatility_research.paper_backtest import (  # noqa: E402
    build_forward_outcomes,
    evaluate_signal_regression,
    walk_forward_signal_regression,
)
from volatility_research.surface import (  # noqa: E402
    add_volatility_surface_context,
    fit_svi_slice,
    prepare_surface_contracts,
    svi_butterfly_g,
    svi_total_variance,
)


def sample_prices(periods: int = 145) -> pd.DataFrame:
    dates = pd.bdate_range("2025-01-02", periods=periods)
    index = np.arange(periods, dtype=float)
    returns = 0.0003 + 0.009 * np.sin(index / 4.3) + 0.004 * np.cos(index / 9.1)
    closes = 500.0 * np.exp(np.cumsum(returns))
    return pd.DataFrame({"ticker": "SPY", "date": dates, "close": closes})


class TargetConstructionTests(unittest.TestCase):
    def test_future_target_uses_only_next_h_returns(self) -> None:
        returns = np.array([np.nan, 0.01, -0.02, 0.03, 0.50], dtype=float)
        expected = np.std(np.array([-0.02, 0.03]), ddof=1) * np.sqrt(252.0) * 100.0
        self.assertAlmostEqual(_future_realized_vol(returns, 1, 2), expected, places=12)

        altered_after_horizon = returns.copy()
        altered_after_horizon[4] = -9.0
        self.assertAlmostEqual(
            _future_realized_vol(altered_after_horizon, 1, 2),
            expected,
            places=12,
        )

    def test_one_day_target_is_absolute_return_proxy(self) -> None:
        returns = np.array([np.nan, 0.01, -0.02])
        self.assertAlmostEqual(
            _future_realized_vol(returns, 1, 1),
            0.02 * np.sqrt(252.0) * 100.0,
            places=12,
        )


class WalkForwardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.prices = sample_prices()
        cls.config = ForecastConfig(
            horizons=(1, 2, 3, 5, 10),
            min_train_observations=12,
            training_window=70,
            rebalance_every=5,
        )
        cls.engine = VolatilityResearchEngine(cls.config)
        cls.forecasts = cls.engine.fit_predict(cls.prices)

    def test_no_parameter_lookahead(self) -> None:
        learned = self.forecasts.dropna(subset=["parameter_train_end"])
        self.assertTrue((pd.to_datetime(learned["parameter_train_end"]) <= pd.to_datetime(learned["date"])).all())
        self.assertTrue((pd.to_datetime(self.forecasts["forecast_input_end"]) == pd.to_datetime(self.forecasts["date"])).all())

    def test_optimized_weights_are_nonnegative_and_sum_to_one(self) -> None:
        weight_columns = [c for c in self.engine.weights_history_.columns if re.fullmatch(r"w\d+", c)]
        self.assertGreater(len(weight_columns), 4)  # a broad candidate window set, not just 5/10/20/60
        weights = self.engine.weights_history_[weight_columns].to_numpy(float)
        self.assertTrue(np.all(weights >= -1e-12))
        np.testing.assert_allclose(weights.sum(axis=1), 1.0, atol=1e-9)

    def test_sparse_blend_is_sparse_and_normalized(self) -> None:
        cap = self.config.sparse_max_terms
        # The pre-training warm-start is a uniform blend; the sparsity guarantee
        # applies once the greedy selector has actually trained on completed targets.
        trained = self.engine.weights_history_[self.engine.weights_history_["parameter_train_end"].notna()]
        self.assertGreater(len(trained), 0)
        for weights in trained["sparse_weights"]:
            values = np.array([float(v) for v in weights.values()], dtype=float)
            self.assertLessEqual(len(values), cap)  # cardinality cap: no useless windows
            self.assertTrue(np.all(values > self.config.weight_zero_threshold))  # no dust weights
            np.testing.assert_allclose(values.sum(), 1.0, atol=1e-9)
        self.assertTrue((trained["sparse_n_terms"] <= cap).all())

    def test_sparse_blend_forecasts_are_leakage_safe(self) -> None:
        sparse = self.forecasts[self.forecasts["model"] == "sparse_blend"].dropna(subset=["parameter_train_end"])
        self.assertTrue((pd.to_datetime(sparse["parameter_train_end"]) <= pd.to_datetime(sparse["date"])).all())

    def test_ewma_variance_stays_positive(self) -> None:
        returns = self.engine.price_features_["log_return"].to_numpy(float)
        lambdas = np.array([0.70, 0.94, 0.99])
        paths = _ewma_volatility_paths(returns, lambdas)
        finite = paths[np.isfinite(paths)]
        self.assertGreater(finite.size, 0)
        self.assertTrue(np.all(finite >= 0.0))
        self.assertTrue(np.all(np.square(finite / 100.0) >= 0.0))

    def test_har_rv_forecast_is_positive_and_past_trained(self) -> None:
        har = self.forecasts[self.forecasts["model"] == "har_rv"]
        self.assertGreater(len(har), 0)
        self.assertTrue((har["forecast_vol"] > 0).all())
        trained = har.dropna(subset=["parameter_train_end"])
        self.assertGreater(len(trained), 0)
        self.assertTrue(
            (pd.to_datetime(trained["parameter_train_end"]) <= pd.to_datetime(trained["date"])).all()
        )

    def test_garch_models_are_positive_stationary_and_past_trained(self) -> None:
        for model in ("garch_11", "gjr_garch"):
            rows = self.forecasts[self.forecasts["model"] == model]
            self.assertGreater(len(rows), 0)
            self.assertTrue((rows["forecast_vol"] > 0).all())
            trained = rows.dropna(subset=["parameter_train_end"])
            self.assertGreater(len(trained), 0)
            self.assertTrue((pd.to_datetime(trained["parameter_train_end"]) <= pd.to_datetime(trained["date"])).all())
            for parameters in rows["parameters_used"].dropna():
                self.assertGreater(parameters["persistence"], 0.0)
                self.assertLess(parameters["persistence"], 1.0)
                self.assertGreater(parameters["next_variance"], 0.0)

    def test_adaptive_ensemble_weights_are_convex_and_past_trained(self) -> None:
        history = self.engine.ensemble_weights_history_
        weight_columns = [column for column in history if column.startswith("weight_")]
        self.assertGreater(len(weight_columns), 3)
        weights = history[weight_columns].to_numpy(dtype=float)
        self.assertTrue(np.all(weights >= -1e-12))
        np.testing.assert_allclose(weights.sum(axis=1), 1.0, atol=1e-9)
        trained = history.dropna(subset=["parameter_train_end"])
        self.assertGreater(len(trained), 0)
        self.assertTrue((pd.to_datetime(trained["parameter_train_end"]) <= pd.to_datetime(trained["date"])).all())

    def test_target_dates_are_strictly_future(self) -> None:
        completed = self.forecasts.dropna(subset=["future_realized_vol"]).copy()
        self.assertTrue((pd.to_datetime(completed["target_start_date"]) > pd.to_datetime(completed["date"])).all())
        self.assertTrue((pd.to_datetime(completed["target_end_date"]) >= pd.to_datetime(completed["target_start_date"])).all())

    def test_forecast_at_t_is_unchanged_by_returns_after_t(self) -> None:
        cutoff = self.prices["date"].iloc[109]
        truncated = self.prices[self.prices["date"] <= cutoff]
        short_engine = VolatilityResearchEngine(self.config)
        short_forecasts = short_engine.fit_predict(truncated)
        full_at_cutoff = self.forecasts[(self.forecasts["date"] == cutoff)].sort_values(["horizon", "model"]).reset_index(drop=True)
        short_at_cutoff = short_forecasts[(short_forecasts["date"] == cutoff)].sort_values(["horizon", "model"]).reset_index(drop=True)
        self.assertEqual(len(full_at_cutoff), len(short_at_cutoff))
        np.testing.assert_allclose(full_at_cutoff["forecast_vol"], short_at_cutoff["forecast_vol"], rtol=0, atol=1e-12)
        self.assertEqual(full_at_cutoff["model_used"].tolist(), short_at_cutoff["model_used"].tolist())

    def test_ewma_lambda_is_selected_from_requested_grid(self) -> None:
        ewma = self.forecasts[self.forecasts["model"] == "ewma"].dropna(subset=["lambda_used"])
        self.assertTrue(ewma["lambda_used"].between(0.70, 0.99).all())
        scaled = ewma["lambda_used"].to_numpy(float) * 1000
        np.testing.assert_allclose(scaled, np.round(scaled), atol=1e-9)

    def test_walk_forward_model_selection_uses_variance_loss(self) -> None:
        self.assertIn("training_mse_variance", self.engine.model_selection_history_.columns)
        self.assertNotIn("training_mae", self.engine.model_selection_history_.columns)

    def test_evaluation_includes_robust_loss_and_calibration(self) -> None:
        evaluation = evaluate_forecasts(self.forecasts)
        self.assertTrue({"mean_qlike", "variance_bias", "mz_intercept", "mz_slope", "mz_r_squared"}.issubset(evaluation.columns))
        self.assertTrue(np.isfinite(evaluation["mean_qlike"]).all())

    def test_multiple_ticker_groups_keep_independent_date_indexes(self) -> None:
        qqq = self.prices.assign(ticker="QQQ", close=self.prices["close"] * 0.9)
        engine = VolatilityResearchEngine(ForecastConfig(horizons=(5,), min_train_observations=12, rebalance_every=10))
        result = engine.fit_predict(pd.concat([self.prices, qqq], ignore_index=True))
        self.assertEqual(set(result["ticker"]), {"SPY", "QQQ"})
        self.assertEqual(result.groupby("ticker").size().nunique(), 1)


class ConditionalVarianceUnitTests(unittest.TestCase):
    def test_qmle_parameters_and_forward_variance_are_valid(self) -> None:
        index = np.arange(300, dtype=float)
        returns = 0.008 * np.sin(index / 7.0) + np.where(index % 17 == 0, -0.025, 0.001)
        for asymmetric in (False, True):
            parameters = fit_garch_qmle(returns, asymmetric=asymmetric)
            self.assertGreater(parameters["alpha"], 0.0)
            self.assertGreater(parameters["beta"], 0.0)
            self.assertGreaterEqual(parameters["gamma"], 0.0)
            self.assertLess(parameters["persistence"], 1.0)
            self.assertGreater(average_forward_variance(parameters, 10), 0.0)

    def test_walk_forward_garch_does_not_use_later_returns(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=120)
        returns = 0.01 * np.sin(np.arange(120) / 6.0)
        full, _, _ = walk_forward_garch(
            returns, dates, (5,), asymmetric=True, min_train_observations=30,
            training_window=80, rebalance_every=5,
        )
        altered = returns.copy()
        altered[91:] = 0.50
        changed, _, _ = walk_forward_garch(
            altered, dates, (5,), asymmetric=True, min_train_observations=30,
            training_window=80, rebalance_every=5,
        )
        self.assertAlmostEqual(float(full[5][90]), float(changed[5][90]), places=12)


class PaperOutcomeRegressionTests(unittest.TestCase):
    @staticmethod
    def _paper_records(count: int = 150) -> list[dict]:
        records = []
        base = pd.Timestamp("2026-01-02T15:00:00Z").timestamp() * 1000
        for index in range(count):
            observed = base + index * 2 * 60 * 60 * 1000
            edge = 1.0 + (index % 10)
            contract = f"SPY-{index}"
            common = {
                "contractKey": contract, "strike": 500.0, "marketDelta": 0.50,
                "spot": 500.0, "varianceEdge": edge / 1000.0,
                "gammaWeightedEdge": edge, "vegaNormalizedEdge": edge / 5.0,
                "edgePercent": edge, "marketIv": 20.0, "forecastAtmIv": 22.0,
                "days": 5.0, "volume": 100 + index, "openInterest": 500 + index,
            }
            records.append({
                **common, "observedAt": observed, "flagDirection": "below-model",
                "bid": 0.95, "mark": 1.00, "ask": 1.05,
            })
            records.append({
                **common, "observedAt": observed + 60 * 60 * 1000, "flagDirection": None,
                "bid": 1.00 + edge / 100.0, "mark": 1.05 + edge / 100.0,
                "ask": 1.10 + edge / 100.0, "spot": 500.0,
            })
        return records

    def test_outcome_pairing_uses_executable_sides(self) -> None:
        outcomes = build_forward_outcomes(self._paper_records(3), horizon_minutes=60)
        self.assertEqual(len(outcomes), 3)
        self.assertTrue((outcomes["entryExecutable"] == 1.05).all())
        self.assertTrue((outcomes["exitExecutable"] > 1.00).all())

    def test_signal_regression_is_strictly_walk_forward(self) -> None:
        outcomes = build_forward_outcomes(self._paper_records(), horizon_minutes=60)
        predicted = walk_forward_signal_regression(
            outcomes, min_train_observations=30, training_window=100, rebalance_every=10,
        )
        valid = predicted.dropna(subset=["predictedPnlContract"])
        self.assertGreater(len(valid), 50)
        self.assertTrue((pd.to_datetime(valid["regressionTrainEnd"], utc=True) < pd.to_datetime(valid["signalTime"], utc=True)).all())
        diagnostics = evaluate_signal_regression(predicted)
        self.assertGreater(int(diagnostics.loc[0, "observations"]), 50)


class PricingAndRankingTests(unittest.TestCase):
    def test_market_iv_black_scholes_is_consistent(self) -> None:
        price = float(black_scholes_price(100, 100, 30, 20, 4, 1, "call"))
        self.assertGreater(price, 0)
        self.assertLess(price, 20)
        greeks = black_scholes_greeks(100, 100, 30, 20, 4, 1)
        self.assertGreater(float(greeks["gamma"]), 0)
        self.assertGreater(float(greeks["vega"]), 0)

    def test_contract_ranking_contains_research_fields(self) -> None:
        as_of = pd.Timestamp("2026-08-05")
        market_mid = float(black_scholes_price(100, 100, 5, 18.0, 4.0, 1.2, "call"))
        forecasts = pd.DataFrame([
            {
                "ticker": "SPY", "date": as_of, "horizon": 5, "model": "best_model",
                "model_used": "ewma", "forecast_vol": 22.0, "lambda_used": 0.931,
                "weights_used": None, "future_realized_vol": np.nan,
            }
        ])
        options = pd.DataFrame([
            {
                "ticker": "SPY", "date": as_of, "expiration": "2026-08-10", "dte": 5,
                "option_type": "call", "strike": 100, "market_iv": 18.0, "market_mid": market_mid,
                "bid": market_mid - 0.05, "ask": market_mid + 0.05, "volume": 500, "open_interest": 2000,
                "spot": 100, "rate": 4.0, "dividend": 1.2,
            }
        ])
        ranked = rank_option_contracts(options, forecasts)
        required = {
            "ticker", "date", "expiration", "dte", "option_type", "strike", "market_iv",
            "forecast_vol", "vol_edge", "market_mid", "model_fair_value", "price_edge",
            "bid", "ask", "spread_pct", "volume", "open_interest", "model_used",
            "lambda_used", "weights_used", "edge_after_bid_ask", "liquidity_pass",
            "implied_variance", "forecast_variance", "variance_edge", "dollar_gamma",
            "gamma_weighted_edge", "vega_normalized_edge", "atm_iv",
            "contract_iv_minus_atm_iv", "iv_percentile", "candidate_side",
        }
        self.assertTrue(required.issubset(ranked.columns))
        self.assertAlmostEqual(float(ranked.loc[0, "vol_edge"]), 4.0)
        self.assertLess(float(ranked.loc[0, "variance_edge"]), 0.0)
        self.assertLess(float(ranked.loc[0, "gamma_weighted_edge"]), 0.0)
        self.assertEqual(ranked.loc[0, "candidate_side"], "long_vol")
        self.assertTrue(bool(ranked.loc[0, "liquidity_pass"]))

    def test_positive_gamma_weighted_edge_is_short_vol_sign(self) -> None:
        as_of = pd.Timestamp("2026-08-05")
        forecast_vol = 15.0
        market_iv = 25.0
        market_mid = float(black_scholes_price(100, 100, 5, market_iv, 4, 0, "put"))
        forecasts = pd.DataFrame([{
            "ticker": "SPY", "date": as_of, "horizon": 5, "model": "best_model",
            "model_used": "ewma", "forecast_vol": forecast_vol, "lambda_used": 0.94,
            "weights_used": None, "future_realized_vol": np.nan,
        }])
        options = pd.DataFrame([{
            "ticker": "SPY", "date": as_of, "expiration": as_of + pd.Timedelta(days=5),
            "dte": 5, "option_type": "put", "strike": 100, "market_iv": market_iv,
            "market_mid": market_mid, "bid": market_mid - 0.02, "ask": market_mid + 0.02,
            "volume": 500, "open_interest": 2000, "spot": 100, "rate": 4, "dividend": 0,
        }])
        history_dates = pd.bdate_range(end=as_of - pd.Timedelta(days=1), periods=30)
        history = pd.DataFrame({
            "ticker": "SPY", "date": history_dates,
            "expiration": history_dates + pd.to_timedelta(5, unit="D"), "dte": 5,
            "option_type": "put", "strike": 100, "spot": 100,
            "market_iv": np.linspace(18, 22, len(history_dates)),
        })
        ranked = rank_option_contracts(options, forecasts, surface_history=history)
        self.assertEqual(ranked.loc[0, "candidate_side"], "short_vol")
        self.assertGreater(float(ranked.loc[0, "variance_edge"]), 0.0)
        self.assertGreater(float(ranked.loc[0, "gamma_weighted_edge"]), 0.0)
        self.assertGreater(float(ranked.loc[0, "iv_percentile"]), 90.0)
        self.assertTrue(bool(ranked.loc[0, "surface_context_pass"]))

    def test_high_put_iv_is_not_automatically_mispricing(self) -> None:
        as_of = pd.Timestamp("2026-08-05")
        market_iv = 32.0
        mid = float(black_scholes_price(100, 90, 5, market_iv, 4, 0, "put"))
        forecasts = pd.DataFrame([{
            "ticker": "SPY", "date": as_of, "horizon": 5, "model": "best_model",
            "model_used": "realized_60", "forecast_vol": 20.0, "lambda_used": np.nan,
            "weights_used": None, "future_realized_vol": np.nan,
        }])
        options = pd.DataFrame([{
            "ticker": "SPY", "date": as_of, "expiration": as_of + pd.Timedelta(days=5),
            "dte": 5, "option_type": "put", "strike": 90, "market_iv": market_iv,
            "market_mid": mid, "bid": max(mid - 0.02, 0.01), "ask": mid + 0.02,
            "volume": 500, "open_interest": 2000, "spot": 100, "rate": 4, "dividend": 0,
        }])
        history_dates = pd.bdate_range(end=as_of - pd.Timedelta(days=1), periods=30)
        history = pd.DataFrame({
            "ticker": "SPY", "date": history_dates,
            "expiration": history_dates + pd.to_timedelta(5, unit="D"), "dte": 5,
            "option_type": "put", "strike": 90, "spot": 100,
            "market_iv": np.linspace(33, 39, len(history_dates)),
        })
        ranked = rank_option_contracts(options, forecasts, surface_history=history)
        self.assertFalse(bool(ranked.loc[0, "surface_context_pass"]))
        self.assertNotEqual(ranked.loc[0, "research_bucket"], "A - strongest research candidate")


class SurfaceAndDiagnosticsTests(unittest.TestCase):
    def test_svi_recovers_a_smooth_forward_moneyness_slice(self) -> None:
        parameters = {"a": 0.012, "b": 0.08, "rho": -0.35, "m": 0.01, "sigma": 0.18}
        k = np.linspace(-0.25, 0.25, 13)
        variance = svi_total_variance(k, parameters)
        variance[2] += 0.004  # visible outlier; robust weights should contain it
        fit = fit_svi_slice(k, variance)
        self.assertEqual(fit["status"], "fitted")
        self.assertTrue(bool(fit["parameter_constraint_satisfied"]))
        self.assertGreater(float(np.min(svi_butterfly_g(k, fit["parameters"]))), -1e-6)
        fitted = svi_total_variance(k, fit["parameters"])
        clean = np.ones_like(k, dtype=bool)
        clean[2] = False
        self.assertLess(float(np.sqrt(np.mean(np.square(fitted[clean] - svi_total_variance(k[clean], parameters))))), 0.002)

    def test_surface_uses_forward_not_spot_log_moneyness(self) -> None:
        prepared = prepare_surface_contracts(pd.DataFrame([{
            "ticker": "SPY", "date": "2026-08-05", "expiration": "2027-08-05", "dte": 365,
            "option_type": "call", "strike": 100, "spot": 100, "market_iv": 20,
            "rate": 10, "dividend": 0,
        }]))
        self.assertAlmostEqual(float(prepared.loc[0, "spot_log_moneyness"]), 0.0, places=12)
        self.assertAlmostEqual(float(prepared.loc[0, "log_moneyness"]), -0.10, places=12)

    def test_svi_calendar_diagnostic_detects_decreasing_total_variance(self) -> None:
        date = pd.Timestamp("2026-08-05")
        rows = []
        for dte, total_variance in ((10, 0.04), (30, 0.03)):
            iv = math.sqrt(total_variance / (dte / 365.0)) * 100.0
            for strike in np.linspace(80, 120, 9):
                rows.append({
                    "ticker": "SPY", "date": date, "expiration": date + pd.Timedelta(days=dte),
                    "dte": dte, "option_type": "call", "strike": strike, "spot": 100,
                    "market_iv": iv,
                })
        surface = add_volatility_surface_context(pd.DataFrame(rows))
        longer = surface[surface["dte"] == 30]
        self.assertTrue((longer["svi_status"] == "fitted").all())
        self.assertFalse(bool(longer["svi_calendar_arbitrage_free"].all()))
        self.assertLess(float(longer["svi_calendar_min_total_variance_change"].iloc[0]), 0)

    def test_surface_context_has_atm_skew_term_structure_and_past_only_percentile(self) -> None:
        as_of = pd.Timestamp("2026-08-05")
        rows = []
        for dte, atm in ((1, 18), (2, 19), (5, 21), (10, 23)):
            for strike, offset in ((95, 3), (100, 0), (105, 1)):
                rows.append({
                    "ticker": "SPY", "date": as_of, "expiration": as_of + pd.Timedelta(days=dte),
                    "dte": dte, "option_type": "put", "strike": strike, "spot": 100,
                    "market_iv": atm + offset,
                })
        history_dates = pd.bdate_range(end=as_of - pd.Timedelta(days=1), periods=25)
        history = pd.DataFrame({
            "ticker": "SPY", "date": list(history_dates) + [as_of + pd.Timedelta(days=1)],
            "expiration": list(history_dates + pd.to_timedelta(5, unit="D")) + [as_of + pd.Timedelta(days=6)],
            "dte": 5, "option_type": "put", "strike": 100, "spot": 100,
            "market_iv": list(np.linspace(15, 20, 25)) + [999],
        })
        surface = add_volatility_surface_context(pd.DataFrame(rows), history=history)
        five_day_atm = surface[(surface["dte"] == 5) & (surface["strike"] == 100)].iloc[0]
        self.assertAlmostEqual(float(five_day_atm["atm_iv"]), 21.0)
        self.assertAlmostEqual(float(five_day_atm["contract_iv_minus_atm_iv"]), 0.0)
        self.assertAlmostEqual(float(five_day_atm["atm_iv_1d"]), 18.0)
        self.assertAlmostEqual(float(five_day_atm["atm_iv_2d"]), 19.0)
        self.assertAlmostEqual(float(five_day_atm["atm_iv_5d"]), 21.0)
        self.assertAlmostEqual(float(five_day_atm["atm_iv_10d"]), 23.0)
        self.assertEqual(int(five_day_atm["iv_percentile_observations"]), 25)
        self.assertGreater(float(five_day_atm["iv_percentile"]), 90.0)

    def test_threshold_study_is_research_framed_and_coverage_decreases(self) -> None:
        prices = sample_prices()
        engine = VolatilityResearchEngine(ForecastConfig(horizons=(5,), min_train_observations=12, rebalance_every=10))
        forecasts = engine.fit_predict(prices)
        completed = forecasts[(forecasts["model"] == "best_model") & forecasts["future_realized_vol"].notna()]
        market_iv = pd.DataFrame({
            "ticker": "SPY",
            "date": completed["date"].to_numpy(),
            "dte": 5,
            "market_iv": np.clip(completed["forecast_vol"].to_numpy() - 4.0, 1.0, None),
        })
        study = threshold_sensitivity_study(forecasts, market_iv, thresholds=(0.0, 2.0, 5.0))
        expected = {
            "ticker", "min_abs_vol_edge_points", "observations", "coverage_pct",
            "directional_accuracy_vs_market_iv", "variance_skill_vs_market",
        }
        self.assertTrue(expected.issubset(study.columns))
        spy = study[study["ticker"] == "SPY"].sort_values("min_abs_vol_edge_points")
        # Wider gaps are rarer, so coverage must be non-increasing in the threshold.
        self.assertTrue((spy["coverage_pct"].diff().dropna() <= 1e-9).all())
        self.assertAlmostEqual(float(spy.iloc[0]["coverage_pct"]), 100.0, places=6)
        self.assertLessEqual(float(spy["directional_accuracy_vs_market_iv"].max()), 1.0)

    def test_diagnostics_selects_one_variance_winner_per_group(self) -> None:
        prices = sample_prices()
        engine = VolatilityResearchEngine(ForecastConfig(horizons=(5,), min_train_observations=12, rebalance_every=10))
        forecasts = engine.fit_predict(prices)
        dates = prices["date"].iloc[70:120]
        history = pd.DataFrame({
            "ticker": "SPY", "date": dates, "expiration": dates + pd.to_timedelta(5, unit="D"),
            "dte": 5, "option_type": "call", "strike": 500, "spot": 500, "market_iv": 20,
        })
        diagnostics = diagnose_models_by_moneyness(forecasts, history)
        self.assertEqual(
            set(diagnostics["model"]),
            {
                "optimized_blend", "sparse_blend", "ewma", "har_rv", "garch_11", "gjr_garch",
                "simple_ensemble", "adaptive_ensemble", "realized_20", "realized_60",
            },
        )
        winners = diagnostics[diagnostics["is_best"]]
        self.assertEqual(
            len(winners),
            diagnostics[["ticker", "horizon", "moneyness_bucket"]].drop_duplicates().shape[0],
        )


class BlackScholesPropertyTests(unittest.TestCase):
    S, K, DTE, VOL, R, Q = 100.0, 100.0, 30.0, 22.0, 4.0, 1.5

    def test_put_call_parity(self) -> None:
        call = float(black_scholes_price(self.S, self.K, self.DTE, self.VOL, self.R, self.Q, "call"))
        put = float(black_scholes_price(self.S, self.K, self.DTE, self.VOL, self.R, self.Q, "put"))
        t = self.DTE / 365.0
        expected = self.S * np.exp(-self.Q / 100.0 * t) - self.K * np.exp(-self.R / 100.0 * t)
        self.assertAlmostEqual(call - put, expected, places=6)

    def test_call_increases_and_put_decreases_with_spot(self) -> None:
        call_lo = float(black_scholes_price(95, self.K, self.DTE, self.VOL, self.R, self.Q, "call"))
        call_hi = float(black_scholes_price(105, self.K, self.DTE, self.VOL, self.R, self.Q, "call"))
        put_lo = float(black_scholes_price(95, self.K, self.DTE, self.VOL, self.R, self.Q, "put"))
        put_hi = float(black_scholes_price(105, self.K, self.DTE, self.VOL, self.R, self.Q, "put"))
        self.assertGreater(call_hi, call_lo)
        self.assertLess(put_hi, put_lo)

    def test_price_increases_with_volatility(self) -> None:
        for option_type in ("call", "put"):
            low = float(black_scholes_price(self.S, self.K, self.DTE, 15.0, self.R, self.Q, option_type))
            high = float(black_scholes_price(self.S, self.K, self.DTE, 35.0, self.R, self.Q, option_type))
            self.assertGreater(high, low)

    def test_iv_solver_recovers_known_sigma(self) -> None:
        # The safeguarded-Newton solver recovers sigma to far tighter precision
        # than the old bisection-only inversion (which the 1e-4 check reflected).
        for sigma in (12.0, 27.5, 60.0):
            for option_type, strike in (("call", 100.0), ("put", 90.0), ("call", 115.0)):
                price = float(black_scholes_price(self.S, strike, self.DTE, sigma, self.R, self.Q, option_type))
                recovered = implied_volatility_percent(price, self.S, strike, self.DTE, option_type, self.R, self.Q)
                self.assertAlmostEqual(recovered, sigma, places=5)

    def test_normal_cdf_matches_full_precision_erf(self) -> None:
        from volatility_research.black_scholes import _normal_cdf

        xs = np.linspace(-6.0, 6.0, 61)
        reference = np.array([0.5 * (1.0 + math.erf(x / math.sqrt(2.0))) for x in xs])
        np.testing.assert_allclose(_normal_cdf(xs), reference, atol=1e-15)

    def test_gamma_and_vega_are_equal_for_call_and_put(self) -> None:
        call = black_scholes_greeks(self.S, self.K, self.DTE, self.VOL, self.R, self.Q, "call")
        put = black_scholes_greeks(self.S, self.K, self.DTE, self.VOL, self.R, self.Q, "put")
        self.assertAlmostEqual(float(call["gamma"]), float(put["gamma"]), places=12)
        self.assertAlmostEqual(float(call["vega"]), float(put["vega"]), places=12)

    def test_delta_theta_rho_are_finite_and_signed(self) -> None:
        call = black_scholes_greeks(self.S, self.K, self.DTE, self.VOL, self.R, self.Q, "call")
        put = black_scholes_greeks(self.S, self.K, self.DTE, self.VOL, self.R, self.Q, "put")
        for greeks in (call, put):
            for key in ("delta", "theta", "rho", "gamma", "vega"):
                self.assertTrue(np.isfinite(float(greeks[key])))
        self.assertGreater(float(call["delta"]), 0.0)  # long call is positive delta
        self.assertLess(float(put["delta"]), 0.0)  # long put is negative delta
        self.assertGreater(float(call["rho"]), 0.0)  # call gains when rates rise
        self.assertLess(float(put["rho"]), 0.0)  # put loses when rates rise


class SparseBlendTests(unittest.TestCase):
    def test_sparse_selection_respects_cardinality_and_threshold(self) -> None:
        rng = np.arange(400, dtype=float)
        # A target that only two windows can explain well; the sparse selector
        # should not pad the blend with additional, useless windows.
        features = np.column_stack([
            18 + 3 * np.sin(rng / 5),
            18 + 3 * np.sin(rng / 5) + 0.2 * np.cos(rng / 11),
            40 + 10 * np.cos(rng / 30),
            25 + np.zeros_like(rng),
        ])
        target = 18 + 3 * np.sin(rng / 5)
        config = ForecastConfig(sparse_max_terms=2)
        weights = _sparse_variance_weights(features, target, config)
        nonzero = weights[weights > config.weight_zero_threshold]
        self.assertLessEqual(np.count_nonzero(weights > config.weight_zero_threshold), 2)
        self.assertTrue(np.all(nonzero > 0))
        self.assertAlmostEqual(float(weights.sum()), 1.0, places=9)
        # No weight should linger in the dust band between 0 and the threshold.
        self.assertFalse(np.any((weights > 0) & (weights < config.weight_zero_threshold)))

    def test_blend_formula_is_readable_and_drops_dust(self) -> None:
        formula = format_blend_formula({"5": 0.6, "20": 0.4, "60": 1e-12})
        self.assertTrue(formula.startswith("sqrt("))
        self.assertIn("0.60*vol_5", formula)
        self.assertIn("0.40*vol_20", formula)
        self.assertNotIn("vol_60", formula)  # negligible weight is dropped


if __name__ == "__main__":
    unittest.main()
