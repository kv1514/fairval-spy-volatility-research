# Model inputs and sources

As of August 5, 2026.

## Methodology

- [Bollerslev, “Generalized Autoregressive Conditional Heteroskedasticity” (1986)](https://public.econ.duke.edu/~boller/Published_Papers/joe_86.pdf): primary basis for the variance-targeted GARCH(1,1) conditional-variance forecast and Gaussian quasi-likelihood fit.
- [Glosten, Jagannathan, and Runkle, “On the Relation between the Expected Value and the Volatility of the Nominal Excess Return on Stocks” (1993)](https://doi.org/10.1111/j.1540-6261.1993.tb05128.x): primary basis for allowing negative and positive SPY innovations to affect conditional variance differently in `gjr_garch`.
- [Corsi, “A Simple Approximate Long-Memory Model of Realized Volatility” (2009)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1365738): basis for the daily/weekly/monthly HAR variance regression.
- [Patton, “Volatility Forecast Comparison Using Imperfect Volatility Proxies” (2011)](https://public.econ.duke.edu/~ap172/Patton_robust_JoE_forthcoming.pdf): basis for reporting QLIKE alongside variance MSE when the realized-volatility target is noisy.
- [Hansen and Lunde, “A Forecast Comparison of Volatility Models: Does Anything Beat a GARCH(1,1)?” (2005)](https://doi.org/10.1002/jae.800): supports retaining a plain GARCH benchmark and testing asymmetric models out of sample rather than presuming complexity wins.

- [Cox, Ross, and Rubinstein, “Option Pricing: A Simplified Approach” (1979)](https://doi.org/10.1016/0304-405X(79)90015-1): the primary CRR discrete-time, no-arbitrage foundation for the binomial implementation.
- [Barone-Adesi and Whaley, “Efficient Analytic Approximation of American Option Values” (1987)](https://doi.org/10.1111/j.1540-6261.1987.tb02569.x): the primary source for the fast quadratic American approximation used as a scanner benchmark.
- [OCC Characteristics and Risks of Standardized Options](https://www.theocc.com/company-information/documents-and-archives/options-disclosure-document): primary contract-risk and exercise-style definitions. OCC notes that index options may be American- or European-style, which is why FairVal keeps style mapping configurable and warns when it is inferred.
- [Cboe American- and European-Style Theoretical Options Calculation Methodology](https://cdn.cboe.com/api/global/us_indices/governance/Cboe_American_and_European-Style_Theoretical_Options_Calculation_Methodology.pdf): Cboe describes a strike/maturity volatility surface, U.S. Constant Maturity Treasury rates interpolated to each expiration, discrete dividend forecasts for American-style ETF options, and Black–Scholes for European-style index options.
- [Cboe LiveVol methodology FAQ](https://datashop.cboe.com/faqs): Cboe states that option mid-price is normally used for implied volatility and that NBBO inputs are used. This supports using Robinhood's displayed Mark/IV pair instead of treating Ask IV as equivalent.
- [SEC Investor.gov bid/ask definition](https://www.investor.gov/introduction-investing/investing-basics/glossary/ask-price): the bid/ask difference is the spread. The research-flag filter requires modeled edge beyond an executable-side quote and rejects spreads above the user-set threshold.
- [SEC Investor Bulletin: An Introduction to Options](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-63): options involve material risks and trade across multiple marketplaces. Extension flags are deliberately presented as research candidates, not final recommendations.
- The extension follows the same input hierarchy at a screen-grade level. It now includes American CRR, trinomial, and Barone-Adesi/Whaley calculations, but it still cannot reproduce professional analytics without OPRA NBBO data, contract-reference style fields, and a forward discrete-dividend database.

## Risk-free rates

- [U.S. Treasury Daily Treasury Par Yield Curve Rates](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value=2026)
- The extension retrieves the public Treasury XML feed when it starts, caches the latest curve locally, and applies a natural cubic spline to the selected expiration.
- Embedded August 4, 2026 fallback points: 1M 3.78%, 1.5M 3.80%, 2M 3.85%, 3M 3.89%, 4M 3.91%, 6M 4.00%, 1Y 4.04%, and 2Y 4.20%.

## Dividends

- SPY: [State Street SPY fund page](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy) reported a 1.11% indicated index dividend yield as of August 3, 2026. [State Street's 2026 distribution schedule](https://www.ssga.com/library-content/products/fund-data/etfs/us/distribution/SPDR_Dividend_Distribution_Schedule.pdf) identifies SPY's quarterly ex-dates.
- SPX: [S&P Dow Jones Indices](https://www.spglobal.com/spdji/en/education/article/talkingpoints-why-dividend-and-capital-return-strategies-have-stood-out-in-2026/) reported a 1.12% trailing S&P 500 dividend yield as of April 30, 2026. The extension uses 1.12% as a continuous index-yield approximation.
- QQQ: [Invesco QQQ](https://www.invesco.com/qqq-etf/en/home.html) distributes quarterly. The 0.44% annual assumption is based on the latest four quarterly distributions through June 2026 relative to the current QQQ level. The extension converts it to estimated quarterly cash dividends and includes only ex-dates before expiration.

## Interpreting the IV modes

- `Individual market IV` solves for the volatility that reproduces each displayed Robinhood quote. With a zero IV shift, fair value equals that quote by construction.
- `Smoothed market smile` is the default relative-value screen. It calculates each contract's quote-implied IV, smooths neighboring strike IVs, and prices each strike from that local fair-IV surface.
- `Own forecast + market skew` replaces the market surface's ATM level with the user's independent realized-volatility forecast while retaining the contemporaneous strike skew. `IV EDGE` is model/fair IV minus the individual contract's market IV.
- `Flat own-vol forecast` applies the user's independent volatility forecast to every strike and deliberately discards market skew.
- `Fair-IV shift` is the user's independent volatility view in percentage points. It is the cleanest way to test a bullish or bearish volatility assumption without discarding the observed smile.

## Historical replay data

- Robinhood `get_option_historicals`: fixed hourly trade-price OHLC bars for 264 expired SPY call and put contracts across 12 expirations.
- Robinhood `get_equity_historicals`: split-adjusted regular-session SPY OHLCV bars aligned to the option timestamps.
- The returned option history does not contain historical bid/ask or NBBO. The replay therefore uses explicit cost haircuts and is labeled a trade-bar diagnostic, not an executable backtest.

All outputs are model estimates, not trade recommendations.
