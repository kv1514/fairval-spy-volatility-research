# Walk-forward volatility research results — v1.4.0

## Run completed

The included demonstration uses 3,449 non-interpolated daily Robinhood bars:

| Ticker | Observations | Start | End |
| --- | ---: | --- | --- |
| QQQ | 1,150 | 2022-01-03 | 2026-08-04 |
| SPX | 1,149 | 2022-01-03 | 2026-08-04 |
| SPY | 1,150 | 2022-01-03 | 2026-08-04 |

Configuration: 30 completed targets before tuning, rolling 252-target training window, parameters rebalanced every five forecast dates, and horizons `1, 2, 3, 5, 10`.

## Strictly out-of-sample best-model errors

| Horizon | Completed forecasts | MAE (vol pts) | RMSE (vol pts) | Variance MSE |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 3,266 | 10.430 | 14.172 | 0.012290 |
| 2 | 3,263 | 10.024 | 13.842 | 0.014093 |
| 3 | 3,260 | 7.963 | 11.223 | 0.007109 |
| 5 | 3,254 | 6.600 | 9.723 | 0.005329 |
| 10 | 3,239 | 5.952 | 9.173 | 0.003895 |

The much larger one-day error is expected in part because one-day realized volatility is a noisy absolute-return proxy rather than a sample standard deviation. Model comparisons should therefore be made within a horizon, not by assuming the error scales are interchangeable.

## Latest forecast payload

As of the August 4, 2026 daily bars:

| Ticker | h=1 | h=2 | h=3 | h=5 | h=10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| QQQ | 26.77% | 26.19% | 26.19% | 27.74% | 26.77% |
| SPX | 14.98% | 14.07% | 14.07% | 14.07% | 14.07% |
| SPY | 15.27% | 14.86% | 15.51% | 15.21% | 14.25% |

The selected models differ by ticker and horizon; this is the intended result of walk-forward model selection rather than one globally fitted rule.

## Live option snapshot

The example ranking file contains 54 near-the-money Robinhood contracts—nine calls and nine puts for each of SPY, QQQ, and SPX—with an August 10, 2026 expiration. Quotes were refreshed around 19:37 UTC on August 5, 2026. The option snapshot is for output validation only: its future realized-volatility target had not occurred at capture time, so it cannot establish whether any displayed edge was correct or profitable.

The ranking uses market Mark, bid/ask, volume, open interest, a 3.78% short-rate input, and documented ETF/index yield assumptions from the extension. A large `vol_edge` survives to a research bucket only after executable bid/ask and liquidity checks, but still requires event, jump, American-exercise, dividend, and fill-risk review.

## What this run does and does not prove

It proves that the requested forecasts, nested walk-forward selection, option DataFrame, charts, and no-lookahead invariants run end to end on multi-year broker data. It does not prove a profitable options strategy. Profit optimization, delta hedging, slippage, fees, and timestamp-aligned historical option quotes remain intentionally outside this accuracy-first stage.
