import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidateStudy, INTERNALS, STUDY_POLICY } from "../scripts/candidate-study-lib.mjs";

const studyPromise = buildCandidateStudy();

test("candidate study never uses a same-bar fill or future returns in the forecast", async () => {
  const study = await studyPromise;
  for (const row of study.candidates) {
    assert.ok(Date.parse(row.forecastCutoff) < Date.parse(row.signalTime));
    if (row.entryTime) assert.ok(Date.parse(row.entryTime) > Date.parse(row.signalTime));
  }
});

test("daily selection contains unique contracts and respects the candidate cap", async () => {
  const study = await studyPromise;
  for (const day of study.dailySummary) {
    const rows = study.candidates.filter((row) => row.date === day.date);
    assert.ok(rows.length <= STUDY_POLICY.dailyCandidateCap);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  }
});

test("reported target hits are supported by later observed prices", async () => {
  const study = await studyPromise;
  for (const row of study.candidates.filter((candidate) => candidate.actionable)) {
    assert.ok(row.trajectory.every((point) => Date.parse(point.time) >= Date.parse(row.entryTime)));
    if (row.closeHit) assert.ok(row.trajectory.some((point) => point.close >= row.fairValue - 1e-6));
    if (row.highHit) assert.ok(row.trajectory.some((point) => point.high >= row.fairValue - 1e-6));
    if (!row.closeHit) assert.equal(row.closeExitPrice, row.finalObservedPrice);
  }
});

test("the pilot makes missing DTE coverage and sub-50 daily capacity explicit", async () => {
  const study = await studyPromise;
  assert.deepEqual(study.coverage.dteMissing, [5, 6, 7, 8, 9, 10]);
  assert.ok(study.coverage.maximumContractsPerDay < study.coverage.requestedDailyTarget);
  assert.equal(study.dteSummary.length, 11);
});

test("American tree remains finite and respects intrinsic value", () => {
  const input = {
    optionType: "put",
    spot: 100,
    strike: 105,
    days: 5,
    volatility: 25,
    rate: 4,
    dividend: 0,
  };
  const value = INTERNALS.americanCrrPrice(input, 75);
  assert.ok(Number.isFinite(value));
  assert.ok(value >= 5);
});
