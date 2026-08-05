import { readFile } from "node:fs/promises";
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

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const seedText = process.argv[2] || "0x5eed1200";
const seed = Number(seedText);
const simulatedChains = Math.max(Number(process.argv[3]) || 1_000, 1);
const formulaCases = Math.max(Number(process.argv[4]) || 5_000, 1);
const random = mulberry32(seed);
const uniform = (low, high) => low + (high - low) * random();
const pick = (values) => values[Math.floor(random() * values.length)];
const normal = () => {
  const first = Math.max(random(), Number.EPSILON);
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};

function percentile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(Math.floor((sorted.length - 1) * probability), sorted.length - 1);
  return sorted[index];
}

function summary(values) {
  return {
    count: values.length,
    mean: values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

const inversionErrors = [];
for (let index = 0; index < formulaCases; index += 1) {
  const optionType = random() < 0.5 ? "call" : "put";
  const spot = Math.exp(uniform(Math.log(15), Math.log(1_500)));
  const strike = spot * uniform(0.8, 1.2);
  const days = pick([1, 7, 14, 30, 60, 90, 180, 365, 730]);
  const volatility = uniform(8, 140);
  const rate = uniform(0, 8);
  const dividend = uniform(-2, 8);
  const marketPrice = core.calculateBlackScholes({
    optionType,
    spot,
    strike,
    days,
    volatility,
    rate,
    dividend,
  })[optionType];
  const recovered = core.impliedVolatility({
    marketPrice,
    optionType,
    spot,
    strike,
    days,
    rate,
    dividend,
  });
  if (recovered != null) inversionErrors.push(Math.abs(recovered - volatility));
}

function buildChain(chainIndex) {
  const now = Date.parse("2026-08-04T20:00:00Z");
  const optionType = chainIndex % 2 ? "put" : "call";
  const spot = Math.exp(uniform(Math.log(20), Math.log(1_200)));
  const days = pick([7, 14, 30, 60, 90, 180, 365]);
  const rate = uniform(1, 7);
  const dividend = uniform(-1, 7);
  const atmIv = uniform(15, 95);
  const skew = uniform(-45, 45);
  const curvature = uniform(40, 180);
  const anomalyIndex = 5 + Math.floor(random() * 5);
  const anomalyDirection = chainIndex % 4 < 2 ? "below-model" : "above-model";
  const quotes = [];

  for (let strikeIndex = 0; strikeIndex < 15; strikeIndex += 1) {
    const offset = strikeIndex - 7;
    const strike = spot * (1 + offset * 0.025);
    const moneyness = strike / spot - 1;
    const trueIv = Math.max(atmIv + skew * moneyness + curvature * moneyness ** 2, 3);
    const theoretical = core.calculateBlackScholes({
      optionType,
      spot,
      strike,
      days,
      volatility: trueIv,
      rate,
      dividend,
    })[optionType];
    if (theoretical < 0.08) continue;

    let observedMark = theoretical * (1 + normal() * 0.0025);
    const isAnomaly = strikeIndex === anomalyIndex;
    if (isAnomaly) {
      const distortion = uniform(0.2, 0.4);
      observedMark *= anomalyDirection === "below-model" ? 1 - distortion : 1 + distortion;
    }
    observedMark = Math.max(observedMark, 0.03);
    const spreadPercent = uniform(1, 8) / 100;
    const spread = Math.max(0.02, observedMark * spreadPercent);
    const bid = Math.max(0.01, observedMark - spread / 2);
    const ask = observedMark + spread / 2;
    const mark = (bid + ask) / 2;
    const iv = core.impliedVolatility({
      marketPrice: mark,
      optionType,
      spot,
      strike,
      days,
      rate,
      dividend,
    });
    if (iv == null) continue;
    quotes.push({
      strike,
      mark,
      bid,
      ask,
      iv,
      volume: Math.floor(uniform(10, 5_000)),
      openInterest: Math.floor(uniform(100, 20_000)),
      capturedAt: now,
      theoretical,
      trueIv,
      isAnomaly,
      anomalyDirection,
    });
  }

  return { now, optionType, spot, days, rate, dividend, quotes };
}

const carryErrors = [];
let chainsWithCarry = 0;
let eligibleAnomalies = 0;
let detectedAnomalies = 0;
let totalFlags = 0;
let falseFlags = 0;
let normalContracts = 0;
let normalFlags = 0;
const edgeScores = [];

for (let chainIndex = 0; chainIndex < simulatedChains; chainIndex += 1) {
  const chain = buildChain(chainIndex);
  const carry = core.chainImpliedCarry({
    quotes: chain.quotes,
    optionType: chain.optionType,
    spot: chain.spot,
    days: chain.days,
    rate: chain.rate,
    now: chain.now,
  });
  if (!carry) continue;
  chainsWithCarry += 1;
  carryErrors.push(Math.abs(carry.yield - chain.dividend));
  const observations = chain.quotes.map((quote) => ({ strike: quote.strike, iv: quote.iv }));

  for (const quote of chain.quotes) {
    const fairIv = core.smoothedVolatility(quote.strike, observations, chain.spot);
    const fairValue = core.calculateBlackScholes({
      optionType: chain.optionType,
      spot: chain.spot,
      strike: quote.strike,
      days: chain.days,
      volatility: fairIv,
      rate: chain.rate,
      dividend: carry.yield,
    })[chain.optionType];
    const alert = core.assessDiscrepancy({
      fairValue,
      referencePrice: quote.mark,
      exactQuote: quote,
      gapThreshold: 10,
      maxSpreadPercent: 20,
      now: chain.now,
    });
    if (alert.flagged) {
      totalFlags += 1;
      edgeScores.push(alert.score);
    }

    if (quote.isAnomaly) {
      const groundTruthAlert = core.assessDiscrepancy({
        fairValue: quote.theoretical,
        referencePrice: quote.mark,
        exactQuote: quote,
        gapThreshold: 10,
        maxSpreadPercent: 20,
        now: chain.now,
      });
      if (groundTruthAlert.flagged) {
        eligibleAnomalies += 1;
        if (alert.flagged && alert.direction === quote.anomalyDirection) detectedAnomalies += 1;
        else if (alert.flagged) falseFlags += 1;
      }
    } else {
      normalContracts += 1;
      if (alert.flagged) {
        normalFlags += 1;
        falseFlags += 1;
      }
    }
  }
}

const gateQuote = {
  bid: 0.98,
  mark: 1,
  ask: 1.02,
  volume: 500,
  openInterest: 2_000,
  capturedAt: 1_000_000,
};
const gateCases = {
  valid: core.assessDiscrepancy({ fairValue: 1.3, referencePrice: 1, exactQuote: gateQuote, now: 1_000_000 }),
  stale: core.assessDiscrepancy({ fairValue: 1.3, referencePrice: 1, exactQuote: { ...gateQuote, capturedAt: 870_000 }, now: 1_000_000 }),
  illiquid: core.assessDiscrepancy({ fairValue: 1.3, referencePrice: 1, exactQuote: { ...gateQuote, volume: 9, openInterest: 99 }, now: 1_000_000 }),
  wideSpread: core.assessDiscrepancy({ fairValue: 1.5, referencePrice: 1, exactQuote: { ...gateQuote, bid: 0.7, ask: 1.3 }, now: 1_000_000 }),
};

const precision = totalFlags ? (totalFlags - falseFlags) / totalFlags : 0;
const recall = eligibleAnomalies ? detectedAnomalies / eligibleAnomalies : 0;
const falsePositiveRate = normalContracts ? normalFlags / normalContracts : 0;
const results = {
  seed: seedText,
  configuration: {
    formulaCases,
    simulatedChains,
    optionTypes: ["call", "put"],
    expirationsDays: [7, 14, 30, 60, 90, 180, 365],
    stockPriceRange: [20, 1_200],
    volatilityRangePercent: [15, 95],
    injectedMispricingRangePercent: [20, 40],
    alertThresholdPercent: 10,
    maximumSpreadPercent: 20,
  },
  formulaInversionAbsoluteErrorVolPoints: summary(inversionErrors),
  carryCalibrationAbsoluteErrorYieldPoints: summary(carryErrors),
  screening: {
    chainsWithCarry,
    eligibleInjectedAnomalies: eligibleAnomalies,
    detectedInjectedAnomalies: detectedAnomalies,
    totalFlags,
    falseFlags,
    precision,
    recall,
    normalContracts,
    normalFlags,
    falsePositiveRate,
    edgeToSpreadScore: summary(edgeScores),
  },
  gates: {
    validFlagged: gateCases.valid.flagged,
    staleRejected: !gateCases.stale.flagged,
    illiquidRejected: !gateCases.illiquid.flagged,
    wideSpreadRejected: !gateCases.wideSpread.flagged,
  },
};

results.verdict = {
  formulaPass: results.formulaInversionAbsoluteErrorVolPoints.max < 1e-6,
  carryPass: results.carryCalibrationAbsoluteErrorYieldPoints.p95 < 0.05,
  precisionPass: precision >= 0.9,
  recallPass: recall >= 0.85,
  falsePositivePass: falsePositiveRate <= 0.01,
  gatesPass: Object.values(results.gates).every(Boolean),
};
results.verdict.allPass = Object.values(results.verdict).every(Boolean);

console.log(JSON.stringify(results, null, 2));
