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
  assert.equal(core.parseMoney("$1.50"), 1.5);
  assert.equal(core.parseMoney("—"), null);
  assert.equal(core.extractSelectedIv("Implied volatility18.22%Open interest566"), 18.22);
  assert.equal(
    core.parseExpirationLabel("Expiring August 5 (1d)", new Date("2026-08-04T20:00:00Z")),
    "2026-08-05",
  );
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
