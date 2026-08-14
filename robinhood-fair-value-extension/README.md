# FairVal SPY Volatility Research

A local Chrome extension that reads a SPY option chain visible in Robinhood and adds strike-specific volatility-scenario values, model selection, implied-volatility context, and quote-quality-gated research candidates. Pricing still renders on other supported symbols, but version 2.4 intentionally ranks multi-leg strategies only for SPY.

## What it does

- Uses Robinhood's visible ticker, underlying share price, expiration, strike, option type, and displayed price.
- Recalculates as Robinhood's virtualized option chain updates.
- Reads Robinhood's exact Mark and displayed IV whenever a contract is expanded, and caches them for that chain.
- Re-captures every rendered contract's exact Mark/IV from the DOM every 30 seconds by default. The interval is configurable from 15 to 300 seconds. Capture time is not misrepresented as an exchange timestamp.
- Recalculates the displayed research scenario every second as spot and time change. The independent realized-volatility forecast updates after a completed daily close, not on every quote tick.
- Uses a clearly starred Ask-implied IV estimate only for rows that have not yet been expanded or scanned.
- Fits raw SVI to total variance on forward log-moneyness when at least five strikes are available. Robust Huber weights reduce quote-outlier influence, and butterfly-arbitrage diagnostics must pass before live SVI is used. Sparse chains fall back to the prior leave-one-out local smile.
- When Robinhood displays an extended-hours ETF price beside a frozen option quote, removes the displayed after-hours or pre-market move and uses the regular-session close paired with that quote.
- Fetches the official U.S. Treasury CMT curve, converts quoted par yields to explicitly labeled continuous zero-rate proxies, and interpolates by expiration. This is not represented as a bootstrapped OIS curve.
- Supports arbitrary Robinhood option tickers, including symbols with share-class punctuation and digits.
- After three or more fresh Mark/IV pairs are scanned on expirations of at least seven days, calibrates a robust chain-implied dividend/carry yield. This avoids assuming that every stock has the same yield.
- Passes estimated SPY/QQQ ex-date cash-dividend schedules into CRR/trinomial through an escrowed-dividend lattice instead of double-counting them as continuous yield. SPX retains a continuous index yield. Other tickers use an explicitly labeled chain-implied carry diagnostic or 0% fallback; manual continuous yield remains available.
- In independent-volatility modes, highlights only fresh, liquid contracts whose price edge and volatility direction agree, whose modeled edge clears the executable quote and spread gates, and whose IV is unusual versus the same historical ticker/option-type/DTE/moneyness bucket.
- Adds an independent **Own forecast + market skew** mode. It shifts the live strike smile so its ATM level equals the user's realized-volatility forecast, then shows the resulting per-contract `IV EDGE` and model price.
- Adds a **Walk-forward volatility forecast** mode backed by a Python/pandas research engine. It fits realized-volatility baselines, dense and sparse variance blends, coarse-to-fine EWMA, HAR-RV, variance-targeted GARCH(1,1), asymmetric GJR-GARCH, and simple/shrunk forecast ensembles across 1/2/3/5/10-day horizons. Model selection minimizes past out-of-sample variance error without training on unfinished targets. QLIKE and calibration diagnostics expose cases where a lower headline error is still biased or poorly calibrated.
- Shows implied variance, forecast variance, implied-minus-forecast variance edge, dollar gamma, the Haugh gamma-weighted edge, vega-normalized price edge, the full greek set at market IV (delta, gamma, theta per day, vega per vol point, rho per rate point), and an approximate matched-bucket IV percentile in each badge tooltip.
- Prices every visible contract through a common model API. The overlay keeps dividend-adjusted Black–Scholes as the European baseline, cross-checks American contracts with CRR binomial and trinomial trees, benchmarks them against the fast Barone-Adesi/Whaley approximation, and identifies the selected model plus the reason for selection.
- The offline diagnostics backsolve midpoint IV under both dividend-adjusted Black–Scholes and American CRR. The live path preserves Robinhood's displayed per-contract IV and avoids redundantly rebuilding a large American tree merely to reproduce it.
- Applies early exercise at every American tree node with `max(continuation value, intrinsic value)`. CRR uses adaptive step doubling from 50 steps, adjacent-step smoothing to reduce parity oscillation, a configurable dollar tolerance, and a hard maximum. The selected model exposes actual steps, error estimate, convergence status, and explicit fallback reason.
- Ranks SPY-only defined-risk verticals and equal-width butterflies using executable prices on every leg. It also exposes outright delta-hedged volatility candidates as paper research only.
- Rejects structures unless every leg has a fresh exact quote and matched historical context and the modeled edge exceeds both the configured threshold and the complete quoted round-trip spread estimate.
- Records exact quote snapshots and forward 5/15/30/60-minute plus same-session end-of-day paper outcomes locally. EOD resolves only when a same-contract snapshot at or after 3:55 p.m. New York time exists. Long-side candidates are scored ask-to-later-bid; sell-side candidates are scored bid-to-later-ask. Option P&L, the initial-delta SPY hedge, gross delta-hedged P&L, underlying move, IV change, spread change, theta estimate, and a holding-window realized-variance proxy are kept separately. The popup can export or clear this JSON study.
- Uses weekday-aware forecast freshness and blocks stale daily forecasts from generating flags or strategy candidates. Scenario output remains visible with the warning.
- Makes no brokerage-data requests, does not read account credentials, and cannot place orders. Its only external request is the public Treasury curve.

The model resolver treats SPX/SPXW/XSP as European-style and U.S. single-stock/ETF contracts as American-style. When the data source does not explicitly supply style, the badge says the classification was inferred. The timing resolver distinguishes standard SPX AM settlement (09:30 ET), SPXW/XSP PM settlement (16:00 ET), and equity/ETF option close (16:15 ET) from the visible series root.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this entire `robinhood-fair-value-extension` folder.
5. Open a Robinhood classic SPY option chain.

A packaged build is also provided as `fairval-spy-research-extension-2.4.0.zip`, containing
`manifest.json`, `pricing-core.js`, `research-core.js`, `strategy-core.js`, `content.js`, `content.css`, `popup.html`, `popup.js`, `popup.css`, and the bundled SPY forecast. To
install from it, unzip the archive into a folder and **Load unpacked** that folder (Chrome
cannot load a `.zip` directly in developer mode).

When updating an already loaded copy, click the extension's **Reload** button on `chrome://extensions`, then refresh Robinhood.

The floating panel appears at the lower left. Exact Mark/IV scanning starts automatically while a supported chain is open and repeats at the configured interval. **Refresh Mark IV now** remains available for an immediate pass. A scan only clicks strike labels to reveal public contract details; it never clicks Robinhood's green `+` order button.

A small `RV-SCN $x.xx | CRR/BS-q/BS-EU | RH IV | IV EDGE | EXEC | IVP | C | DATA` badge is added beside each visible Robinhood price. `RV-SCN` means a physical realized-volatility scenario, not a uniquely identified risk-neutral fair value. `MKT-Q` means a market-implied diagnostic. `EXEC` is the directional ask- or bid-based edge, `C` is decomposed heuristic confidence, and `DATA` is the quote state. The badge stays neutral unless every executable, direction, data, surface, forecast, and model gate passes. Click it for the full diagnostic panel.

## Pricing architecture

The browser module in `pricing-core.js` and the Python research package both use the same conceptual API:

```text
pricing_model.price(inputs) -> value
pricing_model.greeks(inputs) -> greeks
implied_volatility(midpoint, pricing_model, inputs) -> status + volatility or failure reason
```

Implemented models are dividend-free Black–Scholes, continuous/dividend-adjusted Black–Scholes, adaptive European/American CRR, European/American trinomial, and Barone-Adesi/Whaley as a fast American benchmark. Discrete cash dividends are supported in the trees and escrowed-adjustment European baseline; BAW explicitly declines that case. CRR is selected only when the adaptive lattice converges, the independent trinomial agrees, and same-lattice early exercise exceeds `max($0.01, 10% of spread, 0.5% of option price)`. Otherwise FairVal explains the Black–Scholes retention/fallback.

The exact tree early-exercise premium compares American and European values on the same lattice. The scanner's displayed premium compares American value with the analytic dividend-adjusted Black–Scholes baseline and floors tiny negative discretization noise at zero.

## Research flags

The green or red `FLAG` treatment is an idea-generation screen, not a buy/sell instruction. The historical replay below did **not** establish a profitable rule, so a flag must be treated as a paper-research candidate. A fresh scanned contract is flagged only when:

- the model value remains beyond the ask for a below-model candidate, or beyond the bid for an above-model candidate;
- that executable edge exceeds the selected **Minimum edge %** and at least half the full bid/ask spread;
- the full spread is no wider than **Maximum spread %** of Mark;
- volume is at least 10 contracts or open interest is at least 100; and
- the exact quote was captured within the last two minutes;
- long-vol candidates have both positive price edge and forecast IV above market IV, while short-vol candidates have negative long-option price edge and market IV above forecast IV; and
- the IV percentile is at most 40 for a long-vol candidate or at least 60 for a short-vol candidate versus the same historical ticker, option type, DTE, and moneyness bucket.

Flags require a walk-forward, own-forecast, or manual volatility view; circular market-smile and individual-market-IV modes cannot trigger them. For an arbitrary ticker, flags also remain disabled until carry is calibrated or supplied manually and until the imported JSON contains a matched historical IV bucket. This prevents an unknown yield or normal downside skew from masquerading as a pricing opportunity.

The panel ranks up to five flags by edge-to-spread coverage. A flag means “record and review this contract and its assumptions,” not “place this trade.” Automatic refresh keeps the exact quote cache current while the chain remains open.

## SPY strategy lab

The strategy lab ranks research candidates rather than individual buy/sell instructions. It constructs call and put debit/credit verticals, equal-width call and put butterflies, and paper-only delta-hedged volatility candidates from the currently scanned expiration. The entire structure is evaluated at executable bid/ask prices, and the result shows net delta, gamma, vega, maximum loss, maximum profit when bounded, edge, and spread coverage. Calendar spreads and risk reversals are deferred until a synchronized multi-expiration data feed is available.

## Reading the result

- **Walk-forward forecast JSON** imports `latest_forecasts.json`, converts expiration to trading-day DTE, uses exact 1/2/3/5/10-day forecasts or interpolates annualized variance between adjacent horizons, and replaces market ATM volatility with the selected out-of-sample forecast while preserving live strike skew. Extrapolation is warned; 0DTE cannot produce a high-confidence signal without an intraday model.
- **Smoothed market smile** is the default relative-value screen. It uses robust forward-moneyness SVI when enough strikes pass static-arbitrage diagnostics, with a leave-one-out local smoother as the sparse-chain fallback. Automatic scanning replaces temporary ask-derived estimates with Robinhood's exact Mark IVs.
- **Own forecast + market skew** is the independent-volatility workflow. Enter your forecast of future ATM realized volatility. The extension preserves the live strike shape with a configurable additive-IV, IV-ratio, variance, or total-variance transform; total variance is the default. Nonpositive or extreme strike forecasts are floored/clamped with a warning.
- **Individual market IV** uses each contract's raw quote-implied IV. With a zero IV shift, the model necessarily reproduces the quote used to infer IV; this mode is diagnostic, not an independent fair value.
- **Flat own-vol forecast** applies one user-entered volatility to every strike without preserving market skew.
- **IV EDGE** is fair/model IV minus that contract's market IV. A positive number means the model volatility is higher; a negative number means it is lower.
- **VAR** is market implied variance minus forecast variance, in annualized decimal-variance basis points. Positive supports the short-vol sign in Haugh's delta-hedged approximation; negative supports the long-vol sign.
- **IVP** is an approximate historical IV percentile for the matched ticker, call/put, DTE, and moneyness bucket. No match means no strongest research flag.
- **IV shift** adds or subtracts volatility points from whichever IV model is selected so you can test a sensitivity. It is explicit user input, not learned alpha.
- **Minimum edge %** controls how far the model must remain beyond the executable ask or bid before a contract is flagged.
- **Maximum spread %** rejects illiquid quotes whose spread can explain the apparent discrepancy.
- A positive difference means the model value is above Robinhood's displayed reference price; a negative difference means it is below. It is not a buy or sell recommendation and does not estimate execution probability.
- `CRR` means the convergence-checked American binomial value was selected. `BS-q` means dividend-adjusted Black–Scholes remained selected because exercise value was negligible or an American diagnostic failed. `BS-EU` is the European index baseline.
- American-model IV and Black–Scholes IV are separately backsolved from midpoint; neither is the same thing as the walk-forward realized-volatility forecast.

For scanned rows, the extension compares fair value with Robinhood's exact Mark and reports Robinhood's displayed IV verbatim. For unscanned rows, it compares with the visible Ask/Bid/Mark column and marks the calculated IV with `*`.

## Market-input sources

- Risk-free proxy: U.S. Department of the Treasury Daily Treasury Par Yield Curve Rates, refreshed at startup, converted to continuous-rate proxies, and cached locally. It is not a bootstrapped SOFR/OIS zero curve.
- Arbitrary stocks/ETFs: robust effective carry inferred from three or more fresh, near-the-money Robinhood Mark/IV pairs for expirations of at least seven days; otherwise an explicitly labeled 0% fallback or the user's manual input.
- SPY: annual yield proxy plus estimated quarterly ex-date schedule, converted to explicit cash amounts for the lattice.
- SPX: S&P Dow Jones Indices' S&P 500 dividend yield, modeled as a continuous index yield.
- QQQ: annualized recent QQQ distributions, converted into estimated quarterly cash dividends and applied only when an ex-date falls before expiration.

These are transparent screen-grade approximations, not OPRA/Cboe professional analytics. Professional analytics can use NBBO data, a full interest-rate curve, discrete-dividend forecasts, and contract-reference data unavailable in the DOM. SPY/QQQ ex-dividend dates and cash amounts are explicitly labeled estimates. When a schedule is unavailable FairVal uses a continuous/carry approximation and warns. The extension labels output as potential discrepancies under assumptions rather than trade recommendations.

## Model limitations

- SPY/QQQ cash schedules remain estimates until a dated dividend forecast source is connected; unknown tickers can still use a continuous/carry approximation.
- Adaptive CRR reports rather than hides residual step-size error. Trinomial remains an independent same-resolution cross-check.
- Barone-Adesi/Whaley is a fast approximation and a benchmark, not the final source of truth.
- Volatility smile, jumps, earnings, event risk, stale quotes, wide spreads, slippage, and forecast error can dominate a small theoretical premium.
- A model value is conditional on spot, time, rate, dividend, volatility, style, and quote timestamp. It is not a guaranteed executable price.
- Robinhood page parsing does not provide a trustworthy exchange timestamp. The extension detects DOM-capture age, session mixing, chain changes, partial scans, exact-versus-estimated IV, invalid/locked quotes, and missing liquidity, but it is not an OPRA NBBO feed.
- Daily close-to-close forecasts are low-confidence for 1DTE and disabled for high-confidence 0DTE ranking. No minute-bar intraday model is fabricated.
- CPI/FOMC/jobs/earnings calendars are not bundled. Event availability is marked missing, and the scenario carries an explicit jump-risk warning.
- Historical bucket and ranking weights are heuristic until a sufficiently large quote-level walk-forward outcome sample validates them.

See [SOURCES.md](SOURCES.md) for the source URLs, as-of dates, embedded fallback curve, and interpretation notes.

The full architecture map, audit findings, implementation matrix, and phased institutional roadmap are in [QUANTITATIVE_ENGINE_AUDIT.md](../QUANTITATIVE_ENGINE_AUDIT.md).

## Walk-forward research engine

Run the pandas pipeline after each official daily close, then import `volatility-research-output/latest_forecasts.json` from the popup. Full formulas, schemas, leakage controls, CLI arguments, and outputs are documented in [volatility_research/README.md](volatility_research/README.md). The current extension payload is SPY-only and selects among realized-volatility baselines, variance blends, EWMA, and log-HAR by horizon using past out-of-sample variance error. The implementation plan and data gates are in [SPY_RESEARCH_PLAN.md](SPY_RESEARCH_PLAN.md).

The extension keeps live Mark/IV scanning separate from the daily forecast. That distinction is important: market IV updates continuously, while a daily-return forecast should change only when a new daily close enters the model.

## Reproducible simulation

Run the deterministic stress harness with Node.js:

```text
node tests/simulation.mjs [seed] [chain-count] [formula-case-count]
```

The default run covers 5,000 formula inversions and 1,000 synthetic call/put chains across stock prices, expirations, IV smiles, carry rates, spreads, quote noise, and injected 20%–40% mispricings. See [SIMULATION_RESULTS.md](SIMULATION_RESULTS.md) for the latest results and limitations.

## Robinhood historical replay

Run the included fixed Robinhood trade-bar replay with Node.js:

```text
node tests/robinhood-replay.mjs
```

The fixture contains 264 expired SPY contracts (132 calls and 132 puts), 12 weekly expirations from May 15 through July 31, 2026, 7,524 hourly option bars, and 636 underlying bars. The first eight expirations select the realized-volatility forecast; the final four are a held-out check. Signals are formed only after an hourly bar completes, use the next bar's first trade as an entry proxy, and are delta-hedged through that next bar.

Neither the relative-smile rule nor the simple 20-day historical-volatility forecast produced a positive held-out result after conservative transaction-cost haircuts. This is useful negative evidence: the extension does not label either rule a proven buying strategy. See [ROBINHOOD_REPLAY_RESULTS.md](ROBINHOOD_REPLAY_RESULTS.md) for the full result and limitations.
