# Robinhood Fair Value Overlay

A local Chrome extension that reads the option chain already visible in Robinhood and adds a strike-specific `FV` and implied-volatility badge beside every rendered contract.

## What it does

- Uses Robinhood's visible ticker, underlying share price, expiration, strike, option type, and displayed price.
- Recalculates as Robinhood's virtualized option chain updates.
- Reads Robinhood's exact Mark and displayed IV whenever a contract is expanded, and caches them for that chain.
- Provides **Scan visible Mark IVs** to expand each rendered strike in sequence and capture Robinhood's exact values without placing or preparing an order.
- Uses a clearly starred Ask-implied IV estimate only for rows that have not yet been expanded or scanned.
- Builds a neighbor-interpolated strike-by-strike IV smile for relative fair-value comparisons. A contract's own quote is excluded from its fair-IV estimate so one noisy quote cannot define its own fair value.
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

The floating panel appears at the lower left. Click **Scan visible Mark IVs** once after opening a chain to capture the exact Mark and IV for every currently rendered contract. The scan only clicks strike labels to reveal public contract details; it never clicks Robinhood's green `+` order button.

A small `FV $x.xx` badge is added beside each visible Robinhood price. `RH IV 20.35%` means Robinhood's exact displayed Mark IV was captured. `Ask IV 20.5%*` is an estimated ask-implied IV because that row has not been scanned yet. Hover a badge to see the full price basis.

## Reading the result

- **Smoothed market smile** is the default relative-value screen. Fair value uses the nearest lower and upper strikes' IVs, linearly interpolated at the contract's strike. Scan the visible rows first to build this from Robinhood's exact Mark IVs instead of ask-derived estimates.
- **Individual market IV** uses each contract's raw quote-implied IV. With a zero IV shift, the model necessarily reproduces the quote used to infer IV; this mode is diagnostic, not an independent fair value.
- **Manual IV** applies one user-entered volatility to all visible strikes.
- **Fair-IV shift** adds or subtracts volatility points from whichever IV model is selected so you can test your own volatility view.
- A positive difference means the model value is above Robinhood's displayed reference price; a negative difference means it is below. It is not a buy or sell recommendation and does not estimate execution probability.

For scanned rows, the extension compares fair value with Robinhood's exact Mark and reports Robinhood's displayed IV verbatim. For unscanned rows, it compares with the visible Ask/Bid/Mark column and marks the calculated IV with `*`.

## Market-input sources

- Risk-free curve: U.S. Department of the Treasury Daily Treasury Par Yield Curve Rates, refreshed when the extension starts and cached locally.
- SPY: State Street's indicated S&P 500 index dividend yield and published quarterly ex-date schedule.
- SPX: S&P Dow Jones Indices' S&P 500 dividend yield, modeled as a continuous index yield.
- QQQ: annualized recent QQQ distributions, converted into estimated quarterly cash dividends and applied only when an ex-date falls before expiration.

These are transparent public-data approximations, not OPRA/Cboe professional analytics. Cboe's production methodology uses NBBO data, a full interest-rate curve, forward discrete-dividend forecasts, and an American-style binomial model for ETF options.

See [SOURCES.md](SOURCES.md) for the source URLs, as-of dates, embedded fallback curve, and interpretation notes.
