(function fairValueExtension() {
  "use strict";

  const DIVIDEND_DEFAULTS = { SPY: 1.1, SPX: 1.25, QQQ: 0.55 };
  const DEFAULT_SETTINGS = {
    enabled: true,
    ivSource: "manual",
    volatility: 20,
    rate: 4.3,
    autoDividend: true,
    dividend: 1.1,
    collapsed: false,
  };

  const normalPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  function normalCdf(x) {
    const sign = x < 0 ? -1 : 1;
    const absolute = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * absolute);
    const erf =
      1 -
      (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
        0.254829592) *
        t *
        Math.exp(-absolute * absolute));
    return 0.5 * (1 + sign * erf);
  }

  function calculateBlackScholes(input) {
    const S = Math.max(Number(input.spot), 0.0001);
    const K = Math.max(Number(input.strike), 0.0001);
    const T = Math.max(Number(input.days) / 365, 1 / (365 * 24 * 60));
    const sigma = Math.max(Number(input.volatility) / 100, 0.0001);
    const r = Number(input.rate) / 100;
    const q = Number(input.dividend) / 100;
    const sqrtT = Math.sqrt(T);
    const discountR = Math.exp(-r * T);
    const discountQ = Math.exp(-q * T);
    const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const pdfD1 = normalPdf(d1);
    const nD1 = normalCdf(d1);
    const nD2 = normalCdf(d2);

    return {
      call: Math.max(S * discountQ * nD1 - K * discountR * nD2, 0),
      put: Math.max(K * discountR * normalCdf(-d2) - S * discountQ * normalCdf(-d1), 0),
      callDelta: discountQ * nD1,
      putDelta: discountQ * (nD1 - 1),
      gamma: (discountQ * pdfD1) / (S * sigma * sqrtT),
      vega: (S * discountQ * pdfD1 * sqrtT) / 100,
    };
  }

  function parseMoney(value) {
    if (typeof value !== "string" || value.includes("—")) return null;
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseHeading(value) {
    const match = String(value || "").match(/^([A-Z.^-]+)\s+(buy|sell)\s+(Call|Put)$/i);
    if (!match) return null;
    return {
      ticker: match[1].replace(/^\^/, "").toUpperCase(),
      side: match[2].toLowerCase(),
      optionType: match[3].toLowerCase(),
    };
  }

  function parseExpirationLabel(value, now = new Date()) {
    const months = {
      january: 0,
      february: 1,
      march: 2,
      april: 3,
      may: 4,
      june: 5,
      july: 6,
      august: 7,
      september: 8,
      october: 9,
      november: 10,
      december: 11,
    };
    const match = String(value || "").match(
      /(?:Expiring\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i,
    );
    if (!match) return null;
    const month = months[match[1].toLowerCase()];
    const day = Number(match[2]);
    let year = now.getUTCFullYear();
    let candidate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (newYorkSettlement(candidate) < now.getTime() - 2 * 86_400_000) {
      year += 1;
      candidate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return candidate;
  }

  function timeZoneOffset(timestamp, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const representedAsUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    return representedAsUtc - timestamp;
  }

  function newYorkSettlement(expiration, settlementMinutes = 16 * 60 + 15) {
    const [year, month, day] = String(expiration).split("-").map(Number);
    if (![year, month, day].every(Number.isFinite)) return Number.NaN;
    const hour = Math.floor(settlementMinutes / 60);
    const minute = settlementMinutes % 60;
    const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    const firstPass = localAsUtc - timeZoneOffset(localAsUtc, "America/New_York");
    return localAsUtc - timeZoneOffset(firstPass, "America/New_York");
  }

  function daysToExpiration(expiration, now = Date.now(), settlementMinutes = 16 * 60 + 15) {
    const settlement = newYorkSettlement(expiration, settlementMinutes);
    if (!Number.isFinite(settlement)) return null;
    return Math.max((settlement - now) / 86_400_000, 1 / (24 * 60));
  }

  function extractSelectedIv(value) {
    const match = String(value || "").match(/Implied volatility\s*([0-9]+(?:\.[0-9]+)?)%/i);
    return match ? Number(match[1]) : null;
  }

  function formatMoney(value) {
    return `$${Number(value).toFixed(2)}`;
  }

  function textWithoutOverlay(element) {
    if (!element) return "";
    const copy = element.cloneNode(true);
    copy.querySelectorAll?.("[data-bsfv-overlay]").forEach((overlay) => overlay.remove());
    return copy.textContent || "";
  }

  const Core = {
    calculateBlackScholes,
    daysToExpiration,
    extractSelectedIv,
    formatMoney,
    newYorkSettlement,
    parseExpirationLabel,
    parseHeading,
    parseMoney,
  };

  globalThis.__BSFV_CORE__ = Core;

  if (typeof document === "undefined" || typeof chrome === "undefined" || !chrome.storage) return;

  let settings = { ...DEFAULT_SETTINGS };
  let observer;
  let renderQueued = false;
  let renderTimer;

  function pageContext() {
    const heading = [...document.querySelectorAll("h1")]
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .map(parseHeading)
      .find(Boolean);
    if (!heading) return null;

    const shareButton = [...document.querySelectorAll("button")].find((button) =>
      /^Share price:/i.test((button.textContent || "").replace(/\s+/g, " ").trim()),
    );
    const spot = parseMoney(shareButton?.textContent || "");
    const expirationControl = document.querySelector('[aria-label="Expiration Date"]');
    const expiration = parseExpirationLabel(expirationControl?.textContent || "");
    const grid = document.querySelector('[role="grid"]');
    const selectedIv = extractSelectedIv(grid?.textContent || "");
    const priceHeading = [...document.querySelectorAll("h4")]
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .find((text) => /^(Ask|Bid|Mark|Natural) Price$/i.test(text));

    if (spot == null || !expiration || !grid) return null;
    return {
      ...heading,
      spot,
      expiration,
      selectedIv,
      priceHeading: priceHeading || (heading.side === "buy" ? "Ask Price" : "Bid Price"),
      grid,
    };
  }

  function removeBadges() {
    document.querySelectorAll("[data-bsfv-overlay]").forEach((element) => element.remove());
    document.querySelectorAll("[data-bsfv-cell]").forEach((element) => element.removeAttribute("data-bsfv-cell"));
  }

  function ensurePanel() {
    let panel = document.getElementById("bsfv-panel");
    if (panel) return panel;
    panel = document.createElement("section");
    panel.id = "bsfv-panel";
    panel.setAttribute("aria-label", "Black-Scholes fair value controls");
    panel.innerHTML = `
      <div class="bsfv-panel-header">
        <div><span class="bsfv-live-dot"></span><strong>FAIR VALUE OVERLAY</strong></div>
        <button id="bsfv-collapse" type="button" aria-label="Collapse fair value controls">−</button>
      </div>
      <div id="bsfv-panel-body">
        <p id="bsfv-context">Open an option chain to begin.</p>
        <div class="bsfv-control-grid">
          <label>IV source
            <select id="bsfv-iv-source">
              <option value="manual">Manual IV</option>
              <option value="selected">Selected-row IV</option>
            </select>
          </label>
          <label>Volatility
            <span><input id="bsfv-volatility" type="number" min="0.01" max="500" step="0.1"><small>%</small></span>
          </label>
          <label>Risk-free rate
            <span><input id="bsfv-rate" type="number" min="-20" max="100" step="0.05"><small>%</small></span>
          </label>
          <label>Dividend yield
            <span><input id="bsfv-dividend" type="number" min="0" max="100" step="0.05"><small>%</small></span>
          </label>
        </div>
        <label class="bsfv-check"><input id="bsfv-auto-dividend" type="checkbox"> Use ticker dividend default</label>
        <p id="bsfv-status">Waiting for Robinhood’s visible chain…</p>
        <p class="bsfv-disclaimer">Local model comparison only · no orders · no data leaves this page</p>
      </div>`;
    document.documentElement.appendChild(panel);

    panel.querySelector("#bsfv-collapse").addEventListener("click", () => {
      settings.collapsed = !settings.collapsed;
      chrome.storage.sync.set({ collapsed: settings.collapsed });
      syncPanel();
    });
    panel.querySelector("#bsfv-iv-source").addEventListener("change", (event) => {
      settings.ivSource = event.target.value === "selected" ? "selected" : "manual";
      chrome.storage.sync.set({ ivSource: settings.ivSource });
      syncPanel();
      scheduleRender();
    });
    for (const [id, key] of [
      ["bsfv-volatility", "volatility"],
      ["bsfv-rate", "rate"],
      ["bsfv-dividend", "dividend"],
    ]) {
      panel.querySelector(`#${id}`).addEventListener("change", (event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value)) return;
        settings[key] = value;
        chrome.storage.sync.set({ [key]: value });
        scheduleRender();
      });
    }
    panel.querySelector("#bsfv-auto-dividend").addEventListener("change", (event) => {
      settings.autoDividend = event.target.checked;
      chrome.storage.sync.set({ autoDividend: settings.autoDividend });
      scheduleRender();
    });
    return panel;
  }

  function syncPanel(context = pageContext(), effectiveIv = null, effectiveDividend = null) {
    const panel = ensurePanel();
    panel.classList.toggle("is-collapsed", settings.collapsed);
    panel.querySelector("#bsfv-panel-body").hidden = settings.collapsed;
    panel.querySelector("#bsfv-collapse").textContent = settings.collapsed ? "+" : "−";
    panel.querySelector("#bsfv-iv-source").value = settings.ivSource;
    panel.querySelector("#bsfv-volatility").value = String(settings.volatility);
    panel.querySelector("#bsfv-volatility").disabled = settings.ivSource === "selected";
    panel.querySelector("#bsfv-rate").value = String(settings.rate);
    panel.querySelector("#bsfv-dividend").value = String(settings.dividend);
    panel.querySelector("#bsfv-dividend").disabled = settings.autoDividend;
    panel.querySelector("#bsfv-auto-dividend").checked = settings.autoDividend;

    const contextLine = panel.querySelector("#bsfv-context");
    const statusLine = panel.querySelector("#bsfv-status");
    if (!context) {
      contextLine.textContent = "Open a Robinhood option chain to begin.";
      statusLine.textContent = "No supported chain detected.";
      return;
    }
    contextLine.textContent = `${context.ticker} ${context.optionType.toUpperCase()} · ${context.expiration} · spot ${formatMoney(context.spot)}`;
    const ivCopy = settings.ivSource === "selected"
      ? context.selectedIv != null
        ? `selected IV ${context.selectedIv.toFixed(2)}%`
        : `selected IV unavailable; using manual ${settings.volatility.toFixed(2)}%`
      : `manual IV ${Number(effectiveIv ?? settings.volatility).toFixed(2)}%`;
    statusLine.textContent = `${ivCopy} · r ${settings.rate.toFixed(2)}% · q ${Number(effectiveDividend ?? settings.dividend).toFixed(2)}%`;
  }

  function render() {
    renderQueued = false;
    if (!settings.enabled) {
      removeBadges();
      ensurePanel().classList.add("is-disabled");
      return;
    }
    ensurePanel().classList.remove("is-disabled");
    const context = pageContext();
    if (!context) {
      removeBadges();
      syncPanel(null);
      return;
    }

    const days = daysToExpiration(context.expiration);
    const selectedIv = settings.ivSource === "selected" ? context.selectedIv : null;
    const effectiveIv = selectedIv != null ? selectedIv : Number(settings.volatility);
    const effectiveDividend = settings.autoDividend
      ? DIVIDEND_DEFAULTS[context.ticker] ?? Number(settings.dividend)
      : Number(settings.dividend);
    syncPanel(context, effectiveIv, effectiveDividend);

    const rows = [...context.grid.querySelectorAll('[data-testid^="ChainTableRow-"]')];
    for (const row of rows) {
      const strikeCell = row.querySelector('[data-testid="OptionChainStrikePriceCell"]');
      const priceCell = row.querySelector('[data-testid="OptionChainValidPriceCell"]');
      const strike = parseMoney(strikeCell?.textContent || "");
      const marketPrice = parseMoney(textWithoutOverlay(priceCell));
      if (!priceCell || strike == null || marketPrice == null || days == null) {
        row.querySelector("[data-bsfv-overlay]")?.remove();
        priceCell?.removeAttribute("data-bsfv-cell");
        continue;
      }

      const result = calculateBlackScholes({
        spot: context.spot,
        strike,
        days,
        volatility: effectiveIv,
        rate: Number(settings.rate),
        dividend: effectiveDividend,
      });
      const fairValue = context.optionType === "put" ? result.put : result.call;
      const difference = fairValue - marketPrice;
      let badge = priceCell.querySelector("[data-bsfv-overlay]");
      if (!badge) {
        badge = document.createElement("span");
        badge.setAttribute("data-bsfv-overlay", "true");
        badge.setAttribute("aria-label", "Black-Scholes fair value");
        priceCell.setAttribute("data-bsfv-cell", "true");
        priceCell.appendChild(badge);
      }
      const nextText = `FV ${formatMoney(fairValue)}`;
      if (badge.textContent !== nextText) badge.textContent = nextText;
      const comparison = difference >= 0 ? `+${formatMoney(difference)}` : `-${formatMoney(Math.abs(difference))}`;
      badge.dataset.signal = Math.abs(difference) < 0.005 ? "flat" : difference > 0 ? "above" : "below";
      badge.title = `${formatMoney(fairValue)} model value; ${comparison} versus Robinhood ${context.priceHeading.toLowerCase()} ${formatMoney(marketPrice)}. IV ${effectiveIv.toFixed(2)}%.`;
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 80);
  }

  function start() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (saved) => {
      settings = { ...DEFAULT_SETTINGS, ...saved };
      ensurePanel();
      syncPanel();
      render();
      observer = new MutationObserver((mutations) => {
        const pageChanged = mutations.some((mutation) => {
          const target = mutation.target.nodeType === Node.ELEMENT_NODE
            ? mutation.target
            : mutation.target.parentElement;

          return target && !target.closest("#bsfv-panel, [data-bsfv-overlay]");
        });

        if (pageChanged) scheduleRender();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      window.addEventListener("popstate", scheduleRender);
      setInterval(scheduleRender, 1000);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
      syncPanel();
      scheduleRender();
    });
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "bsfv-refresh") scheduleRender();
    });
  }

  start();
})();
