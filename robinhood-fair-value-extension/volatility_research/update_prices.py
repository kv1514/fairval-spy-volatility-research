"""Append completed SPY daily closes from Robinhood's public historical feed."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen

import pandas as pd


ROBINHOOD_DAILY_URL = "https://api.robinhood.com/quotes/historicals/SPY/?interval=day&span=year&bounds=regular"


def fetch_spy_daily() -> pd.DataFrame:
    request = Request(ROBINHOOD_DAILY_URL, headers={"User-Agent": "FairVal-SPY-Research/2.2"})
    with urlopen(request, timeout=30) as response:  # noqa: S310 - fixed HTTPS endpoint
        payload = json.load(response)
    rows = []
    for bar in payload.get("historicals", []):
        if bool(bar.get("interpolated")) or str(bar.get("session", "reg")) != "reg":
            continue
        rows.append({
            "ticker": "SPY",
            "date": pd.Timestamp(bar["begins_at"]).date().isoformat(),
            "close": float(bar["close_price"]),
            "source": "robinhood_equity_day",
        })
    if not rows:
        raise RuntimeError("Robinhood returned no completed SPY daily bars")
    return pd.DataFrame(rows)


def update_price_file(path: str | Path) -> pd.DataFrame:
    target = Path(path)
    fresh = fetch_spy_daily()
    fresh = fresh.sort_values("date").drop_duplicates(["ticker", "date"], keep="last")

    if target.exists():
        # Preserve the original byte representation of every existing row.  Rewriting
        # the mixed SPY/QQQ/SPX archive would create a noisy whole-file diff merely
        # because older sources used different decimal precision.
        existing = pd.read_csv(target)
        existing_dates = set(
            existing.loc[existing["ticker"].astype(str).str.upper() == "SPY", "date"].astype(str)
        )
        additions = fresh.loc[~fresh["date"].isin(existing_dates)].copy()
        if not additions.empty:
            additions.to_csv(
                target,
                mode="a",
                header=False,
                index=False,
                float_format="%.6f",
                lineterminator="\r\n",
            )
        combined = pd.concat([existing, additions], ignore_index=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        fresh.to_csv(target, index=False, float_format="%.6f", lineterminator="\r\n")
        combined = fresh

    combined["ticker"] = combined["ticker"].astype(str).str.upper().str.strip()
    combined["date"] = pd.to_datetime(combined["date"]).dt.date.astype(str)
    combined["close"] = pd.to_numeric(combined["close"], errors="raise")
    combined = combined.sort_values(["ticker", "date"]).drop_duplicates(["ticker", "date"], keep="last")
    return combined


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh completed SPY daily closes")
    parser.add_argument("--prices", default="data/robinhood-daily-2022-2026.csv")
    args = parser.parse_args()
    frame = update_price_file(args.prices)
    spy = frame[frame["ticker"] == "SPY"]
    print(f"SPY daily closes: {len(spy):,}; latest completed date: {spy['date'].max()}")


if __name__ == "__main__":
    main()
