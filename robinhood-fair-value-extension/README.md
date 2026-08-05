# Robinhood Fair Value Overlay

A local Chrome extension that reads any classic single-stock, ETF, or supported-index option chain visible in Robinhood and adds a strike-specific `FV`, implied-volatility basis, and quote-quality-gated research flag beside every rendered contract.

## What it does

- Uses Robinhood's visible ticker, underlying share price, expiration, strike, option type, and displayed price.
- Recalculates as Robinhood's virtualized option chain updates.
- Reads Robinhood's exact Mark and displayed IV whenever a contract is expanded, and caches them for that chain.
- Provides **Scan visible Mark IVs** to expand each rendered strike in sequence and capture Robinhood's exact values without placing or preparing an order.
- Uses a clearly starred Ask-implied IV estimate only for rows that have not yet been expanded or scanned.
- Builds an outlier-resistant local IV smile for relative fair-value comparisons. A contract's own quote is excluded from its fair-IV estimate, and robust local regression reduces contamination from a bad neighboring quote.
- When Robinhood displays an extended-hours ETF price beside a frozen option quote, removes the displayed after-hours or pre-market move and uses the regular-session close paired with that quote.
- Fetches the official U.S. Treasury CMT curve and interpolates a rate for the selected expiration.
- Supports arbitrary Robinhood option tickers, including symbols with share-class punctuation and digits.
- After three or more fresh Mark/IV pairs are scanned on expirations of at least seven days, calibrates a robust chain-implied dividend/carry yield. This avoids assuming that every stock has the same yield.
- Retains expiration-aware public dividend fallbacks for SPY, SPX, and QQQ. Other tickers use an explicitly labeled 0% fallback until enough exact quotes are scanned; manual dividend input remains available.
- Highlights only fresh, liquid contracts whose modeled edge extends past the executable ask/bid, clears the configured percentage threshold, and is not explained by a wide spread.
- Makes no brokerage-data requests, does not read account credentials, and cannot place orders. Its only external request is the public Treasury curve.

The model is European-style Black–Scholes. Most U.S. single-stock and ETF contracts are American-style, so their values remain approximations even with chain-calibrated carry. SPX options are European-style, but standard AM-settled and SPXW PM-settled series can have different expiration timing that Robinhood's visible chain does not always identify.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this entire `robinhood-fair-value-extension` folder.
5. Open a Robinhood classic option chain for any available stock, ETF, or supported index.

When updating an already loaded copy, click the extension's **Reload** button on `chrome://extensions`, then refresh Robinhood.

The floating panel appears at the lower left. Click **Scan visible Mark IVs** once after opening a chain to capture the exact Mark and IV for every currently rendered contract. The scan only clicks strike labels to reveal public contract details; it never clicks Robinhood's green `+` order button.

A small `FV $x.xx` badge is added beside each visible Robinhood price. `RH IV 20.35%` means Robinhood's exact displayed Mark IV was captured. `Ask IV 20.5%*` is an estimated ask-implied IV because that row has not been scanned yet. Hover a badge to see the full price basis.

## Research flags

The green or red `FLAG` treatment is an idea-generation screen, not a buy/sell instruction. A fresh scanned contract is flagged only when:

- the model value remains beyond the ask for a below-model candidate, or beyond the bid for an above-model candidate;
- that executable edge exceeds the selected **Minimum edge %** and at least half the full bid/ask spread;
- the full spread is no wider than **Maximum spread %** of Mark;
- volume is at least 10 contracts or open interest is at least 100; and
- the exact quote was captured within the last two minutes.

For an arbitrary ticker, flags remain disabled until chain-implied carry is calibrated from at least three eligible Mark/IV pairs, or the user turns off automatic dividends and supplies a manual dividend/carry assumption. This prevents an unknown 0% dividend fallback from masquerading as a pricing opportunity.

The panel ranks up to five flags by edge-to-spread coverage. A flag means “review this contract and its assumptions,” not “place this trade.” Rescan before relying on a flag because Robinhood's collapsed rows do not expose continuously updating Mark/IV data.

## Reading the result

- **Smoothed market smile** is the default relative-value screen. Fair value uses the nearest lower and upper strikes' IVs, linearly interpolated at the contract's strike. Scan the visible rows first to build this from Robinhood's exact Mark IVs instead of ask-derived estimates.
- **Individual market IV** uses each contract's raw quote-implied IV. With a zero IV shift, the model necessarily reproduces the quote used to infer IV; this mode is diagnostic, not an independent fair value.
- **Manual IV** applies one user-entered volatility to all visible strikes.
- **Fair-IV shift** adds or subtracts volatility points from whichever IV model is selected so you can test your own volatility view.
- **Minimum edge %** controls how far the model must remain beyond the executable ask or bid before a contract is flagged.
- **Maximum spread %** rejects illiquid quotes whose spread can explain the apparent discrepancy.
- A positive difference means the model value is above Robinhood's displayed reference price; a negative difference means it is below. It is not a buy or sell recommendation and does not estimate execution probability.

For scanned rows, the extension compares fair value with Robinhood's exact Mark and reports Robinhood's displayed IV verbatim. For unscanned rows, it compares with the visible Ask/Bid/Mark column and marks the calculated IV with `*`.

## Market-input sources

- Risk-free curve: U.S. Department of the Treasury Daily Treasury Par Yield Curve Rates, refreshed when the extension starts and cached locally.
- Arbitrary stocks/ETFs: robust effective carry inferred from three or more fresh, near-the-money Robinhood Mark/IV pairs for expirations of at least seven days; otherwise an explicitly labeled 0% fallback or the user's manual input.
- SPY: State Street's indicated S&P 500 index dividend yield and published quarterly ex-date schedule when chain calibration is unavailable.
- SPX: S&P Dow Jones Indices' S&P 500 dividend yield, modeled as a continuous index yield.
- QQQ: annualized recent QQQ distributions, converted into estimated quarterly cash dividends and applied only when an ex-date falls before expiration.

These are transparent screen-grade approximations, not OPRA/Cboe professional analytics. Cboe's production methodology uses NBBO data, a full interest-rate curve, forward discrete-dividend forecasts, and an American-style model where applicable. The extension therefore labels output as research candidates rather than trade recommendations.

See [SOURCES.md](SOURCES.md) for the source URLs, as-of dates, embedded fallback curve, and interpretation notes.

## Reproducible simulation

Run the deterministic stress harness with Node.js:

```text
node tests/simulation.mjs [seed] [chain-count] [formula-case-count]
```

The default run covers 5,000 formula inversions and 1,000 synthetic call/put chains across stock prices, expirations, IV smiles, carry rates, spreads, quote noise, and injected 20%–40% mispricings. See [SIMULATION_RESULTS.md](SIMULATION_RESULTS.md) for the latest results and limitations.
