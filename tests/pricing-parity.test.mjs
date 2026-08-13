import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const [source, vectors] = await Promise.all([
  readFile(new URL("../app/lib/pricing.ts", import.meta.url), "utf8"),
  readFile(new URL("../robinhood-fair-value-extension/tests/fixtures/pricing-golden-vectors.json", import.meta.url), "utf8").then(JSON.parse),
]);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleRecord = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleRecord,
  exports: moduleRecord.exports,
  Intl,
  Date,
  Math,
  Number,
  Object,
  String,
});

test("website TypeScript pricing matches extension/Python golden vectors", () => {
  const pricing = moduleRecord.exports;
  for (const vector of vectors) {
    const input = { ...vector.inputs, optionType: vector.inputs.optionType };
    const adaptive = pricing.calculateAdaptiveCrr(input, {
      minSteps: 50,
      maxSteps: 400,
      tolerance: 0.0025,
      american: true,
    });
    const blackScholes = pricing.calculateBlackScholes(input);
    const bsPrice = vector.inputs.optionType === "put" ? blackScholes.put : blackScholes.call;
    assert.ok(Math.abs(adaptive.price - vector.adaptivePrice) < 1e-9, vector.name);
    assert.ok(Math.abs(bsPrice - vector.blackScholesPrice) < 1e-10, vector.name);
    assert.equal(adaptive.steps, vector.stepsUsed, vector.name);
  }
});
