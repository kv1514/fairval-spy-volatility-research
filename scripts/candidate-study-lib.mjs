import { readFile } from "node:fs/promises";
import vm from "node:vm";

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;

export const STUDY_POLICY = Object.freeze({
  annualRatePercent: 3.8,
  dividendYieldPercent: 0,
  treeSteps: 75,
  largeGapPercent: 20,
  minimumAbsoluteGap: 0.10,
  minimumSignalPrice: 0.20,
  dailyCandidateCap: 50,
  costRate: 0.10,
  minimumRoundTripCost: 0.05,
});

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarizeReturns(rows, valueField = "netPnl") {
  const values = rows.map((row) => row[valueField]).filter(Number.isFinite);
  if (!values.length) {
    return { n: 0, mean: null, median: null, winRate: null, total: null };
  }
  return {
    n: values.length,
    mean: round(mean(values)),
    median: round(median(values)),
    winRate: round(values.filter((value) => value > 0).length / values.length),
    total: round(values.reduce((total, value) => total + value, 0)),
  };
}

function annualizedRealizedVol(path) {
  if (path.length < 3) return null;
  let squaredReturns = 0;
  let elapsedYears = 0;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    const years = (current.timestamp - previous.timestamp) / YEAR_MS;
    if (years <= 0 || previous.c <= 0 || current.c <= 0) continue;
    squaredReturns += Math.log(current.c / previous.c) ** 2;
    elapsedYears += years;
  }
  return elapsedYears > 0 ? Math.sqrt(squaredReturns / elapsedYears) * 100 : null;
}

function americanCrrPrice(input, steps = STUDY_POLICY.treeSteps) {
  const spot = Math.max(Number(input.spot), 0.0001);
  const strike = Math.max(Number(input.strike), 0.0001);
  const years = Math.max(Number(input.days) / 365, 1 / (365 * 24 * 60));
  const volatility = Math.max(Number(input.volatility) / 100, 0.0001);
  const rate = Number(input.rate) / 100;
  const dividend = Number(input.dividend) / 100;
  const optionType = String(input.optionType).toLowerCase() === "put" ? "put" : "call";
  const count = Math.max(10, Math.floor(steps));
  const dt = years / count;
  const up = Math.exp(volatility * Math.sqrt(dt));
  const down = 1 / up;
  const growth = Math.exp((rate - dividend) * dt);
  let probability = (growth - down) / (up - down);
  probability = Math.min(Math.max(probability, 0), 1);
  const discount = Math.exp(-rate * dt);
  const payoff = (underlying) => optionType === "put"
    ? Math.max(strike - underlying, 0)
    : Math.max(underlying - strike, 0);
  const values = new Array(count + 1);
  for (let upMoves = 0; upMoves <= count; upMoves += 1) {
    const terminalSpot = spot * (up ** upMoves) * (down ** (count - upMoves));
    values[upMoves] = payoff(terminalSpot);
  }
  for (let step = count - 1; step >= 0; step -= 1) {
    for (let upMoves = 0; upMoves <= step; upMoves += 1) {
      const continuation = discount * (
        probability * values[upMoves + 1] + (1 - probability) * values[upMoves]
      );
      const nodeSpot = spot * (up ** upMoves) * (down ** (step - upMoves));
      values[upMoves] = Math.max(continuation, payoff(nodeSpot));
    }
  }
  return values[0];
}

function csvCell(value) {
  if (value == null) return "";
  const text = Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows, fields) {
  return [
    fields.join(","),
    ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(",")),
  ].join("\n");
}

async function loadCore(extensionUrl) {
  const extensionSource = await readFile(extensionUrl, "utf8");
  const context = vm.createContext({ Date, Intl, Math, Number, Object, String, clearTimeout, console, setTimeout });
  context.globalThis = context;
  vm.runInContext(extensionSource, context);
  return context.__BSFV_CORE__;
}

function firstTargetHit(path, target, field) {
  const hit = path.find((point) => Number(point[field]) >= target);
  return hit ? hit.timestamp : null;
}

function exitOutcome({ path, target, entryPrice, hitField, cost }) {
  const hitTimestamp = firstTargetHit(path, target, hitField);
  const finalPoint = path.at(-1);
  const exitPrice = hitTimestamp ? target : Number(finalPoint?.c);
  const grossPnl = exitPrice - entryPrice;
  return {
    hit: Boolean(hitTimestamp),
    hitTimestamp: hitTimestamp ? new Date(hitTimestamp).toISOString() : null,
    exitPrice: round(exitPrice),
    grossPnl: round(grossPnl),
    netPnl: round(grossPnl - cost),
    netContractDollars: round((grossPnl - cost) * 100, 2),
    returnPercent: round(((grossPnl - cost) / entryPrice) * 100, 3),
  };
}

export async function buildCandidateStudy({
  fixtureUrl = new URL("../robinhood-fair-value-extension/tests/fixtures/spy-may-july-2026-hourly.json", import.meta.url),
  extensionUrl = new URL("../robinhood-fair-value-extension/content.js", import.meta.url),
  policy = STUDY_POLICY,
} = {}) {
  const [fixtureText, core] = await Promise.all([
    readFile(fixtureUrl, "utf8"),
    loadCore(extensionUrl),
  ]);
  const fixture = JSON.parse(fixtureText);
  const expirations = [...new Set(fixture.contracts.map((contract) => contract.expiration))].sort();
  const trainingExpirations = new Set(expirations.slice(0, -4));
  const holdoutExpirations = new Set(expirations.slice(-4));
  const underlyingBars = fixture.underlying
    .map((bar) => ({ ...bar, timestamp: Date.parse(bar.t), day: bar.t.slice(0, 10) }))
    .sort((a, b) => a.timestamp - b.timestamp);
  const byTime = new Map(underlyingBars.map((bar) => [bar.timestamp, bar]));
  const contractBars = new Map(fixture.contracts.map((contract) => [
    contract.id,
    contract.bars
      .filter((bar) => !bar.interpolated)
      .map((bar) => ({ ...bar, timestamp: Date.parse(bar.t), day: bar.t.slice(0, 10) }))
      .sort((a, b) => a.timestamp - b.timestamp),
  ]));

  const historicalVol = (timestamp, tradingDays) => {
    const available = underlyingBars.filter((bar) => bar.timestamp < timestamp);
    const days = [...new Set(available.map((bar) => bar.day))].slice(-tradingDays);
    return annualizedRealizedVol(available.filter((bar) => days.includes(bar.day)));
  };
  const futureVol = (timestamp, settlement) => {
    const current = byTime.get(timestamp);
    if (!current) return null;
    return annualizedRealizedVol([current, ...underlyingBars.filter(
      (bar) => bar.timestamp > timestamp && bar.timestamp <= settlement,
    )]);
  };
  const forecastModels = {
    hv5: (timestamp) => historicalVol(timestamp, 5),
    hv10: (timestamp) => historicalVol(timestamp, 10),
    hv20: (timestamp) => historicalVol(timestamp, 20),
    blend5_20: (timestamp) => {
      const fast = historicalVol(timestamp, 5);
      const slow = historicalVol(timestamp, 20);
      return Number.isFinite(fast) && Number.isFinite(slow)
        ? Math.sqrt(0.5 * fast ** 2 + 0.5 * slow ** 2)
        : null;
    },
  };

  const allGroups = new Map();
  for (const contract of fixture.contracts) {
    for (const bar of contract.bars) {
      if (bar.interpolated) continue;
      const timestamp = Date.parse(bar.t);
      const underlying = byTime.get(timestamp);
      if (!underlying) continue;
      const day = bar.t.slice(0, 10);
      const key = `${day}|${contract.expiration}|${contract.type}|${timestamp}`;
      const group = allGroups.get(key) || [];
      group.push({ ...contract, bars: undefined, timestamp, day, bar, underlying });
      allGroups.set(key, group);
    }
  }
  const dailyOpenGroups = [...allGroups.values()].filter((group) => {
    const firstTimestamp = Math.min(...[...allGroups.values()]
      .filter((candidate) => candidate[0].day === group[0].day
        && candidate[0].expiration === group[0].expiration
        && candidate[0].type === group[0].type)
      .map((candidate) => candidate[0].timestamp));
    return group[0].timestamp === firstTimestamp;
  });

  const dailyForecastTests = [];
  const seenForecastTests = new Set();
  for (const group of dailyOpenGroups) {
    const key = `${group[0].day}|${group[0].expiration}`;
    if (seenForecastTests.has(key)) continue;
    seenForecastTests.add(key);
    const settlement = Date.parse(`${group[0].expiration}T20:15:00Z`);
    const actual = futureVol(group[0].timestamp, settlement);
    if (!Number.isFinite(actual)) continue;
    dailyForecastTests.push({
      expiration: group[0].expiration,
      date: group[0].day,
      timestamp: group[0].timestamp,
      actual,
      forecasts: Object.fromEntries(Object.entries(forecastModels).map(
        ([name, model]) => [name, model(group[0].timestamp)],
      )),
    });
  }

  const forecastError = (modelName, universe) => {
    const rows = dailyForecastTests.filter((row) => universe.has(row.expiration)
      && Number.isFinite(row.forecasts[modelName]));
    const errors = rows.map((row) => row.forecasts[modelName] - row.actual);
    return {
      n: rows.length,
      mae: round(mean(errors.map(Math.abs))),
      rmse: round(Math.sqrt(mean(errors.map((error) => error ** 2)) || 0)),
      varianceMse: round(mean(rows.map((row) => (
        (row.forecasts[modelName] / 100) ** 2 - (row.actual / 100) ** 2
      ) ** 2))),
      bias: round(mean(errors)),
    };
  };
  const forecastValidation = Object.fromEntries(Object.keys(forecastModels).map((name) => [name, {
    training: forecastError(name, trainingExpirations),
    holdout: forecastError(name, holdoutExpirations),
  }]));
  const selectedForecast = Object.keys(forecastModels).sort((a, b) => (
    forecastValidation[a].training.varianceMse - forecastValidation[b].training.varianceMse
  ))[0];

  const snapshotRows = [];
  for (const group of dailyOpenGroups) {
    if (group.length < 7) continue;
    const timestamp = group[0].timestamp;
    const settlement = Date.parse(`${group[0].expiration}T20:15:00Z`);
    const days = Math.max((settlement - timestamp) / DAY_MS, 1 / (24 * 60));
    const forecastVol = forecastModels[selectedForecast](timestamp);
    if (!Number.isFinite(forecastVol)) continue;
    const contracts = group.map((contract) => {
      const signalPrice = Number(contract.bar.c);
      const spot = Number(contract.underlying.c);
      const marketIv = core.impliedVolatility({
        marketPrice: signalPrice,
        optionType: contract.type,
        spot,
        strike: contract.strike,
        days,
        rate: policy.annualRatePercent,
        dividend: policy.dividendYieldPercent,
      });
      return { ...contract, signalPrice, spot, days, marketIv };
    }).filter((contract) => Number.isFinite(contract.marketIv));
    if (contracts.length < 7) continue;
    const smile = contracts.map((contract) => ({ strike: contract.strike, iv: contract.marketIv }));
    const atmMarketIv = core.smoothedVolatility(contracts[0].spot, smile, contracts[0].spot);
    if (!Number.isFinite(atmMarketIv)) continue;
    for (const contract of contracts) {
      const surfaceIv = core.smoothedVolatility(contract.strike, smile, contract.spot);
      if (!Number.isFinite(surfaceIv)) continue;
      const fairIv = Math.min(Math.max(surfaceIv + (forecastVol - atmMarketIv), 1), 300);
      const fairValue = americanCrrPrice({
        optionType: contract.type,
        spot: contract.spot,
        strike: contract.strike,
        days,
        volatility: fairIv,
        rate: policy.annualRatePercent,
        dividend: policy.dividendYieldPercent,
      }, policy.treeSteps);
      const priceEdge = fairValue - contract.signalPrice;
      const edgePercent = contract.signalPrice > 0 ? (priceEdge / contract.signalPrice) * 100 : null;
      const dte = Math.min(10, Math.max(0, Math.floor((settlement - timestamp) / DAY_MS)));
      snapshotRows.push({
        id: contract.id,
        occ: contract.occ,
        ticker: "SPY",
        date: contract.day,
        expiration: contract.expiration,
        phase: holdoutExpirations.has(contract.expiration) ? "holdout" : "calibration",
        optionType: contract.type,
        strike: Number(contract.strike),
        dte,
        signalTimestamp: timestamp,
        signalTime: new Date(timestamp).toISOString(),
        forecastCutoff: new Date(timestamp - 1).toISOString(),
        spot: contract.spot,
        signalPrice: contract.signalPrice,
        marketIv: contract.marketIv,
        atmMarketIv,
        forecastVol,
        fairIv,
        volEdge: fairIv - contract.marketIv,
        fairValue,
        priceEdge,
        edgePercent,
        modelUsed: `American CRR (${policy.treeSteps} steps), ${selectedForecast} variance forecast`,
      });
    }
  }

  const availableDays = [...new Set(snapshotRows.map((row) => row.date))].sort();
  const selectedByDay = new Map();
  for (const day of availableDays) {
    const selected = snapshotRows
      .filter((row) => row.date === day
        && row.signalPrice >= policy.minimumSignalPrice
        && row.priceEdge >= policy.minimumAbsoluteGap
        && row.edgePercent >= policy.largeGapPercent
        && row.volEdge > 0)
      .sort((a, b) => b.edgePercent - a.edgePercent)
      .slice(0, policy.dailyCandidateCap);
    selectedByDay.set(day, selected);
  }

  const candidates = [];
  for (const day of availableDays) {
    for (const row of selectedByDay.get(day)) {
      const entryTimestamp = row.signalTimestamp + 3_600_000;
      const path = (contractBars.get(row.id) || []).filter((bar) => bar.timestamp >= entryTimestamp);
      const entryBar = path.find((bar) => bar.timestamp === entryTimestamp);
      if (!entryBar || !path.length) {
        candidates.push({ ...row, entryStatus: "no-next-hour-trade", actionable: false });
        continue;
      }
      const entryPrice = Number(entryBar.o);
      const entryGap = row.fairValue - entryPrice;
      const cost = Math.max(policy.minimumRoundTripCost, entryPrice * policy.costRate);
      const actionable = Number.isFinite(entryPrice) && entryPrice >= policy.minimumSignalPrice && entryGap > cost;
      if (!actionable) {
        candidates.push({
          ...row,
          entryTime: new Date(entryTimestamp).toISOString(),
          entryPrice: round(entryPrice),
          entryGap: round(entryGap),
          estimatedCost: round(cost),
          entryStatus: "gap-closed-before-entry",
          actionable: false,
        });
        continue;
      }
      const closeOutcome = exitOutcome({
        path,
        target: row.fairValue,
        entryPrice,
        hitField: "c",
        cost,
      });
      const highOutcome = exitOutcome({
        path,
        target: row.fairValue,
        entryPrice,
        hitField: "h",
        cost,
      });
      candidates.push({
        ...row,
        entryTime: new Date(entryTimestamp).toISOString(),
        entryPrice: round(entryPrice),
        entryGap: round(entryGap),
        estimatedCost: round(cost),
        entryStatus: "entered",
        actionable: true,
        closeHit: closeOutcome.hit,
        closeHitTime: closeOutcome.hitTimestamp,
        closeExitPrice: closeOutcome.exitPrice,
        grossPnl: closeOutcome.grossPnl,
        netPnl: closeOutcome.netPnl,
        netContractDollars: closeOutcome.netContractDollars,
        netReturnPercent: closeOutcome.returnPercent,
        highHit: highOutcome.hit,
        highHitTime: highOutcome.hitTimestamp,
        optimisticNetPnl: highOutcome.netPnl,
        optimisticContractDollars: highOutcome.netContractDollars,
        finalObservedTime: new Date(path.at(-1).timestamp).toISOString(),
        finalObservedPrice: round(Number(path.at(-1).c)),
        trajectory: path.map((point) => ({
          time: new Date(point.timestamp).toISOString(),
          close: round(Number(point.c)),
          high: round(Number(point.h)),
        })),
      });
    }
  }

  const actionable = candidates.filter((row) => row.actionable);
  const dailySummary = availableDays.map((date) => {
    const universe = snapshotRows.filter((row) => row.date === date);
    const flagged = candidates.filter((row) => row.date === date);
    const entered = flagged.filter((row) => row.actionable);
    return {
      date,
      phase: universe[0]?.phase ?? "unknown",
      dte: universe[0]?.dte ?? null,
      expiration: universe[0]?.expiration ?? null,
      contractsObserved: new Set(universe.map((row) => row.id)).size,
      largeGapCandidates: flagged.length,
      actionableCandidates: entered.length,
      noLargeGap: flagged.length === 0,
      gapClosedBeforeEntry: flagged.filter((row) => row.entryStatus === "gap-closed-before-entry").length,
      closeHitRate: entered.length ? round(entered.filter((row) => row.closeHit).length / entered.length) : null,
      optimisticHitRate: entered.length ? round(entered.filter((row) => row.highHit).length / entered.length) : null,
      meanNetPnl: round(mean(entered.map((row) => row.netPnl))),
      totalNetContractDollars: round(entered.reduce((total, row) => total + row.netContractDollars, 0), 2),
    };
  });
  const dteSummary = Array.from({ length: 11 }, (_, dte) => {
    const rows = actionable.filter((row) => row.dte === dte);
    return {
      dte,
      dataAvailable: snapshotRows.some((row) => row.dte === dte),
      observedContracts: snapshotRows.filter((row) => row.dte === dte).length,
      candidates: candidates.filter((row) => row.dte === dte).length,
      actionable: rows.length,
      closeHitRate: rows.length ? round(rows.filter((row) => row.closeHit).length / rows.length) : null,
      optimisticHitRate: rows.length ? round(rows.filter((row) => row.highHit).length / rows.length) : null,
      meanNetPnl: round(mean(rows.map((row) => row.netPnl))),
      meanNetContractDollars: round(mean(rows.map((row) => row.netContractDollars)), 2),
      winRate: rows.length ? round(rows.filter((row) => row.netPnl > 0).length / rows.length) : null,
    };
  });
  const thresholdSensitivity = [10, 20, 30, 50].map((threshold) => {
    const rows = snapshotRows.filter((row) => row.signalPrice >= policy.minimumSignalPrice
      && row.priceEdge >= policy.minimumAbsoluteGap
      && row.edgePercent >= threshold
      && row.volEdge > 0);
    return {
      threshold,
      signals: rows.length,
      uniqueDays: new Set(rows.map((row) => row.date)).size,
    };
  });
  const holdoutActionable = actionable.filter((row) => row.phase === "holdout");
  const cumulative = [];
  let running = 0;
  for (const day of dailySummary) {
    const rows = actionable.filter((row) => row.date === day.date);
    const dayAverage = mean(rows.map((row) => row.netPnl));
    if (Number.isFinite(dayAverage)) running += dayAverage;
    cumulative.push({ date: day.date, value: round(running), phase: day.phase });
  }

  return {
    generatedAt: new Date().toISOString(),
    title: "Fair-value gap candidate outcome study",
    status: "screening research, not arbitrage and not a trade recommendation",
    source: fixture.source,
    coverage: {
      ticker: "SPY",
      start: availableDays[0],
      end: availableDays.at(-1),
      tradingDays: availableDays.length,
      expirations,
      trainingExpirations: [...trainingExpirations],
      holdoutExpirations: [...holdoutExpirations],
      uniqueContracts: fixture.contracts.length,
      maximumContractsPerDay: Math.max(...dailySummary.map((day) => day.contractsObserved)),
      requestedDailyTarget: policy.dailyCandidateCap,
      dteAvailable: [...new Set(snapshotRows.map((row) => row.dte))].sort((a, b) => a - b),
      dteMissing: Array.from({ length: 11 }, (_, value) => value)
        .filter((value) => !snapshotRows.some((row) => row.dte === value)),
    },
    method: {
      signal: "First completed hourly option trade bar each day; one row per unique contract.",
      forecast: `${selectedForecast}, selected only on the first eight expirations by variance MSE; last four expirations held out.`,
      fairValue: `American CRR tree (${policy.treeSteps} steps) using the forecast-volatility level while preserving the same-day market smile.`,
      entry: "Next hour's first trade; a candidate is not entered if the model gap no longer exceeds the cost haircut.",
      target: "Original signal-time model fair value, held fixed for the target test.",
      conservativeExit: "Target counted only when a later hourly closing trade reaches it; otherwise the last observed trade is used.",
      optimisticExit: "Target counted when a later hourly high touches it; this is an upper bound, not proof of an executable fill.",
      costs: `${Math.round(policy.costRate * 100)}% of entry premium with a $${policy.minimumRoundTripCost.toFixed(2)} minimum round-trip haircut.`,
    },
    caveats: [
      "The historical source contains trades, not NBBO bid/ask quotes or depth. Entry and exit prices can be stale and are not guaranteed fills.",
      "Only 22 contracts are available per day, so this pilot cannot honestly select 50 contracts per day.",
      "Coverage is SPY and 0–4 DTE only. Rows for 5–10 DTE are deliberately marked unavailable.",
      "A model gap is not arbitrage. Forecast error, smile dynamics, theta, jumps, liquidity, assignment, fees, and execution can erase it.",
      "Calibration-period charts are diagnostic. Performance claims should use the untouched holdout only.",
    ],
    policy,
    forecastValidation,
    selectedForecast,
    summary: {
      allActionable: summarizeReturns(actionable),
      holdoutActionable: summarizeReturns(holdoutActionable),
      allCandidates: candidates.length,
      actionableCandidates: actionable.length,
      holdoutCandidates: candidates.filter((row) => row.phase === "holdout").length,
      holdoutActionableCandidates: holdoutActionable.length,
      noLargeGapDays: dailySummary.filter((day) => day.noLargeGap).length,
      closeTargetHitRate: actionable.length
        ? round(actionable.filter((row) => row.closeHit).length / actionable.length)
        : null,
      holdoutCloseTargetHitRate: holdoutActionable.length
        ? round(holdoutActionable.filter((row) => row.closeHit).length / holdoutActionable.length)
        : null,
      optimisticTargetHitRate: actionable.length
        ? round(actionable.filter((row) => row.highHit).length / actionable.length)
        : null,
      holdoutOptimisticTargetHitRate: holdoutActionable.length
        ? round(holdoutActionable.filter((row) => row.highHit).length / holdoutActionable.length)
        : null,
    },
    dailySummary,
    dteSummary,
    thresholdSensitivity,
    cumulative,
    candidates: candidates.map((row) => ({
      ...row,
      signalTimestamp: undefined,
      forecastCutoff: row.forecastCutoff,
      marketIv: round(row.marketIv, 4),
      atmMarketIv: round(row.atmMarketIv, 4),
      forecastVol: round(row.forecastVol, 4),
      fairIv: round(row.fairIv, 4),
      volEdge: round(row.volEdge, 4),
      fairValue: round(row.fairValue),
      priceEdge: round(row.priceEdge),
      edgePercent: round(row.edgePercent, 3),
    })),
  };
}

export const INTERNALS = Object.freeze({ americanCrrPrice, annualizedRealizedVol, firstTargetHit });
