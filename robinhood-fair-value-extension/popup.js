const DEFAULTS = {
  settingsVersion: 2,
  enabled: true,
  ivSource: "surface",
  volatility: 20,
  ivShift: 0,
  autoRate: true,
  rate: 4.3,
  autoDividend: true,
  dividend: 1.1,
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
};

function syncDisabledState() {
  fields.volatility.disabled = fields.ivSource.value !== "manual";
  fields.rate.disabled = fields.autoRate.checked;
  fields.dividend.disabled = fields.autoDividend.checked;
}

chrome.storage.sync.get(null, (saved) => {
  const settings = { ...DEFAULTS, ...saved };
  if (Number(saved.settingsVersion || 0) < DEFAULTS.settingsVersion) {
    settings.ivSource = "surface";
    chrome.storage.sync.set({ ivSource: settings.ivSource, settingsVersion: DEFAULTS.settingsVersion });
  }
  fields.enabled.checked = settings.enabled;
  fields.ivSource.value = ["surface", "individual", "manual"].includes(settings.ivSource)
    ? settings.ivSource
    : "surface";
  fields.volatility.value = settings.volatility;
  fields.ivShift.value = settings.ivShift;
  fields.autoRate.checked = settings.autoRate;
  fields.rate.value = settings.rate;
  fields.autoDividend.checked = settings.autoDividend;
  fields.dividend.value = settings.dividend;
  syncDisabledState();
});

fields.ivSource.addEventListener("change", syncDisabledState);
fields.autoRate.addEventListener("change", syncDisabledState);
fields.autoDividend.addEventListener("change", syncDisabledState);

document.getElementById("apply").addEventListener("click", () => {
  const settings = {
    settingsVersion: DEFAULTS.settingsVersion,
    enabled: fields.enabled.checked,
    ivSource: ["surface", "individual", "manual"].includes(fields.ivSource.value)
      ? fields.ivSource.value
      : "surface",
    volatility: Math.max(0.01, Number(fields.volatility.value) || DEFAULTS.volatility),
    ivShift: Math.min(Math.max(Number(fields.ivShift.value) || 0, -100), 100),
    autoRate: fields.autoRate.checked,
    rate: Number(fields.rate.value) || 0,
    autoDividend: fields.autoDividend.checked,
    dividend: Math.max(0, Number(fields.dividend.value) || 0),
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
