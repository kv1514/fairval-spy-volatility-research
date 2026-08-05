# Robinhood Fair Value Overlay

A local Chrome extension that reads the option chain already visible in Robinhood and adds a strike-specific `FV` and implied-volatility badge beside every rendered contract.

## What it does

- Uses Robinhood's visible ticker, underlying share price, expiration, strike, option type, and displayed price.
- Recalculates as Robinhood's virtualized option chain updates.
- Inverts each visible quote to calculate that contract's own market-implied volatility.
- Builds a locally smoothed strike-by-strike IV smile for relative fair-value comparisons.
- When Robinhood displays an extended-hours ETF price beside a frozen option quote, removes the displayed after-hours or pre-market move and uses the regular-session close paired with that quote.
- Fetches the official U.S. Treasury CMT curve and interpolates a rate for the selected expiration.
- Uses separate dividend assumptions for SPY, SPX, and QQQ. Short-dated SPY/QQQ expirations include only estimated quarterly dividends occurring before expiry.
- Makes no brokerage-data requests, does not read account credentials, and cannot place orders. Its only external request is the public Treasury curve.

The model is European-style Black–Scholes. SPY and QQQ contracts are American-style, so their values remain approximations even with expiration-aware dividends. SPX options are European-style, but standard AM-settled and SPXW PM-settled series can have different expiration timing that Robinhood's visible chain does not always identify.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this entire `robinhood-fair-value-extension` folder.
5. Open a Robinhood classic option chain for SPY, SPX, or QQQ.

When updating an already loaded copy, click the extension's **Reload** button on `chrome://extensions`, then refresh Robinhood.

The floating panel appears at the lower left. A small `FV $x.xx` badge is added beside each visible Robinhood price. Hover a badge to see the difference versus Robinhood's active Ask, Bid, or Mark column.

## Reading the result

- **Smoothed market smile** is the default relative-value screen. Every contract gets its own quote-implied IV, while fair value uses a locally smoothed strike-specific IV to reduce one-quote bid/ask noise.
- **Individual market IV** uses each contract's raw quote-implied IV. With a zero IV shift, the model necessarily reproduces the quote used to infer IV; this mode is diagnostic, not an independent fair value.
- **Manual IV** applies one user-entered volatility to all visible strikes.
- **Fair-IV shift** adds or subtracts volatility points from whichever IV model is selected so you can test your own volatility view.
- A positive difference means the model value is above Robinhood's displayed reference price; a negative difference means it is below. It is not a buy or sell recommendation and does not estimate execution probability.

Robinhood can switch between natural and mark pricing. The extension compares against the exact price column currently rendered on the page.

## Market-input sources

- Risk-free curve: U.S. Department of the Treasury Daily Treasury Par Yield Curve Rates, refreshed when the extension starts and cached locally.
- SPY: State Street's indicated S&P 500 index dividend yield and published quarterly ex-date schedule.
- SPX: S&P Dow Jones Indices' S&P 500 dividend yield, modeled as a continuous index yield.
- QQQ: annualized recent QQQ distributions, converted into estimated quarterly cash dividends and applied only when an ex-date falls before expiration.

These are transparent public-data approximations, not OPRA/Cboe professional analytics. Cboe's production methodology uses NBBO data, a full interest-rate curve, forward discrete-dividend forecasts, and an American-style binomial model for ETF options.

See [SOURCES.md](SOURCES.md) for the source URLs, as-of dates, embedded fallback curve, and interpretation notes.
