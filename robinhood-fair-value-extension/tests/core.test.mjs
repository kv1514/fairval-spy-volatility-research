import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../content.js", import.meta.url), "utf8");
const pricingSource = await readFile(new URL("../pricing-core.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const bundledForecast = JSON.parse(await readFile(
  new URL("../volatility-research-output/latest_forecasts.json", import.meta.url),
  "utf8",
));
const pricingGoldenVectors = JSON.parse(await readFile(
  new URL("./fixtures/pricing-golden-vectors.json", import.meta.url),
  "utf8",
));
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
vm.runInContext(pricingSource, context);
vm.runInContext(source, context);
const core = context.__BSFV_CORE__;
const pricing = context.FairValPricing;

test("bundles a valid walk-forward forecast bridge for Robinhood", () => {
  assert.deepEqual(manifest.content_scripts[0].js, ["pricing-core.js", "strategy-core.js", "content.js"]);
  const exposedResources = manifest.web_accessible_resources
    ?.flatMap((entry) => entry.resources || []) || [];
  assert.ok(exposedResources.includes("volatility-research-output/latest_forecasts.json"));
  assert.equal(bundledForecast.schema, "volatility_forecast.v1");
  assert.ok(bundledForecast.records.length > 0);
  assert.deepEqual(
    [...new Set(bundledForecast.records.map((record) => record.ticker))].sort(),
    ["SPY"],
  );
  assert.ok(bundledForecast.records.every((record) =>
    Number.isFinite(Number(record.horizon)) && Number.isFinite(Number(record.forecast_vol))
  ));
});

test("multi-model core prices European benchmarks and American exercise", () => {
  const input = { spot: 100, strike: 100, days: 365, volatility: 20, rate: 5, dividend: 0, optionType: "call", exerciseStyle: "european" };
  const bs = pricing.blackScholes(input).price;
  const binomial = pricing.crr(input, { steps: 1000, american: false }).price;
  const trinomial = pricing.trinomial(input, { steps: 1000, american: false }).price;
  assert.ok(Math.abs(bs - 10.45058357) < 1e-6);
  assert.ok(Math.abs(binomial - bs) < 0.003);
  assert.ok(Math.abs(trinomial - bs) < 0.002);
  const put = { ...input, spot: 80, strike: 100, rate: 8, optionType: "put", exerciseStyle: "american" };
  assert.ok(pricing.crr(put, { steps: 500, american: true }).price > pricing.blackScholes(put).price);
});

test("generic JavaScript IV solver supports Black-Scholes and CRR", () => {
  const input = { spot: 100, strike: 105, days: 45, volatility: 27, rate: 4, dividend: 1, optionType: "put", exerciseStyle: "american" };
  const crrModel = pricing.crrModel(100, true);
  const result = pricing.impliedVolatility(crrModel.price(input), crrModel, { ...input, volatility: 15 });
  assert.equal(result.converged, true);
  assert.ok(Math.abs(result.volatility - 27) < 1e-5);
  const impossible = pricing.impliedVolatility(4, crrModel, { ...input, spot: 100, strike: 110 });
  assert.equal(impossible.status, "below_lower_bound");
});

test("model comparison resolves style and reports selection rationale", () => {
  const spx = pricing.compareModels({ ticker: "SPX", spot: 6000, strike: 6000, days: 10, volatility: 20, marketIv: 20, forecastVolatility: 22, marketMid: 50, rate: 4, dividend: 1, optionType: "call" });
  assert.equal(spx.style, "european");
  assert.equal(spx.modelUsed, "black_scholes_dividend_adjusted");
  const put = pricing.compareModels({ ticker: "AAPL", spot: 80, strike: 100, days: 90, volatility: 25, marketIv: 25, forecastVolatility: 30, marketMid: 20.5, rate: 5, dividend: 0, optionType: "put", treeSteps: 100 });
  assert.equal(put.style, "american");
  assert.ok(put.pricingWarning.includes("inferred"));
  assert.ok(Number.isFinite(put.americanForecastFairValue));
  assert.ok(put.earlyExercisePremium >= 0);
});

test("model selection uses same-tree exercise premium, not lattice error", () => {
  const noDividendCall = pricing.compareModels({ ticker: "SPY", spot: 100, strike: 100, days: 30, volatility: 20, marketIv: 20, forecastVolatility: 20, marketMid: 2.5, rate: 5, dividend: 0, optionType: "call", treeSteps: 75 });
  assert.equal(noDividendCall.sameTreeExercisePremium, 0);
  assert.equal(noDividendCall.modelUsed, "black_scholes_dividend_adjusted");
  const deepPut = pricing.compareModels({ ticker: "AAPL", spot: 80, strike: 100, days: 365, volatility: 20, marketIv: 20, forecastVolatility: 20, marketMid: 20.5, rate: 8, dividend: 0, optionType: "put", treeSteps: 150 });
  assert.ok(deepPut.sameTreeExercisePremium > 0.01);
  assert.equal(deepPut.modelUsed, "binomial_american_crr");
});

test("adaptive CRR step-doubles, smooths lattice oscillation, and reports its error", () => {
  const input = { spot: 100, strike: 105, days: 45, volatility: 27, rate: 4, dividend: 1, optionType: "put", exerciseStyle: "american" };
  const adaptive = pricing.adaptiveCrr(input, { minSteps: 50, maxSteps: 400, tolerance: 0.0025, american: true });
  const reference = pricing.crrSmoothedAtSteps(input, { steps: 800, american: true }).price;
  assert.equal(adaptive.converged, true);
  assert.equal(adaptive.status, "converged");
  assert.ok(adaptive.history.length >= 3);
  assert.ok(adaptive.errorEstimate <= adaptive.tolerance);
  assert.ok(adaptive.steps <= adaptive.maxSteps);
  assert.ok(Math.abs(adaptive.price - reference) < 0.003);
});

test("JavaScript pricing matches the shared cross-language golden vectors", () => {
  for (const vector of pricingGoldenVectors) {
    const adaptive = pricing.adaptiveCrr(vector.inputs, {
      minSteps: 50,
      maxSteps: 400,
      tolerance: 0.0025,
      american: true,
    });
    assert.ok(Math.abs(adaptive.price - vector.adaptivePrice) < 1e-9, vector.name);
    assert.ok(Math.abs(pricing.blackScholes(vector.inputs).price - vector.blackScholesPrice) < 1e-10, vector.name);
    assert.equal(adaptive.steps, vector.stepsUsed, vector.name);
  }
});

test("American model selection falls back explicitly when the adaptive tree cannot converge", () => {
  const result = pricing.compareModels({
    ticker: "SPY", spot: 80, strike: 100, days: 365, marketIv: 20,
    forecastVolatility: 20, marketMid: 20.5, rate: 8, dividend: 0,
    optionType: "put", treeSteps: 100, treeTolerance: 0.000001,
  });
  assert.equal(result.treeConverged, false);
  assert.equal(result.treeConvergenceStatus, "max_steps_reached");
  assert.equal(result.modelUsed, "black_scholes_dividend_adjusted");
  assert.match(result.pricingWarning, /did not converge/);
});

test("adaptive American values respect bounds and strike monotonicity", () => {
  const base = { spot: 100, days: 30, volatility: 25, rate: 4, dividend: 1, exerciseStyle: "american" };
  const call90 = pricing.adaptiveCrr({ ...base, strike: 90, optionType: "call" }).price;
  const call100 = pricing.adaptiveCrr({ ...base, strike: 100, optionType: "call" }).price;
  const put90 = pricing.adaptiveCrr({ ...base, strike: 90, optionType: "put" }).price;
  const put100 = pricing.adaptiveCrr({ ...base, strike: 100, optionType: "put" }).price;
  assert.ok(call90 >= call100 && call90 <= base.spot);
  assert.ok(put100 >= put90 && put100 <= 100);
  assert.ok(call90 >= Math.max(base.spot - 90, 0));
  assert.ok(put100 >= Math.max(100 - base.spot, 0));
});

test("adaptive American values are monotone in maturity without dividends", () => {
  const base = { spot: 100, strike: 100, volatility: 25, rate: 4, dividend: 0, exerciseStyle: "american" };
  for (const optionType of ["call", "put"]) {
    const short = pricing.adaptiveCrr({ ...base, days: 10, optionType }).price;
    const long = pricing.adaptiveCrr({ ...base, days: 60, optionType }).price;
    assert.ok(long >= short - 1e-8, optionType);
  }
});

test("discrete cash dividends flow through BS, CRR, trinomial, and early exercise", () => {
  const base = { spot: 100, strike: 95, days: 45, volatility: 22, rate: 4, dividend: 0, optionType: "call", exerciseStyle: "american" };
  const noDividend = pricing.adaptiveCrr(base).price;
  const withDividend = { ...base, discreteDividends: [{ days: 20, amount: 2.5 }] };
  const crrValue = pricing.adaptiveCrr(withDividend).price;
  const triValue = pricing.trinomial(withDividend, { steps: 400, american: true }).price;
  assert.ok(crrValue < noDividend);
  assert.ok(Math.abs(crrValue - triValue) < 0.03);
  assert.ok(pricing.crr(withDividend, { steps: 400, american: true }).price >= pricing.crr(withDividend, { steps: 400, american: false }).price);
  assert.equal(pricing.blackScholes(withDividend).dividendModel, "escrowed_cash_dividend_adjustment");
  assert.throws(() => pricing.baw(withDividend), /does not support discrete cash dividends/);
});

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

test("computes the full greek set with correct signs and parity", () => {
  const g = core.calculateBlackScholes({
    spot: 100,
    strike: 100,
    days: 30,
    volatility: 22,
    rate: 4,
    dividend: 1.5,
  });
  // Gamma and vega are shared between call and put; delta/theta/rho are signed.
  assert.ok(g.gamma > 0 && g.vega > 0);
  assert.ok(g.callDelta > 0 && g.putDelta < 0);
  assert.ok(g.callRho > 0 && g.putRho < 0);
  assert.ok(g.callTheta < 0); // near-ATM long call bleeds time value
  // Put-call parity: C - P = S e^{-qT} - K e^{-rT}.
  const T = 30 / 365;
  const parity = 100 * Math.exp((-1.5 / 100) * T) - 100 * Math.exp((-4 / 100) * T);
  assert.ok(Math.abs(g.call - g.put - parity) < 1e-6);
  // Delta relationship: callDelta - putDelta = e^{-qT}.
  assert.ok(Math.abs(g.callDelta - g.putDelta - Math.exp((-1.5 / 100) * T)) < 1e-9);
});

test("selects the nearest leakage-safe walk-forward horizon", () => {
  const payload = {
    schema: "volatility_forecast.v1",
    records: [
      { ticker: "SPY", as_of_date: "2026-08-04", horizon: 1, forecast_vol: 15, model_used: "ewma", lambda_used: 0.94 },
      { ticker: "SPY", as_of_date: "2026-08-04", horizon: 5, forecast_vol: 19, model_used: "optimized_blend" },
      { ticker: "SPX", as_of_date: "2026-08-04", horizon: 5, forecast_vol: 18, model_used: "fixed_blend" },
    ],
  };
  const selected = core.selectVolatilityForecast(payload, "SPY", 4);
  assert.equal(selected.horizon, 5);
  assert.equal(selected.forecastVol, 19);
  assert.equal(selected.modelUsed, "optimized_blend");
  assert.equal(core.selectVolatilityForecast(payload, "SPXW", 5).ticker, "SPX");
  assert.equal(core.selectVolatilityForecast(payload, "QQQ", 5), null);
  assert.equal(core.forecastHorizonFromDte(7.2), 7);
});

test("disables research flags when a daily forecast is stale", () => {
  const record = { asOfDate: "2026-08-04" };
  assert.equal(core.isForecastFresh(record, Date.parse("2026-08-07T20:00:00Z"), 4), true);
  assert.equal(core.isForecastFresh(record, Date.parse("2026-08-11T20:00:00Z"), 4), false);
  assert.ok(core.forecastAgeDays(record, Date.parse("2026-08-11T20:00:00Z")) > 6.9);
});

test("matches historical IV context by ticker, option type, DTE, and moneyness", () => {
  const payload = {
    surface_benchmarks: [
      { ticker: "SPY", option_type: "put", dte_bucket: 5, moneyness_bucket: "downside", observations: 80, p10: 18, p25: 20, p50: 23, p75: 27, p90: 31 },
      { ticker: "SPY", option_type: "call", dte_bucket: 5, moneyness_bucket: "downside", observations: 75, p10: 14, p25: 16, p50: 18, p75: 20, p90: 23 },
    ],
  };
  const selected = core.selectSurfaceBenchmark(payload, "SPY", "put", 6, -0.05);
  assert.equal(selected.optionType, "put");
  assert.equal(selected.moneynessBucket, "downside");
  assert.equal(selected.dteBucket, 5);
  assert.equal(core.selectSurfaceBenchmark(payload, "SPY", "put", 6, 0.01), null);
  assert.equal(core.approximateIvPercentile(23, selected), 50);
});

test("uses Haugh short-option sign and suppresses uncontextualized skew flags", () => {
  const richBenchmark = { p10: 12, p25: 14, p50: 16, p75: 18, p90: 20 };
  const shortVol = core.varianceResearchContext({
    marketIv: 22,
    forecastVol: 16,
    priceEdge: -0.4,
    spot: 100,
    gamma: 0.05,
    vega: 0.12,
    days: 5,
    benchmark: richBenchmark,
  });
  assert.equal(shortVol.candidateSide, "short_vol");
  assert.ok(shortVol.varianceEdge > 0);
  assert.ok(shortVol.dollarGamma > 0);
  assert.ok(shortVol.gammaWeightedEdge > 0);
  assert.ok(shortVol.vegaNormalizedEdge < 0);
  assert.equal(shortVol.surfaceContextPass, true);

  const ordinaryPutSkew = core.varianceResearchContext({
    marketIv: 22,
    forecastVol: 16,
    priceEdge: -0.4,
    spot: 100,
    gamma: 0.05,
    vega: 0.12,
    days: 5,
    benchmark: { p10: 20, p25: 22, p50: 24, p75: 27, p90: 31 },
  });
  assert.equal(ordinaryPutSkew.candidateSide, "short_vol");
  assert.equal(ordinaryPutSkew.surfaceContextPass, false);
});

test("uses the opposite Haugh sign for a consistent long-vol candidate", () => {
  const result = core.varianceResearchContext({
    marketIv: 15,
    forecastVol: 20,
    priceEdge: 0.25,
    spot: 100,
    gamma: 0.06,
    vega: 0.15,
    days: 2,
    benchmark: { p10: 14, p25: 16, p50: 18, p75: 20, p90: 22 },
  });
  assert.equal(result.candidateSide, "long_vol");
  assert.ok(result.varianceEdge < 0);
  assert.ok(result.gammaWeightedEdge < 0);
  assert.ok(result.vegaNormalizedEdge > 0);
  assert.equal(result.surfaceContextPass, true);
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
  const currentPriceCell = { id: "current-price-cell" };
  assert.equal(core.optionPriceCell({
    querySelector(selector) {
      assert.match(selector, /OptionChainExpiringSoonCell/);
      return currentPriceCell;
    },
  }), currentPriceCell);
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

test("robust smile fit resists a corrupted neighboring IV quote", () => {
  const observations = [80, 85, 90, 95, 100, 105, 110, 115, 120].map((strike) => ({
    strike,
    iv: strike === 105 ? 60 : 20 + (strike - 100) * 0.1,
  }));
  const iv = core.smoothedVolatility(100, observations, 100);
  assert.ok(Math.abs(iv - 20) < 1);
});

test("live SVI fits total variance on forward moneyness with butterfly diagnostics", () => {
  const parameters = { a: 0.002, b: 0.03, rho: -0.35, m: 0.01, sigma: 0.18 };
  const days = 30;
  const T = days / 365;
  const spot = 100;
  const rate = 4;
  const forward = spot * Math.exp((rate / 100) * T);
  const observations = Array.from({ length: 13 }, (_, index) => {
    const k = -0.24 + index * 0.04;
    const totalVariance = pricing.sviTotalVariance
      ? pricing.sviTotalVariance(k, parameters)
      : core.sviTotalVariance(k, parameters);
    return {
      strike: forward * Math.exp(k),
      iv: Math.sqrt(totalVariance / T) * 100 + (index === 2 ? 6 : 0),
    };
  });
  const fit = core.fitSviSmile(observations, { spot, days, rate, dividend: 0 });
  assert.equal(fit.status, "fitted");
  assert.equal(fit.butterflyArbitrageFree, true);
  assert.ok(Number.isFinite(fit.ivAtLogMoneyness(0)));
  assert.ok(Math.abs(fit.forward - forward) < 1e-10);
});

test("uses the New York option close for intraday expiry", () => {
  const days = core.daysToExpiration("2026-08-04", Date.parse("2026-08-04T20:00:00Z"));
  assert.ok(Math.abs(days - 15 / 1440) < 1e-9);
});

test("distinguishes AM-settled SPX from PM-settled SPXW and ETF options", () => {
  assert.equal(core.settlementMinutesForSeries("SPX"), 9 * 60 + 30);
  assert.equal(core.settlementMinutesForSeries("SPXW"), 16 * 60);
  assert.equal(core.settlementMinutesForSeries("XSP"), 16 * 60);
  assert.equal(core.settlementMinutesForSeries("SPY"), 16 * 60 + 15);
  const expiration = "2026-08-21";
  const now = Date.parse("2026-08-20T20:00:00Z");
  assert.ok(
    core.daysToExpiration(expiration, now, core.settlementMinutesForSeries("SPX"))
      < core.daysToExpiration(expiration, now, core.settlementMinutesForSeries("SPXW")),
  );
});

test("pricing cache key is stable within a minute and includes numerical controls", () => {
  const common = {
    ticker: "SPY", optionType: "call", expiration: "2026-08-14", spot: 775.12,
    strike: 775, fairIv: 18.2344, marketIv: 17.951, referencePrice: 2.35,
    rate: 4.2, dividend: 1.1, treeSteps: 400, treeTolerance: 0.0025,
    exactQuote: true,
  };
  const first = core.buildPricingCacheKey({ ...common, days: 2.50060 });
  const sameMinute = core.buildPricingCacheKey({ ...common, days: 2.50055 });
  const priorMinute = core.buildPricingCacheKey({ ...common, days: 2.49980 });
  const stricter = core.buildPricingCacheKey({ ...common, days: 2.50060, treeTolerance: 0.001 });
  assert.equal(first, sameMinute);
  assert.notEqual(first, priorMinute);
  assert.notEqual(first, stricter);
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

test("scores forward paper outcomes at executable bid and ask prices", () => {
  const start = Date.parse("2026-08-04T17:00:00Z");
  const records = [
    { contractKey: "SPY|call|2026-08-07|775", observedAt: start, bid: 1, ask: 1.05, flagDirection: "below-model" },
    { contractKey: "SPY|call|2026-08-07|775", observedAt: start + 60 * 60_000, bid: 1.25, ask: 1.3 },
    { contractKey: "SPY|put|2026-08-07|760", observedAt: start, bid: 0.9, ask: 0.95, flagDirection: "above-model" },
    { contractKey: "SPY|put|2026-08-07|760", observedAt: start + 60 * 60_000, bid: 0.68, ask: 0.72 },
  ];
  const outcome = core.computePaperOutcomes(records, 60);
  assert.equal(outcome.count, 2);
  assert.equal(outcome.wins, 2);
  assert.ok(Math.abs(outcome.meanPnl - 0.19) < 1e-12);
});

test("attributes gross delta-hedged paper PnL separately from option PnL", () => {
  const start = Date.parse("2026-08-04T17:00:00Z");
  const records = [
    {
      contractKey: "SPY|call|2026-08-07|775",
      observedAt: start,
      bid: 1,
      ask: 1.05,
      spot: 100,
      marketDelta: 0.5,
      flagDirection: "below-model",
    },
    {
      contractKey: "SPY|call|2026-08-07|775",
      observedAt: start + 60 * 60_000,
      bid: 1.25,
      ask: 1.3,
      spot: 101,
    },
  ];
  const outcome = core.computePaperOutcomes(records, 60);
  assert.equal(outcome.deltaHedgedCount, 1);
  assert.ok(Math.abs(outcome.meanOptionPnlContract - 20) < 1e-12);
  assert.ok(Math.abs(outcome.meanHedgePnlContract + 50) < 1e-12);
  assert.ok(Math.abs(outcome.meanDeltaHedgedPnlContract + 30) < 1e-12);
});

test("thins DOM redraw snapshots without dropping later quote samples", () => {
  const start = Date.parse("2026-08-04T17:00:00Z");
  const records = [0, 1_000, 14_999, 15_000, 30_000].map((offset) => ({
    id: `sample-${offset}`,
    contractKey: "SPY|call|2026-08-07|775",
    observedAt: start + offset,
  }));
  assert.deepEqual(Array.from(core.thinPaperRecords(records), (record) => record.id), [
    "sample-0",
    "sample-15000",
    "sample-30000",
  ]);
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
  const zeroProxy = core.continuousTreasuryZeroProxy(curve.points);
  assert.equal(zeroProxy.length, curve.points.length);
  assert.ok(zeroProxy.every((point) => Number.isFinite(point.rate) && point.rate > 0));
  assert.notEqual(zeroProxy[0].rate, curve.points[0].rate);
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
  assert.equal(quarterlySpy.yield, 0);
  assert.ok(quarterlySpy.equivalentYield > 0);
  assert.equal(quarterlySpy.discreteDividends.length, 1);
  assert.ok(quarterlySpy.discreteDividends[0].amount > 0);
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
