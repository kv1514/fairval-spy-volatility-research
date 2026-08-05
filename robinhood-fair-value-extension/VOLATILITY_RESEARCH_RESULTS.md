# Walk-forward variance research results — v1.5.0

## Run completed

The included demonstration uses 3,449 non-interpolated daily Robinhood bars:

| Ticker | Observations | Start | End |
| --- | ---: | --- | --- |
| QQQ | 1,150 | 2022-01-03 | 2026-08-04 |
| SPX | 1,149 | 2022-01-03 | 2026-08-04 |
| SPY | 1,150 | 2022-01-03 | 2026-08-04 |

Configuration: 252 completed targets before tuning, rolling 756-target training window, parameters rebalanced every 21 forecast dates, horizons `1, 2, 3, 5, 10`, and model selection minimized past out-of-sample variance MSE.

## Strictly out-of-sample best-model errors

| Horizon | Completed forecasts | MAE (vol pts) | RMSE (vol pts) | Variance MSE |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 3,266 | 10.529 | 14.103 | 0.011978 |
| 2 | 3,263 | 9.850 | 13.556 | 0.013251 |
| 3 | 3,260 | 7.731 | 10.983 | 0.006648 |
| 5 | 3,254 | 6.644 | 9.766 | 0.004808 |
| 10 | 3,239 | 6.047 | 8.997 | 0.003161 |

The much larger one-day error is expected in part because one-day realized volatility is a noisy absolute-return proxy rather than a sample standard deviation. Model comparisons should therefore be made within a horizon, not by assuming the error scales are interchangeable.

## Latest forecast payload

As of the August 4, 2026 daily bars:

| Ticker | h=1 | h=2 | h=3 | h=5 | h=10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| QQQ | 29.24% | 32.80% | 32.33% | 28.35% | 23.80% |
| SPX | 17.72% | 20.30% | 20.80% | 16.27% | 14.31% |
| SPY | 17.80% | 20.14% | 20.34% | 15.97% | 14.54% |

The selected models differ by ticker and horizon; this is the intended result of walk-forward model selection rather than one globally fitted rule.

## Live option snapshot

The example ranking file contains 54 near-the-money Robinhood contracts—nine calls and nine puts for each of SPY, QQQ, and SPX—with an August 10, 2026 expiration. Quotes were refreshed around 19:37 UTC on August 5, 2026. The option snapshot is for output validation only: its future realized-volatility target had not occurred at capture time, so it cannot establish whether any displayed edge was correct or profitable.

The ranking uses market Mark, bid/ask, volume, open interest, a 3.78% short-rate input, and documented ETF/index yield assumptions. It now compares implied and forecast variance, scales the difference by market-IV dollar gamma and time, and reports price edge normalized by vega. A strongest-tier row requires price/volatility sign agreement, executable spread and liquidity gates, and the proper historical ticker/option-type/DTE/moneyness bucket.

The included SPY replay produced 99 prior observations in each matching 5-DTE ATM call/put bucket. It does not include QQQ or SPX option histories, so their current contracts remain unbenchmarked and cannot enter the strongest tier. Five SPY calls entered the strongest research tier in this point-in-time snapshot; these are candidates for study, not trading recommendations or validated outcomes.

## What this run does and does not prove

It proves that the requested forecasts, nested walk-forward variance selection, Haugh-sign contract fields, skew-aware surface context, diagnostics, charts, and no-lookahead invariants run end to end. It does not prove a profitable options strategy. The historical surface replay uses daily-final last trades rather than historical NBBO; delta-hedging slippage, fees, jumps, changing gamma, early exercise, and fill quality remain outside this accuracy-first stage.
