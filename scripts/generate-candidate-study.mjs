import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCandidateStudy, toCsv } from "./candidate-study-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const study = await buildCandidateStudy();
const appOutput = resolve(root, "app/research/backtest-data.json");
const publicOutput = resolve(root, "public/research");
await mkdir(dirname(appOutput), { recursive: true });
await mkdir(publicOutput, { recursive: true });
await writeFile(appOutput, `${JSON.stringify(study, null, 2)}\n`, "utf8");

const candidateFields = [
  "ticker", "date", "phase", "expiration", "dte", "optionType", "strike", "occ",
  "signalTime", "entryTime", "signalPrice", "entryPrice", "marketIv", "forecastVol",
  "fairIv", "volEdge", "fairValue", "priceEdge", "edgePercent", "estimatedCost",
  "entryStatus", "actionable", "closeHit", "closeHitTime", "netPnl",
  "netContractDollars", "netReturnPercent", "highHit", "highHitTime",
  "optimisticNetPnl", "finalObservedTime", "finalObservedPrice", "modelUsed",
];
await writeFile(
  resolve(publicOutput, "candidate-outcomes.csv"),
  `${toCsv(study.candidates, candidateFields)}\n`,
  "utf8",
);
await writeFile(
  resolve(publicOutput, "daily-summary.csv"),
  `${toCsv(study.dailySummary, Object.keys(study.dailySummary[0] || {}))}\n`,
  "utf8",
);
await writeFile(
  resolve(publicOutput, "dte-summary.csv"),
  `${toCsv(study.dteSummary, Object.keys(study.dteSummary[0] || {}))}\n`,
  "utf8",
);

console.log(JSON.stringify({
  output: appOutput,
  coverage: study.coverage,
  summary: study.summary,
  selectedForecast: study.selectedForecast,
}, null, 2));
