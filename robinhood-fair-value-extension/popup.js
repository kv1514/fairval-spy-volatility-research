const DEFAULTS = {
  settingsVersion: 4,
  enabled: true,
  ivSource: "surface",
  volatility: 20,
  ivShift: 0,
  autoRate: true,
  rate: 4.3,
  autoDividend: true,
  dividend: 1.1,
  alertsEnabled: true,
  gapThreshold: 10,
  maxSpreadPercent: 20,
  autoScan: true,
  autoScanIntervalSeconds: 30,
  paperRecording: true,
};

const fields = {
  enabled: document.getElementById("enabled"),
  ivSource: document.getElementById("ivSource"),
  volatility: document.getElementById("volatility"),
  ivShift: document.getElementById("ivShift"),
  autoRate: document.getElementById("autoRate"),
  rate: document.getElementById("rate"),
  autoDividend: document.getElementById("autoDividend"),
  dividend: document.getElementById("dividend"),
  alertsEnabled: document.getElementById("alertsEnabled"),
  gapThreshold: document.getElementById("gapThreshold"),
  maxSpreadPercent: document.getElementById("maxSpreadPercent"),
  autoScan: document.getElementById("autoScan"),
  autoScanIntervalSeconds: document.getElementById("autoScanIntervalSeconds"),
  paperRecording: document.getElementById("paperRecording"),
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
  status.textContent = outcome?.count
    ? `${records.toLocaleString()} snapshots · ${outcome.count} resolved 60m flags · ${(outcome.winRate * 100).toFixed(1)}% positive · mean ${outcome.meanPnl >= 0 ? "+" : ""}$${outcome.meanPnl.toFixed(2)}`
    : `${records.toLocaleString()} snapshots · no 60m flag outcomes resolved yet.`;
}

chrome.storage.sync.get(null, (saved) => {
  const settings = { ...DEFAULTS, ...saved };
  if (Number(saved.settingsVersion || 0) < DEFAULTS.settingsVersion) chrome.storage.sync.set({
    settingsVersion: DEFAULTS.settingsVersion,
    alertsEnabled: settings.alertsEnabled,
    gapThreshold: settings.gapThreshold,
    maxSpreadPercent: settings.maxSpreadPercent,
    autoScan: settings.autoScan,
    autoScanIntervalSeconds: settings.autoScanIntervalSeconds,
    paperRecording: settings.paperRecording,
  });
  fields.enabled.checked = settings.enabled;
  fields.ivSource.value = ["surface", "forecast", "individual", "manual"].includes(settings.ivSource)
    ? settings.ivSource
    : "surface";
  fields.volatility.value = settings.volatility;
  fields.ivShift.value = settings.ivShift;
  fields.autoRate.checked = settings.autoRate;
  fields.rate.value = settings.rate;
  fields.autoDividend.checked = settings.autoDividend;
  fields.dividend.value = settings.dividend;
  fields.alertsEnabled.checked = settings.alertsEnabled;
  fields.gapThreshold.value = settings.gapThreshold;
  fields.maxSpreadPercent.value = settings.maxSpreadPercent;
  fields.autoScan.checked = settings.autoScan;
  fields.autoScanIntervalSeconds.value = settings.autoScanIntervalSeconds;
  fields.paperRecording.checked = settings.paperRecording;
  syncDisabledState();
});

chrome.storage.local.get({ paperStudyV1: { version: 2, records: [] } }, ({ paperStudyV1 }) => showPaperStatus(paperStudyV1));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.paperStudyV1?.newValue) showPaperStatus(changes.paperStudyV1.newValue);
});

fields.ivSource.addEventListener("change", syncDisabledState);
fields.autoRate.addEventListener("change", syncDisabledState);
fields.autoDividend.addEventListener("change", syncDisabledState);
fields.autoScan.addEventListener("change", syncDisabledState);

document.getElementById("apply").addEventListener("click", () => {
  const settings = {
    settingsVersion: DEFAULTS.settingsVersion,
    enabled: fields.enabled.checked,
    ivSource: ["surface", "forecast", "individual", "manual"].includes(fields.ivSource.value)
      ? fields.ivSource.value
      : "surface",
    volatility: Math.max(0.01, Number(fields.volatility.value) || DEFAULTS.volatility),
    ivShift: Math.min(Math.max(Number(fields.ivShift.value) || 0, -100), 100),
    autoRate: fields.autoRate.checked,
    rate: Number(fields.rate.value) || 0,
    autoDividend: fields.autoDividend.checked,
    dividend: Math.max(0, Number(fields.dividend.value) || 0),
    alertsEnabled: fields.alertsEnabled.checked,
    gapThreshold: Math.min(Math.max(Number(fields.gapThreshold.value) || DEFAULTS.gapThreshold, 1), 100),
    maxSpreadPercent: Math.min(Math.max(Number(fields.maxSpreadPercent.value) || DEFAULTS.maxSpreadPercent, 1), 100),
    autoScan: fields.autoScan.checked,
    autoScanIntervalSeconds: Math.min(Math.max(Number(fields.autoScanIntervalSeconds.value) || 30, 15), 300),
    paperRecording: fields.paperRecording.checked,
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
  chrome.storage.local.get({ paperStudyV1: { version: 2, records: [] } }, ({ paperStudyV1 }) => {
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
  const empty = { version: 2, records: [], updatedAt: Date.now(), outcomes15m: null, outcomes60m: null };
  chrome.storage.local.set({ paperStudyV1: empty }, () => showPaperStatus(empty));
});
