# Walk-forward volatility research engine

This package turns daily underlying prices into leakage-safe volatility forecasts and then translates those forecasts into option research fields. It deliberately does **not** optimize trading profit and does not treat a large modeled edge as a trade instruction.

## Forecasts

For each ticker, daily log returns are:

```text
r_t = ln(close_t / close_(t-1))
```

Annualized realized volatility is expressed in percent. The engine evaluates horizons `1, 2, 3, 5, 10` trading days and creates these model rows:

- `realized_5`, `realized_10`, `realized_20`, and `realized_60`
- `fixed_blend`, with variance weights `0.40, 0.30, 0.20, 0.10`
- `optimized_blend`, with nonnegative variance weights that sum to one
- `ewma`, with lambda selected from a coarse `0.70..0.99` grid and a `0.001` fine grid around the coarse winner
- `best_model`, selected by past out-of-sample variance MSE for that ticker and horizon:

```text
mean(((forecast_vol / 100)^2 - (future_realized_vol / 100)^2)^2)
```

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
- `model_diagnostics.csv`: optimized blend, EWMA, realized-20, and realized-60 variance errors by ticker, horizon, and available moneyness bucket
- `latest_forecasts.json`: compact `volatility_forecast.v1` bridge for the Chrome extension
- `variance_diagnostics_report.html`: standalone diagnostics and current research queue
- six SVG charts and a local `visualizations/index.html` dashboard

## Extension bridge

Open the extension popup, import `latest_forecasts.json`, choose **Walk-forward forecast JSON**, and apply. For the visible option DTE, the overlay chooses the nearest forecast horizon. It uses that forecast as the ATM volatility level while retaining the live relative strike skew, then continues refreshing Robinhood Mark/IV values at the configured interval.

The daily forecast is intentionally slower-moving than the live quote. Re-run the Python job after a new official daily close and import the new compact JSON. Live Mark, IV, spread, volume, and open interest continue updating independently on Robinhood.

## Contract output

The ranking table includes:

```text
ticker, date, expiration, dte, option_type, strike, market_iv,
forecast_vol, vol_edge, market_mid, model_fair_value,
market_iv_fair_value, price_edge, implied_variance, forecast_variance,
variance_edge, dollar_gamma, gamma_weighted_edge, vega_normalized_edge,
bid, ask, spread_pct, volume, open_interest, model_used, lambda_used,
weights_used
```

The Haugh short-option/delta-hedge approximation is:

```text
P&L ≈ 0.5 * S^2 * gamma * (implied_variance - realized_variance) * T
```

`gamma_weighted_edge` uses market-IV gamma and annualized decimal variance. Its positive sign supports short-vol research; the long-vol sign is the inverse. The ranking also includes ATM IV, contract IV minus ATM, skew slope, 1/2/5/10D term fields, historical IV percentile, `edge_after_bid_ask`, liquidity gates, and the matched historical bucket. These are research prioritization aids, not trade instructions.
