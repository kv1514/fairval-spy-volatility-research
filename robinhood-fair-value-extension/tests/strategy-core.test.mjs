import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../strategy-core.js", import.meta.url), "utf8");
const context = vm.createContext({ Date, Math, Number, Object, String });
context.globalThis = context;
vm.runInContext(source, context);
const strategies = context.FairValStrategies;

const NOW = Date.parse("2026-08-11T18:00:00Z");

function contract(strike, fairValue, bid, ask, overrides = {}) {
  const optionType = overrides.optionType || "call";
  return {
    ticker: overrides.ticker || "SPY",
    expiration: "2026-08-14",
    optionType,
    strike,
    fairValue,
    fairIv: overrides.fairIv ?? 22,
    marketIv: overrides.marketIv ?? 18,
    surfaceBenchmark: { observations: 90 },
    variance: {
      candidateSide: overrides.candidateSide || "neutral",
      surfaceContextPass: overrides.surfaceContextPass ?? false,
      ivPercentile: overrides.ivPercentile ?? 35,
    },
    marketGreeks: {
      callDelta: overrides.delta ?? 0.5,
      putDelta: overrides.delta ?? -0.5,
      gamma: overrides.gamma ?? 0.03,
      vega: overrides.vega ?? 0.12,
    },
    exactQuote: {
      bid,
      ask,
      mark: (bid + ask) / 2,
      volume: overrides.volume ?? 500,
      openInterest: overrides.openInterest ?? 2_000,
      capturedAt: overrides.capturedAt ?? NOW,
    },
  };
}

test("strategy study is deliberately SPY-only", () => {
  const result = strategies.buildSpyStrategyStudy([
    contract(100, 2, 1.9, 2.0, { ticker: "QQQ" }),
  ], { ticker: "QQQ", now: NOW, spot: 100 });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.reason, "SPY-only research mode");
});

test("builds an executable defined-risk call vertical", () => {
  const result = strategies.buildSpyStrategyStudy([
    contract(100, 5.0, 4.4, 4.5, { delta: 0.58 }),
    contract(105, 1.8, 1.7, 1.8, { delta: 0.31 }),
  ], {
    ticker: "SPY",
    optionType: "call",
    expiration: "2026-08-14",
    spot: 102,
    now: NOW,
    minimumEdgePercent: 1,
  });
  const vertical = result.candidates.find((candidate) => candidate.label === "CALL DEBIT VERTICAL");
  assert.ok(vertical);
  assert.equal(vertical.entryType, "debit");
  assert.ok(Math.abs(vertical.marketCost - 2.8) < 1e-12); // buy ask 4.50, sell bid 1.70
  assert.ok(Math.abs(vertical.fairValue - 3.2) < 1e-12);
  assert.ok(Math.abs(vertical.edge - 0.4) < 1e-12);
  assert.ok(vertical.maxLossContract > 0 && vertical.maxLossContract <= 280.0000001);
  assert.ok(vertical.maxProfitContract > 0);
});

test("rejects structures whose apparent edge does not survive the full quoted spread", () => {
  const result = strategies.buildSpyStrategyStudy([
    contract(100, 5.05, 4.5, 5.0),
    contract(105, 2.0, 1.5, 2.0),
  ], {
    ticker: "SPY",
    spot: 102,
    now: NOW,
    minimumEdgePercent: 0,
    minimumSpreadCoverage: 1,
    maxSpreadPercent: 50,
  });
  assert.equal(result.candidates.length, 0);
  assert.match(result.diagnostics.noCandidateReason, /executable spread/);
});

test("requires fresh exact liquid quotes and historical context", () => {
  const stale = contract(100, 3, 2, 2.1, {
    candidateSide: "long_vol",
    surfaceContextPass: true,
    capturedAt: NOW - 121_000,
  });
  const result = strategies.buildSpyStrategyStudy([stale], {
    ticker: "SPY",
    spot: 100,
    now: NOW,
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.rejectionCounts["stale or estimated quote"], 1);
});

test("labels single-contract variance candidates as paper-only delta hedges", () => {
  const result = strategies.buildSpyStrategyStudy([
    contract(100, 2.6, 2.0, 2.1, {
      candidateSide: "long_vol",
      surfaceContextPass: true,
      delta: 0.42,
    }),
  ], {
    ticker: "SPY",
    spot: 100,
    now: NOW,
    minimumEdgePercent: 1,
  });
  const candidate = result.candidates.find((item) => item.family === "delta_hedged_variance");
  assert.ok(candidate);
  assert.equal(candidate.paperOnly, true);
  assert.ok(Math.abs(candidate.hedgeSharesPerContract + 42) < 1e-12);
});

test("finds equal-width butterfly curvature candidates", () => {
  const result = strategies.buildSpyStrategyStudy([
    contract(95, 8.0, 7.8, 7.9, { delta: 0.7 }),
    contract(100, 3.8, 4.1, 4.2, { delta: 0.5 }),
    contract(105, 1.8, 1.6, 1.7, { delta: 0.3 }),
  ], {
    ticker: "SPY",
    spot: 100,
    now: NOW,
    minimumEdgePercent: 1,
    maxCandidates: 20,
  });
  const fly = result.candidates.find((candidate) => candidate.label === "LONG CALL BUTTERFLY");
  assert.ok(fly);
  assert.equal(fly.legText, "+1 95C / -2 100C / +1 105C");
  assert.ok(Math.abs(fly.netDelta) < 1e-12);
  assert.ok(fly.maxLossContract >= 0);
});
