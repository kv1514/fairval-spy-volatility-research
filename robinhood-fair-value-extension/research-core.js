(function initializeFairValResearch(root) {
  "use strict";

  const SUPPORTED_HORIZONS = Object.freeze([1, 2, 3, 5, 10]);
  const SURFACE_METHODS = Object.freeze([
    "additive_iv",
    "multiplicative_iv",
    "variance_shift",
    "total_variance_shift",
  ]);

  const finite = (value) => Number.isFinite(Number(value));
  const clamp01 = (value) => Math.min(Math.max(Number(value) || 0, 0), 1);

  function newYorkClock(now = Date.now()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      date: `${values.year}-${values.month}-${values.day}`,
      weekday: values.weekday,
      minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
      second: Number(values.second),
    };
  }

  function marketSessionState(now = Date.now()) {
    const clock = newYorkClock(now);
    const businessDay = !["Sat", "Sun"].includes(clock.weekday);
    let state = "closed";
    if (businessDay && clock.minuteOfDay >= 4 * 60 && clock.minuteOfDay < 9 * 60 + 30) state = "pre_market";
    else if (businessDay && clock.minuteOfDay >= 9 * 60 + 30 && clock.minuteOfDay < 16 * 60) state = "regular";
    else if (businessDay && clock.minuteOfDay >= 16 * 60 && clock.minuteOfDay < 20 * 60) state = "after_hours";
    return {
      state,
      date: clock.date,
      minuteOfDay: clock.minuteOfDay,
      businessDay,
      marketCalendarStatus: "weekday_only",
      warning: "Official holiday and early-close calendar is unavailable in the page runtime.",
    };
  }

  function tradingDaysToExpiration(expiration, now = Date.now(), holidays = []) {
    const clock = newYorkClock(now);
    const start = new Date(`${clock.date}T00:00:00Z`);
    const end = new Date(`${String(expiration)}T00:00:00Z`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      return { tradingDays: null, method: "unavailable", warning: "Expiration could not be parsed." };
    }
    if (end <= start) {
      return {
        tradingDays: 0,
        method: "weekday_count",
        warning: "0DTE requires an intraday model; the bundled forecast is daily close-to-close.",
        calendarStatus: holidays.length ? "supplied_holidays" : "weekday_only",
      };
    }
    const holidaySet = new Set((holidays || []).map(String));
    let count = 0;
    for (let cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const day = cursor.getUTCDay();
      const date = cursor.toISOString().slice(0, 10);
      if (day !== 0 && day !== 6 && !holidaySet.has(date)) count += 1;
    }
    return {
      tradingDays: count,
      method: "weekday_count",
      warning: holidays.length ? null : "Holiday and early-close adjustments are unavailable; weekday count used.",
      calendarStatus: holidays.length ? "supplied_holidays" : "weekday_only",
    };
  }

  function businessDaysSince(asOfDate, now = Date.now(), holidays = []) {
    const start = new Date(`${String(asOfDate)}T00:00:00Z`);
    const clock = newYorkClock(now);
    const end = new Date(`${clock.date}T00:00:00Z`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return Number.POSITIVE_INFINITY;
    if (end <= start) return 0;
    const holidaySet = new Set((holidays || []).map(String));
    let count = 0;
    for (let cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const day = cursor.getUTCDay();
      const date = cursor.toISOString().slice(0, 10);
      if (day !== 0 && day !== 6 && !holidaySet.has(date)) count += 1;
    }
    return count;
  }

  function interpolateForecastRecords(records, requestedHorizon) {
    const target = Number(requestedHorizon);
    const usable = (records || [])
      .filter((record) => finite(record?.horizon) && finite(record?.forecast_vol) && Number(record.forecast_vol) > 0)
      .sort((left, right) => Number(left.horizon) - Number(right.horizon));
    if (!usable.length || !finite(target)) return null;
    const unique = [];
    for (const record of usable) {
      const horizon = Number(record.horizon);
      const previous = unique.at(-1);
      if (previous && Number(previous.horizon) === horizon) {
        if (String(record.as_of_date || "") > String(previous.as_of_date || "")) unique[unique.length - 1] = record;
      } else unique.push(record);
    }
    const make = (record, method, warning = null) => ({
      forecastVol: Number(record.forecast_vol),
      horizon: Number(record.horizon),
      forecastHorizonUsed: String(record.horizon),
      forecastHorizonMethod: method,
      interpolationWeight: 0,
      lowerHorizon: Number(record.horizon),
      upperHorizon: Number(record.horizon),
      recordsUsed: [record],
      warning,
      rankingEligible: method !== "unavailable",
    });
    if (target <= 0) {
      return {
        ...make(unique[0], "unavailable", "0DTE disabled for high-confidence ranking: no intraday volatility model is bundled."),
        forecastHorizonUsed: "daily 1D diagnostic only",
        rankingEligible: false,
      };
    }
    const exact = unique.find((record) => Number(record.horizon) === target);
    if (exact) {
      const shortDated = target <= 1;
      return {
        ...make(exact, "exact", shortDated ? "Daily close-to-close forecast used for a short-dated contract; intraday and event risk are unmodeled." : null),
        rankingEligible: !shortDated,
      };
    }
    const lower = [...unique].reverse().find((record) => Number(record.horizon) < target);
    const upper = unique.find((record) => Number(record.horizon) > target);
    if (lower && upper) {
      const lowH = Number(lower.horizon);
      const highH = Number(upper.horizon);
      const weight = (target - lowH) / (highH - lowH);
      const lowVariance = (Number(lower.forecast_vol) / 100) ** 2;
      const highVariance = (Number(upper.forecast_vol) / 100) ** 2;
      const variance = (1 - weight) * lowVariance + weight * highVariance;
      return {
        forecastVol: Math.sqrt(Math.max(variance, 0)) * 100,
        horizon: target,
        forecastHorizonUsed: `${lowH}-${highH}D`,
        forecastHorizonMethod: "interpolated",
        interpolationWeight: weight,
        lowerHorizon: lowH,
        upperHorizon: highH,
        recordsUsed: [lower, upper],
        warning: null,
        rankingEligible: true,
      };
    }
    const nearest = lower || upper;
    return {
      ...make(nearest, "extrapolated", `No bracketing forecast horizons; ${Number(nearest.horizon)}D forecast used for ${target} trading days.`),
      forecastHorizonUsed: `${Number(nearest.horizon)}D for ${target}D`,
      rankingEligible: false,
    };
  }

  function shiftStrikeVolatility({
    marketStrikeVol,
    marketAtmVol,
    forecastAtmVol,
    timeYears = 1,
    method = "total_variance_shift",
    minimumVol = 0.01,
    maximumVol = 500,
    warningLow = 5,
    warningHigh = 200,
  }) {
    const strike = Number(marketStrikeVol);
    const marketAtm = Number(marketAtmVol);
    const forecastAtm = Number(forecastAtmVol);
    const years = Math.max(Number(timeYears) || 0, 1e-12);
    if (![strike, marketAtm, forecastAtm].every(Number.isFinite) || strike <= 0 || marketAtm <= 0 || forecastAtm <= 0) {
      return { volatility: null, status: "invalid_inputs", method, warning: "Surface shift requires positive strike, market ATM, and forecast ATM volatility." };
    }
    const selected = SURFACE_METHODS.includes(method) ? method : "total_variance_shift";
    let raw;
    if (selected === "additive_iv") raw = strike + forecastAtm - marketAtm;
    else if (selected === "multiplicative_iv") raw = strike * forecastAtm / marketAtm;
    else if (selected === "variance_shift") {
      raw = Math.sqrt(Math.max(strike ** 2 + forecastAtm ** 2 - marketAtm ** 2, 0));
    } else {
      const strikeTotalVariance = (strike / 100) ** 2 * years;
      const marketAtmTotalVariance = (marketAtm / 100) ** 2 * years;
      const forecastAtmTotalVariance = (forecastAtm / 100) ** 2 * years;
      raw = Math.sqrt(Math.max((strikeTotalVariance + forecastAtmTotalVariance - marketAtmTotalVariance) / years, 0)) * 100;
    }
    const volatility = Math.min(Math.max(raw, Number(minimumVol)), Number(maximumVol));
    const warnings = [];
    if (!Number.isFinite(raw) || raw <= 0) warnings.push("Surface transform produced nonpositive variance and was floored.");
    if (raw !== volatility) warnings.push(`Surface transform was clamped to ${volatility.toFixed(2)}%.`);
    if (volatility < Number(warningLow)) warnings.push("Forecast strike volatility is unusually low.");
    if (volatility > Number(warningHigh)) warnings.push("Forecast strike volatility is unusually high.");
    return {
      volatility,
      rawVolatility: raw,
      method: selected,
      status: warnings.length ? "warning" : "pass",
      warning: warnings.join(" ") || null,
      marketStrikeVol: strike,
      marketAtmVol: marketAtm,
      forecastAtmVol: forecastAtm,
    };
  }

  function assessDataQuality({
    exactQuote = null,
    displayedPrice = null,
    now = Date.now(),
    session = marketSessionState(now),
    underlyingBasis = "live underlying",
    underlyingCapturedAt = null,
    scanState = null,
    parseWarnings = [],
    maxQuoteAgeMs = 120_000,
    minimumVolume = 10,
    minimumOpenInterest = 100,
  } = {}) {
    const warnings = [];
    const exact = Boolean(exactQuote);
    const bid = Number(exactQuote?.bid);
    const ask = Number(exactQuote?.ask);
    const mark = Number(exactQuote?.mark);
    const capturedAt = Number(exactQuote?.capturedAt);
    const quoteAgeMs = finite(capturedAt) ? Math.max(Number(now) - capturedAt, 0) : Number.POSITIVE_INFINITY;
    const validBidAsk = exact && [bid, ask, mark].every(Number.isFinite) && bid > 0 && ask > bid && mark > 0;
    const captureFresh = exact && quoteAgeMs <= Number(maxQuoteAgeMs);
    const volumePresent = exactQuote?.volume != null && finite(exactQuote.volume);
    const openInterestPresent = exactQuote?.openInterest != null && finite(exactQuote.openInterest);
    const liquidityAvailable = volumePresent || openInterestPresent;
    const liquid = (volumePresent && Number(exactQuote.volume) >= Number(minimumVolume)) ||
      (openInterestPresent && Number(exactQuote.openInterest) >= Number(minimumOpenInterest));
    const mixedSession = session?.state !== "regular" || String(underlyingBasis).includes("regular-session close");
    const partialScan = ["running", "partial", "aborted"].includes(String(scanState?.status || ""));
    const parseWarning = Array.isArray(parseWarnings) && parseWarnings.length > 0;
    const underlyingTimestampKnown = underlyingCapturedAt != null && finite(underlyingCapturedAt);
    const underlyingAgeMs = underlyingTimestampKnown
      ? Math.max(Number(now) - Number(underlyingCapturedAt), 0)
      : Number.POSITIVE_INFINITY;
    const underlyingFresh = underlyingTimestampKnown && underlyingAgeMs <= Number(maxQuoteAgeMs);

    if (!exact) warnings.push("Exact Robinhood Mark/IV has not been captured; displayed-price IV is estimated.");
    if (exact && !validBidAsk) warnings.push("Bid/ask/mark is missing, locked, crossed, or invalid.");
    if (exact && !captureFresh) warnings.push("Captured option quote is stale.");
    if (exact && !exactQuote?.sourceTimestamp) warnings.push("Robinhood exchange quote timestamp is unavailable; freshness is based on DOM capture time.");
    if (!underlyingTimestampKnown) warnings.push("Underlying source timestamp is unavailable.");
    else if (!underlyingFresh) warnings.push("Underlying quote timestamp is stale.");
    if (mixedSession) warnings.push("Option and underlying may belong to different market sessions; ranking is disabled.");
    if (partialScan) warnings.push("Visible-chain exact quote scan is incomplete.");
    if (!liquidityAvailable) warnings.push("Volume and open interest are missing.");
    else if (!liquid) warnings.push("Volume/open interest does not meet the research liquidity gate.");
    if (parseWarning) warnings.push(...parseWarnings.map(String));
    if (!finite(displayedPrice) || Number(displayedPrice) < 0) warnings.push("Displayed Robinhood option price could not be validated.");
    if (exact && finite(displayedPrice) && Math.abs(Number(displayedPrice) - mark) > Math.max(0.05, Math.abs(ask - bid) + 0.01)) {
      warnings.push("Displayed Robinhood price differs materially from exact Mark.");
    }

    let state = "fresh_exact";
    if (exact && !validBidAsk) state = "invalid_bid_ask";
    else if (exact && !captureFresh) state = "stale_option_quote";
    else if (underlyingTimestampKnown && !underlyingFresh) state = "stale_underlying_quote";
    else if (mixedSession) state = "mixed_session_warning";
    else if (partialScan) state = "partial_scan";
    else if (!liquidityAvailable || !liquid) state = "missing_liquidity";
    else if (!exact) state = "fresh_estimated_iv";
    else if (parseWarning) state = "dom_parse_warning";

    let score = 0;
    score += exact ? 0.22 : 0.07;
    score += validBidAsk ? 0.18 : 0;
    score += captureFresh ? 0.12 : 0;
    score += session?.state === "regular" ? 0.14 : 0;
    score += underlyingFresh ? 0.10 : (underlyingTimestampKnown ? 0.02 : 0.04);
    score += liquidityAvailable ? (liquid ? 0.12 : 0.04) : 0;
    score += partialScan ? 0 : 0.07;
    score += parseWarning ? 0 : 0.05;
    const rankingEligible = exact && validBidAsk && captureFresh && session?.state === "regular" &&
      !mixedSession && !partialScan && !parseWarning && liquidityAvailable && liquid &&
      (!underlyingTimestampKnown || underlyingFresh);
    return {
      state,
      score: clamp01(score),
      warning: warnings.join(" ") || null,
      warnings,
      rankingEligible,
      exact,
      validBidAsk,
      quoteAgeMs,
      quoteFreshnessBasis: exactQuote?.sourceTimestamp ? "source_timestamp" : "dom_capture_time",
      sourceTimestampAvailable: Boolean(exactQuote?.sourceTimestamp),
      underlyingTimestampAvailable: underlyingTimestampKnown,
      underlyingAgeMs,
      underlyingFresh,
      liquidityAvailable,
      liquid,
      sessionState: session?.state || "unknown",
      scanStatus: scanState?.status || "unknown",
    };
  }

  function executableEdges({ modelValue, midpoint, bid, ask, estimatedFees = 0.02, tickSize = 0.01 }) {
    const value = Number(modelValue);
    const mid = Number(midpoint);
    const bidValue = Number(bid);
    const askValue = Number(ask);
    if (![value, mid, bidValue, askValue].every(Number.isFinite) || askValue <= bidValue || bidValue <= 0 || mid <= 0) {
      return { valid: false, warning: "Executable edges require a valid unlocked bid/ask." };
    }
    const spread = askValue - bidValue;
    const longExecutableEdge = value - askValue;
    const shortExecutableEdge = bidValue - value;
    const minimumEdge = Math.max(Number(tickSize), Number(estimatedFees), 0.5 * spread, 0.01 * Math.max(mid, 0));
    return {
      valid: true,
      midpointEdge: value - mid,
      longExecutableEdge,
      shortExecutableEdge,
      spread,
      spreadPct: mid > 0 ? spread / mid * 100 : Number.POSITIVE_INFINITY,
      minimumEdge,
      longThresholdPassed: longExecutableEdge >= minimumEdge,
      shortThresholdPassed: shortExecutableEdge >= minimumEdge,
      longEdgeToSpreadRatio: longExecutableEdge / Math.max(spread, Number(tickSize)),
      shortEdgeToSpreadRatio: shortExecutableEdge / Math.max(spread, Number(tickSize)),
    };
  }

  function classifyResearchSignal({
    forecastVol,
    marketIv,
    edges,
    dataQuality,
    modelWarning = null,
    surfaceStatus = "pass",
    minimumVolEdge = 0.25,
  }) {
    if (!dataQuality?.rankingEligible) return { classification: "data_warning", clean: false, reason: dataQuality?.warning || "Data quality gate failed." };
    if (!edges?.valid) return { classification: "liquidity_warning", clean: false, reason: edges?.warning || "Executable quote unavailable." };
    if (modelWarning) return { classification: "model_warning", clean: false, reason: String(modelWarning) };
    if (surfaceStatus !== "pass") return { classification: "surface_warning", clean: false, reason: "Surface transformation did not pass sanity diagnostics." };
    const volEdge = Number(forecastVol) - Number(marketIv);
    const longVol = volEdge >= Number(minimumVolEdge);
    const shortVol = volEdge <= -Number(minimumVolEdge);
    if (longVol && edges.longThresholdPassed) return { classification: "long_vol_candidate", clean: true, reason: "Forecast volatility and ask-based scenario edge agree." };
    if (shortVol && edges.shortThresholdPassed) return { classification: "short_vol_candidate", clean: true, reason: "Forecast volatility and bid-based scenario edge agree." };
    if ((longVol && edges.shortThresholdPassed) || (shortVol && edges.longThresholdPassed)) {
      return { classification: "mixed_signal", clean: false, reason: "Volatility and executable-price directions disagree." };
    }
    return { classification: "no_signal", clean: false, reason: "Edge does not clear volatility and executable-cost thresholds." };
  }

  function modelConfidence(components = {}) {
    const weights = {
      dataQuality: 0.28,
      forecastFreshness: 0.10,
      horizonMatch: 0.10,
      forecastValidation: 0.12,
      surfaceQuality: 0.10,
      historicalContext: 0.08,
      pricingStability: 0.10,
      rateQuality: 0.04,
      dividendQuality: 0.04,
      eventCoverage: 0.04,
    };
    const breakdown = {};
    let score = 0;
    for (const [name, weight] of Object.entries(weights)) {
      const value = clamp01(components[name] ?? 0);
      breakdown[name] = { value, weight, contribution: value * weight };
      score += value * weight;
    }
    return { score: clamp01(score), breakdown, calibrated: false, warning: "Confidence components are heuristic until validated on sufficient walk-forward executable outcomes." };
  }

  root.FairValResearch = {
    SUPPORTED_HORIZONS,
    SURFACE_METHODS,
    newYorkClock,
    marketSessionState,
    tradingDaysToExpiration,
    businessDaysSince,
    interpolateForecastRecords,
    shiftStrikeVolatility,
    assessDataQuality,
    executableEdges,
    classifyResearchSignal,
    modelConfidence,
  };
})(globalThis);
