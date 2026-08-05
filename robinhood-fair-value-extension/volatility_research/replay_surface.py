"""Build screen-grade historical IV buckets from the included Robinhood replay."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .black_scholes import black_scholes_greeks, implied_volatility_percent


def build_surface_history(
    fixture_path: str | Path,
    rate_percent: float = 3.8,
    dividend_percent: float = 0.0,
) -> pd.DataFrame:
    fixture = json.loads(Path(fixture_path).read_text(encoding="utf-8"))
    ticker = str(fixture.get("symbol", "SPY")).upper()
    underlying = pd.DataFrame(fixture["underlying"]).rename(columns={"t": "quote_time", "c": "spot"})
    underlying["quote_time"] = pd.to_datetime(underlying["quote_time"], utc=True)
    underlying["spot"] = pd.to_numeric(underlying["spot"], errors="coerce")
    underlying = underlying[["quote_time", "spot"]].dropna().sort_values("quote_time")

    option_rows: list[dict] = []
    for contract in fixture["contracts"]:
        bars = pd.DataFrame(contract.get("bars", []))
        if bars.empty:
            continue
        bars["quote_time"] = pd.to_datetime(bars["t"], utc=True)
        bars["date"] = bars["quote_time"].dt.tz_convert("America/New_York").dt.tz_localize(None).dt.normalize()
        bars["market_mid"] = pd.to_numeric(bars["c"], errors="coerce")
        daily = bars.sort_values("quote_time").groupby("date", as_index=False).tail(1)
        for bar in daily.itertuples(index=False):
            option_rows.append({
                "ticker": ticker,
                "date": bar.date,
                "quote_time": bar.quote_time,
                "expiration": contract["expiration"],
                "option_type": str(contract["type"]).lower(),
                "strike": float(contract["strike"]),
                "market_mid": float(bar.market_mid),
                "contract_id": contract["id"],
            })
    options = pd.DataFrame(option_rows).sort_values("quote_time")
    options = pd.merge_asof(options, underlying, on="quote_time", direction="backward", tolerance=pd.Timedelta("2h"))
    options["expiration"] = pd.to_datetime(options["expiration"]).dt.normalize()
    options["dte"] = (options["expiration"] - options["date"]).dt.days.clip(lower=1)
    options["rate"] = float(rate_percent)
    options["dividend"] = float(dividend_percent)
    options = options.dropna(subset=["spot", "market_mid"])
    options = options[options["market_mid"] >= 0.01]

    options["market_iv"] = [
        implied_volatility_percent(
            market_price=row.market_mid,
            spot=row.spot,
            strike=row.strike,
            dte=row.dte,
            option_type=row.option_type,
            rate_percent=rate_percent,
            dividend_percent=dividend_percent,
        )
        for row in options.itertuples(index=False)
    ]
    options = options.replace([np.inf, -np.inf], np.nan).dropna(subset=["market_iv"])
    options = options[options["market_iv"].between(1.0, 300.0)]
    greeks = black_scholes_greeks(
        options["spot"], options["strike"], options["dte"], options["market_iv"],
        options["rate"], options["dividend"],
    )
    options["vega"] = greeks["vega"]
    options = options[options["vega"] >= 0.001]
    options["source"] = "Robinhood hourly last-trade replay; IV inverted from daily final trade"
    columns = [
        "ticker", "date", "quote_time", "expiration", "dte", "option_type", "strike",
        "market_iv", "market_mid", "spot", "rate", "dividend", "vega", "contract_id", "source",
    ]
    return options[columns].sort_values(["date", "expiration", "option_type", "strike"]).reset_index(drop=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert the Robinhood replay fixture to historical IV buckets")
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--rate", type=float, default=3.8)
    parser.add_argument("--dividend", type=float, default=0.0)
    args = parser.parse_args()
    history = build_surface_history(args.fixture, args.rate, args.dividend)
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    history.to_csv(target, index=False)
    print(f"wrote {len(history):,} surface observations to {target.resolve()}")


if __name__ == "__main__":
    main()
