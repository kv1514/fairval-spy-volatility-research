# Walk-forward volatility research engine

This package turns daily underlying prices into leakage-safe volatility forecasts and then translates those forecasts into option research fields. It deliberately does **not** optimize trading profit and does not treat a large modeled edge as a trade instruction.

## Forecasts

For each ticker, daily log returns are:

```text
r_t = ln(close_t / close_(t-1))
```

Annualized realized volatility is expressed in percent. The engine evaluates horizons `1, 2, 3, 5, 10` trading days and creates these model rows:

- `realized_5`, `realized_10`, `realized_20`, and `realized_60` — named realized-volatility baselines
- `fixed_blend`, with variance weights `0.40, 0.30, 0.20, 0.10` on the 5/10/20/60 windows
- `optimized_blend` — a **dense** variance blend fitted by projected-gradient descent over the full candidate window set, with nonnegative weights that sum to one
- `sparse_blend` — a **sparse** variance blend built by greedy forward selection; it adds one window at a time only while training variance MSE keeps improving, is capped at `sparse_max_terms` windows (default 3), and drops any weight below `weight_zero_threshold` (`1e-8`) so unused windows carry exactly zero weight
- `ewma`, with lambda selected from a coarse `0.70..0.99` grid and a `0.001` fine grid around the coarse winner
- `best_model`, selected by past out-of-sample variance MSE for that ticker and horizon:

```text
mean(((forecast_vol / 100)^2 - (future_realized_vol / 100)^2)^2)
```

### Flexible candidate windows

The blends do **not** rely on four hardcoded windows. `ForecastConfig.vol_windows` supplies a broad candidate set — `1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 45, 60` by default — and the optimizer and sparse selector decide out of sample which windows actually help. The set is configurable and can be extended toward 100D. The 1-day window uses the `abs(return) * sqrt(252)` proxy because a one-observation sample standard deviation is undefined. Both blend optimizers minimize error in annualized **variance** (options are more directly linked to variance than to volatility) and are deterministic functions of the training slice, so the walk-forward leakage guarantee holds. The diagnostics report prints each latest blend as a readable formula, for example `sqrt(0.57*vol_60² + 0.26*vol_3² + 0.10*vol_20² + 0.08*vol_7²)`.

### Pricing models and Greeks

`pricing_models.py` separates the volatility forecast from the price engine. Every model exposes `price(inputs)` and `greeks(inputs)`; `implied_volatility(target_price, pricing_model, inputs)` accepts any monotone model and returns convergence status, iterations, residual, and a failure reason.

Implemented models:

- `black_scholes_european`: the no-dividend European baseline.
- `black_scholes_dividend_adjusted`: European Black–Scholes with continuous yield `q`.
- `binomial_american_crr`: Cox–Ross–Rubinstein with early exercise at every node.
- `trinomial_american`: a recombining up/middle/down tree and independent lattice cross-check.
- `american_approximation_baw`: Barone-Adesi/Whaley fast approximation with a numerically bracketed critical boundary.

Finite-difference and Longstaff–Schwartz Monte Carlo were deliberately not added to this vanilla continuous-yield path: they would expand numerical and stochastic validation scope without improving the current scanner's explainability. The generic interface leaves room for either model later.

American nodes use `max(discounted risk-neutral continuation, intrinsic)`. European nodes use continuation only. CRR and trinomial also expose practical lattice delta, gamma, theta, exercise-boundary samples, same-tree early-exercise premium, runtime, steps, and convergence diagnostics. Vega and rho use small model-consistent finite differences.

Contract style is configurable. Explicit broker style wins. The default map identifies SPX/SPXW/XSP as European indexes and SPY/QQQ/IWM as American ETFs. A supplied `equity`, `stock`, or `etf` instrument type resolves to American. Every inference is warned; an unresolved contract uses `unknown_style_black_scholes_fallback`.

For American contracts, FairVal calculates CRR and trinomial values under market IV and forecast volatility. CRR becomes the selected model only when the estimated early-exercise premium is material, the tree values agree, and American midpoint IV solves. Negligible premium retains dividend-adjusted Black–Scholes for speed and stability. Solver or convergence failures fall back with an explicit reason.

`black_scholes_greeks` returns delta, gamma, theta (per calendar day), vega (per one volatility point), and rho (per one rate point). Gamma and vega are identical for a call and a put; delta, theta, and rho depend on the option type. All five greeks are written to `option_rankings.csv`.

The `h=1` sample standard deviation is undefined. The implementation uses the standard one-day realized-volatility proxy `abs(next_return) * sqrt(252)` for that target. Horizons above one use sample standard deviation (`ddof=1`) over exactly the next `h` returns.

## Leakage controls

At a forecast origin `t`:

- rolling-volatility inputs use returns through `t`, never after `t`;
- a training row is eligible only when its entire target window ended on or before `t`;
- blend weights, EWMA lambda, and model selection are fitted only on eligible completed targets;
- parameters rebalance at the configured cadence and remain frozen between rebalances;
- final error metrics use the forecasts already emitted at each origin, not refitted in-sample values.

The tests compare a full history with a history physically truncated at `t`; every forecast and model selection at `t` must remain identical.

## Input CSVs

Prices require:

```text
ticker,date,close
```

Option quotes require:

```text
ticker,date,expiration,dte,option_type,strike,market_iv,bid,ask,volume,open_interest,spot
```

Optional option columns are `market_mid`, `rate`, and `dividend`. `market_iv` may be decimal (`0.20`) or percent (`20`); auto-detection treats a column median at or below `1.5` as decimal, so unusually high decimal-IV datasets should be converted to percent explicitly. Rate and dividend inputs are explicitly percent (`4.25`, not `0.0425`). If `market_mid` is absent, bid/ask midpoint is used.

Historical surface context uses the same option schema and is supplied with `--surface-history`. Percentiles are computed only from dates strictly before the ranked contract, grouped by ticker, option type, DTE bucket, and log-moneyness bucket. Calls and puts are separate so normal downside put skew is not automatically labeled rich volatility.

## Run

From the extension directory:

```powershell
python -m volatility_research.cli `
  --prices data/robinhood-daily-2022-2026.csv `
  --options data/robinhood-options-snapshot-2026-08-05.csv `
  --surface-history data/spy-option-surface-history-2026.csv `
  --output-dir volatility-research-output `
  --min-train 30 `
  --training-window 252 `
  --rebalance-every 5
```

Use `--training-window 0` for expanding rather than rolling training. The command writes:

- `forecasts.csv`: every model/ticker/date/horizon forecast and completed target
- `evaluation.csv`: MAE, RMSE, variance MSE, and directional accuracy when timestamp-aligned market IV history is supplied
- `option_rankings.csv`: required contract DataFrame plus executable-edge and liquidity fields
- `ewma_lambda_performance.csv`, `blend_weights_history.csv`, and `model_selection_history.csv`
- `model_diagnostics.csv`: optimized blend, sparse blend, EWMA, realized-20, and realized-60 variance errors by ticker, horizon, and available moneyness bucket, with exactly one winner marked per group
- `threshold_study.csv`: forecast-reliability sweep — for each minimum `|forecast_vol - market_iv|` gap it reports observation count, coverage, directional accuracy versus market IV, and variance skill versus simply trusting market IV. It answers "does a bigger gap mean a more reliable signal?" empirically and is a research diagnostic, **not** a buy/sell threshold. It needs a historical market-IV series (`--surface-history`), so it only covers tickers with supplied option history.
- `latest_forecasts.json`: compact `volatility_forecast.v1` bridge for the Chrome extension
- `variance_diagnostics_report.html`: standalone diagnostics and current research queue
- `pricing_diagnostics_report.html`: interactive per-contract inputs, model prices, model IVs, selection reason, warnings, and CRR/trinomial 50/100/250/500/1000-step convergence tables
- six SVG charts and a local `visualizations/index.html` dashboard

## Extension bridge

Open the extension popup, import `latest_forecasts.json`, choose **Walk-forward forecast JSON**, and apply. For the visible option DTE, the overlay chooses the nearest forecast horizon. It uses that forecast as the ATM volatility level while retaining the live relative strike skew, then continues refreshing Robinhood Mark/IV values at the configured interval.

The daily forecast is intentionally slower-moving than the live quote. Re-run the Python job after a new official daily close and import the new compact JSON. Live Mark, IV, spread, volume, and open interest continue updating independently on Robinhood.

## Contract output

The ranking table distinguishes market data, circular market-IV diagnostics, independent forecast-volatility values, and the selected model:

```text
ticker, underlying_price, date, expiration, dte, option_type, strike,
bid, ask, market_mid, last_price, market_iv, black_scholes_iv,
american_model_iv, forecast_volatility, bs_market_iv_fair_value,
bs_forecast_vol_fair_value, american_market_iv_fair_value,
american_forecast_vol_fair_value, selected_model_fair_value,
early_exercise_premium, price_edge_bs, price_edge_american,
edge_after_spread_bs, edge_after_spread_american, vol_edge,
implied_variance, forecast_variance, variance_edge, delta, gamma,
theta, vega, rho, american_delta, american_gamma, spread, spread_pct,
volume, open_interest, model_used, model_reason, model_confidence,
pricing_warning, data_quality_warning, forecast_model_used,
lambda_used, weights_used
```

The Haugh short-option/delta-hedge approximation is:

```text
P&L ≈ 0.5 * S^2 * gamma * (implied_variance - realized_variance) * T
```

`gamma_weighted_edge` uses market-IV gamma and annualized decimal variance. Its positive sign supports short-vol research; the long-vol sign is the inverse. The ranking also includes ATM IV, contract IV minus ATM, skew slope, 1/2/5/10D term fields, historical IV percentile, `edge_after_bid_ask`, liquidity gates, and the matched historical bucket. These are research prioritization aids, not trade instructions.

`bs_market_iv_fair_value` and `american_market_iv_fair_value` are diagnostics: feeding market IV back into a compatible model should reproduce the market price up to model/style/input differences. The research edge is `forecast-volatility fair value - market midpoint`. Spread-adjusted edge is measured against the executable side of the quote and is reduced by liquidity and model-confidence gates.

## Theory and limitations

Black–Scholes values European exercise. American contracts can be exercised before expiration, so the holder owns an additional optimal-stopping right; its value cannot be negative. A lattice represents the replicating/no-arbitrage logic used to price that right, but FairVal does not buy shares, submit orders, or execute a delta hedge.

American IV can differ from Black–Scholes IV because each solver asks a different pricing function to reproduce the same midpoint. The difference is most relevant for deep-ITM puts, dividend-sensitive calls, and short-dated ITM contracts. It is not a separate volatility forecast.

Remaining risks include continuous-yield rather than discrete-dividend modeling, missing ex-dividend calendars, early-exercise uncertainty, approximation and lattice convergence error, volatility-surface dynamics, stale or bad IV data, bid/ask spread, liquidity, slippage, earnings and other event jumps, and realized-volatility forecast error. The scanner describes a potential pricing discrepancy under model assumptions and never a guaranteed mispricing.
