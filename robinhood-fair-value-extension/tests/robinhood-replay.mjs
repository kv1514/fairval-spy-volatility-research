import { readFile } from "node:fs/promises";
import vm from "node:vm";

const extensionSource = await readFile(new URL("../content.js", import.meta.url), "utf8");
const fixture = JSON.parse(await readFile(new URL("./fixtures/spy-may-july-2026-hourly.json", import.meta.url), "utf8"));
const context = vm.createContext({ Date, Intl, Math, Number, Object, String, clearTimeout, console, setTimeout });
context.globalThis = context;
vm.runInContext(extensionSource, context);
const core = context.__BSFV_CORE__;

const RATE = 3.8;
const DIVIDEND = 0;
const thresholds = [5, 10, 15, 20, 30];
const costRates = [0, 0.05, 0.10, 0.20];
const expirations = [...new Set(fixture.contracts.map((contract) => contract.expiration))].sort();
const trainingExpirations = new Set(expirations.slice(0, -4));
const holdoutExpirations = new Set(expirations.slice(-4));
const underlyingBars = fixture.underlying
  .map((bar) => ({ ...bar, timestamp: Date.parse(bar.t), day: bar.t.slice(0, 10) }))
  .sort((a, b) => a.timestamp - b.timestamp);
const byTime = new Map(underlyingBars.map((bar) => [bar.timestamp, bar]));
const contractBars = new Map(
  fixture.contracts.map((contract) => [
    contract.id,
    new Map(contract.bars.filter((bar) => !bar.interpolated).map((bar) => [Date.parse(bar.t), bar])),
  ]),
);

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function summarize(values) {
  if (!values.length) return { n: 0, mean: null, median: null, winRate: null, standardError: null };
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    Math.max(values.length - 1, 1);
  return {
    n: values.length,
    mean,
    median: median(values),
    winRate: values.filter((value) => value > 0).length / values.length,
    standardError: Math.sqrt(variance / values.length),
  };
}

function annualizedRealizedVol(path) {
  if (path.length < 3) return null;
  let squaredReturns = 0;
  let elapsedYears = 0;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    const years = (current.timestamp - previous.timestamp) / (365.25 * 86_400_000);
    if (years <= 0 || previous.c <= 0 || current.c <= 0) continue;
    squaredReturns += Math.log(current.c / previous.c) ** 2;
    elapsedYears += years;
  }
  return elapsedYears > 0 ? Math.sqrt(squaredReturns / elapsedYears) * 100 : null;
}

function historicalVol(timestamp, tradingDays) {
  const available = underlyingBars.filter((bar) => bar.timestamp < timestamp);
  const days = [...new Set(available.map((bar) => bar.day))].slice(-tradingDays);
  return annualizedRealizedVol(available.filter((bar) => days.includes(bar.day)));
}

function futureVol(timestamp, settlement) {
  const current = byTime.get(timestamp);
  if (!current) return null;
  return annualizedRealizedVol([
    current,
    ...underlyingBars.filter((bar) => bar.timestamp > timestamp && bar.timestamp <= settlement),
  ]);
}

const forecastModels = {
  hv5: (timestamp) => historicalVol(timestamp, 5),
  hv10: (timestamp) => historicalVol(timestamp, 10),
  hv20: (timestamp) => historicalVol(timestamp, 20),
  blend5_20: (timestamp) => {
    const fast = historicalVol(timestamp, 5);
    const slow = historicalVol(timestamp, 20);
    return Number.isFinite(fast) && Number.isFinite(slow) ? 0.5 * fast + 0.5 * slow : null;
  },
};

const grouped = new Map();
let rawBars = 0;
let alignedBars = 0;
for (const contract of fixture.contracts) {
  for (const bar of contract.bars) {
    rawBars += 1;
    if (bar.interpolated) continue;
    const timestamp = Date.parse(bar.t);
    const underlying = byTime.get(timestamp);
    if (!underlying) continue;
    alignedBars += 1;
    const key = `${contract.expiration}|${contract.type}|${timestamp}`;
    const group = grouped.get(key) || [];
    group.push({ ...contract, bars: undefined, timestamp, bar, underlying });
    grouped.set(key, group);
  }
}

const volatilityTests = [];
const seenVolTests = new Set();
for (const group of grouped.values()) {
  const key = `${group[0].expiration}|${group[0].timestamp}`;
  if (seenVolTests.has(key)) continue;
  seenVolTests.add(key);
  const settlement = Date.parse(`${group[0].expiration}T20:15:00Z`);
  const actual = futureVol(group[0].timestamp, settlement);
  if (!Number.isFinite(actual)) continue;
  volatilityTests.push({
    expiration: group[0].expiration,
    timestamp: group[0].timestamp,
    actual,
    forecasts: Object.fromEntries(Object.entries(forecastModels).map(([name, model]) => [name, model(group[0].timestamp)])),
  });
}

function forecastError(modelName, universe) {
  const rows = volatilityTests.filter((row) => universe.has(row.expiration) && Number.isFinite(row.forecasts[modelName]));
  const errors = rows.map((row) => row.forecasts[modelName] - row.actual);
  return {
    n: rows.length,
    mae: errors.reduce((total, error) => total + Math.abs(error), 0) / Math.max(errors.length, 1),
    rmse: Math.sqrt(errors.reduce((total, error) => total + error ** 2, 0) / Math.max(errors.length, 1)),
    bias: errors.reduce((total, error) => total + error, 0) / Math.max(errors.length, 1),
  };
}

const forecastValidation = Object.fromEntries(Object.keys(forecastModels).map((name) => [name, {
  training: forecastError(name, trainingExpirations),
  holdout: forecastError(name, holdoutExpirations),
}]));
const selectedForecast = Object.keys(forecastModels).sort(
  (a, b) => forecastValidation[a].training.mae - forecastValidation[b].training.mae,
)[0];

function buildObservations(mode) {
  const output = [];
  for (const group of grouped.values()) {
    if (group.length < 7) continue;
    const settlement = Date.parse(`${group[0].expiration}T20:15:00Z`);
    const days = Math.max((settlement - group[0].timestamp) / 86_400_000, 1 / (24 * 60));
    const forecast = mode === "relative" ? null : forecastModels[mode](group[0].timestamp);
    if (mode !== "relative" && !Number.isFinite(forecast)) continue;
    const contracts = group.map((contract) => {
      const price = Number(contract.bar.c);
      const spot = Number(contract.underlying.c);
      const iv = core.impliedVolatility({
        marketPrice: price,
        optionType: contract.type,
        spot,
        strike: contract.strike,
        days,
        rate: RATE,
        dividend: DIVIDEND,
      });
      return { ...contract, price, spot, days, iv };
    }).filter((contract) => Number.isFinite(contract.iv));
    if (contracts.length < 7) continue;
    const smile = contracts.map((contract) => ({ strike: contract.strike, iv: contract.iv }));
    const atmIv = core.smoothedVolatility(contracts[0].spot, smile, contracts[0].spot);
    if (!Number.isFinite(atmIv)) continue;

    for (const contract of contracts) {
      const surfaceIv = core.smoothedVolatility(contract.strike, smile, contract.spot);
      if (!Number.isFinite(surfaceIv)) continue;
      const fairIv = Math.min(Math.max(
        mode === "relative" ? surfaceIv : surfaceIv + (forecast - atmIv),
        1,
      ), 300);
      const model = core.calculateBlackScholes({
        optionType: contract.type,
        spot: contract.spot,
        strike: contract.strike,
        days: contract.days,
        volatility: fairIv,
        rate: RATE,
        dividend: DIVIDEND,
      });
      const fairValue = contract.type === "put" ? model.put : model.call;
      const delta = contract.type === "put" ? model.putDelta : model.callDelta;
      const residual = fairValue - contract.price;
      const direction = Math.sign(residual);
      if (!direction || contract.price < 0.10) continue;

      // Form the signal only after the current bar completes. Use the next bar's first trade as
      // the entry proxy and that bar's last trade as the exit proxy, avoiding a same-bar fill.
      const outcomeTime = contract.timestamp + 3_600_000;
      const outcomeBar = contractBars.get(contract.id)?.get(outcomeTime);
      const outcomeUnderlying = byTime.get(outcomeTime);
      if (!outcomeBar || !outcomeUnderlying || outcomeBar.interpolated) continue;
      const entryPrice = Number(outcomeBar.o);
      const exitPrice = Number(outcomeBar.c);
      const entrySpot = Number(outcomeUnderlying.o);
      const exitSpot = Number(outcomeUnderlying.c);
      if (![entryPrice, exitPrice, entrySpot, exitSpot].every(Number.isFinite) || entryPrice < 0.10) continue;
      const deltaHedgedGross = direction * ((exitPrice - entryPrice) - delta * (exitSpot - entrySpot));
      output.push({
        id: contract.id,
        expiration: contract.expiration,
        type: contract.type,
        strike: contract.strike,
        signalTime: new Date(contract.timestamp).toISOString(),
        signalPrice: contract.price,
        entryPrice,
        marketIv: contract.iv,
        atmMarketIv: atmIv,
        forecastIv: forecast,
        fairIv,
        fairValue,
        residual,
        volEdge: fairIv - contract.iv,
        edgePercent: Math.abs(residual) / contract.price * 100,
        direction: direction > 0 ? "below-model" : "above-model",
        deltaHedgedGross,
      });
    }
  }
  return output;
}

function screen(rows, threshold) {
  return rows.filter((row) =>
    row.signalPrice >= 0.20 && Math.abs(row.residual) >= 0.05 && row.edgePercent >= threshold,
  );
}

function resultGrid(rows, universe) {
  const results = [];
  const eligible = rows.filter((row) => universe.has(row.expiration));
  for (const threshold of thresholds) {
    const selected = screen(eligible, threshold);
    for (const costRate of costRates) {
      const values = selected.map((row) => row.deltaHedgedGross - Math.max(0.05, row.entryPrice * costRate));
      results.push({ threshold, costRate, ...summarize(values) });
    }
  }
  return results;
}

const relativeRows = buildObservations("relative");
const forecastRows = buildObservations(selectedForecast);
const allExpirations = new Set(expirations);
const holdoutDefault = screen(forecastRows.filter((row) => holdoutExpirations.has(row.expiration)), 10);
const netAtTenPercentCost = (row) => row.deltaHedgedGross - Math.max(0.05, row.entryPrice * 0.10);
const breakdown = {};
for (const field of ["type", "direction", "expiration"]) {
  breakdown[field] = Object.fromEntries(
    [...new Set(holdoutDefault.map((row) => row[field]))].map((value) => [
      value,
      summarize(holdoutDefault.filter((row) => row[field] === value).map(netAtTenPercentCost)),
    ]),
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  source: fixture.source,
  method: "Walk-forward realized-volatility forecast with market skew preserved; completed-hour signal; next-hour first-trade entry and last-trade exit; delta hedged at signal delta",
  caveat: "Robinhood history contains trade bars, not historical bid/ask or NBBO. Cost rates are sensitivity haircuts, not observed spreads or guaranteed fills. Results are research diagnostics, not evidence of an executable trading strategy.",
  assumptions: { annualRatePercent: RATE, discreteDividendBeforeExpiry: false, dividendYieldPercent: DIVIDEND },
  coverage: {
    expirations,
    trainingExpirations: [...trainingExpirations],
    holdoutExpirations: [...holdoutExpirations],
    contracts: fixture.contracts.length,
    calls: fixture.contracts.filter((contract) => contract.type === "call").length,
    puts: fixture.contracts.filter((contract) => contract.type === "put").length,
    rawOptionBars: rawBars,
    alignedOptionBars: alignedBars,
    relativeOutcomes: relativeRows.length,
    forecastOutcomes: forecastRows.length,
    underlyingBars: underlyingBars.length,
  },
  forecastValidation,
  selectedForecast,
  relativeSmileReplayAllExpirations: resultGrid(relativeRows, allExpirations),
  forecastReplayTraining: resultGrid(forecastRows, trainingExpirations),
  forecastReplayHoldout: resultGrid(forecastRows, holdoutExpirations),
  holdoutBreakdownAt10PercentEdgeAnd10PercentCost: breakdown,
  largestHoldoutSignals: forecastRows
    .filter((row) => holdoutExpirations.has(row.expiration) && row.edgePercent >= 10)
    .sort((a, b) => b.edgePercent - a.edgePercent)
    .slice(0, 20)
    .map((row) => ({
      expiration: row.expiration,
      type: row.type,
      strike: row.strike,
      signalTime: row.signalTime,
      direction: row.direction,
      signalPrice: row.signalPrice,
      marketIv: row.marketIv,
      forecastIv: row.forecastIv,
      fairIv: row.fairIv,
      fairValue: row.fairValue,
      edgePercent: row.edgePercent,
      deltaHedgedGross: row.deltaHedgedGross,
    })),
};

console.log(JSON.stringify(report, null, 2));
