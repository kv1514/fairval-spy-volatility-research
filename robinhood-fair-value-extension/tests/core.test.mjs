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
    { ticker: "SPY", side: "buy", optionType: "call" },
  );
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
