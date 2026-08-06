"""Command-line runner for leakage-safe volatility research."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from .engine import (
    ForecastConfig,
    VolatilityResearchEngine,
    diagnose_models_by_moneyness,
    evaluate_forecasts,
    json_safe_frame,
    latest_forecast_payload,
    rank_option_contracts,
    threshold_sensitivity_study,
)
from .reports import write_variance_diagnostics_report
from .visualizations import write_visualizations


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Walk-forward volatility forecasts and option mispricing research")
    parser.add_argument("--prices", required=True, help="CSV with ticker,date,close")
    parser.add_argument("--options", help="Optional CSV of dated option quotes")
    parser.add_argument("--surface-history", help="Optional historical option IV CSV for DTE/moneyness percentiles")
    parser.add_argument("--output-dir", default="volatility-research-output")
    parser.add_argument("--min-train", type=int, default=30)
    parser.add_argument("--training-window", type=int, default=252, help="Completed targets kept in each training window; 0 means expanding")
    parser.add_argument("--rebalance-every", type=int, default=5)
    parser.add_argument("--min-volume", type=float, default=10)
    parser.add_argument("--min-open-interest", type=float, default=100)
    return parser


def run(args: argparse.Namespace) -> dict[str, Path]:
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    prices = pd.read_csv(args.prices)
    config = ForecastConfig(
        min_train_observations=args.min_train,
        training_window=None if args.training_window == 0 else args.training_window,
        rebalance_every=max(args.rebalance_every, 1),
    )
    engine = VolatilityResearchEngine(config)
    forecasts = engine.fit_predict(prices)
    options = pd.read_csv(args.options) if args.options else pd.DataFrame()
    surface_history = pd.read_csv(args.surface_history) if args.surface_history else pd.DataFrame()
    market_iv = options[["ticker", "date", "dte", "market_iv"]].copy() if not options.empty else None
    evaluation = evaluate_forecasts(forecasts, market_iv=market_iv, horizons=config.horizons)
    rankings = rank_option_contracts(
        options,
        forecasts,
        surface_history=surface_history,
        minimum_volume=args.min_volume,
        minimum_open_interest=args.min_open_interest,
    ) if not options.empty else pd.DataFrame()
    diagnostics = diagnose_models_by_moneyness(
        forecasts,
        option_history=surface_history if not surface_history.empty else None,
        horizons=config.horizons,
    )
    # A historical market-IV time series (the surface history) is required to
    # study how forecast reliability changes with the volatility gap.
    threshold_market_iv = surface_history if not surface_history.empty else (
        options[["ticker", "date", "dte", "market_iv"]] if not options.empty else None
    )
    threshold_study = (
        threshold_sensitivity_study(forecasts, threshold_market_iv, horizons=config.horizons)
        if threshold_market_iv is not None else pd.DataFrame()
    )

    paths = {
        "forecasts": output / "forecasts.csv",
        "evaluation": output / "evaluation.csv",
        "rankings": output / "option_rankings.csv",
        "lambda_curve": output / "ewma_lambda_performance.csv",
        "weights": output / "blend_weights_history.csv",
        "model_selection": output / "model_selection_history.csv",
        "diagnostics": output / "model_diagnostics.csv",
        "threshold_study": output / "threshold_study.csv",
        "diagnostics_report": output / "variance_diagnostics_report.html",
        "latest_json": output / "latest_forecasts.json",
    }
    json_safe_frame(forecasts).to_csv(paths["forecasts"], index=False)
    evaluation.to_csv(paths["evaluation"], index=False)
    json_safe_frame(rankings).to_csv(paths["rankings"], index=False)
    json_safe_frame(engine.lambda_performance_).to_csv(paths["lambda_curve"], index=False)
    json_safe_frame(engine.weights_history_).to_csv(paths["weights"], index=False)
    json_safe_frame(engine.model_selection_history_).to_csv(paths["model_selection"], index=False)
    diagnostics.to_csv(paths["diagnostics"], index=False)
    threshold_study.to_csv(paths["threshold_study"], index=False)
    paths["latest_json"].write_text(
        json.dumps(latest_forecast_payload(
            forecasts,
            surface_history=surface_history if not surface_history.empty else None,
        ), indent=2),
        encoding="utf-8",
    )
    write_variance_diagnostics_report(
        paths["diagnostics_report"], diagnostics, rankings, forecast_rows=len(forecasts),
        weights_history=engine.weights_history_, threshold_study=threshold_study,
    )
    write_visualizations(output / "visualizations", forecasts, evaluation, engine.lambda_performance_, engine.weights_history_, rankings)
    return paths


def main() -> None:
    args = _parser().parse_args()
    paths = run(args)
    print(f"Completed walk-forward research run: {Path(args.output_dir).resolve()}")
    for label, path in paths.items():
        print(f"  {label}: {path.resolve()}")


if __name__ == "__main__":
    main()
