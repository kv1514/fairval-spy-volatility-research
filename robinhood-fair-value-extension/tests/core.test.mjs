import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../content.js", import.meta.url), "utf8");
const context = vm.createContext({
  Date,
  Intl,
  Math,
  Number,
  Object,
  String,
  clearTimeout,
  console,
  setTimeout,
});
context.globalThis = context;
vm.runInContext(source, context);
const core = context.__BSFV_CORE__;

test("matches the standard Black-Scholes reference result", () => {
  const result = core.calculateBlackScholes({
    spot: 100,
    strike: 100,
    days: 365,
    volatility: 20,
    rate: 5,
    dividend: 0,
  });
  assert.ok(Math.abs(result.call - 10.4506) < 0.001);
  assert.ok(Math.abs(result.put - 5.5735) < 0.001);
});

test("parses the visible Robinhood option-chain fields", () => {
  assert.deepEqual(
    { ...core.parseHeading("SPY buy Call") },
    { ticker: "SPY", seriesTicker: "SPY", side: "buy", optionType: "call" },
  );
  assert.equal(core.parseHeading("SPXW buy Put").ticker, "SPX");
  assert.equal(core.parseHeading("BRK.B buy Call").ticker, "BRK.B");
  assert.equal(core.parseHeading("A1BC sell Put").ticker, "A1BC");
  assert.equal(core.parseMoney("$1.50"), 1.5);
  assert.equal(core.parseMoney("—"), null);
  assert.equal(core.extractSelectedIv("Implied volatility18.22%Open interest566"), 18.22);
  assert.equal(
    core.parseExpirationLabel("Expiring August 5 (1d)", new Date("2026-08-04T20:00:00Z")),
    "2026-08-05",
  );
});

test("parses Robinhood's exact expanded Mark and displayed IV", () => {
  const quote = core.parseExpandedContract(`
SPY $775 Call 8/5
Bid
$1.10 × 14
Mark
$1.13
High
$1.79
Last trade
$1.15
Volume
91,963
Ask
$1.15 × 128
Previous close
$0.03
Low
$0.03
Implied volatility
20.35%
Open interest
2,886
The Greeks
Delta
0.2848
`);
  assert.deepEqual(
    { ...quote },
    {
      ticker: "SPY",
      seriesTicker: "SPY",
      strike: 775,
      optionType: "call",
      expirationLabel: "8/5",
      bid: 1.1,
      mark: 1.13,
      ask: 1.15,
      volume: 91963,
      openInterest: 2886,
      iv: 20.35,
    },
  );
});

test("fair-smile interpolation excludes the contract's own noisy IV", () => {
  const iv = core.smoothedVolatility(
    105,
    [
      { strike: 100, iv: 20 },
      { strike: 105, iv: 40 },
      { strike: 110, iv: 30 },
    ],
    105,
  );
  assert.equal(iv, 25);
});

test("uses the New York option close for intraday expiry", () => {
  const days = core.daysToExpiration("2026-08-04", Date.parse("2026-08-04T20:00:00Z"));
  assert.ok(Math.abs(days - 15 / 1440) < 1e-9);
});

test("recovers a different implied volatility for each option quote", () => {
  const shared = { spot: 100, days: 30, rate: 4, dividend: 1, optionType: "call" };
  const firstPrice = core.calculateBlackScholes({ ...shared, strike: 95, volatility: 18 }).call;
  const secondPrice = core.calculateBlackScholes({ ...shared, strike: 105, volatility: 27 }).call;
  const firstIv = core.impliedVolatility({ ...shared, strike: 95, marketPrice: firstPrice });
  const secondIv = core.impliedVolatility({ ...shared, strike: 105, marketPrice: secondPrice });
  assert.ok(Math.abs(firstIv - 18) < 0.001);
  assert.ok(Math.abs(secondIv - 27) < 0.001);
});

test("recovers an effective dividend/carry yield from a Mark and IV pair", () => {
  const shared = {
    optionType: "call",
    spot: 200,
    strike: 205,
    days: 90,
    volatility: 32,
    rate: 4.1,
  };
  const marketPrice = core.calculateBlackScholes({ ...shared, dividend: 2.75 }).call;
  const inferred = core.impliedDividendYield({ ...shared, marketPrice });
  assert.ok(Math.abs(inferred - 2.75) < 0.001);
  const putPrice = core.calculateBlackScholes({ ...shared, dividend: 2.75 }).put;
  const inferredPut = core.impliedDividendYield({ ...shared, optionType: "put", marketPrice: putPrice });
  assert.ok(Math.abs(inferredPut - 2.75) < 0.001);
});

test("builds a robust all-stock carry input from fresh liquid scanned quotes", () => {
  const now = Date.parse("2026-08-04T20:00:00Z");
  const shared = { optionType: "call", spot: 200, days: 90, rate: 4.1 };
  const quotes = [190, 195, 200, 205, 210].map((strike, index) => {
    const iv = 28 + index;
    const mark = core.calculateBlackScholes({ ...shared, strike, volatility: iv, dividend: 2.5 }).call;
    return {
      strike,
      mark,
      iv,
      bid: Math.max(mark - 0.05, 0.01),
      ask: mark + 0.05,
      capturedAt: now,
    };
  });
  const carry = core.chainImpliedCarry({ ...shared, quotes, now });
  assert.ok(Math.abs(carry.yield - 2.5) < 0.001);
  assert.equal(carry.count, 5);
});

test("only flags executable discrepancies with fresh, liquid, tight quotes", () => {
  const now = Date.parse("2026-08-04T20:00:00Z");
  const exactQuote = {
    bid: 0.98,
    mark: 1,
    ask: 1.02,
    volume: 250,
    openInterest: 1000,
    capturedAt: now,
  };
  const flag = core.assessDiscrepancy({
    fairValue: 1.25,
    referencePrice: 1,
    exactQuote,
    gapThreshold: 10,
    maxSpreadPercent: 20,
    now,
  });
  assert.equal(flag.flagged, true);
  assert.equal(flag.direction, "below-model");

  const wide = core.assessDiscrepancy({
    fairValue: 1.25,
    referencePrice: 1,
    exactQuote: { ...exactQuote, bid: 0.7, ask: 1.3 },
    gapThreshold: 10,
    maxSpreadPercent: 20,
    now,
  });
  assert.equal(wide.flagged, false);

  const stale = core.assessDiscrepancy({
    fairValue: 1.25,
    referencePrice: 1,
    exactQuote: { ...exactQuote, capturedAt: now - 121_000 },
    gapThreshold: 10,
    maxSpreadPercent: 20,
    now,
  });
  assert.equal(stale.flagged, false);
});

test("parses and interpolates the latest official Treasury curve", () => {
  const xml = `<feed>
    <entry><d:NEW_DATE>2026-08-03T00:00:00</d:NEW_DATE><d:BC_1MONTH>3.79</d:BC_1MONTH><d:BC_3MONTH>3.91</d:BC_3MONTH></entry>
    <entry><d:NEW_DATE>2026-08-04T00:00:00</d:NEW_DATE><d:BC_1MONTH>3.78</d:BC_1MONTH><d:BC_3MONTH>3.89</d:BC_3MONTH></entry>
  </feed>`;
  const curve = core.parseTreasuryXml(xml);
  assert.equal(curve.date, "2026-08-04");
  assert.equal(curve.points[0].rate, 3.78);
  const rate = core.interpolateTreasuryRate(curve.points, 60);
  assert.ok(rate > 3.78 && rate < 3.89);
});

test("uses expiration-aware ETF dividends and a continuous SPX yield", () => {
  const now = Date.parse("2026-08-04T20:00:00Z");
  const shortSpy = core.dividendAssumption({
    ticker: "SPY", spot: 773, expiration: "2026-08-07", days: 3, rate: 3.78, now,
  });
  const quarterlySpy = core.dividendAssumption({
    ticker: "SPY", spot: 773, expiration: "2026-09-25", days: 52, rate: 3.9, now,
  });
  const spx = core.dividendAssumption({
    ticker: "SPX", spot: 7730, expiration: "2026-08-07", days: 3, rate: 3.78, now,
  });
  assert.equal(shortSpy.yield, 0);
  assert.equal(quarterlySpy.count, 1);
  assert.ok(quarterlySpy.yield > 0);
  assert.equal(spx.yield, 1.12);
});

test("removes extended-hours moves from the spot paired with frozen option quotes", () => {
  const aligned = core.sessionAlignedSpot(
    774.38,
    "+$13.61 (+1.80%) Today+$3.10 (+0.40%) After Hours",
  );
  assert.ok(Math.abs(aligned.spot - 771.28) < 1e-9);
  assert.equal(aligned.basis, "regular-session close");
  assert.equal(core.parseExtendedHoursChange("-$1.25 (-0.16%) Pre-Market"), -1.25);

  const days = core.daysToExpiration(
    "2026-08-05",
    Date.parse("2026-08-05T05:32:16.089Z"),
  );
  const iv = core.impliedVolatility({
    marketPrice: 1.15,
    optionType: "call",
    spot: aligned.spot,
    strike: 775,
    days,
    rate: 3.78,
    dividend: 0,
  });
  assert.ok(Math.abs(iv - 20.42) < 0.03);
});
