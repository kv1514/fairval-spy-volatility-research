# FairVal Full Model Audit and Upgrade Baseline

Date: 2026-08-13  
Scope: Chrome extension, Robinhood DOM ingestion, pricing engines, volatility forecasts, volatility surface, ranking, paper outcomes, website, tests, and deployment artifacts  
Status: pre-upgrade audit; this document records the observed behavior before the 2026-08-13 hardening work

> This is intentionally the pre-change baseline requested by the audit. The post-implementation disposition is appended at the end rather than rewriting the original findings.

## Executive finding

FairVal already contains substantially more than a Black-Scholes overlay: it has market-IV diagnostics, a leakage-aware daily realized-variance research engine, adaptive American trees, an SVI surface, executable-price screens, and local paper snapshots. The main weakness is not a missing exotic pricing formula. It is that data provenance, forecast-horizon fit, surface transformation, and confidence are not carried together as one auditable contract-level state.

The result can look more precise than the evidence supports. A Robinhood row can receive a compact scenario badge even when the exact contract quote has not been captured, the option and underlying belong to different sessions, the daily forecast is being applied to 0DTE, the chain scan is incomplete, or the historical surface bucket is thin. The existing gates reject some of these cases for alerts, but the badge does not make the distinction sufficiently visible and the offline ranker does not use the same data-state vocabulary.

The correct product interpretation is:

- `MKT-Q` is a market-implied diagnostic. It uses the displayed or internally backsolved market IV and should normally reproduce the executable quote or midpoint within model and input differences.
- `RV-SCN` is a conditional realized-volatility scenario. It starts with an out-of-sample physical (`P`) variance forecast, maps that ATM forecast onto the current strike surface, and reprices the contract. It is not a unique risk-neutral (`Q`) fair value and is not arbitrage proof.
- A research signal exists only after direction, bid/ask execution, liquidity, data integrity, numerical stability, forecast freshness/horizon, surface context, and confidence agree.

No code path places or stages an order. That boundary must remain.

## System map

```text
Robinhood DOM
  -> content.js parses chain context and expands rows for Mark / IV / bid / ask
  -> pricing-core.js calculates MKT-Q and RV-SCN values with BS / adaptive CRR
  -> strategy-core.js screens executable single- and multi-leg paper candidates
  -> content.js renders badges, records local paper snapshots, and exports research data

Daily underlying history
  -> volatility_research/engine.py builds completed future-variance targets
  -> rolling RV / EWMA / HAR / GARCH / GJR / variance ensembles
  -> strict walk-forward selection and latest_forecasts.json

Option snapshots and history
  -> surface.py fits forward-moneyness raw SVI and historical IV buckets
  -> pricing_models.py reprices each contract and exposes numerical diagnostics
  -> engine.py ranks conditional scenarios and writes CSV / HTML reports

Website
  -> broker API route and selected contract state
  -> duplicated TypeScript pricing implementation
  -> standalone contract calculator / model-comparison interface
```

## What the system currently calculates

### Market-implied diagnostics

- Robinhood/displayed contract IV when exact row details have been captured.
- An internally inferred Black-Scholes IV when the exact IV is unavailable.
- Black-Scholes value using market IV.
- Adaptive CRR market-IV value for inferred American-style contracts.
- Trinomial and Barone-Adesi/Whaley comparison values in offline diagnostics.
- Market ATM IV, strike-minus-ATM skew, raw SVI fitted IV/residual, butterfly diagnostics, calendar total-variance diagnostics, term structure, and prior-bucket IV percentile.

These values describe the market or compare numerical models. They are not independent alpha.

### Independent forecast-based research values

- Daily future realized-volatility forecasts for 1, 2, 3, 5, and 10 trading-return horizons.
- Candidate forecasts from realized windows, fixed/dense/sparse variance blends, EWMA, HAR-RV, GARCH, GJR-GARCH, and ensembles.
- Walk-forward best-model selection using out-of-sample variance MSE, with MAE/RMSE, QLIKE, bias, and Mincer-Zarnowitz diagnostics.
- A strike-specific forecast volatility formed in the extension by applying an additive ATM IV shift to the current smile.
- `RV-SCN` price, volatility edge, variance edge, gamma-weighted variance edge, price/vega edge, and executable bid/ask edge.

The forecast is physical realized variance. Repricing it with a risk-neutral option formula is a transparent conditional scenario, not a complete risk-neutral valuation.

## What is displayed, ranked, and recorded

### Current compact badge

The live badge currently compresses the RV-SCN price, selected model, Robinhood IV, IV edge, variance edge, IV percentile, and convergence state. Color is derived too directly from the scenario-price difference. It does not consistently show quote state, exact-versus-estimated status, executable edge, or a contract-level confidence score. The market-IV diagnostic and realized-volatility scenario are described elsewhere, but the compact label can still be read as a single authoritative fair value.

### Current ranking inputs

The offline ranker uses price edge, absolute volatility edge, executable edge, gamma-weighted edge, historical surface context, liquidity, and model confidence. Directional candidate checks exist, but the composite percentile ranks rely materially on absolute magnitudes. A mixed-sign or bad-data outlier can therefore receive more attention than it deserves before later gates. The score weights are heuristic and have not been validated against a large, quote-level, walk-forward outcome sample.

The live alert gate requires an exact quote, freshness, minimum price, spread, volume/open interest, edge larger than a fixed/spread threshold, and historical surface context. This is safer than the badge, but it is not a unified score shared with the offline ranker.

### Current paper tracking

The extension records contract identity, signal time, quote inputs, spot, forecast/model values, Greeks, signal direction, and selected research fields. It summarizes executable 15- and 60-minute outcomes. The offline paper analyzer pairs a signal with a later bid/ask, uses ask-to-bid for a long and bid-to-ask for a short, and adds a single initial-delta hedge. It does not yet provide 5/30-minute and end-of-day outcomes, repeated hedge accounting, option/stock fees and spreads, assignments, dividend cash flows, or full gamma/theta/vega/slippage attribution.

## Data-integrity audit

### Stale or mixed data entry points

1. `capturedAt` is the time FairVal read the DOM, not an exchange quote timestamp. A recently captured frozen quote can look fresh.
2. The underlying price is scraped from Robinhood without a source timestamp. After-hours alignment attempts to reconstruct the regular close from displayed extended-hours movement, but the pairing cannot be proven from timestamps.
3. After-hours and pre-market option quotes may be frozen while the underlying changes. The current alignment reduces the error but does not always disable confidence or ranking.
4. A chain scan expands rows sequentially. The expiration, call/put tab, or chain can change while the scan is running; the cache key does not carry a complete immutable scan identity.
5. Partially completed scans do not produce a first-class per-contract `partial_scan` state.
6. Exact Mark/IV absence falls back to a displayed price or inferred IV, but the badge warning is too subtle.
7. Bid/ask validation permits locked markets in some paths and is implemented differently between the content script, strategy module, and Python ranker.
8. Missing volume and open interest can be coerced to zero, obscuring “missing” versus true zero.
9. Robinhood DOM selectors and text parsing have no single layout-version or parse-confidence status. A layout change can degrade individual fields without a prominent global warning.
10. Expiration parsing and settlement mapping are symbol-based. SPX/SPXW/XSP handling is better than a generic date, but holidays, early closes, and ambiguous roots remain operational risks.
11. Treasury fallback data can remain usable with no prominent stale-source penalty when refresh fails.
12. Dividend dates and amounts for SPY/QQQ are estimates, not a dated official distribution feed.

### Required unified quote states

The upgrade must emit one primary state plus detailed warnings:

- `fresh_exact`
- `fresh_estimated_iv`
- `stale_option_quote`
- `stale_underlying_quote`
- `mixed_session_warning`
- `partial_scan`
- `invalid_bid_ask`
- `missing_liquidity`
- `dom_parse_warning`

The score must distinguish unavailable source timestamps from genuinely fresh exchange timestamps. Capture freshness is not quote freshness.

## Statistical forecast audit

### Controls that are sound

- Targets are forward realized variance and the one-day target uses the next absolute log return as annualized volatility.
- Forecast tuning uses only rows whose future target has fully completed before the forecast origin.
- Variance blends combine variances, constrain weights to be nonnegative, and enforce a unit sum.
- EWMA lambda selection uses past validation records; GARCH/GJR parameters are fit walk-forward.
- Negative forecast variances are floored and HAR is fit in log-variance space.
- Model selection is based on forecast loss rather than realized trading profit.
- Historical IV percentiles use strictly prior dates.

### Weaknesses

1. Code defaults allow only 30 minimum training observations, a 252-row window, and 5-row rebalancing even though the production run was manually invoked with 252/756/21. Safe research defaults are not enforced.
2. The extension maps calendar DTE to the nearest supported horizon. It does not count trading days, interpolate annualized variance, or explicitly identify extrapolation.
3. 0DTE uses a one-day close-to-close forecast by construction. There is no intraday realized-variance model, time-of-day decomposition, or remaining-session scaling.
4. Weekends and holidays can make the selected daily horizon inconsistent with the contract’s actual remaining trading exposure.
5. Forecast staleness is a fixed calendar rule and is not market-calendar aware.
6. Latest forecast artifacts omit enough training/validation counts, rebalancing history, parameter stability, and generation provenance for a live user to judge reliability.
7. A best model selected from many close competitors can switch frequently; the UI does not show selection margin or stability.
8. Moneyness-bucket diagnostics subset forecast dates but do not create truly strike-specific underlying-volatility forecasts. The distinction is not obvious in every report.
9. Daily close-to-close targets mix overnight and regular-session movement. This is especially weak for 0–1DTE use.
10. Daily GARCH/HAR models do not separately price scheduled event or jump risk.

## Surface and skew audit

### Strengths

- Raw SVI is fit in total-variance space on forward log-moneyness.
- Forward construction uses rates, continuous dividend yield, and a prepaid-spot cash-dividend adjustment.
- The fit uses deterministic robust weights, minimum-point checks, parameter constraints, quote residuals, outlier flags, butterfly `g(k)`, and cross-expiry calendar total-variance diagnostics.
- ATM IV and current term structure are explicitly calculated.
- Historical IV percentiles compare ticker, option type, DTE bucket, and moneyness bucket using prior dates only.

### Weaknesses

1. Live SVI accepts captured or inferred IVs without a unified stale/quality filter.
2. The extension only sees one visible expiration at a time, so live calendar-arbitrage diagnostics are incomplete.
3. The live fallback and offline SVI paths are separate implementations and can drift.
4. The extension uses an additive IV-level shift. The offline ranker currently applies the ATM realized-vol forecast directly to all strikes rather than consistently preserving the fitted strike skew. This is a material live/offline mismatch.
5. Additive IV, multiplicative ratio, annualized-variance shift, and total-variance shift are not configurable or compared.
6. The 1%–500% clamp prevents negative values but is silent and too permissive to be a quality diagnostic.
7. Very short maturity turns small quote errors into large annualized-IV and SVI total-variance noise; no special short-DTE fit penalty is applied.
8. ATM fallback is the nearest forward strike. Sparse or one-sided chains can make that estimate fragile.
9. Bucket widths and the 40/60 percentile gates are heuristic. Sample count is stored but its uncertainty does not proportionally shrink ranking influence.

## Rates, carry, and dividends audit

- The extension downloads the official Treasury constant-maturity curve, interpolates by expiry, and labels the continuously compounded result as a zero-rate proxy. This is preferable to a hard-coded rate but it is not an OIS or fully bootstrapped zero curve.
- Curve interpolation is cubic and can be less robust than shape-preserving interpolation around sparse maturities. Source age and fallback age need explicit confidence penalties.
- Option discounting correctly uses calendar time, while forecast horizons should use trading days. Those two clocks must remain distinct.
- SPY/QQQ dividends are estimated quarterly cash flows and are passed to the tree with continuous dividend yield set to zero, which is the correct double-counting guard in that branch.
- Estimated ex-dates and amounts can be wrong. Around ex-dividend dates that directly changes American-call exercise incentives.
- Chain-implied carry is circular when used to judge the same option market and should remain a market diagnostic, not independent evidence.
- Required provenance fields are not carried through every badge/ranking row: `rate_source`, `rate_timestamp`, `rate_for_expiration`, `rate_warning`, `dividend_method`, `dividend_schedule`, `dividend_warning`, `carry_estimate_method`, and `double_counting_guard`.

## Pricing-model audit

### Black-Scholes and dividend adjustment

The core formula, dividend discounting, calls/puts, Greeks, vega-per-vol-point, rho-per-rate-point, theta-per-day, parity, and IV recovery are covered by benchmarks. Discrete dividends are handled through an escrowed/prepaid spot adjustment. Near-expiry input currently floors time to roughly one minute instead of using a first-class expired/intrinsic state, which is especially misleading at and after settlement.

### Adaptive CRR

The lattice uses standard `u`, `d`, risk-neutral probability, discounting, continuous yield, and early-exercise checks at every node. It evaluates adjacent step counts and doubles the base resolution up to a hard maximum. Convergence metadata and same-tree American-minus-European premium are good controls. Remaining weaknesses are performance, the one-minute expiry floor, and a resolver policy that uses a fixed $0.01 materiality threshold rather than a price/spread-relative threshold.

### Trinomial

The trinomial is an independent stability cross-check and has benchmark/convergence tests. The live resolver requires agreement with CRR. Its transition-probability and convergence diagnostics should remain visible rather than silently collapsing to a single model tag.

### Barone-Adesi/Whaley

BAW is a benchmark approximation, supports its valid call/put/continuous-yield domain, and refuses discrete-dividend inputs. It is correctly not the primary selected model. The report must continue to label it benchmark-only and surface domain refusal rather than substitute it silently.

### Resolver weaknesses

1. A flat $0.01 early-exercise premium threshold is not comparable across a $0.05 option, a $20 option, and different spreads.
2. The threshold does not depend on the quoted spread or option price.
3. American diagnostics are available, but scanner language does not always explain why BS was retained for an American-style ETF contract.
4. In Python, selected pricing can be made contingent on a separate American IV solve even when the scenario value itself is numerically sound.
5. Inferred style does not receive a large enough explicit confidence penalty.
6. Duplicate pricing/IV implementations exist in content.js, pricing-core.js, website TypeScript, and Python. Golden vectors reduce but do not eliminate drift.
7. Solver result objects contain status/reason/iterations/bounds/residual in Python, but not all fields survive to contract output. Live UI often shows RH IV without a separately labeled calculated selected-model IV.

### Required resolver policy

- European index contracts: select dividend-adjusted BS and explain the contract-style resolution.
- American contracts: compute BS and American diagnostics when feasible.
- Select American CRR only when the tree converges and agrees with trinomial.
- Treat the early-exercise premium as material when it exceeds `max($0.01, 10% of quoted spread, 0.5% of option price)`; otherwise allow BS as the selected fast/scanner value while displaying the negligible American premium.
- If the American model is unstable, visibly fall back to BS.
- If style is unknown or inferred from a weak symbol rule, lower confidence and warn.
- Keep thresholds configurable and persist every component of the decision.

## Edge and classification audit

The current sign conventions are internally meaningful:

- `vol_edge = forecast_vol - market_iv`: positive supports a long-vol interpretation.
- `variance_edge = market_iv² - forecast_vol²`: positive supports a short-vol interpretation.
- `midpoint_edge = RV-SCN - market_mid`: positive means the scenario value is above midpoint.
- `long_executable_edge = RV-SCN - ask`: positive survives a long entry at the ask.
- `short_executable_edge = bid - RV-SCN`: positive survives a short entry at the bid.
- `gamma_weighted_edge = 0.5*S²*gamma*(market variance - forecast variance)*T`: positive has the Haugh constant-gamma sign favorable to the short-vol side.

The principal risk is mixing these signs into absolute percentile ranks. Direction must be resolved first. If scenario-price and volatility directions disagree, the contract must be `mixed_signal`, not a clean opportunity.

The current executable screen needs a consistent locked/crossed-market policy, minimum tick/fee/slippage threshold, low-vega penalty, data-quality gate, forecast freshness gate, and explicit ratios to spread, vega, and option price.

## Ranking and overfit audit

The composite weights are transparent but heuristic. There is not enough quote-level historical outcome data to claim that 25/15/25/15/10/5/5 maximizes after-cost performance. Percentile ranking inside one snapshot also changes with the candidate universe and can reward a bad extreme quote.

Overfit can enter through:

- selecting among many forecast models and parameters on small horizon samples;
- optimizing dense blend weights that change materially at each rebalance;
- using multiple correlated edge features in one score;
- arbitrary IV percentile thresholds and DTE/moneyness buckets;
- tuning candidate thresholds after viewing paper outcomes;
- evaluating midpoint residuals instead of executable outcomes;
- ranking long and short signals together;
- reusing a regression specification without a frozen out-of-sample period;
- treating sparse historical buckets as equally reliable;
- outcome selection bias when only visually interesting contracts are expanded and recorded.

The upgrade should retain heuristic scoring until enough resolved outcomes exist, make every component visible, apply confidence multiplicatively, rank long and short separately, assign mixed signals no strong grade, and use walk-forward outcome evaluation only after an outcome is resolved before the next signal.

## UI audit

Misleading behaviors:

- “FV” is still visually dominant without always carrying `MKT-Q` or `RV-SCN` context.
- Green can appear from a positive midpoint difference even when the edge does not survive the ask/spread.
- Estimated IV can look almost identical to exact RH IV.
- Model tags do not explain an American-style option legitimately priced with BS because early-exercise value is negligible.
- A long tooltip is not a substitute for an inspectable contract diagnostic record.
- Data/session/forecast warnings are panel-level and not always contract-specific.
- Confidence is not decomposed and can imply more validation than exists.

The compact badge should be neutral by default and only turn signal-positive after executable, direction, data, model, liquidity, surface, and confidence gates. Clicking it should open an 11-section diagnostic view with the exact inputs, methods, score decomposition, warnings, and paper history.

## Test audit

### Existing strong coverage

- Black-Scholes call/put benchmarks, parity, Greeks, and IV recovery.
- Impossible IV and pricing-bound cases.
- CRR/trinomial convergence and American-versus-European relationships.
- Discrete-dividend behavior and cross-language golden vectors.
- Adaptive convergence, maximum-step fallback, and model selection metadata.
- EWMA/GARCH/HAR/blend walk-forward leakage controls and variance objectives.
- Nonnegative/unit-sum blend weights and positive forecast variance.
- SVI recovery, parameter constraints, residual/outlier, butterfly, and prior-only percentile behavior.
- Basic quote-quality, executable multi-leg structure, paper-only/no-order, and paper outcome regression tests.
- Website/extension pricing parity checks.

### Missing or incomplete coverage

- Unified stale option/underlying/mixed-session/partial-scan/DOM-parse states.
- Proof that a captured-at timestamp is not presented as an exchange timestamp.
- Trading-day DTE and variance interpolation between horizons.
- Explicit 0DTE and daily-only 1DTE confidence suppression.
- Forecast artifact staleness and parameter/model stability diagnostics.
- All four surface-shift methods and nonnegative/sanity-bounded strike forecasts.
- Live/offline equivalence for strike-specific forecast volatility.
- Spread/price-relative early-exercise resolver threshold.
- Exact versus estimated RH Mark/IV badge behavior.
- Mixed-sign classification and separate long/short ranking.
- Data-quality and historical-sample penalties in final grade.
- Full sample-contract-to-badge integration under exact, estimated, mixed-session, American-negligible, American-material, SVI, fallback, and low-liquidity cases.
- 5/30/EOD paper outcome fields and attribution identities.
- Runtime regression gates for a full visible chain.
- Automated scan proving no trade/order API or DOM click path is introduced.

## Highest-priority fixes

1. **Unify contract data state.** Carry parse identity, scan identity, source/capture timestamps, session, bid/ask validity, exact/estimated state, liquidity availability, and explicit warnings into one `data_quality_score` used by badge, alerts, ranking, and paper records.
2. **Make MKT-Q and RV-SCN impossible to confuse.** Rename fields and labels, neutralize market-consistency diagnostics, and reserve signal color for executable filtered RV-SCN edges.
3. **Harden the resolver.** Add spread/price-relative premium materiality, preserve convergence/disagreement diagnostics, clarify inferred style, and persist IV solver details.
4. **Replace nearest calendar horizon.** Use trading-day DTE, variance-space interpolation, explicit exact/interpolated/extrapolated/unavailable states, forecast-file freshness, and 0DTE/1DTE warnings.
5. **Make surface transformation explicit and shared.** Default to total-variance/variance-space preservation, support all four methods, add sanity checks, and apply the same strike-specific transformation offline and live.
6. **Rebuild candidate classification before scoring.** Require directional agreement and executable edges; reject invalid data; apply tick/fees/spread/vega/liquidity thresholds; classify mixed/data/liquidity/model/surface warnings explicitly.
7. **Make score uncertainty visible.** Separate long/short rankings, show components, shrink historical context by sample count, penalize forecast and model instability, cap grades by confidence, and label weights heuristic.
8. **Add a clicked-contract diagnostic panel.** Expose quote provenance, both volatility roles, horizon mapping, surface transform, model comparison, edges, filters, history, score, paper state, and limitations.
9. **Expand paper outcomes.** Add 5/15/30/60/EOD executable outcomes and the requested attribution fields without claiming fill probability or profit validation.
10. **Add honest intraday/event/jump architecture.** Disable 0DTE high-confidence ranking without minute data, flag daily-only short-DTE use, publish a simple historical jump diagnostic, and mark event-calendar data unavailable rather than invent it.

## Acceptance gates for the upgrade

- No exact/estimated/stale/mixed quote can be ambiguous in a badge or record.
- No 0DTE contract can receive a high-confidence candidate grade from the daily model.
- A contract between supported horizons reports its trading-day target, interpolation method, and weights.
- Live and offline strike-vol mapping use the same documented method and bounds.
- Every selected pricing model has a user-readable reason, numerical status, and warning path.
- No mixed signal receives an A grade.
- No edge smaller than spread/tick/estimated-cost thresholds is labeled executable.
- Market-IV repricing is always labeled diagnostic.
- Scenario pricing is always labeled conditional and non-arbitrage.
- All existing and new unit/integration tests pass.
- The extension retains no order API, order construction, or automated trade action.
- Documentation lists daily-data, intraday, jump/event, Treasury-proxy, dividend-estimate, Robinhood-DOM, forecast, model, execution, and overfit limitations.

## Deliberately deferred claims

This upgrade cannot validate trading alpha without a sufficiently large timestamped historical option NBBO dataset synchronized with the underlying. It will add a defensible research and outcome-measurement framework, not manufacture a profitable backtest from the current small sample. Intraday variance and official event calendars will remain unavailable unless real inputs exist. The interface must say so.

## Post-implementation disposition

The 2.4 hardening release closes the ten prioritized engineering items above:

- A shared live/offline quote-state vocabulary now gates ranking and records capture/source timestamps, session, scan completeness, parse warnings, bid/ask validity, and liquidity. Stale option and stale underlying states are distinct.
- Badges and diagnostics use `MKT-Q` only for market-implied repricing and `RV-SCN` only for the conditional realized-volatility scenario. Signal color requires a clean executable classification.
- The resolver uses a spread/price-relative early-exercise threshold, preserves CRR/trinomial/convergence metadata, and no longer changes a valid price model solely because a secondary IV inversion fails.
- Trading-day DTE, variance-space interpolation, exact/interpolated/extrapolated/unavailable methods, forecast freshness, and low-confidence 0DTE/1DTE policy are shared between live and offline paths.
- Additive IV, multiplicative IV, variance, and total-variance strike transforms are configurable, bounded, and tested; total variance is the default.
- Long and short candidates require agreement between volatility direction and executable ask/bid edge. Mixed directions and data/model/surface warnings receive no clean grade.
- Confidence is decomposed into data, forecast freshness/validation, horizon, surface, historical context, pricing stability, rates, dividends, and event coverage. It is explicitly heuristic.
- Clicked badges expose the requested eleven-section diagnostic view.
- Paper tracking now reports 5/15/30/60-minute and same-session EOD executable outcomes, option-only and initial-delta-hedged P&L, underlying/IV/spread changes, theta estimate, and realized-variance proxy.
- Daily-only short-DTE, unavailable intraday model, unavailable scheduled-event calendar, and historical jump-risk limitations are explicit rather than imputed.

Validation completed on 2026-08-13: 42 JavaScript extension/pricing tests, 75 Python pricing/research tests, 6 strategy tests, 9 website/replay tests, a production web build, and a full SPY artifact regeneration. The repository-wide lint command still reports pre-existing React effect/purity, internal-link, and generated Cloudflare typing rules; the production build and behavioral suites pass.

Still deliberately deferred: true OPRA/NBBO timestamps, an official holiday/event/dividend ingestion service, minute/tick intraday variance, OIS curve bootstrapping, repeated hedge execution/fees/assignment, and any claim of profitable alpha. Those require real synchronized data, not another formula or tuned constant.
