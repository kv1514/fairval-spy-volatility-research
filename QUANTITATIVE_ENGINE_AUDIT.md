# FairVal Quantitative Engine Audit

Date: 2026-08-12  
Scope: website, Robinhood extension, offline volatility research, surface analytics, ranking, and paper backtests  
Status: architecture audit complete; implementation proceeds in the phases below

## Implementation status (2026-08-13)

- **Completed in 2.4:** unified live/offline quote-state vocabulary, DOM-capture versus source-timestamp distinction, locked/crossed quote rejection, mixed-session suppression, scan identity/partial-scan diagnostics, and contract-level data quality/confidence.
- **Completed in 2.4:** trading-day DTE, variance-space interpolation, explicit exact/interpolated/extrapolated/unavailable horizon methods, and high-confidence 0DTE suppression when no intraday model exists.
- **Completed in 2.4:** configurable additive-IV, ratio, variance, and total-variance strike transforms with live/offline parity and surface sanity warnings.
- **Completed in 2.4:** spread/price-relative early-exercise materiality, IV-solver observability, directional executable edges, mixed-signal rejection, long/short-separated heuristic ranks, and score/confidence decomposition.
- **Completed in 2.4:** clicked-contract diagnostics, neutral-by-default badges, 5/15/30/60-minute and same-session EOD executable paper outcomes, outcome attribution fields, jump diagnostic payload, and explicit unavailable event/intraday modules.
- **Completed:** adaptive adjacent-smoothed CRR in extension JavaScript, website TypeScript, and research Python; convergence tolerance/error/status/history; hard maximum; explicit fallback; stable minute-bucket caching; seeded IV inversion; shared cross-language golden vectors.
- **Completed:** explicit `RV-SCN` physical-volatility scenario versus `MKT-Q` market-implied diagnostic labeling.
- **Completed:** estimated discrete SPY/QQQ cash-dividend schedules passed into CRR/trinomial via an escrowed-dividend construction; BAW refuses unsupported discrete-dividend cases.
- **Completed:** forward-moneyness raw SVI calibration in the Python surface engine with robust weights, quote residuals, outlier flags, butterfly `g(k)`, and calendar-total-variance diagnostics. The live extension uses SVI when enough strikes fit and the butterfly test passes, otherwise the previous robust local smile is the explicit fallback.
- **Completed:** SPX standard AM versus SPXW/XSP PM settlement-time resolution and a continuous-rate CMT proxy that is labeled as a proxy rather than a bootstrapped OIS curve.
- **Still open:** official dated dividend feed, OIS/zero-curve bootstrap, a separately trained future implied-volatility (`Q`) model, event/jump features, quote-level institutional history, and full hedge/assignment/cost accounting.

## Executive conclusion

FairVal is a useful research prototype, but the displayed forecast-volatility value is not yet a uniquely identified no-arbitrage fair value. The current walk-forward volatility models forecast the physical distribution (`P`), while Black-Scholes and the trees require a risk-neutral or future-implied volatility input (`Q`). Feeding the physical realized-volatility forecast directly into a pricing model is a transparent scenario calculation, not a complete risk-neutral valuation model. That distinction must remain visible in the UI, stored records, reports, and tests.

The highest-priority numerical defect is the fixed 75-step American tree. It has no per-contract convergence guarantee, and same-step CRR/trinomial agreement is not a substitute for convergence. The first implementation phase therefore replaces the fixed assumption with adaptive CRR step doubling, adjacent-step smoothing to reduce lattice oscillation, explicit tolerance/error metadata, a hard maximum, and a safe fallback.

The strongest existing research controls should remain intact: completed-target walk-forward splits, variance/QLIKE evaluation, executable bid/ask outcomes, liquidity and freshness gates, explicit option-style resolution, exact early-exercise checks inside the lattice, and honest negative backtest results.

## End-to-end architecture

```text
Website live path
Alpaca / Tradier
  -> app/api/market/route.ts (quotes, spot, OCC normalization, timestamps)
  -> app/page.tsx (selected contract and controls)
  -> app/lib/pricing.ts (BS / CRR / trinomial / IV inversion / selection)
  -> browser UI

Extension live path
Robinhood DOM
  -> content.js (contract parsing, exact-row scanning, spot/time/rate/carry inputs)
  -> pricing-core.js (BS / CRR / trinomial / BAW / IV inversion / selection)
  -> strategy-core.js (single-leg and executable multi-leg research candidates)
  -> badge, panel, and Chrome-local paper snapshots

Offline research path
Daily closes
  -> volatility_research/engine.py
  -> rolling RV / EWMA / HAR / GARCH / GJR / ensembles
  -> walk-forward evaluation and latest_forecasts.json

Option snapshots/history
  -> volatility_research/surface.py
  -> volatility_research/pricing_models.py
  -> rankings and HTML diagnostics
  -> extension import

Historical evaluation
Hourly fixture -> candidate-study/replay tools
Exact exported quotes -> paper_backtest.py
```

## Model-purpose boundary

| Layer | Probability measure / purpose | Current status | Required interpretation |
|---|---|---|---|
| Market IV and fitted surface | Risk-neutral `Q` snapshot | Implemented, but surface is a robust local strike fit rather than SVI | Market-consistent diagnostic and relative-value context |
| Realized-volatility forecast | Physical `P` | Implemented with walk-forward RV/EWMA/HAR/GARCH/GJR/ensembles | Forecast of future realized variance, not directly a no-arbitrage option value |
| Forecast-IV model | Future risk-neutral `Q` | Not implemented | Needed to predict future repricing of implied volatility |
| Option pricing | Risk-neutral valuation conditional on inputs | BS/CRR/trinomial/BAW implemented | Valid only for the specified volatility/carry/exercise assumptions |
| Trading signal | Residual after costs and conditioning | Partial | Candidate research signal; not arbitrage and not a recommendation |

No arithmetic average of unrelated model prices should be called fair value. Ensembles belong in the forecast layer and must be fitted only on completed past targets.

## Component audit and implementation map

| File / function | Current behavior | Assessment | Proposed change | Expected benefit | Main risk | Required tests |
|---|---|---|---|---|---|---|
| `robinhood-fair-value-extension/pricing-core.js::crr` | Fixed-step CRR with exact node exercise | Correct lattice mechanics; fixed resolution is fragile | Add adaptive CRR with step doubling, adjacent-step numerical smoothing, error estimate, max-step cap, status, and history | Per-contract numerical control and auditable fallback | Higher runtime | convergence, bounds, monotonicity, runtime |
| `pricing-core.js::compareModels` | Same-step CRR/trinomial agreement; 75-step default | Agreement is not convergence | Require adaptive CRR convergence plus independent trinomial agreement before selecting CRR | Prevents false precision | More BS fallbacks when tree is unresolved | fallback and metadata tests |
| `content.js::pricingCacheKey` | Includes DTE to six decimals | Cache churns every fraction of a second | Use a stable minute bucket and all numerical-control settings | Large UI speedup without material time-value error | Stale value within one minute | cache-key unit test/helper test |
| `content.js` pricing exception | Silently falls back to local BS | Operationally unsafe because failure is hidden | Preserve fallback but surface explicit error metadata and warning | No silent model substitution | More warning text | forced-error test |
| `popup.js/html` | User supplies one tree step count | Misleading control | Treat as maximum steps; expose dollar convergence tolerance | Configurable precision/performance tradeoff | Bad user-entered tolerance | settings validation |
| `app/lib/pricing.ts` | Duplicated fixed-step logic | Model drift risk | Mirror adaptive interface and metadata; later consolidate shared vectors | Website/extension consistency | Independent implementations can diverge | JS/TS parity vectors |
| `volatility_research/pricing_models.py` | Fixed tree in selection; separate offline convergence report | Diagnostics do not control selected output | Route selection through adaptive convergence and persist metadata | Offline/live consistency | Batch runtime | Python convergence and parity tests |
| `content.js` volatility input | `surface IV + (forecast RV - ATM market IV)` | A physical-volatility scenario applied to a market smile | Keep as an explicitly labeled RV scenario; add separate future-IV output later | Honest semantics, no hidden assumption | Existing users may expect “FV” label | role/label tests |
| `surface.py` | Robust local strike fit on spot log-moneyness | Useful outlier resistance; not a full surface | Fit SVI on forward log-moneyness, enforce positivity and calendar/butterfly diagnostics, preserve raw quotes | Smooth strike/expiry surface and comparable residuals | Sparse/illiquid fits | synthetic recovery and arbitrage checks |
| rate ingestion | Treasury CMT/par yields interpolated by expiry | Better than a hard-coded rate, but not a zero curve | Add zero-curve bootstrap or documented proxy flag; centralize day count/compounding | Correct discount factors and forward moneyness | Data availability | curve interpolation/discount tests |
| dividend/carry input | Dividend fallback plus chain-implied carry | Chain-implied carry is partly circular; continuous yield misses discrete ETF dividends | Add discrete ex-date/cash schedules and explicit model branch; keep implied carry as market diagnostic | Better American calls and early-exercise boundary | Dividend dates/amount changes | ex-date sensitivity and no-dividend equivalence |
| SPX settlement | Symbol maps differ; standard vs weekly ambiguity | Material for 0DTE | Resolve root/series to AM/PM settlement explicitly and test holidays/DST | Correct time to expiration | Broker symbols may omit settlement class | calendar fixtures |
| `engine.py` targets | Daily close-to-close realized volatility | Strict walk-forward implementation is sound | Add overnight/intraday decomposition when OHLC or tick data exists; add jump/event features | Better horizon-specific physical variance forecast | Sample size and event leakage | cutoff and target-window tests |
| GARCH/GJR grid | Deterministic walk-forward QML grid | Reproducible baseline | Add bounded continuous optimization with grid fallback and parameter diagnostics | Less coarse parameter estimation | Unstable optimizer | stationarity and fallback tests |
| future implied-volatility prediction | Absent | Major research gap | Model ATM future IV, smile dynamics, term structure, event premia, and IV change separately from realized variance | Separates “hold/reprice” trades from “delta-hedged variance” trades | Requires historical option quotes | strict timestamped walk-forward tests |
| `paper_backtest.py` | Executable option entry/exit plus one initial hedge | Stronger than midpoint tests, but incomplete | Add stock spread, fees, borrow/funding, repeated hedge rules, assignments, dividend cash flows, and P&L attribution | Realistic net performance | Missing quote-level data | accounting identities and event tests |
| candidate ranking | Edge, variance, skew, liquidity, percentile gates | Sensible research screen | Rank only among executable candidates; separate long-option, short-vol, and relative-value families | Avoids mixing incompatible trades | Selection bias | frozen-universe and cost tests |

## Existing behavior to preserve

- Browser-side credentials remain in session/local browser storage and are not sent to an unrelated server.
- Exact displayed Robinhood Mark/IV is preferred over inferred row values.
- Underlying price is aligned to the regular-session option quote rather than blindly mixing after-hours stock moves with a stale option mark.
- Expiration timestamps are New York calendar/DST aware.
- American early exercise is evaluated at every tree node.
- Same-lattice American-minus-European premium is used rather than a cross-model difference.
- Forecast tuning uses only completed historical targets.
- Model selection is based on variance forecast error/QLIKE, not trading profit.
- Alerts require freshness, spread, liquidity, sign consistency, and historical-bucket context.
- Paper outcomes use executable ask-to-bid or bid-to-ask paths and retain negative results.

## Quantitative weaknesses found

1. **Numerical precision is not controlled.** A fixed 75-step CRR value can move materially when the lattice is refined. CRR/trinomial agreement at a single step count can occur before either model has stabilized.
2. **The cache defeats itself.** DTE in six decimal places changes roughly every 0.086 seconds, so expensive American-IV inversions are repeatedly recomputed.
3. **The current “fair value” mixes measures.** Realized-vol forecasts are `P`; option prices are `Q`. The number is useful as a scenario or volatility-risk-premium signal, but it is not a complete risk-neutral fair value.
4. **The smile is not SVI.** Current smoothing is robust and leave-one-out, but it uses spot moneyness, lacks a forward/carry basis, and has no static-arbitrage controls.
5. **Dividend handling is incomplete for American ETF options.** Continuous yield is an approximation; early-exercise decisions are driven by actual discrete cash dividends and ex-dates.
6. **Rates are proxy inputs.** Treasury par yields are not the same object as continuously compounded zero rates used for discounting.
7. **SPX settlement metadata is ambiguous.** Standard AM-settled and weekly PM-settled contracts must not share a generic timestamp rule.
8. **Historical options data is not yet sufficient for a strategy claim.** The available replay sample is daily final trades and the Theta sample is one day; neither is a full historical NBBO dataset.
9. **Hedging costs are incomplete.** The exact-quote paper engine has an initial delta hedge but not a systematic rebalance path with stock spreads, fees, assignments, funding, and dividend cash flows.
10. **Pricing logic is duplicated.** Website TypeScript, extension JavaScript, and Python can drift without shared golden vectors.

## Phased implementation plan

### Phase 1 — numerical correctness and observability

1. Adaptive CRR step doubling with adjacent-step smoothing.
2. Configurable absolute price tolerance and hard maximum steps.
3. Persist/display actual steps, convergence error, status, and method.
4. Require convergence before American CRR selection; otherwise use an explicit BS fallback warning.
5. Stabilize the live pricing cache and expose caught pricing errors.
6. Add bounds, monotonicity, convergence, fallback, and performance tests.

### Phase 2 — cash-flow and surface correctness

1. Discrete-dividend schedules in CRR/trinomial with ex-date alignment.
2. Explicit SPX/SPXW/XSP settlement metadata and calendar fixtures.
3. Zero-curve/forward construction with documented data-source provenance.
4. SVI by expiry on forward log-moneyness, robust weighted calibration, quote-level residuals, and static-arbitrage diagnostics.

### Phase 3 — forecast-layer separation

1. Keep physical realized-variance forecasts for delta-hedged variance research.
2. Build a separate future implied-volatility/smile forecast for option repricing research.
3. Add event features, jump diagnostics, volatility-of-volatility, surface dynamics, and regime state using strict walk-forward cutoffs.
4. Calibrate the mapping from realized-vol forecasts to future implied vol rather than assuming equality.

### Phase 4 — institutional backtest

1. Quote-level NBBO/trade synchronization with underlying NBBO.
2. No-crossed/no-stale data cleaning and locked-market policy.
3. Executable option and stock fills, commissions/fees, borrow/funding, and partial-fill assumptions.
4. Repeated hedge schedules and delta/gamma/theta/vega/carry/slippage/fee P&L attribution.
5. Vertical/calendar/butterfly and delta-hedged families evaluated separately.
6. Expanding/rolling walk-forward train/validation/test windows with frozen specifications.

### Phase 5 — advanced models only when diagnostics justify them

- Local volatility for smile-consistent European path pricing.
- Heston/stochastic volatility for documented volatility-of-volatility failures.
- Merton/Bates jump models for event and jump residuals.
- PDE/finite differences for complex exercise/cash-flow cases.
- Monte Carlo/Longstaff-Schwartz for path dependence or high-dimensional state.

These models are not added merely to increase model count. Each requires a diagnosed residual pattern, a calibration policy, out-of-sample evidence, and a runtime budget.

## Validation gates

Before a phase is accepted:

- All existing tests must pass.
- New numerical tests must pass for calls and puts, American and European styles, 0–10 DTE, deep ITM/OTM, low/high volatility, and dividend/no-dividend cases.
- No-arbitrage bounds and strike/maturity monotonicity must hold within stated numerical tolerances.
- Adaptive methods must report non-convergence rather than silently treating the maximum-step value as exact.
- Python, extension JavaScript, and website TypeScript must agree on shared golden vectors within tolerance.
- Runtime benchmarks must report cold-cache and warm-cache results.
- Research reports must separate market-consistent diagnostics, physical-volatility scenarios, future-IV forecasts, and executable trading outcomes.

## Current evidence baseline

- Python volatility research tests: 36 passing.
- Python pricing-model tests: 25 passing.
- JavaScript extension/site tests: 41 passing.
- Exact-quote benchmark before Phase 1: approximately 255 ms per contract for the tested `compareModels` path.
- Raw CRR benchmark before Phase 1 showed roughly quadratic growth: about 1.7 ms at 50 steps, 6.6 ms at 100, 24 ms at 200, 95 ms at 400, and 490 ms at 800 for the sampled contract.
- Available daily underlying history: SPY/QQQ/SPX from 2022-01-03 through 2026-08-11.
- Available option replay data is not yet a multi-year quote-level NBBO history; performance claims must remain provisional.
