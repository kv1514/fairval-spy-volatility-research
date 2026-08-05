"""Leakage and numerical tests for the walk-forward volatility engine."""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

import numpy as np
import pandas as pd


EXTENSION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXTENSION_ROOT))

from volatility_research.black_scholes import black_scholes_greeks, black_scholes_price  # noqa: E402
from volatility_research.engine import (  # noqa: E402
    ForecastConfig,
    VolatilityResearchEngine,
    _ewma_volatility_paths,
    _future_realized_vol,
    diagnose_models_by_moneyness,
    rank_option_contracts,
)
from volatility_research.surface import add_volatility_surface_context  # noqa: E402


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
        weights = self.engine.weights_history_[["w5", "w10", "w20", "w60"]].to_numpy(float)
        self.assertTrue(np.all(weights >= -1e-12))
        np.testing.assert_allclose(weights.sum(axis=1), 1.0, atol=1e-10)

    def test_ewma_variance_stays_positive(self) -> None:
        returns = self.engine.price_features_["log_return"].to_numpy(float)
        lambdas = np.array([0.70, 0.94, 0.99])
        paths = _ewma_volatility_paths(returns, lambdas)
        finite = paths[np.isfinite(paths)]
        self.assertGreater(finite.size, 0)
        self.assertTrue(np.all(finite >= 0.0))
        self.assertTrue(np.all(np.square(finite / 100.0) >= 0.0))

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

    def test_multiple_ticker_groups_keep_independent_date_indexes(self) -> None:
        qqq = self.prices.assign(ticker="QQQ", close=self.prices["close"] * 0.9)
        engine = VolatilityResearchEngine(ForecastConfig(horizons=(5,), min_train_observations=12, rebalance_every=10))
        result = engine.fit_predict(pd.concat([self.prices, qqq], ignore_index=True))
        self.assertEqual(set(result["ticker"]), {"SPY", "QQQ"})
        self.assertEqual(result.groupby("ticker").size().nunique(), 1)


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
        self.assertEqual(set(diagnostics["model"]), {"optimized_blend", "ewma", "realized_20", "realized_60"})
        winners = diagnostics[diagnostics["is_best"]]
        self.assertEqual(
            len(winners),
            diagnostics[["ticker", "horizon", "moneyness_bucket"]].drop_duplicates().shape[0],
        )


if __name__ == "__main__":
    unittest.main()
