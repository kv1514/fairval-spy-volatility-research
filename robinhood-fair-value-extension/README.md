# Robinhood Fair Value Overlay

A local Chrome extension that reads the option chain already visible in Robinhood and adds a Black–Scholes `FV` badge beside every rendered strike.

## What it does

- Uses Robinhood's visible ticker, underlying share price, expiration, strike, option type, and displayed price.
- Recalculates as Robinhood's virtualized option chain updates.
- Supports editable volatility, risk-free rate, and dividend-yield assumptions.
- Can use the selected contract's displayed IV as a shared volatility assumption across the visible chain.
- Makes no network requests, does not read account credentials, and cannot place orders.

The model is European-style Black–Scholes with continuous dividends. SPY and QQQ contracts are American-style, so their model values remain approximations. SPX options are European-style, but AM- and PM-settled series can have different expiration timing.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this entire `robinhood-fair-value-extension` folder.
5. Open a Robinhood classic option chain for SPY, SPX, or QQQ.

The floating panel appears at the lower left. A small `FV $x.xx` badge is added beside each visible Robinhood price. Hover a badge to see the difference versus Robinhood's active Ask, Bid, or Mark column.

## Reading the result

- **Manual IV** is the useful independent comparison: you supply your volatility view.
- **Selected-row IV** reads IV from the expanded Robinhood contract and applies that one IV across visible strikes. It is convenient, but it does not reproduce the full volatility smile.
- A positive difference means the model value is above Robinhood's displayed reference price; a negative difference means it is below. It is not a buy or sell recommendation and does not estimate execution probability.

Robinhood can switch between natural and mark pricing. The extension compares against the exact price column currently rendered on the page.
