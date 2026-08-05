# Robinhood SPY Replay — v1.3.0

## Bottom line

The larger replay did **not** find a reliable buy/sell rule. Both the cross-strike relative-value signal and a simple realized-volatility forecast lost money in the held-out check after conservative cost haircuts. The correct product behavior is therefore to surface and record research candidates, not issue trade instructions.

## Data coverage

- Source: direct Robinhood option- and equity-historical endpoints
- Underlying: SPY
- Expirations: 12 weeklies from May 15 through July 31, 2026
- Contracts: 264 total — 132 calls and 132 puts
- Strikes: 11 near-money strikes per expiration and option type
- Option bars: 7,524 hourly trade-price OHLC bars
- Underlying bars: 636 hourly OHLCV bars
- Time-aligned next-hour outcomes: 5,379
- Forecast training set: first eight expirations through July 2
- Untouched forecast holdout: July 10, 17, 24, and 31

The fixed source fixture is `tests/fixtures/spy-may-july-2026-hourly.json`; `tests/robinhood-replay.mjs` reproduces the calculations.

## Non-lookahead replay design

1. At the end of hour `t`, infer a separate market IV for every contract from its trade close.
2. Estimate the strike smile with the same robust leave-one-out fitter used by the extension.
3. For the independent-volatility model, forecast ATM realized volatility using only SPY bars earlier than `t`, then preserve the contemporaneous market skew around that new ATM level.
4. Form the signal only after hour `t` completes.
5. Use the first option trade in hour `t+1` as the entry proxy and the last trade in that hour as the exit proxy.
6. Remove the first-order underlying move with the signal-time Black–Scholes delta.
7. Apply all-in cost sensitivities of `max($0.05, entry premium × 0%/5%/10%/20%)`.

This prevents a same-bar/look-ahead fill, but it is still a trade-bar replay rather than an executable NBBO backtest.

## Forecast selection

Forecasts were selected only on the first eight expirations. Lower error is better; errors are annualized volatility points.

| Forecast | Training MAE | Holdout MAE | Training bias | Holdout bias |
| --- | ---: | ---: | ---: | ---: |
| 5-day historical vol | 6.20 | 6.38 | -3.24 | -3.64 |
| 10-day historical vol | 5.67 | 5.63 | -3.11 | -3.79 |
| **20-day historical vol — selected** | **5.47** | 5.71 | -3.53 | -2.72 |
| 50/50 5-day + 20-day | 5.61 | 5.68 | -3.38 | -3.18 |

The 20-day model won on the training set and was locked before the four-expiration holdout was examined. The negative bias shows that simple historical volatility generally sat below subsequently realized volatility in this sample; that is one reason raw “IV above historical vol” is not enough to sell options.

## Signal results

Option P&L below is in option-price points; multiply by 100 for one standard contract. It is delta-hedged in the replay and excludes stock-hedging costs.

### Existing relative-smile screen, all 12 expirations

At a 10% modeled price edge:

| Cost assumption | Signals | Mean P&L | Median P&L | Positive outcomes |
| --- | ---: | ---: | ---: | ---: |
| 5¢ all-in floor only | 707 | -0.044 | -0.054 | 36.6% |
| 10% premium / 5¢ floor | 707 | -0.265 | -0.159 | 23.5% |

### Selected realized-vol forecast, final four-expiration holdout

At a 10% modeled price edge:

| Cost assumption | Signals | Mean P&L | Median P&L | Positive outcomes |
| --- | ---: | ---: | ---: | ---: |
| 5¢ all-in floor only | 1,243 | -0.119 | -0.055 | 37.2% |
| 5% premium / 5¢ floor | 1,243 | -0.247 | -0.138 | 25.0% |
| 10% premium / 5¢ floor | 1,243 | -0.418 | -0.250 | 16.5% |
| 20% premium / 5¢ floor | 1,243 | -0.763 | -0.517 | 6.7% |

Raising the required price edge to 30% did not rescue the holdout: the 5¢-floor mean P&L was `-0.088`, and the 10% cost case was `-0.285` across 728 observations.

## What changed in the extension

- Exact Robinhood Mark/IV refresh runs continuously while a chain is open.
- `Own forecast + market skew` explicitly separates the user's ATM realized-volatility forecast from market IV while retaining the live strike skew.
- Every badge shows per-contract market IV, fair/model IV, and `IV EDGE`.
- Exact live snapshots and 15/60-minute forward paper outcomes are recorded locally and can be exported from the popup.
- Flags remain research candidates. No threshold is represented as historically profitable.

## Important limitations

- Robinhood's historical option bars are trades, not historical bid, ask, NBBO, size, or queue position.
- A bar's first or last trade may be stale or may have occurred on the favorable side of the spread.
- The cost haircuts are sensitivity assumptions, not observed spreads.
- Signals across adjacent hours and strikes are correlated; raw observation counts are not independent sample sizes.
- The test omits option-leg depth, stock-hedge transaction costs, fees, assignment, early exercise, taxes, halts, and portfolio/margin constraints.
- The volatility forecasts are deliberately simple. Event calendars, volatility-risk-premium adjustments, term structure, skew dynamics, and regime conditioning require more data and a separate untouched test period.

The live paper recorder is the next validation layer because it captures the exact bid/ask and IV visible at signal time. It still cannot guarantee a fill, but it is materially closer to an executable test than trade-bar history.
