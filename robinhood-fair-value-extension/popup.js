const DEFAULTS = {
  enabled: true,
  ivSource: "manual",
  volatility: 20,
  rate: 4.3,
  autoDividend: true,
  dividend: 1.1,
};

const fields = {
  enabled: document.getElementById("enabled"),
  ivSource: document.getElementById("ivSource"),
  volatility: document.getElementById("volatility"),
  rate: document.getElementById("rate"),
  autoDividend: document.getElementById("autoDividend"),
  dividend: document.getElementById("dividend"),
};

function syncDisabledState() {
  fields.volatility.disabled = fields.ivSource.value === "selected";
  fields.dividend.disabled = fields.autoDividend.checked;
}

chrome.storage.sync.get(DEFAULTS, (settings) => {
  fields.enabled.checked = settings.enabled;
  fields.ivSource.value = settings.ivSource;
  fields.volatility.value = settings.volatility;
  fields.rate.value = settings.rate;
  fields.autoDividend.checked = settings.autoDividend;
  fields.dividend.value = settings.dividend;
  syncDisabledState();
});

fields.ivSource.addEventListener("change", syncDisabledState);
fields.autoDividend.addEventListener("change", syncDisabledState);

document.getElementById("apply").addEventListener("click", () => {
  const settings = {
    enabled: fields.enabled.checked,
    ivSource: fields.ivSource.value === "selected" ? "selected" : "manual",
    volatility: Math.max(0.01, Number(fields.volatility.value) || DEFAULTS.volatility),
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
