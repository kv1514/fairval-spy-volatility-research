(function fairValueExtension() {
  "use strict";

  const DIVIDEND_DEFAULTS = { SPY: 1.11, SPX: 1.12, QQQ: 0.44 };
  const FALLBACK_TREASURY_CURVE = {
    date: "2026-08-04",
    points: [
      { days: 30, rate: 3.78 },
      { days: 45, rate: 3.8 },
      { days: 60, rate: 3.85 },
      { days: 91, rate: 3.89 },
      { days: 122, rate: 3.91 },
      { days: 182, rate: 4.0 },
      { days: 365, rate: 4.04 },
      { days: 730, rate: 4.2 },
    ],
  };
  const DEFAULT_SETTINGS = {
    enabled: true,
    ivSource: "surface",
    volatility: 20,
    ivShift: 0,
    autoRate: true,
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

  function optionPrice(input) {
    const result = calculateBlackScholes(input);
    return String(input.optionType).toLowerCase() === "put" ? result.put : result.call;
  }

  function impliedVolatility(input) {
    const target = Number(input.marketPrice);
    if (!Number.isFinite(target) || target <= 0) return null;

    const lowVolPrice = optionPrice({ ...input, volatility: 0.01 });
    const highVolPrice = optionPrice({ ...input, volatility: 500 });
    if (target < lowVolPrice - 0.015 || target > highVolPrice + 0.015) return null;

    let low = 0.01;
    let high = 500;
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const midpoint = (low + high) / 2;
      const price = optionPrice({ ...input, volatility: midpoint });
      if (price > target) high = midpoint;
      else low = midpoint;
    }
    const result = (low + high) / 2;
    return Number.isFinite(result) ? result : null;
  }

  function interpolateTreasuryRate(points, days) {
    const curve = (points || [])
      .filter((point) => Number.isFinite(point.days) && Number.isFinite(point.rate))
      .sort((a, b) => a.days - b.days);
    if (!curve.length) return null;
    const maturity = Math.max(Number(days) || 0, 0);
    if (maturity <= curve[0].days) return curve[0].rate;
    if (maturity >= curve[curve.length - 1].days) return curve[curve.length - 1].rate;

    const count = curve.length;
    const x = curve.map((point) => point.days);
    const a = curve.map((point) => point.rate);
    const h = Array(count - 1);
    const alpha = Array(count).fill(0);
    for (let index = 0; index < count - 1; index += 1) h[index] = x[index + 1] - x[index];
    for (let index = 1; index < count - 1; index += 1) {
      alpha[index] = (3 / h[index]) * (a[index + 1] - a[index]) -
        (3 / h[index - 1]) * (a[index] - a[index - 1]);
    }

    const l = Array(count).fill(1);
    const mu = Array(count).fill(0);
    const z = Array(count).fill(0);
    const c = Array(count).fill(0);
    const b = Array(count - 1).fill(0);
    const d = Array(count - 1).fill(0);
    for (let index = 1; index < count - 1; index += 1) {
      l[index] = 2 * (x[index + 1] - x[index - 1]) - h[index - 1] * mu[index - 1];
      mu[index] = h[index] / l[index];
      z[index] = (alpha[index] - h[index - 1] * z[index - 1]) / l[index];
    }
    for (let index = count - 2; index >= 0; index -= 1) {
      c[index] = z[index] - mu[index] * c[index + 1];
      b[index] = (a[index + 1] - a[index]) / h[index] -
        (h[index] * (c[index + 1] + 2 * c[index])) / 3;
      d[index] = (c[index + 1] - c[index]) / (3 * h[index]);
    }

    const interval = x.findIndex((value, index) => index < count - 1 && maturity <= x[index + 1]);
    const offset = maturity - x[interval];
    return a[interval] + b[interval] * offset + c[interval] * offset ** 2 + d[interval] * offset ** 3;
  }

  function parseTreasuryXml(xml) {
    const tags = [
      ["BC_1MONTH", 30],
      ["BC_1_5MONTH", 45],
      ["BC_2MONTH", 60],
      ["BC_3MONTH", 91],
      ["BC_4MONTH", 122],
      ["BC_6MONTH", 182],
      ["BC_1YEAR", 365],
      ["BC_2YEAR", 730],
    ];
    const entries = [...String(xml || "").matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
      .map((match) => {
        const body = match[1];
        const date = body.match(/<d:NEW_DATE[^>]*>(\d{4}-\d{2}-\d{2})T/i)?.[1];
        if (!date) return null;
        const points = tags
          .map(([tag, days]) => {
            const value = body.match(new RegExp(`<d:${tag}[^>]*>([^<]+)<\\/d:${tag}>`, "i"))?.[1];
            const rate = Number(value);
            return Number.isFinite(rate) ? { days, rate } : null;
          })
          .filter(Boolean);
        return points.length ? { date, points } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));
    return entries.at(-1) || null;
  }

  function smoothedVolatility(strike, observations, spot) {
    const valid = (observations || []).filter(
      (point) => Number.isFinite(point.strike) && Number.isFinite(point.iv) && point.iv >= 1 && point.iv <= 300,
    );
    if (!valid.length) return null;
    const sortedStrikes = [...new Set(valid.map((point) => point.strike))].sort((a, b) => a - b);
    const spacings = sortedStrikes.slice(1).map((value, index) => value - sortedStrikes[index]);
    const typicalSpacing = spacings.length
      ? spacings.sort((a, b) => a - b)[Math.floor(spacings.length / 2)]
      : Math.max(Number(spot) * 0.005, 1);
    const bandwidth = Math.max(typicalSpacing * 3, Number(spot) * 0.008, 1);
    let weightedVolatility = 0;
    let totalWeight = 0;
    for (const point of valid) {
      const scaledDistance = Math.abs(point.strike - strike) / bandwidth;
      const weight = 1 / (1 + scaledDistance ** 4);
      weightedVolatility += point.iv * weight;
      totalWeight += weight;
    }
    return totalWeight ? weightedVolatility / totalWeight : null;
  }

  function parseMoney(value) {
    if (typeof value !== "string" || value.includes("—")) return null;
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseHeading(value) {
    const match = String(value || "").match(/^([A-Z.^-]+)\s+(buy|sell)\s+(Call|Put)$/i);
    if (!match) return null;
    const seriesTicker = match[1].replace(/^\^/, "").toUpperCase();
    return {
      ticker: seriesTicker === "SPXW" ? "SPX" : seriesTicker,
      seriesTicker,
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

  function thirdFriday(year, month) {
    const first = new Date(Date.UTC(year, month, 1));
    const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
    return new Date(Date.UTC(year, month, firstFriday + 14));
  }

  function quarterlyDividendDates(ticker, fromTimestamp, throughTimestamp) {
    if (!['SPY', 'QQQ'].includes(ticker)) return [];
    const startYear = new Date(fromTimestamp).getUTCFullYear();
    const endYear = new Date(throughTimestamp).getUTCFullYear();
    const dates = [];
    for (let year = startYear; year <= endYear; year += 1) {
      for (const month of [2, 5, 8, 11]) {
        const friday = thirdFriday(year, month);
        const exDate = ticker === 'QQQ'
          ? new Date(Date.UTC(year, month, friday.getUTCDate() + 3))
          : friday;
        const timestamp = exDate.getTime();
        if (timestamp > fromTimestamp && timestamp <= throughTimestamp) dates.push(timestamp);
      }
    }
    return dates;
  }

  function dividendAssumption({ ticker, spot, expiration, days, rate, now = Date.now() }) {
    const annualYield = DIVIDEND_DEFAULTS[ticker] ?? 0;
    if (ticker === 'SPX' || !['SPY', 'QQQ'].includes(ticker)) {
      return { yield: annualYield, count: null, model: 'continuous index yield' };
    }
    const settlement = newYorkSettlement(expiration, 16 * 60 + 15);
    const dividendDates = quarterlyDividendDates(ticker, now, settlement);
    if (!dividendDates.length || !Number.isFinite(days) || days <= 0) {
      return { yield: 0, count: 0, model: 'no forecast dividend before expiry' };
    }
    const annualCashDividend = Number(spot) * (annualYield / 100);
    const expectedQuarterlyDividend = annualCashDividend / 4;
    const continuouslyCompoundedRate = Number(rate) / 100;
    const presentValue = dividendDates.reduce((total, timestamp) => {
      const years = Math.max((timestamp - now) / 31_536_000_000, 0);
      return total + expectedQuarterlyDividend * Math.exp(-continuouslyCompoundedRate * years);
    }, 0);
    const prepaidForwardSpot = Math.max(Number(spot) - presentValue, Number(spot) * 0.01);
    const effectiveYield = -Math.log(prepaidForwardSpot / Number(spot)) / (days / 365) * 100;
    return {
      yield: Number.isFinite(effectiveYield) ? effectiveYield : annualYield,
      count: dividendDates.length,
      model: `${dividendDates.length} estimated quarterly dividend${dividendDates.length === 1 ? '' : 's'}`,
    };
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
    dividendAssumption,
    extractSelectedIv,
    formatMoney,
    impliedVolatility,
    interpolateTreasuryRate,
    newYorkSettlement,
    parseExpirationLabel,
    parseHeading,
    parseMoney,
    parseTreasuryXml,
    smoothedVolatility,
  };

  globalThis.__BSFV_CORE__ = Core;

  if (typeof document === "undefined" || typeof chrome === "undefined" || !chrome.storage) return;

  let settings = { ...DEFAULT_SETTINGS };
  let observer;
  let renderQueued = false;
  let renderTimer;
  let treasuryCurve = FALLBACK_TREASURY_CURVE;

  async function refreshTreasuryCurve() {
    const year = new Date().getUTCFullYear();
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Treasury returned ${response.status}`);
      const parsed = parseTreasuryXml(await response.text());
      if (!parsed) throw new Error("Treasury curve was empty");
      treasuryCurve = parsed;
      chrome.storage.local.set({ treasuryCurve: parsed });
      scheduleRender();
    } catch {
      // Keep the most recent cached or embedded official curve.
    }
  }

  function pageContext() {
    const heading = [...document.querySelectorAll("h1")]
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .map(parseHeading)
      .find(Boolean);
    if (!heading) return null;

    const shareButton = [...document.querySelectorAll("button")].find((button) =>
      /^(Share|Index) price:/i.test((button.textContent || "").replace(/\s+/g, " ").trim()),
    );
    const indexPrice = document.querySelector('[data-testid="IndexDetailPage-PriceSection"] [aria-label]');
    const spot = parseMoney(shareButton?.textContent || indexPrice?.getAttribute("aria-label") || "");
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
          <label class="bsfv-wide">Fair-IV model
            <select id="bsfv-iv-source">
              <option value="surface">Smoothed market smile</option>
              <option value="individual">Individual market IV</option>
              <option value="manual">Manual IV</option>
            </select>
          </label>
          <label>Manual IV
            <span><input id="bsfv-volatility" type="number" min="0.01" max="500" step="0.1"><small>%</small></span>
          </label>
          <label>IV shift
            <span><input id="bsfv-iv-shift" type="number" min="-100" max="100" step="0.1"><small>pt</small></span>
          </label>
          <label>Manual rate
            <span><input id="bsfv-rate" type="number" min="-20" max="100" step="0.05"><small>%</small></span>
          </label>
          <label>Manual dividend
            <span><input id="bsfv-dividend" type="number" min="0" max="100" step="0.05"><small>%</small></span>
          </label>
        </div>
        <label class="bsfv-check"><input id="bsfv-auto-rate" type="checkbox"> Auto Treasury curve by expiration</label>
        <label class="bsfv-check"><input id="bsfv-auto-dividend" type="checkbox"> Auto ticker dividends by expiration</label>
        <p id="bsfv-status">Waiting for Robinhood’s visible chain…</p>
        <p class="bsfv-disclaimer">Relative-value screen only · no orders · Treasury rate fetch only</p>
      </div>`;
    document.documentElement.appendChild(panel);

    panel.querySelector("#bsfv-collapse").addEventListener("click", () => {
      settings.collapsed = !settings.collapsed;
      chrome.storage.sync.set({ collapsed: settings.collapsed });
      syncPanel();
    });
    panel.querySelector("#bsfv-iv-source").addEventListener("change", (event) => {
      settings.ivSource = ["surface", "individual", "manual"].includes(event.target.value)
        ? event.target.value
        : "surface";
      chrome.storage.sync.set({ ivSource: settings.ivSource });
      syncPanel();
      scheduleRender();
    });
    for (const [id, key] of [
      ["bsfv-volatility", "volatility"],
      ["bsfv-iv-shift", "ivShift"],
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
    panel.querySelector("#bsfv-auto-rate").addEventListener("change", (event) => {
      settings.autoRate = event.target.checked;
      chrome.storage.sync.set({ autoRate: settings.autoRate });
      scheduleRender();
    });
    panel.querySelector("#bsfv-auto-dividend").addEventListener("change", (event) => {
      settings.autoDividend = event.target.checked;
      chrome.storage.sync.set({ autoDividend: settings.autoDividend });
      scheduleRender();
    });
    return panel;
  }

  function syncPanel(context = pageContext(), details = {}) {
    const panel = ensurePanel();
    panel.classList.toggle("is-collapsed", settings.collapsed);
    panel.querySelector("#bsfv-panel-body").hidden = settings.collapsed;
    panel.querySelector("#bsfv-collapse").textContent = settings.collapsed ? "+" : "−";
    panel.querySelector("#bsfv-iv-source").value = settings.ivSource;
    panel.querySelector("#bsfv-volatility").value = String(settings.volatility);
    panel.querySelector("#bsfv-volatility").disabled = settings.ivSource !== "manual";
    panel.querySelector("#bsfv-iv-shift").value = String(settings.ivShift);
    panel.querySelector("#bsfv-rate").value = String(settings.rate);
    panel.querySelector("#bsfv-rate").disabled = settings.autoRate;
    panel.querySelector("#bsfv-dividend").value = String(settings.dividend);
    panel.querySelector("#bsfv-dividend").disabled = settings.autoDividend;
    panel.querySelector("#bsfv-auto-rate").checked = settings.autoRate;
    panel.querySelector("#bsfv-auto-dividend").checked = settings.autoDividend;

    const contextLine = panel.querySelector("#bsfv-context");
    const statusLine = panel.querySelector("#bsfv-status");
    if (!context) {
      contextLine.textContent = "Open a Robinhood option chain to begin.";
      statusLine.textContent = "No supported chain detected.";
      return;
    }
    contextLine.textContent = `${context.ticker} ${context.optionType.toUpperCase()} · ${context.expiration} · spot ${formatMoney(context.spot)}`;
    const ivCopy = settings.ivSource === "surface"
      ? `smoothed smile from ${details.validIvCount ?? 0}/${details.totalRows ?? 0} visible IVs`
      : settings.ivSource === "individual"
        ? "individual quote-implied IV (circular at 0 shift)"
        : `manual IV ${Number(settings.volatility).toFixed(2)}%`;
    const rateCopy = settings.autoRate
      ? `r ${Number(details.rate).toFixed(2)}% CMT (${treasuryCurve.date})`
      : `r ${Number(settings.rate).toFixed(2)}% manual`;
    const dividendCopy = settings.autoDividend
      ? `q ${Number(details.dividend).toFixed(2)}% · ${details.dividendModel || "ticker default"}`
      : `q ${Number(settings.dividend).toFixed(2)}% manual`;
    statusLine.textContent = `${ivCopy} · shift ${Number(settings.ivShift).toFixed(2)}pt · ${rateCopy} · ${dividendCopy}`;
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

    const settlementMinutes = context.ticker === "SPX" ? 16 * 60 : 16 * 60 + 15;
    const days = daysToExpiration(context.expiration, Date.now(), settlementMinutes);
    const interpolatedRate = settings.autoRate
      ? interpolateTreasuryRate(treasuryCurve.points, days)
      : Number(settings.rate);
    const effectiveRate = Number.isFinite(interpolatedRate) ? interpolatedRate : Number(settings.rate);
    const dividendDetails = settings.autoDividend
      ? dividendAssumption({
        ticker: context.ticker,
        spot: context.spot,
        expiration: context.expiration,
        days,
        rate: effectiveRate,
      })
      : { yield: Number(settings.dividend), count: null, model: "manual" };
    const effectiveDividend = dividendDetails.yield;
    const rows = [...context.grid.querySelectorAll('[data-testid^="ChainTableRow-"]')];
    const contracts = rows.map((row) => {
      const strikeCell = row.querySelector('[data-testid="OptionChainStrikePriceCell"]');
      const priceCell = row.querySelector('[data-testid="OptionChainValidPriceCell"]');
      const strike = parseMoney(strikeCell?.textContent || "");
      const marketPrice = parseMoney(textWithoutOverlay(priceCell));
      if (!priceCell || strike == null || marketPrice == null || days == null) {
        row.querySelector("[data-bsfv-overlay]")?.remove();
        priceCell?.removeAttribute("data-bsfv-cell");
        return null;
      }
      const marketIv = impliedVolatility({
        marketPrice,
        optionType: context.optionType,
        spot: context.spot,
        strike,
        days,
        rate: effectiveRate,
        dividend: effectiveDividend,
      });
      return { row, priceCell, strike, marketPrice, marketIv };
    }).filter(Boolean);
    const observations = contracts
      .filter((contract) => contract.marketIv != null)
      .map((contract) => ({ strike: contract.strike, iv: contract.marketIv }));
    syncPanel(context, {
      rate: effectiveRate,
      dividend: effectiveDividend,
      dividendModel: dividendDetails.model,
      validIvCount: observations.length,
      totalRows: contracts.length,
    });

    for (const contract of contracts) {
      const { row, priceCell, strike, marketPrice, marketIv } = contract;
      const baseIv = settings.ivSource === "manual"
        ? Number(settings.volatility)
        : settings.ivSource === "individual"
          ? marketIv
          : smoothedVolatility(strike, observations, context.spot);
      if (!Number.isFinite(baseIv)) {
        row.querySelector("[data-bsfv-overlay]")?.remove();
        priceCell.removeAttribute("data-bsfv-cell");
        continue;
      }
      const fairIv = Math.min(Math.max(baseIv + Number(settings.ivShift), 0.01), 500);
      const fairValue = optionPrice({
        optionType: context.optionType,
        spot: context.spot,
        strike,
        days,
        volatility: fairIv,
        rate: effectiveRate,
        dividend: effectiveDividend,
      });
      const difference = fairValue - marketPrice;
      let badge = priceCell.querySelector("[data-bsfv-overlay]");
      if (!badge) {
        badge = document.createElement("span");
        badge.setAttribute("data-bsfv-overlay", "true");
        badge.setAttribute("aria-label", "Black-Scholes fair value");
        priceCell.setAttribute("data-bsfv-cell", "true");
        priceCell.appendChild(badge);
      }
      const marketIvCopy = marketIv == null ? "IV n/a" : `IV ${marketIv.toFixed(1)}%`;
      const nextText = `FV ${formatMoney(fairValue)} · ${marketIvCopy}`;
      if (badge.textContent !== nextText) badge.textContent = nextText;
      const comparison = difference >= 0 ? `+${formatMoney(difference)}` : `-${formatMoney(Math.abs(difference))}`;
      badge.dataset.signal = Math.abs(difference) < 0.005 ? "flat" : difference > 0 ? "above" : "below";
      badge.title = `${formatMoney(fairValue)} relative model value; ${comparison} versus Robinhood ${context.priceHeading.toLowerCase()} ${formatMoney(marketPrice)}. Quote-implied IV ${marketIv == null ? "unavailable" : `${marketIv.toFixed(2)}%`}; fair IV ${fairIv.toFixed(2)}%; CMT rate ${effectiveRate.toFixed(2)}%; dividend input ${effectiveDividend.toFixed(2)}%.`;
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 80);
  }

  function start() {
    chrome.storage.local.get({ treasuryCurve: FALLBACK_TREASURY_CURVE }, (saved) => {
      if (saved.treasuryCurve?.points?.length) treasuryCurve = saved.treasuryCurve;
      scheduleRender();
    });
    chrome.storage.sync.get(DEFAULT_SETTINGS, (saved) => {
      settings = { ...DEFAULT_SETTINGS, ...saved };
      if (!["surface", "individual", "manual"].includes(settings.ivSource)) settings.ivSource = "surface";
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
      refreshTreasuryCurve();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.treasuryCurve?.newValue?.points?.length) {
        treasuryCurve = changes.treasuryCurve.newValue;
        scheduleRender();
        return;
      }
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
