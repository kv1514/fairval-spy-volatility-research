const DEFAULTS = {
  settingsVersion: 10,
  enabled: true,
  ivSource: "surface",
  volatility: 20,
  ivShift: 0,
  surfaceShiftMethod: "total_variance_shift",
  autoRate: true,
  rate: 4.3,
  autoDividend: true,
  dividend: 1.1,
  alertsEnabled: true,
  strategyEnabled: true,
  gapThreshold: 10,
  maxSpreadPercent: 20,
  autoScan: true,
  autoScanIntervalSeconds: 30,
  paperRecording: true,
  treeSteps: 400,
  treeTolerance: 0.0025,
};
const PAPER_STUDY_VERSION = 5;
const IV_SOURCES = ["walkforward", "surface", "forecast", "individual", "manual"];
const SURFACE_METHODS = ["total_variance_shift", "variance_shift", "multiplicative_iv", "additive_iv"];

const fields = {
  enabled: document.getElementById("enabled"),
  ivSource: document.getElementById("ivSource"),
  volatility: document.getElementById("volatility"),
  ivShift: document.getElementById("ivShift"),
  surfaceShiftMethod: document.getElementById("surfaceShiftMethod"),
  autoRate: document.getElementById("autoRate"),
  rate: document.getElementById("rate"),
  autoDividend: document.getElementById("autoDividend"),
  dividend: document.getElementById("dividend"),
  alertsEnabled: document.getElementById("alertsEnabled"),
  strategyEnabled: document.getElementById("strategyEnabled"),
  gapThreshold: document.getElementById("gapThreshold"),
  maxSpreadPercent: document.getElementById("maxSpreadPercent"),
  autoScan: document.getElementById("autoScan"),
  autoScanIntervalSeconds: document.getElementById("autoScanIntervalSeconds"),
  paperRecording: document.getElementById("paperRecording"),
  treeSteps: document.getElementById("treeSteps"),
  treeTolerance: document.getElementById("treeTolerance"),
};

function syncDisabledState() {
  fields.volatility.disabled = !["forecast", "manual"].includes(fields.ivSource.value);
  fields.rate.disabled = fields.autoRate.checked;
  fields.dividend.disabled = fields.autoDividend.checked;
  fields.autoScanIntervalSeconds.disabled = !fields.autoScan.checked;
}

function showPaperStatus(study) {
  const status = document.getElementById("paperStatus");
  const records = study?.records?.length || 0;
  const outcome = study?.outcomes60m;
  const horizonCounts = [5, 15, 30, 60].map((minutes) => study?.[`outcomes${minutes}m`]?.count || 0).join("/");
  const eodCount = study?.outcomesEod?.count || 0;
  const hedgeCopy = outcome?.deltaHedgedCount
    ? ` · gross delta-hedged mean ${outcome.meanDeltaHedgedPnlContract >= 0 ? "+" : ""}$${outcome.meanDeltaHedgedPnlContract.toFixed(2)}/contract`
    : "";
  status.textContent = outcome?.count
    ? `${records.toLocaleString()} snapshots · 5/15/30/60m ${horizonCounts} · EOD ${eodCount} · 60m ${(outcome.winRate * 100).toFixed(1)}% positive · option mean ${outcome.meanPnl >= 0 ? "+" : ""}$${outcome.meanPnl.toFixed(2)}/share${hedgeCopy}`
    : `${records.toLocaleString()} snapshots · 5/15/30/60m ${horizonCounts} · EOD ${eodCount}.`;
}

function showForecastStatus(payload) {
  const status = document.getElementById("forecastStatus");
  if (payload?.schema !== "volatility_forecast.v1" || !Array.isArray(payload.records) || !payload.records.length) {
    status.textContent = "No valid forecast file imported.";
    return;
  }
  const tickers = [...new Set(payload.records.map((record) => String(record.ticker || "").toUpperCase()).filter(Boolean))];
  const latest = payload.records.map((record) => String(record.as_of_date || "")).sort().at(-1);
  const buckets = Array.isArray(payload.surface_benchmarks) ? payload.surface_benchmarks.length : 0;
  status.textContent = `${payload.records.length} forecasts · ${buckets} historical IV buckets · ${tickers.join(", ")} · latest ${latest || "unknown"}`;
}

chrome.storage.sync.get(null, (saved) => {
  const settings = { ...DEFAULTS, ...saved };
  const needsMigration = Number(saved.settingsVersion || 0) < DEFAULTS.settingsVersion;
  if (needsMigration && Number(settings.treeSteps) <= 75) settings.treeSteps = DEFAULTS.treeSteps;
  if (!Number.isFinite(Number(settings.treeTolerance))) settings.treeTolerance = DEFAULTS.treeTolerance;
  if (needsMigration) chrome.storage.sync.set({
    settingsVersion: DEFAULTS.settingsVersion,
    alertsEnabled: settings.alertsEnabled,
    strategyEnabled: settings.strategyEnabled,
    gapThreshold: settings.gapThreshold,
    maxSpreadPercent: settings.maxSpreadPercent,
    autoScan: settings.autoScan,
    autoScanIntervalSeconds: settings.autoScanIntervalSeconds,
    paperRecording: settings.paperRecording,
    treeSteps: settings.treeSteps,
    treeTolerance: settings.treeTolerance,
    surfaceShiftMethod: settings.surfaceShiftMethod,
  });
  fields.enabled.checked = settings.enabled;
  fields.ivSource.value = IV_SOURCES.includes(settings.ivSource)
    ? settings.ivSource
    : "surface";
  fields.volatility.value = settings.volatility;
  fields.ivShift.value = settings.ivShift;
  fields.surfaceShiftMethod.value = SURFACE_METHODS.includes(settings.surfaceShiftMethod)
    ? settings.surfaceShiftMethod : DEFAULTS.surfaceShiftMethod;
  fields.autoRate.checked = settings.autoRate;
  fields.rate.value = settings.rate;
  fields.autoDividend.checked = settings.autoDividend;
  fields.dividend.value = settings.dividend;
  fields.alertsEnabled.checked = settings.alertsEnabled;
  fields.strategyEnabled.checked = settings.strategyEnabled;
  fields.gapThreshold.value = settings.gapThreshold;
  fields.maxSpreadPercent.value = settings.maxSpreadPercent;
  fields.autoScan.checked = settings.autoScan;
  fields.autoScanIntervalSeconds.value = settings.autoScanIntervalSeconds;
  fields.paperRecording.checked = settings.paperRecording;
  fields.treeSteps.value = settings.treeSteps;
  fields.treeTolerance.value = settings.treeTolerance;
  syncDisabledState();
});

chrome.storage.local.get({
  paperStudyV1: { version: PAPER_STUDY_VERSION, records: [] },
  volatilityForecastV1: { schema: "volatility_forecast.v1", records: [] },
}, ({ paperStudyV1, volatilityForecastV1 }) => {
  showPaperStatus(paperStudyV1);
  showForecastStatus(volatilityForecastV1);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.paperStudyV1?.newValue) showPaperStatus(changes.paperStudyV1.newValue);
  if (area === "local" && changes.volatilityForecastV1?.newValue) showForecastStatus(changes.volatilityForecastV1.newValue);
});

document.getElementById("forecastFile").addEventListener("change", async (event) => {
  const message = document.getElementById("message");
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload?.schema !== "volatility_forecast.v1" || !Array.isArray(payload.records) || !payload.records.length) {
      throw new Error("Expected schema volatility_forecast.v1 with at least one record");
    }
    const invalid = payload.records.some((record) =>
      !record.ticker || !Number.isFinite(Number(record.horizon)) || !Number.isFinite(Number(record.forecast_vol))
    );
    if (invalid) throw new Error("A forecast record is missing ticker, horizon, or forecast_vol");
    chrome.storage.local.set({ volatilityForecastV1: payload });
    fields.ivSource.value = "walkforward";
    chrome.storage.sync.set({ ivSource: "walkforward", settingsVersion: DEFAULTS.settingsVersion });
    showForecastStatus(payload);
    syncDisabledState();
    message.textContent = "Forecast imported. Apply, then return to Robinhood.";
  } catch (error) {
    message.textContent = `Import failed: ${error.message}`;
  } finally {
    event.target.value = "";
  }
});

fields.ivSource.addEventListener("change", syncDisabledState);
fields.autoRate.addEventListener("change", syncDisabledState);
fields.autoDividend.addEventListener("change", syncDisabledState);
fields.autoScan.addEventListener("change", syncDisabledState);

document.getElementById("apply").addEventListener("click", () => {
  const settings = {
    settingsVersion: DEFAULTS.settingsVersion,
    enabled: fields.enabled.checked,
    ivSource: IV_SOURCES.includes(fields.ivSource.value)
      ? fields.ivSource.value
      : "surface",
    volatility: Math.max(0.01, Number(fields.volatility.value) || DEFAULTS.volatility),
    ivShift: Math.min(Math.max(Number(fields.ivShift.value) || 0, -100), 100),
    surfaceShiftMethod: SURFACE_METHODS.includes(fields.surfaceShiftMethod.value)
      ? fields.surfaceShiftMethod.value : DEFAULTS.surfaceShiftMethod,
    autoRate: fields.autoRate.checked,
    rate: Number(fields.rate.value) || 0,
    autoDividend: fields.autoDividend.checked,
    dividend: Math.max(0, Number(fields.dividend.value) || 0),
    alertsEnabled: fields.alertsEnabled.checked,
    strategyEnabled: fields.strategyEnabled.checked,
    gapThreshold: Math.min(Math.max(Number(fields.gapThreshold.value) || DEFAULTS.gapThreshold, 1), 100),
    maxSpreadPercent: Math.min(Math.max(Number(fields.maxSpreadPercent.value) || DEFAULTS.maxSpreadPercent, 1), 100),
    autoScan: fields.autoScan.checked,
    autoScanIntervalSeconds: Math.min(Math.max(Number(fields.autoScanIntervalSeconds.value) || 30, 15), 300),
    paperRecording: fields.paperRecording.checked,
    treeSteps: Math.min(Math.max(Number(fields.treeSteps.value) || 400, 100), 800),
    treeTolerance: Math.min(Math.max(Number(fields.treeTolerance.value) || 0.0025, 0.0001), 0.1),
  };
  chrome.storage.sync.set(settings, async () => {
    const message = document.getElementById("message");
    message.textContent = "Updated. Return to the option chain.";
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "bsfv-refresh" });
    } catch {
      // The content script will use the stored settings on the next Robinhood page.
    }
  });
});

document.getElementById("exportPaper").addEventListener("click", () => {
  chrome.storage.local.get({ paperStudyV1: { version: PAPER_STUDY_VERSION, records: [] } }, ({ paperStudyV1 }) => {
    const blob = new Blob([JSON.stringify(paperStudyV1, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fair-value-paper-study-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  });
});

document.getElementById("clearPaper").addEventListener("click", () => {
  if (!confirm("Clear all locally recorded paper observations?")) return;
  const empty = { version: PAPER_STUDY_VERSION, records: [], updatedAt: Date.now(), outcomes5m: null, outcomes15m: null, outcomes30m: null, outcomes60m: null, outcomesEod: null };
  chrome.storage.local.set({ paperStudyV1: empty }, () => showPaperStatus(empty));
});
