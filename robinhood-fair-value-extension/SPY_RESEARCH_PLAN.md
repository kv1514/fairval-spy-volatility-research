# FairVal SPY research plan — version 2.1

## Mandate

FairVal is restricted to SPY for the current research phase. The extension may still calculate a model value on another visible chain, but the strategy lab must not rank a non-SPY structure. Every ranked row is a paper-research candidate, not a recommendation or an order instruction.

## What changes continuously

- The displayed fair value is recalculated every second from the currently visible SPY spot, time to expiration, rate, dividend/carry input, and selected volatility forecast.
- Exact Robinhood Mark/IV, bid, ask, volume, and open interest are rescanned every 30 seconds by default; the interval remains configurable from 15–300 seconds.
- The walk-forward realized-volatility forecast is a daily model. It should change only after a new completed daily close enters the training data. A forecast older than four calendar days is visibly marked stale and cannot produce a research flag or strategy candidate.
- Later ThetaData integration should replace DOM clicking with synchronized NBBO updates. It should not change the distinction between continuously moving market quotes and a once-daily forecast origin.

## Strategy families

### 1. Delta-hedged variance candidate — paper only

The signal requires price and variance signs to agree:

- Long-vol candidate: forecast volatility is above market IV and forecast-volatility fair value is above the executable ask.
- Short-vol candidate: market IV is above forecast volatility and the executable bid is above forecast-volatility fair value.

The paper recorder saves the option delta and separately reports option P&L, SPY hedge P&L, and their gross delta-hedged sum. Option entry and exit use ask/bid. SPY hedge transaction costs are not yet deducted, so the delta-hedged result remains a gross diagnostic.

### 2. Defined-risk vertical relative value

For adjacent or near-adjacent strikes, FairVal prices the entire vertical rather than adding two independent single-leg alerts. A candidate must have positive model-versus-executable edge after crossing both legs and must exceed the estimated full quoted round-trip friction.

- Call debit vertical: bullish directional and relative-value exposure.
- Call credit vertical: bearish defined-risk premium exposure.
- Put debit vertical: bearish directional and relative-value exposure.
- Put credit vertical: bullish defined-risk premium exposure.

These structures are not pure volatility trades. Net delta, gamma, vega, executable debit/credit, maximum loss, and maximum profit must remain visible.

### 3. Equal-width butterfly curvature research

Long and short call/put butterflies test whether local smile curvature produces a multi-leg discrepancy. The extension uses exact executable prices for all three legs, requires equal strike widths, and rejects a candidate unless its edge exceeds the full quoted friction. Butterflies receive a modest ranking preference because they generally isolate local curvature with less net delta than an outright option, but this is a research prior—not proof of alpha.

### 4. Calendar and risk-reversal research — deferred

Calendars require synchronized quotes for multiple expirations. Risk reversals require synchronized put and call surfaces. The Robinhood DOM only exposes one selected side and expiration reliably, so these strategies remain deferred until the ThetaData pipeline can provide full timestamp-aligned chains.

## Forecast models

The walk-forward selector now includes:

- realized-volatility baselines;
- fixed, optimized, and sparse variance blends;
- coarse-to-fine EWMA;
- a ridge-stabilized log-HAR variance model using daily, weekly, monthly, and downside-return components.

Every candidate model is trained only on targets whose realized window finished before the forecast origin. Model selection minimizes historical out-of-sample variance error. On the currently bundled SPY daily sample, HAR has the lowest full-sample variance error at 5- and 10-day horizons, while EWMA is strongest at 1–3 days. The live payload therefore keeps horizon-specific walk-forward selection instead of declaring one global winner.

HAR-RV background: Fulvio Corsi, “A Simple Approximate Long-Memory Model of Realized Volatility,” *Journal of Financial Econometrics* 7(2), 2009: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1365738

## Gates applied before ranking

Every leg must have:

- an exact quote captured within two minutes;
- valid bid no greater than ask;
- price of at least $0.10;
- spread no wider than the configured percentage;
- volume of at least 10 or open interest of at least 100;
- a matched historical SPY option-type/DTE/moneyness IV bucket;
- a current independent volatility forecast.

Every structure must additionally:

- survive executable bid/ask on every leg;
- exceed at least one full quoted round-trip spread estimate;
- exceed the configured minimum percentage edge;
- disclose net delta, gamma, vega, maximum loss, and whether the candidate is paper-only.

Research on option returns repeatedly shows that bid/ask costs can consume apparent profitability. Goyal and Saretto explicitly analyze historical-versus-implied volatility signals using straddles and delta-hedged calls, while transaction-cost adjustments materially reduce returns: https://www.sciencedirect.com/science/article/pii/S0304405X09001251

## Surface discipline

The model must not classify normal SPY downside skew as a free short-vol opportunity. Candidate IV is compared with the same historical option-type, DTE, and moneyness bucket. Local curvature and calendar checks should eventually be performed against an arbitrage-controlled surface; Gatheral and Jacquier show how SVI can be calibrated without static butterfly and calendar arbitrage: https://arxiv.org/abs/1204.0646

## Required next dataset

The current ThetaData sample is excellent for parser and one-day replay testing but contains only August 19, 2025. It cannot select thresholds or validate performance. The next research run should use:

- at least 12 months of SPY option NBBO history;
- a separate untouched three- to six-month holdout;
- calls and puts from 0–10 DTE;
- synchronized SPY underlying quotes;
- open interest, trade conditions, quote conditions, dividends, and rates;
- one-second chains for broad screening and tick data around candidate entry/exit windows.

The research loop is: forecast variance, fit a clean surface, generate single- and multi-leg residuals, apply liquidity/regime gates, simulate executable fills, attribute option/hedge P&L, evaluate untouched dates, and reject rules that do not survive costs.
