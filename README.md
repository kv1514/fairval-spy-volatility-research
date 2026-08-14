# FairVal multi-model option research

FairVal is a research-only option valuation stack with three connected surfaces:

- a live SPY/SPX/QQQ website under `app/`;
- a local Robinhood overlay under `robinhood-fair-value-extension/`;
- a pandas walk-forward volatility and scanner engine under `robinhood-fair-value-extension/volatility_research/`.

It separates four quantities that are easy to mix up: the broker's market IV, an IV backsolved by a particular pricing model, the engine's forecast of future realized volatility, and the conditional scenario value produced by putting that forecast into a chosen pricing model.

## Pricing architecture

The generic contract is:

```text
pricing_model.price(inputs) -> fair value
pricing_model.greeks(inputs) -> Greeks
implied_volatility(market_midpoint, pricing_model, inputs) -> result/status/reason
```

Implemented models are:

1. European Black–Scholes without dividends.
2. European Black–Scholes with continuous dividend yield.
3. Cox–Ross–Rubinstein European and American binomial trees.
4. European and American recombining trinomial trees.
5. Barone-Adesi/Whaley as a fast American approximation and benchmark.

At each American lattice node FairVal uses:

```text
continuation = discounted risk-neutral expected next value
exercise = max(S - K, 0) for calls; max(K - S, 0) for puts
american value = max(continuation, exercise)
```

European nodes use continuation only. This makes the American value at least as large as the same-tree European value and exposes an exercise boundary and early-exercise premium.

## Model selection

Explicit contract style from a data source wins. Otherwise a configurable resolver maps known index products (SPX, SPXW, XSP) to European style and U.S. equity/ETF products to American style. Every inference is disclosed.

For an American contract, FairVal calculates CRR and trinomial values under market IV and forecast volatility. It selects CRR only when the adaptive tree converges, the lattices agree within tolerance, and the same-tree early-exercise premium exceeds `max($0.01, 10% of spread, 0.5% of option price)`. It retains dividend-adjusted Black–Scholes when that premium is negligible and falls back with an explicit reason if the tree is unstable. IV inversion is reported separately and cannot invalidate an otherwise stable scenario price.

Market-IV fair value is diagnostic and normally close to the quote. The research comparison is:

```text
price edge = selected pricing model(forecast volatility) - market midpoint
```

The scanner then tests whether that edge survives the bid/ask spread and discounts illiquid, low-confidence, inferred-style, or poorly converged results. Outputs are potential pricing discrepancies under assumptions—not trade instructions.

## Run the website

```powershell
npm install
npm run dev
```

The website accepts Alpaca or Tradier credentials in the browser session. Alpaca supplies SPY/QQQ; Tradier is required for SPX in the current connector. Credentials are forwarded only to the selected market-data endpoint and are not stored in the repository.

## Install the Chrome extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select the entire `robinhood-fair-value-extension` directory.
5. Reload an existing installed copy after updates.

The extension continuously scans visible Mark/IV fields at the configured interval, prices through `pricing-core.js`, and caches repeated calculations. It does not access brokerage credentials and cannot submit an order or execute a hedge.

Version 2.4 distinguishes DOM capture time from an unavailable exchange timestamp, rejects locked/crossed quotes, aborts a scan if the chain changes, disables filtered signals outside the regular session, and assigns every row a visible data state and confidence score. A clicked badge opens contract diagnostics rather than asking the user to infer assumptions from a compressed label.

Daily forecasts map to **trading-day DTE**. Exact 1/2/3/5/10-day horizons are used when available, intermediate horizons interpolate annualized variance, and extrapolation is warned. The daily model cannot support a high-confidence 0DTE signal; 0DTE is diagnostic-only until real intraday data exists.

## Run the research engine

From `robinhood-fair-value-extension`:

```powershell
python -m volatility_research.cli `
  --prices data/robinhood-daily-2022-2026.csv `
  --options data/robinhood-options-snapshot-2026-08-05.csv `
  --surface-history data/spy-option-surface-history-2026.csv `
  --output-dir volatility-research-output
```

Key artifacts are `option_rankings.csv`, `variance_diagnostics_report.html`, and `pricing_diagnostics_report.html`. The pricing report supports contract selection and displays all model values, model-specific IVs, reasons, warnings, and 50/100/250/500/1000-step CRR/trinomial convergence.

## Verification

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests/core.test.mjs
```

Tests cover Black–Scholes benchmarks and parity, generic model IV recovery, European tree convergence, American dominance, early-exercise behavior, monotonicity, short-DTE and invalid inputs, binomial/trinomial agreement, BAW benchmarking, spread-relative resolver policy, trading-horizon interpolation, surface transforms, quote-state warnings, mixed-signal rejection, scanner fallback, liquidity/style warnings, no-look-ahead volatility forecasts, executable 5/15/30/60-minute and EOD paper outcomes, and absence of order execution.

## Limitations

- SPY/QQQ discrete dividend dates and amounts are estimates, not an official dated forecast feed; other symbols can still fall back to continuous or chain-implied carry.
- Tree values retain step-size error; the live overlay uses fewer steps than the offline convergence report.
- BAW is an approximation, not the final American source of truth.
- Quote staleness, feed differences, bid/ask spread, liquidity, slippage, surface dynamics, jumps, earnings, and event risk can dominate a small theoretical edge.
- Robinhood does not expose reliable exchange quote timestamps through the parsed page. DOM capture freshness is labeled as such and is not equivalent to NBBO freshness.
- Daily close-to-close forecasts do not contain an intraday 0DTE model, scheduled macro-event calendar, or complete jump model.
- Forecast volatility is uncertain. Historical out-of-sample accuracy does not establish profitable execution.
- Black–Scholes, trees, and model IVs remain conditional on their assumptions.

The replication logic inside a tree is theoretical pricing machinery. FairVal does not buy shares, place trades, submit orders, or execute delta hedges.
