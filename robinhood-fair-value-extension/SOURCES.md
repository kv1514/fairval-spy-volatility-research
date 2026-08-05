# Model inputs and sources

As of August 4, 2026.

## Methodology

- [Cboe American- and European-Style Theoretical Options Calculation Methodology](https://cdn.cboe.com/api/global/us_indices/governance/Cboe_American_and_European-Style_Theoretical_Options_Calculation_Methodology.pdf): Cboe describes a strike/maturity volatility surface, U.S. Constant Maturity Treasury rates interpolated to each expiration, discrete dividend forecasts for American-style ETF options, and Black–Scholes for European-style index options.
- The extension follows the same input hierarchy at a screen-grade level. It cannot reproduce Cboe analytics without OPRA NBBO data, a professional forward-dividend database, and a full American exercise model.

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
- `Fair-IV shift` is the user's independent volatility view in percentage points. It is the cleanest way to test a bullish or bearish volatility assumption without discarding the observed smile.

All outputs are model estimates, not trade recommendations.
