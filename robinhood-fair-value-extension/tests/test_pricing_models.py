from __future__ import annotations

import inspect
import json
import math
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from volatility_research.engine import rank_option_contracts
from volatility_research.pricing_models import (
    BaroneAdesiWhaleyModel,
    BlackScholesModel,
    CRRBinomialModel,
    PricingInputs,
    TrinomialModel,
    adaptive_crr,
    contract_pricing_diagnostics,
    convergence_report,
    implied_volatility,
    smoothed_crr_result,
)


class MultiModelPricingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.call = PricingInputs(100, 100, 365, 20, 5, 0, "call", "european")
        self.put = PricingInputs(100, 100, 365, 20, 5, 0, "put", "european")

    def test_01_black_scholes_known_benchmarks(self) -> None:
        model = BlackScholesModel(True)
        self.assertAlmostEqual(model.price(self.call), 10.45058357, places=6)
        self.assertAlmostEqual(model.price(self.put), 5.57352602, places=6)

    def test_02_dividend_put_call_parity(self) -> None:
        model = BlackScholesModel(True)
        call = PricingInputs(100, 105, 180, 24, 4.5, 1.3, "call")
        put = PricingInputs(**{**call.__dict__, "option_type": "put"})
        lhs = model.price(call) - model.price(put)
        rhs = call.spot * math.exp(-0.013 * call.time_years) - call.strike * math.exp(-0.045 * call.time_years)
        self.assertAlmostEqual(lhs, rhs, places=9)

    def test_03_and_04_generic_iv_recovers_black_scholes_sigma(self) -> None:
        model = BlackScholesModel(True)
        target = model.price(self.call)
        result = implied_volatility(target, model, PricingInputs(**{**self.call.__dict__, "volatility": 35}))
        self.assertTrue(result.converged)
        self.assertAlmostEqual(result.volatility or 0, 20, places=5)

    def test_05_generic_iv_recovers_binomial_american_sigma(self) -> None:
        model = CRRBinomialModel(150, True)
        inputs = PricingInputs(100, 110, 90, 28, 4.0, 1.0, "put", "american")
        result = implied_volatility(model.price(inputs), model, PricingInputs(**{**inputs.__dict__, "volatility": 15}))
        self.assertTrue(result.converged)
        self.assertAlmostEqual(result.volatility or 0, 28, places=4)

    def test_06_binomial_european_converges_to_black_scholes(self) -> None:
        benchmark = BlackScholesModel(True).price(self.call)
        error_50 = abs(CRRBinomialModel(50, False).price(self.call) - benchmark)
        error_1000 = abs(CRRBinomialModel(1000, False).price(self.call) - benchmark)
        self.assertLess(error_1000, error_50)
        self.assertLess(error_1000, 0.003)

    def test_07_trinomial_european_converges_to_black_scholes(self) -> None:
        benchmark = BlackScholesModel(True).price(self.call)
        error_50 = abs(TrinomialModel(50, False).price(self.call) - benchmark)
        error_1000 = abs(TrinomialModel(1000, False).price(self.call) - benchmark)
        self.assertLess(error_1000, error_50)
        self.assertLess(error_1000, 0.002)

    def test_08_american_tree_not_less_than_same_european_tree(self) -> None:
        inputs = PricingInputs(80, 100, 180, 25, 5, 0, "put", "american")
        for model_type in (CRRBinomialModel, TrinomialModel):
            self.assertGreaterEqual(model_type(300, True).price(inputs), model_type(300, False).price(inputs) - 1e-12)

    def test_09_non_dividend_american_call_matches_european_call(self) -> None:
        american = CRRBinomialModel(1000, True).price(self.call)
        european = BlackScholesModel(True).price(self.call)
        self.assertAlmostEqual(american, european, delta=0.003)

    def test_10_american_put_can_exceed_european_put(self) -> None:
        inputs = PricingInputs(80, 100, 365, 20, 8, 0, "put", "american")
        self.assertGreater(CRRBinomialModel(500, True).price(inputs), BlackScholesModel(True).price(inputs) + 0.10)

    def test_11_exact_tree_early_exercise_premium_is_nonnegative(self) -> None:
        inputs = PricingInputs(80, 100, 365, 20, 8, 0, "put", "american")
        result = CRRBinomialModel(250, True).price_diagnostics(inputs)
        self.assertGreaterEqual(result.early_exercise_premium, 0)
        self.assertTrue(result.exercise_boundary)

    def test_12_american_value_is_never_below_intrinsic(self) -> None:
        deep_put = PricingInputs(50, 100, 2, 10, 5, 0, "put", "american")
        self.assertGreaterEqual(CRRBinomialModel(100, True).price(deep_put), 50)
        self.assertGreaterEqual(TrinomialModel(100, True).price(deep_put), 50)

    def test_13_value_increases_with_volatility(self) -> None:
        model = CRRBinomialModel(200, True)
        low = PricingInputs(100, 100, 30, 10, 4, 1, "put", "american")
        high = PricingInputs(**{**low.__dict__, "volatility": 40})
        self.assertGreater(model.price(high), model.price(low))

    def test_14_and_15_values_are_monotone_in_spot(self) -> None:
        model = TrinomialModel(200, True)
        low_call = PricingInputs(95, 100, 30, 25, 4, 1, "call", "american")
        high_call = PricingInputs(**{**low_call.__dict__, "spot": 105})
        low_put = PricingInputs(**{**low_call.__dict__, "option_type": "put"})
        high_put = PricingInputs(**{**high_call.__dict__, "option_type": "put"})
        self.assertGreater(model.price(high_call), model.price(low_call))
        self.assertLess(model.price(high_put), model.price(low_put))

    def test_16_binomial_and_trinomial_are_close(self) -> None:
        inputs = PricingInputs(95, 100, 180, 30, 5, 2, "put", "american")
        binomial = CRRBinomialModel(1000, True).price(inputs)
        trinomial = TrinomialModel(1000, True).price(inputs)
        self.assertAlmostEqual(binomial, trinomial, delta=0.015)

    def test_17_tree_models_handle_very_short_dte(self) -> None:
        inputs = PricingInputs(100, 100, 0.001, 30, 4, 1, "call", "american")
        self.assertTrue(math.isfinite(CRRBinomialModel(50, True).price(inputs)))
        self.assertTrue(math.isfinite(TrinomialModel(50, True).price(inputs)))

    def test_18_invalid_inputs_are_rejected(self) -> None:
        invalid = PricingInputs(-1, 100, 30, 20, 4, 0, "call", "american")
        with self.assertRaises(ValueError):
            CRRBinomialModel(100, True).price(invalid)
        with self.assertRaises(ValueError):
            TrinomialModel(100, True).price(invalid)

    def test_19_iv_rejects_price_below_american_intrinsic(self) -> None:
        inputs = PricingInputs(80, 100, 30, 20, 4, 0, "put", "american")
        result = implied_volatility(19.0, CRRBinomialModel(100, True), inputs)
        self.assertFalse(result.converged)
        self.assertEqual(result.status, "below_lower_bound")

    def test_21_inferred_style_produces_warning(self) -> None:
        diagnostics = contract_pricing_diagnostics(
            ticker="SPY", market_mid=2.5, market_iv=20, forecast_volatility=22,
            inputs=PricingInputs(100, 100, 30, 20, 4, 1, "call"), tree_steps=50,
        )
        self.assertIn("inferred", diagnostics["pricing_warning"])

    def test_model_selection_does_not_confuse_lattice_error_with_exercise_value(self) -> None:
        inputs = PricingInputs(100, 100, 30, 20, 5, 0, "call", "american")
        midpoint = BlackScholesModel(True).price(inputs)
        diagnostics = contract_pricing_diagnostics(
            ticker="SPY", market_mid=midpoint, market_iv=20, forecast_volatility=20,
            inputs=inputs, option_style="american", instrument_type="etf", tree_steps=75,
        )
        self.assertEqual(diagnostics["model_used"], "black_scholes_dividend_adjusted")
        self.assertAlmostEqual(diagnostics["tree_early_exercise_premium"], 0.0, places=10)

    def test_deep_put_selects_american_model_when_same_tree_premium_is_material(self) -> None:
        inputs = PricingInputs(85, 100, 180, 25, 5, 0, "put", "american")
        midpoint = CRRBinomialModel(150, True).price(inputs)
        diagnostics = contract_pricing_diagnostics(
            ticker="TEST", market_mid=midpoint, market_iv=20, forecast_volatility=20,
            inputs=inputs, option_style="american", instrument_type="equity", tree_steps=150,
        )
        self.assertEqual(diagnostics["model_used"], "binomial_american_crr")
        self.assertGreater(diagnostics["tree_early_exercise_premium"], 0.01)

    def test_22_convergence_report_exposes_stability_and_runtime(self) -> None:
        inputs = PricingInputs(100, 105, 30, 25, 4, 1, "put", "american")
        report = convergence_report(CRRBinomialModel, inputs, (50, 100, 250))
        self.assertEqual([row["steps"] for row in report], [50, 100, 250])
        self.assertTrue(all(row["runtime_ms"] is not None for row in report))
        self.assertIn("stabilized", report[-1])

    def test_adaptive_crr_reports_convergence_and_matches_refined_reference(self) -> None:
        inputs = PricingInputs(100, 105, 45, 27, 4, 1, "put", "american")
        result = adaptive_crr(inputs, min_steps=50, max_steps=400, tolerance=0.0025)
        reference = smoothed_crr_result(inputs, steps=800, american=True).price
        self.assertTrue(result.converged)
        self.assertEqual(result.convergence_status, "converged")
        self.assertGreaterEqual(len(result.convergence_history), 3)
        self.assertLessEqual(result.convergence_error or math.inf, 0.0025)
        self.assertLess(abs(result.price - reference), 0.003)

    def test_python_pricing_matches_shared_cross_language_golden_vectors(self) -> None:
        vectors = json.loads((Path(__file__).parent / "fixtures" / "pricing-golden-vectors.json").read_text(encoding="utf-8"))
        for vector in vectors:
            raw = vector["inputs"]
            inputs = PricingInputs(
                spot=raw["spot"], strike=raw["strike"], dte=raw["days"],
                volatility=raw["volatility"], rate=raw["rate"], dividend=raw["dividend"],
                option_type=raw["optionType"], exercise_style=raw["exerciseStyle"],
            )
            adaptive = adaptive_crr(inputs, min_steps=50, max_steps=400, tolerance=0.0025)
            self.assertAlmostEqual(adaptive.price, vector["adaptivePrice"], places=9, msg=vector["name"])
            self.assertAlmostEqual(BlackScholesModel(True).price(inputs), vector["blackScholesPrice"], places=10, msg=vector["name"])
            self.assertEqual(adaptive.steps, vector["stepsUsed"], vector["name"])

    def test_contract_selection_exposes_nonconvergence_and_falls_back(self) -> None:
        inputs = PricingInputs(80, 100, 365, 20, 8, 0, "put", "american")
        diagnostics = contract_pricing_diagnostics(
            ticker="SPY", market_mid=20.5, market_iv=20, forecast_volatility=20,
            inputs=inputs, tree_steps=100, tree_tolerance=0.000001,
        )
        self.assertEqual(diagnostics["tree_convergence_status"], "max_steps_reached")
        self.assertEqual(diagnostics["model_used"], "black_scholes_dividend_adjusted")
        self.assertIn("did not converge", diagnostics["pricing_warning"])

    def test_adaptive_crr_respects_bounds_and_strike_monotonicity(self) -> None:
        base = dict(spot=100, dte=30, volatility=25, rate=4, dividend=1, exercise_style="american")
        call_90 = adaptive_crr(PricingInputs(strike=90, option_type="call", **base)).price
        call_100 = adaptive_crr(PricingInputs(strike=100, option_type="call", **base)).price
        put_90 = adaptive_crr(PricingInputs(strike=90, option_type="put", **base)).price
        put_100 = adaptive_crr(PricingInputs(strike=100, option_type="put", **base)).price
        self.assertGreaterEqual(call_90, call_100)
        self.assertLessEqual(call_90, 100)
        self.assertGreaterEqual(put_100, put_90)
        self.assertLessEqual(put_100, 100)

    def test_adaptive_crr_is_monotone_in_maturity_without_dividends(self) -> None:
        for option_type in ("call", "put"):
            short = adaptive_crr(PricingInputs(100, 100, 10, 25, 4, 0, option_type, "american")).price
            long = adaptive_crr(PricingInputs(100, 100, 60, 25, 4, 0, option_type, "american")).price
            self.assertGreaterEqual(long, short - 1e-8)

    def test_discrete_cash_dividends_flow_through_all_supported_models(self) -> None:
        base = PricingInputs(100, 95, 45, 22, 4, 0, "call", "american")
        with_dividend = PricingInputs(
            100, 95, 45, 22, 4, 0, "call", "american",
            discrete_dividends=((20.0, 2.5),),
        )
        no_dividend_value = adaptive_crr(base).price
        crr_value = adaptive_crr(with_dividend).price
        tri_value = TrinomialModel(400, True).price(with_dividend)
        self.assertLess(crr_value, no_dividend_value)
        self.assertAlmostEqual(crr_value, tri_value, delta=0.03)
        self.assertGreaterEqual(
            CRRBinomialModel(400, True).price(with_dividend),
            CRRBinomialModel(400, False).price(with_dividend),
        )
        with self.assertRaisesRegex(ValueError, "does not support discrete cash dividends"):
            BaroneAdesiWhaleyModel().price(with_dividend)

    def test_23_research_engine_contains_no_order_execution(self) -> None:
        from volatility_research import engine, pricing_models
        source = (inspect.getsource(engine) + inspect.getsource(pricing_models)).lower()
        for forbidden in ("submit_order(", "place_order(", "execute_trade(", "buy_shares("):
            self.assertNotIn(forbidden, source)

    def test_fast_baw_approximation_tracks_tree_benchmark(self) -> None:
        inputs = PricingInputs(95, 100, 180, 25, 5, 1, "put", "american")
        tree = CRRBinomialModel(1000, True).price(inputs)
        approximation = BaroneAdesiWhaleyModel().price(inputs)
        self.assertAlmostEqual(approximation, tree, delta=0.08)


class ScannerIntegrationTests(unittest.TestCase):
    def _rank(self, midpoint: float | None = None) -> pd.DataFrame:
        date = pd.Timestamp("2026-08-05")
        inputs = PricingInputs(80, 100, 30, 25, 5, 0, "put", "american")
        mid = midpoint if midpoint is not None else CRRBinomialModel(200, True).price(inputs)
        forecasts = pd.DataFrame([{
            "ticker": "TEST", "date": date, "horizon": 10, "model": "best_model",
            "model_used": "ewma", "forecast_vol": 30.0, "lambda_used": 0.94,
            "weights_used": None, "future_realized_vol": np.nan,
        }])
        options = pd.DataFrame([{
            "ticker": "TEST", "date": date, "expiration": date + pd.Timedelta(days=30),
            "dte": 30, "option_type": "put", "strike": 100, "market_iv": 25.0,
            "market_mid": mid, "last_price": mid, "bid": max(mid - 0.05, 0.01), "ask": mid + 0.05,
            "volume": 500, "open_interest": 2000, "spot": 80, "rate": 5, "dividend": 0,
            "option_style": "american", "instrument_type": "equity",
        }])
        return rank_option_contracts(options, forecasts, tree_steps=75)

    def test_scanner_emits_full_multi_model_schema(self) -> None:
        ranked = self._rank()
        expected = {
            "bs_market_iv_fair_value", "bs_forecast_vol_fair_value",
            "american_market_iv_fair_value", "american_forecast_vol_fair_value",
            "selected_model_fair_value", "early_exercise_premium", "black_scholes_iv",
            "american_model_iv", "price_edge_bs", "price_edge_american",
            "edge_after_spread_bs", "edge_after_spread_american", "model_used",
            "model_reason", "pricing_warning", "model_confidence",
        }
        self.assertTrue(expected.issubset(ranked.columns))
        self.assertEqual(len(ranked), 1)

    def test_20_scanner_falls_back_when_american_iv_solver_fails(self) -> None:
        ranked = self._rank(midpoint=19.0)
        self.assertEqual(ranked.loc[0, "iv_solver_status"], "failed")
        self.assertIn("IV solver failed", ranked.loc[0, "pricing_warning"])
        self.assertIn("black_scholes", ranked.loc[0, "model_used"])


if __name__ == "__main__":
    unittest.main()
