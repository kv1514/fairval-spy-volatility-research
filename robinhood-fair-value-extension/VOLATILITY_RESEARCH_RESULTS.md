# Walk-forward variance research results — v2.2.0

## August 12, 2026 SPY forecast upgrade

FairVal now adds variance-targeted GARCH(1,1), asymmetric GJR-GARCH, simple forecast combination, a shrunk convex forecast regression, QLIKE loss, and Mincer-Zarnowitz calibration diagnostics. The daily source was refreshed through the August 11 completed close; the live payload is therefore no longer stale on August 12.

On the full strictly walk-forward SPY evaluation, GJR-GARCH produced the lowest single-model variance MSE at horizons 1, 2, 3, 5, and 10. The rolling selector chose GJR-GARCH for the current 1–5 day forecasts and retained HAR-RV for 10 days because selection depends only on its rolling past window, not on the full evaluation period.

| Horizon | Current selected model | Current forecast | GJR variance MSE | Previous benchmark variance MSE | Reduction |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | GJR-GARCH | 11.88% | 0.008709 | 0.009303 (EWMA) | 6.4% |
| 2 | GJR-GARCH | 11.98% | 0.010515 | 0.011292 (EWMA) | 6.9% |
| 3 | GJR-GARCH | 12.07% | 0.004869 | 0.005581 (EWMA) | 12.8% |
| 5 | GJR-GARCH | 12.24% | 0.003411 | 0.003651 (HAR-RV) | 6.6% |
| 10 | HAR-RV | 11.04% | 0.002154 | 0.002211 (HAR-RV) | 2.6% |

These are model-accuracy comparisons, not option returns. The current option snapshot still dates to August 5, so its candidate rankings are retained as pipeline diagnostics and must not be interpreted as live opportunities.

## Prior SPY-only version 2.1 benchmark

The bundled extension payload is now restricted to SPY. It uses 1,150 daily observations from January 3, 2022 through August 4, 2026, requires 252 completed targets before tuning, uses a rolling 756-target training window, and rebalances parameters every 21 forecast dates. The newest candidate model is a ridge-stabilized log-HAR variance forecast.

| Horizon | Selected model | Latest forecast | Selected-model OOS variance MSE |
| ---: | --- | ---: | ---: |
| 1 | EWMA | 17.80% | 0.009303 |
| 2 | EWMA | 20.14% | 0.011293 |
| 3 | EWMA | 20.34% | 0.005581 |
| 5 | HAR-RV | 11.66% | 0.003651 |
| 10 | HAR-RV | 12.92% | 0.002211 |

These were forecast-accuracy results, not trading returns. The version 2.1 August 4 payload became stale on August 11; version 2.2 refreshes the daily close through August 11.

## Earlier multi-ticker benchmark

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
