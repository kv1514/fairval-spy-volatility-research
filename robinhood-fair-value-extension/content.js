(function fairValueExtension() {
  "use strict";

  const Pricing = globalThis.FairValPricing || null;

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
  const IV_SOURCES = ["walkforward", "surface", "forecast", "individual", "manual"];
  const DEFAULT_SETTINGS = {
    settingsVersion: 7,
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
    treeSteps: 75,
    collapsed: false,
  };
  const PAPER_STUDY_VERSION = 3;
  const PAPER_MIN_SPACING_MS = 15_000;

  const normalPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  // Hart's rational-Chebyshev cumulative normal (as popularized by Graeme West).
  // Accurate to roughly 1e-15, matching the Python engine's full-precision erf
  // and replacing the earlier Abramowitz-Stegun approximation whose ~1e-7 error
  // was the dominant source of price, greek, and implied-volatility inaccuracy.
  function normalCdf(x) {
    if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
    const absX = Math.abs(x);
    if (absX > 37) return x > 0 ? 1 : 0;
    const exponential = Math.exp((-absX * absX) / 2);
    let tail;
    if (absX < 7.07106781186547) {
      let numerator = 3.52624965998911e-2 * absX + 0.700383064443688;
      numerator = numerator * absX + 6.37396220353165;
      numerator = numerator * absX + 33.912866078383;
      numerator = numerator * absX + 112.079291497871;
      numerator = numerator * absX + 221.213596169931;
      numerator = numerator * absX + 220.206867912376;
      let denominator = 8.83883476483184e-2 * absX + 1.75566716318264;
      denominator = denominator * absX + 16.064177579207;
      denominator = denominator * absX + 86.7807322029461;
      denominator = denominator * absX + 296.564248779674;
      denominator = denominator * absX + 637.333633378831;
      denominator = denominator * absX + 793.826512519948;
      denominator = denominator * absX + 440.413735824752;
      tail = (exponential * numerator) / denominator;
    } else {
      let build = absX + 0.65;
      build = absX + 4 / build;
      build = absX + 3 / build;
      build = absX + 2 / build;
      build = absX + 1 / build;
      tail = exponential / build / 2.506628274631;
    }
    return x > 0 ? 1 - tail : tail;
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

    // Theta is per calendar day (÷365, matching calendar-time pricing); rho is
    // per one percentage-point move in the rate (÷100). Gamma and vega are the
    // same for a call and a put; delta/theta/rho are per option type.
    const thetaCommon = -(S * discountQ * pdfD1 * sigma) / (2 * sqrtT);
    const callTheta =
      (thetaCommon - r * K * discountR * nD2 + q * S * discountQ * nD1) / 365;
    const putTheta =
      (thetaCommon + r * K * discountR * normalCdf(-d2) - q * S * discountQ * normalCdf(-d1)) / 365;

    return {
      call: Math.max(S * discountQ * nD1 - K * discountR * nD2, 0),
      put: Math.max(K * discountR * normalCdf(-d2) - S * discountQ * normalCdf(-d1), 0),
      callDelta: discountQ * nD1,
      putDelta: -discountQ * normalCdf(-d1),
      gamma: (discountQ * pdfD1) / (S * sigma * sqrtT),
      vega: (S * discountQ * pdfD1 * sqrtT) / 100,
      callTheta,
      putTheta,
      callRho: (K * T * discountR * nD2) / 100,
      putRho: -(K * T * discountR * normalCdf(-d2)) / 100,
    };
  }

  function optionPrice(input) {
    const result = calculateBlackScholes(input);
    return String(input.optionType).toLowerCase() === "put" ? result.put : result.call;
  }

  // Safeguarded Newton inversion (vega-driven with a maintained bracket and a
  // bisection fallback), mirroring the Python engine. Newton gives quadratic
  // convergence for a far tighter implied volatility than the previous 80-step
  // bisection, while the bracket prevents the divergence risk of raw Newton.
  function impliedVolatility(input) {
    const target = Number(input.marketPrice);
    if (!Number.isFinite(target) || target <= 0) return null;
    const isPut = String(input.optionType).toLowerCase() === "put";
    const priceAt = (volatility) => {
      const greeks = calculateBlackScholes({ ...input, volatility });
      return { price: isPut ? greeks.put : greeks.call, vega: greeks.vega };
    };

    if (target < priceAt(0.01).price - 0.015 || target > priceAt(500).price + 0.015) return null;

    let low = 0.01;
    let high = 500;
    const T = Math.max(Number(input.days) / 365, 1 / (365 * 24 * 60));
    const spot = Math.max(Number(input.spot), 1e-9);
    // Brenner-Subrahmanyam near-ATM starting guess, clamped to the bracket.
    let guess = Math.min(Math.max((Math.sqrt((2 * Math.PI) / T) * target) / spot * 100, low), high);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const { price, vega } = priceAt(guess);
      // Price is monotone increasing in volatility, so keep the root bracketed.
      if (price < target) low = guess;
      else high = guess;
      if (high - low <= 1e-10) break; // volatility-space convergence, like bisection
      const difference = price - target;
      const newton = vega > 1e-12 ? guess - difference / vega : Infinity;
      // Accept a Newton step only inside the bracket; otherwise bisect. Where
      // vega is tiny this degrades gracefully to bisection, which still narrows
      // the bracket to machine precision like the previous solver.
      guess = newton > low && newton < high ? newton : (low + high) / 2;
    }
    const result = (low + high) / 2;
    const sensitivity = calculateBlackScholes({ ...input, volatility: result }).vega;
    const minimumIdentifiableVega = Math.max(Number(input.spot) * 1e-9, 1e-7);
    return Number.isFinite(result) && sensitivity >= minimumIdentifiableVega ? result : null;
  }

  function impliedDividendYield(input) {
    const target = Number(input.marketPrice);
    if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(Number(input.volatility))) return null;
    let low = -30;
    let high = 50;
    const lowPrice = optionPrice({ ...input, dividend: low });
    const highPrice = optionPrice({ ...input, dividend: high });
    const minimum = Math.min(lowPrice, highPrice);
    const maximum = Math.max(lowPrice, highPrice);
    if (target < minimum - 0.015 || target > maximum + 0.015 || Math.abs(highPrice - lowPrice) < 0.02) return null;
    const increasing = highPrice > lowPrice;
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const midpoint = (low + high) / 2;
      const price = optionPrice({ ...input, dividend: midpoint });
      if ((increasing && price < target) || (!increasing && price > target)) low = midpoint;
      else high = midpoint;
    }
    const result = (low + high) / 2;
    return Number.isFinite(result) ? result : null;
  }

  function median(values) {
    const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }

  function chainImpliedCarry({ quotes, optionType, spot, days, rate, now = Date.now() }) {
    if (!Number.isFinite(days) || days < 7 || !Number.isFinite(spot) || spot <= 0) return null;
    const candidates = (quotes || []).map((quote) => {
      const spread = Number(quote.ask) - Number(quote.bid);
      const spreadPercent = Number(quote.mark) > 0 ? (spread / Number(quote.mark)) * 100 : Number.POSITIVE_INFINITY;
      const fresh = !Number.isFinite(quote.capturedAt) || now - quote.capturedAt <= 120_000;
      if (
        !fresh || !Number.isFinite(quote.strike) || !Number.isFinite(quote.mark) || quote.mark < 0.1 ||
        !Number.isFinite(quote.iv) || Math.abs(Math.log(quote.strike / spot)) > 0.12 ||
        !Number.isFinite(spreadPercent) || spreadPercent > 25
      ) return null;
      const inferred = impliedDividendYield({
        marketPrice: quote.mark,
        optionType,
        spot,
        strike: quote.strike,
        days,
        volatility: quote.iv,
        rate,
      });
      return Number.isFinite(inferred) && inferred >= -15 && inferred <= 30 ? inferred : null;
    }).filter(Number.isFinite);
    if (candidates.length < 3) return null;
    const center = median(candidates);
    const deviations = candidates.map((value) => Math.abs(value - center));
    const mad = median(deviations) || 0.25;
    const robust = candidates.filter((value) => Math.abs(value - center) <= Math.max(3 * mad, 0.75));
    const inferredYield = median(robust.length >= 3 ? robust : candidates);
    if (!Number.isFinite(inferredYield)) return null;
    return {
      yield: inferredYield,
      count: robust.length >= 3 ? robust.length : candidates.length,
      model: `chain-implied carry from ${robust.length >= 3 ? robust.length : candidates.length} fresh Mark/IV pairs`,
    };
  }

  function assessDiscrepancy({
    fairValue,
    referencePrice,
    exactQuote,
    gapThreshold = 10,
    maxSpreadPercent = 20,
    now = Date.now(),
  }) {
    const neutral = { flagged: false };
    if (!exactQuote || !Number.isFinite(fairValue) || !Number.isFinite(referencePrice) || referencePrice < 0.1) return neutral;
    const bid = Number(exactQuote.bid);
    const ask = Number(exactQuote.ask);
    const mark = Number(exactQuote.mark);
    const ageMs = now - Number(exactQuote.capturedAt || 0);
    if (![bid, ask, mark].every(Number.isFinite) || ask < bid || ageMs > 120_000) return neutral;
    const spread = ask - bid;
    const spreadPercent = mark > 0 ? (spread / mark) * 100 : Number.POSITIVE_INFINITY;
    const liquid = Number(exactQuote.volume) >= 10 || Number(exactQuote.openInterest) >= 100;
    if (!liquid || spreadPercent > Number(maxSpreadPercent)) return neutral;

    const belowModel = fairValue > mark;
    const executionReference = belowModel ? ask : bid;
    if (executionReference <= 0) return neutral;
    const edge = belowModel ? fairValue - ask : bid - fairValue;
    const edgePercent = (edge / executionReference) * 100;
    if (edge < Math.max(0.05, spread * 0.5) || edgePercent < Number(gapThreshold)) return neutral;
    return {
      flagged: true,
      direction: belowModel ? "below-model" : "above-model",
      edge,
      edgePercent,
      executionReference,
      spread,
      spreadPercent,
      score: edge / Math.max(spread, 0.01),
    };
  }

  function computePaperOutcomes(records, horizonMinutes = 60) {
    const horizonMs = Math.max(Number(horizonMinutes), 1) * 60_000;
    const toleranceMs = Math.max(horizonMs * 0.5, 2 * 60_000);
    const grouped = new Map();
    for (const record of records || []) {
      if (!record?.contractKey || !Number.isFinite(Number(record.observedAt))) continue;
      const group = grouped.get(record.contractKey) || [];
      group.push(record);
      grouped.set(record.contractKey, group);
    }
    const outcomes = [];
    for (const group of grouped.values()) {
      group.sort((a, b) => Number(a.observedAt) - Number(b.observedAt));
      for (let index = 0; index < group.length; index += 1) {
        const signal = group[index];
        if (!signal.flagDirection) continue;
        const target = Number(signal.observedAt) + horizonMs;
        const outcome = group.slice(index + 1).find((candidate) => {
          const lag = Number(candidate.observedAt) - target;
          return lag >= 0 && lag <= toleranceMs;
        });
        if (!outcome) continue;
        const entry = signal.flagDirection === "below-model" ? Number(signal.ask) : Number(signal.bid);
        const exit = signal.flagDirection === "below-model" ? Number(outcome.bid) : Number(outcome.ask);
        if (![entry, exit].every(Number.isFinite) || entry <= 0 || exit < 0) continue;
        const pnl = signal.flagDirection === "below-model" ? exit - entry : entry - exit;
        outcomes.push({ pnl, direction: signal.flagDirection });
      }
    }
    const mean = outcomes.length
      ? outcomes.reduce((total, outcome) => total + outcome.pnl, 0) / outcomes.length
      : null;
    return {
      horizonMinutes: Number(horizonMinutes),
      count: outcomes.length,
      wins: outcomes.filter((outcome) => outcome.pnl > 0).length,
      winRate: outcomes.length ? outcomes.filter((outcome) => outcome.pnl > 0).length / outcomes.length : null,
      meanPnl: mean,
    };
  }

  function thinPaperRecords(records, minimumSpacingMs = PAPER_MIN_SPACING_MS) {
    const ordered = [...new Map((records || []).filter((record) => record?.id).map((record) => [record.id, record])).values()]
      .sort((a, b) => Number(a.observedAt) - Number(b.observedAt));
    const lastByContract = new Map();
    return ordered.filter((record) => {
      const observedAt = Number(record.observedAt);
      if (!record.contractKey || !Number.isFinite(observedAt)) return false;
      const previous = lastByContract.get(record.contractKey);
      if (Number.isFinite(previous) && observedAt - previous < Number(minimumSpacingMs)) return false;
      lastByContract.set(record.contractKey, observedAt);
      return true;
    });
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
    const neighbors = valid
      .filter((point) => point.strike !== strike)
      .sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike))
      .slice(0, 9);
    if (!neighbors.length) return valid[0].iv;
    if (neighbors.length === 1) return neighbors[0].iv;
    if (neighbors.length === 2) {
      const [first, second] = neighbors.sort((a, b) => a.strike - b.strike);
      const fraction = (strike - first.strike) / (second.strike - first.strike);
      return first.iv + fraction * (second.iv - first.iv);
    }

    const scale = Math.max(Number(spot), Number(strike), 1);
    const hasLower = neighbors.some((point) => point.strike < strike);
    const hasUpper = neighbors.some((point) => point.strike > strike);
    const degree = hasLower && hasUpper && neighbors.length >= 5 ? 2 : 1;
    const samples = neighbors.map((point) => ({
      x: (point.strike - strike) / scale,
      y: point.iv,
      distanceWeight: 1 / (1 + (Math.abs(point.strike - strike) / (scale * 0.06)) ** 2),
    }));

    const solve = (weights) => {
      const size = degree + 1;
      const matrix = Array.from({ length: size }, () => Array(size + 1).fill(0));
      for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
          matrix[row][column] = samples.reduce(
            (total, sample, index) => total + weights[index] * sample.x ** (row + column),
            0,
          );
        }
        matrix[row][size] = samples.reduce(
          (total, sample, index) => total + weights[index] * sample.y * sample.x ** row,
          0,
        );
      }
      for (let pivot = 0; pivot < size; pivot += 1) {
        let best = pivot;
        for (let row = pivot + 1; row < size; row += 1) {
          if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) best = row;
        }
        if (Math.abs(matrix[best][pivot]) < 1e-12) return null;
        [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]];
        const divisor = matrix[pivot][pivot];
        for (let column = pivot; column <= size; column += 1) matrix[pivot][column] /= divisor;
        for (let row = 0; row < size; row += 1) {
          if (row === pivot) continue;
          const factor = matrix[row][pivot];
          for (let column = pivot; column <= size; column += 1) {
            matrix[row][column] -= factor * matrix[pivot][column];
          }
        }
      }
      return matrix.map((row) => row[size]);
    };

    const pairwiseSlopes = [];
    for (let first = 0; first < samples.length; first += 1) {
      for (let second = first + 1; second < samples.length; second += 1) {
        const difference = samples[second].x - samples[first].x;
        if (Math.abs(difference) > 1e-12) {
          pairwiseSlopes.push((samples[second].y - samples[first].y) / difference);
        }
      }
    }
    const initialSlope = median(pairwiseSlopes) || 0;
    const initialIntercept = median(samples.map((sample) => sample.y - initialSlope * sample.x)) || 0;
    const initialResiduals = samples.map((sample) => sample.y - initialIntercept - initialSlope * sample.x);
    const initialCenter = median(initialResiduals) || 0;
    const initialMad = median(initialResiduals.map((residual) => Math.abs(residual - initialCenter))) || 0.05;
    const initialCutoff = Math.max(3 * 1.4826 * initialMad, 0.5);
    let robustWeights = samples.map((sample, index) => {
      const residual = Math.abs(initialResiduals[index] - initialCenter);
      return sample.distanceWeight * (residual <= initialCutoff ? 1 : initialCutoff / residual);
    });
    let coefficients = solve(robustWeights);
    if (!coefficients) return median(neighbors.map((point) => point.iv));
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const residuals = samples.map((sample) => {
        const fitted = coefficients.reduce((total, coefficient, power) => total + coefficient * sample.x ** power, 0);
        return sample.y - fitted;
      });
      const residualCenter = median(residuals) || 0;
      const mad = median(residuals.map((residual) => Math.abs(residual - residualCenter))) || 0.05;
      const cutoff = Math.max(1.5 * 1.4826 * mad, 0.15);
      robustWeights = samples.map((sample, index) => {
        const residual = Math.abs(residuals[index] - residualCenter);
        const huberWeight = residual <= cutoff ? 1 : cutoff / residual;
        return sample.distanceWeight * huberWeight;
      });
      coefficients = solve(robustWeights) || coefficients;
    }
    return Number.isFinite(coefficients[0]) ? Math.min(Math.max(coefficients[0], 1), 300) : null;
  }

  function parseMoney(value) {
    if (typeof value !== "string" || value.includes("—")) return null;
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseExtendedHoursChange(value) {
    const match = String(value || "").match(
      /([+-])\s*\$([0-9,]+(?:\.[0-9]+)?)\s*\([^)]*\)\s*(After Hours|Pre[- ]?Market)/i,
    );
    if (!match) return null;
    const amount = Number(match[2].replace(/,/g, ""));
    if (!Number.isFinite(amount)) return null;
    return (match[1] === "-" ? -1 : 1) * amount;
  }

  function sessionAlignedSpot(currentSpot, sessionChangeText) {
    const extendedHoursChange = parseExtendedHoursChange(sessionChangeText);
    if (!Number.isFinite(currentSpot) || extendedHoursChange == null) {
      return { spot: currentSpot, liveSpot: currentSpot, basis: "live underlying" };
    }
    return {
      spot: currentSpot - extendedHoursChange,
      liveSpot: currentSpot,
      basis: "regular-session close",
    };
  }

  function parseHeading(value) {
    const match = String(value || "").match(/^([A-Z0-9.^-]+)\s+(buy|sell)\s+(Call|Put)$/i);
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
    if (ticker === 'SPX') {
      return { yield: annualYield, count: null, model: 'continuous index yield' };
    }
    if (!['SPY', 'QQQ'].includes(ticker)) {
      return { yield: 0, count: null, model: '0% fallback until 3+ Mark/IV pairs are scanned' };
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

  function parseExpandedContract(value) {
    const text = String(value || "").replace(/\r/g, "");
    const heading = text.match(/^([A-Z0-9.^-]+)\s+\$([0-9,]+(?:\.[0-9]+)?)\s+(Call|Put)\s+(\d{1,2}\/\d{1,2})\s*$/im);
    if (!heading || heading.index == null) return null;
    const block = text.slice(heading.index, heading.index + 1800);
    const readMoney = (label) => {
      const match = block.match(new RegExp(`${label}\\s*\\$([0-9,]+(?:\\.[0-9]+)?)`, "i"));
      return match ? Number(match[1].replace(/,/g, "")) : null;
    };
    const readInteger = (label) => {
      const match = block.match(new RegExp(`${label}\\s*([0-9,]+)`, "i"));
      return match ? Number(match[1].replace(/,/g, "")) : null;
    };
    const iv = extractSelectedIv(block);
    const seriesTicker = heading[1].replace(/^\^/, "").toUpperCase();
    const strike = Number(heading[2].replace(/,/g, ""));
    const mark = readMoney("Mark");
    if (![strike, mark, iv].every(Number.isFinite)) return null;
    return {
      ticker: seriesTicker === "SPXW" ? "SPX" : seriesTicker,
      seriesTicker,
      strike,
      optionType: heading[3].toLowerCase(),
      expirationLabel: heading[4],
      bid: readMoney("Bid"),
      mark,
      ask: readMoney("Ask"),
      volume: readInteger("Volume"),
      openInterest: readInteger("Open interest"),
      iv,
    };
  }

  function formatMoney(value) {
    return `$${Number(value).toFixed(2)}`;
  }

  function forecastHorizonFromDte(days) {
    if (!Number.isFinite(Number(days))) return null;
    return Math.max(1, Math.round(Number(days)));
  }

  function selectVolatilityForecast(payload, ticker, requestedHorizon) {
    if (payload?.schema !== "volatility_forecast.v1" || !Array.isArray(payload.records)) return null;
    const normalizedTicker = String(ticker || "").toUpperCase() === "SPXW"
      ? "SPX"
      : String(ticker || "").toUpperCase();
    const target = Math.max(Number(requestedHorizon) || 1, 1);
    const eligible = payload.records
      .filter((record) => String(record?.ticker || "").toUpperCase() === normalizedTicker)
      .filter((record) => Number.isFinite(Number(record?.horizon)) && Number.isFinite(Number(record?.forecast_vol)))
      .sort((left, right) => {
        const horizonDifference = Math.abs(Number(left.horizon) - target) - Math.abs(Number(right.horizon) - target);
        if (horizonDifference) return horizonDifference;
        if (Number(left.horizon) !== Number(right.horizon)) return Number(right.horizon) - Number(left.horizon);
        return String(right.as_of_date || "").localeCompare(String(left.as_of_date || ""));
      });
    if (!eligible.length) return null;
    const selected = eligible[0];
    return {
      ticker: normalizedTicker,
      asOfDate: String(selected.as_of_date || ""),
      horizon: Number(selected.horizon),
      forecastVol: Number(selected.forecast_vol),
      modelUsed: String(selected.model_used || "unknown"),
      lambdaUsed: selected.lambda_used == null ? null : Number(selected.lambda_used),
      weightsUsed: selected.weights_used || null,
    };
  }

  function moneynessBucket(logMoneyness) {
    const value = Number(logMoneyness);
    if (!Number.isFinite(value)) return null;
    if (value <= -0.10) return "downside_deep";
    if (value <= -0.03) return "downside";
    if (value < 0.03) return "atm";
    if (value < 0.10) return "upside";
    return "upside_deep";
  }

  function nearestDteBucket(days) {
    const buckets = [1, 2, 3, 5, 10, 20, 30, 60, 90, 180, 365];
    const target = Math.max(Number(days) || 1, 1);
    return buckets.reduce((best, candidate) => {
      const candidateDistance = Math.abs(candidate - target);
      const bestDistance = Math.abs(best - target);
      return candidateDistance < bestDistance || (candidateDistance === bestDistance && candidate > best)
        ? candidate
        : best;
    }, buckets[0]);
  }

  function selectSurfaceBenchmark(payload, ticker, optionType, days, logMoneyness) {
    if (!Array.isArray(payload?.surface_benchmarks)) return null;
    const normalizedTicker = String(ticker || "").toUpperCase() === "SPXW"
      ? "SPX"
      : String(ticker || "").toUpperCase();
    const type = String(optionType || "").toLowerCase();
    const bucket = moneynessBucket(logMoneyness);
    const targetDte = nearestDteBucket(days);
    const eligible = payload.surface_benchmarks
      .filter((record) => String(record?.ticker || "").toUpperCase() === normalizedTicker)
      .filter((record) => String(record?.option_type || "").toLowerCase() === type)
      .filter((record) => String(record?.moneyness_bucket || "") === bucket)
      .filter((record) => Number(record?.observations) >= 10)
      .filter((record) => ["p10", "p25", "p50", "p75", "p90"].every((key) => Number.isFinite(Number(record?.[key]))))
      .sort((left, right) => Math.abs(Number(left.dte_bucket) - targetDte) - Math.abs(Number(right.dte_bucket) - targetDte));
    if (!eligible.length) return null;
    const selected = eligible[0];
    return {
      ticker: normalizedTicker,
      optionType: type,
      dteBucket: Number(selected.dte_bucket),
      moneynessBucket: bucket,
      observations: Number(selected.observations),
      p10: Number(selected.p10),
      p25: Number(selected.p25),
      p50: Number(selected.p50),
      p75: Number(selected.p75),
      p90: Number(selected.p90),
    };
  }

  function approximateIvPercentile(marketIv, benchmark) {
    const value = Number(marketIv);
    if (!benchmark || !Number.isFinite(value)) return null;
    const anchors = [
      [Number(benchmark.p10), 10],
      [Number(benchmark.p25), 25],
      [Number(benchmark.p50), 50],
      [Number(benchmark.p75), 75],
      [Number(benchmark.p90), 90],
    ];
    if (value <= anchors[0][0]) return 5;
    if (value >= anchors.at(-1)[0]) return 95;
    for (let index = 0; index < anchors.length - 1; index += 1) {
      const [lowValue, lowPercentile] = anchors[index];
      const [highValue, highPercentile] = anchors[index + 1];
      if (value <= highValue) {
        if (highValue <= lowValue) return (lowPercentile + highPercentile) / 2;
        return lowPercentile + ((value - lowValue) / (highValue - lowValue)) * (highPercentile - lowPercentile);
      }
    }
    return null;
  }

  function varianceResearchContext({ marketIv, forecastVol, priceEdge, spot, gamma, vega, days, benchmark }) {
    const market = Number(marketIv);
    const forecast = Number(forecastVol);
    const edge = Number(priceEdge);
    const timeYears = Math.max(Number(days) || 0, 0) / 365;
    const impliedVariance = Number.isFinite(market) ? (market / 100) ** 2 : null;
    const forecastVariance = Number.isFinite(forecast) ? (forecast / 100) ** 2 : null;
    const varianceEdge = impliedVariance == null || forecastVariance == null
      ? null
      : impliedVariance - forecastVariance;
    const dollarGamma = [spot, gamma].every((value) => Number.isFinite(Number(value)))
      ? 0.5 * Number(spot) ** 2 * Number(gamma)
      : null;
    const gammaWeightedEdge = dollarGamma == null || varianceEdge == null
      ? null
      : dollarGamma * varianceEdge * timeYears;
    const vegaNormalizedEdge = Number.isFinite(edge) && Number.isFinite(Number(vega)) && Number(vega) > 0
      ? edge / Number(vega)
      : null;
    const candidateSide = Number.isFinite(edge) && Number.isFinite(market) && Number.isFinite(forecast)
      ? forecast > market && edge > 0
        ? "long_vol"
        : market > forecast && edge < 0
          ? "short_vol"
          : forecast > market
            ? "mixed_short_price"
            : market > forecast
              ? "mixed_long_price"
              : "neutral"
      : "unavailable";
    const ivPercentile = approximateIvPercentile(market, benchmark);
    const surfaceContextPass = candidateSide === "long_vol"
      ? Number.isFinite(ivPercentile) && ivPercentile <= 40
      : candidateSide === "short_vol"
        ? Number.isFinite(ivPercentile) && ivPercentile >= 60
        : false;
    return {
      impliedVariance,
      forecastVariance,
      varianceEdge,
      dollarGamma,
      gammaWeightedEdge,
      vegaNormalizedEdge,
      candidateSide,
      ivPercentile,
      surfaceContextPass,
    };
  }

  function textWithoutOverlay(element) {
    if (!element) return "";
    const copy = element.cloneNode(true);
    copy.querySelectorAll?.("[data-bsfv-overlay]").forEach((overlay) => overlay.remove());
    return copy.textContent || "";
  }

  const Core = {
    calculateBlackScholes,
    computePaperOutcomes,
    assessDiscrepancy,
    chainImpliedCarry,
    daysToExpiration,
    dividendAssumption,
    extractSelectedIv,
    formatMoney,
    impliedVolatility,
    impliedDividendYield,
    interpolateTreasuryRate,
    newYorkSettlement,
    parseExpirationLabel,
    parseExpandedContract,
    parseExtendedHoursChange,
    parseHeading,
    parseMoney,
    parseTreasuryXml,
    sessionAlignedSpot,
    smoothedVolatility,
    selectVolatilityForecast,
    moneynessBucket,
    nearestDteBucket,
    selectSurfaceBenchmark,
    approximateIvPercentile,
    varianceResearchContext,
    thinPaperRecords,
    forecastHorizonFromDte,
  };

  globalThis.__BSFV_CORE__ = Core;

  if (typeof document === "undefined" || typeof chrome === "undefined" || !chrome.storage) return;

  let settings = { ...DEFAULT_SETTINGS };
  let observer;
  let renderQueued = false;
  let renderTimer;
  let treasuryCurve = FALLBACK_TREASURY_CURVE;
  let volatilityForecast = { schema: "volatility_forecast.v1", records: [] };
  let exactQuotes = new Map();
  let exactQuoteChainKey = "";
  let scanRunning = false;
  let lastAutoScanAt = 0;
  let autoScanChainKey = "";
  let paperStudy = { version: PAPER_STUDY_VERSION, records: [], updatedAt: null, outcomes15m: null, outcomes60m: null };
  let paperWriteRunning = false;
  let pendingPaperRecords = [];
  const pricingCache = new Map();
  const recordedCaptureTimes = new Map();

  function validForecastPayload(payload) {
    return payload?.schema === "volatility_forecast.v1" &&
      Array.isArray(payload.records) &&
      payload.records.length > 0 &&
      payload.records.every((record) =>
        record?.ticker &&
        Number.isFinite(Number(record.horizon)) &&
        Number.isFinite(Number(record.forecast_vol))
      );
  }

  function forecastTimestamp(payload) {
    const timestamp = Date.parse(payload?.generated_at || payload?.updated_at || "");
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  async function loadBundledForecast(existingPayload) {
    const existingValid = validForecastPayload(existingPayload);
    try {
      const url = chrome.runtime.getURL("volatility-research-output/latest_forecasts.json");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Bundled forecast returned ${response.status}`);
      const bundled = await response.json();
      if (!validForecastPayload(bundled)) throw new Error("Bundled forecast payload is invalid");

      const bundledIsNewer = forecastTimestamp(bundled) > forecastTimestamp(existingPayload);
      if (!existingValid || bundledIsNewer) {
        chrome.storage.local.set({ volatilityForecastV1: bundled });
        return { payload: bundled, firstImport: !existingValid };
      }
      return { payload: existingPayload, firstImport: false };
    } catch {
      return { payload: existingValid ? existingPayload : null, firstImport: false };
    }
  }

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
    const equityPrice = document.querySelector('#sdp-market-price [aria-label]');
    const indexPrice = document.querySelector('[data-testid="IndexDetailPage-PriceSection"] [aria-label]');
    const currentSpot = parseMoney(
      equityPrice?.getAttribute("aria-label") ||
      indexPrice?.getAttribute("aria-label") ||
      shareButton?.textContent ||
      "",
    );
    const alignedSpot = sessionAlignedSpot(
      currentSpot,
      document.querySelector('#sdp-price-chart-price-change')?.textContent || "",
    );
    const expirationControl = document.querySelector('[aria-label="Expiration Date"]');
    const expiration = parseExpirationLabel(expirationControl?.textContent || "");
    const grid = document.querySelector('[role="grid"]');
    const selectedIv = extractSelectedIv(document.body.innerText || "");
    const priceHeading = [...document.querySelectorAll("h4")]
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .find((text) => /^(Ask|Bid|Mark|Natural) Price$/i.test(text));

    if (alignedSpot.spot == null || !expiration || !grid) return null;
    return {
      ...heading,
      ...alignedSpot,
      expiration,
      selectedIv,
      priceHeading: priceHeading || (heading.side === "buy" ? "Ask Price" : "Bid Price"),
      grid,
    };
  }

  function exactQuoteKey(context, strike) {
    return `${context.ticker}|${context.optionType}|${context.expiration}|${Number(strike).toFixed(4)}`;
  }

  function quoteFromRow(row) {
    return parseExpandedContract(row?.parentElement?.innerText || "");
  }

  function cacheExpandedQuote(context, row) {
    const quote = quoteFromRow(row);
    if (!quote || quote.ticker !== context.ticker || quote.optionType !== context.optionType) return null;
    const cached = { ...quote, capturedAt: Date.now() };
    exactQuotes.set(exactQuoteKey(context, quote.strike), cached);
    return cached;
  }

  function captureExpandedQuotes(context) {
    const rows = [...context.grid.querySelectorAll('[data-testid^="ChainTableRow-"]')];
    return rows.map((row) => cacheExpandedQuote(context, row)).filter(Boolean);
  }

  function waitForExpandedQuote(context, strike, timeout = 1600) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const poll = () => {
        const row = [...context.grid.querySelectorAll('[data-testid^="ChainTableRow-"]')].find((candidate) => {
          const candidateStrike = parseMoney(
            candidate.querySelector('[data-testid="OptionChainStrikePriceCell"]')?.textContent || "",
          );
          return candidateStrike != null && Math.abs(candidateStrike - strike) < 0.0001;
        });
        const quote = cacheExpandedQuote(context, row);
        if (quote && Math.abs(quote.strike - strike) < 0.0001) {
          resolve(quote);
          return;
        }
        if (Date.now() - startedAt >= timeout) {
          resolve(null);
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  async function scanVisibleExactQuotes({ automatic = false } = {}) {
    if (scanRunning) return;
    const context = pageContext();
    if (!context) return;
    const chainKey = `${context.ticker}|${context.optionType}|${context.expiration}`;
    if (chainKey !== exactQuoteChainKey) {
      exactQuoteChainKey = chainKey;
      exactQuotes = new Map();
    }
    scanRunning = true;
    const button = ensurePanel().querySelector("#bsfv-scan-exact");
    button.disabled = true;
    const initialRows = [...context.grid.querySelectorAll('[data-testid^="ChainTableRow-"]')];
    const originallyExpanded = new Set(
      initialRows.map((row) => quoteFromRow(row)?.strike).filter(Number.isFinite),
    );
    const strikes = initialRows
      .map((row) => ({
        strike: parseMoney(row.querySelector('[data-testid="OptionChainStrikePriceCell"]')?.textContent || ""),
        price: parseMoney(textWithoutOverlay(row.querySelector('[data-testid="OptionChainValidPriceCell"]'))),
      }))
      .filter((contract) => Number.isFinite(contract.strike) && Number.isFinite(contract.price))
      .map((contract) => contract.strike);

    try {
      for (let index = 0; index < strikes.length; index += 1) {
        const strike = strikes[index];
        button.textContent = `${automatic ? "AUTO " : ""}REFRESHING MARK IV ${index + 1}/${strikes.length}`;
        const row = [...context.grid.querySelectorAll('[data-testid^="ChainTableRow-"]')].find((candidate) => {
          const candidateStrike = parseMoney(
            candidate.querySelector('[data-testid="OptionChainStrikePriceCell"]')?.textContent || "",
          );
          return candidateStrike != null && Math.abs(candidateStrike - strike) < 0.0001;
        });
        const strikeCell = row?.querySelector('[data-testid="OptionChainStrikePriceCell"]');
        if (!strikeCell) continue;
        if (originallyExpanded.has(strike)) {
          cacheExpandedQuote(context, row);
          continue;
        }
        strikeCell.click();
        const quote = await waitForExpandedQuote(context, strike);
        if (quote) strikeCell.click();
      }
    } finally {
      scanRunning = false;
      lastAutoScanAt = Date.now();
      button.disabled = false;
      button.textContent = "REFRESH MARK IV NOW";
      scheduleRender();
    }
  }

  function maybeAutoScan() {
    if (!settings.enabled || !settings.autoScan || scanRunning || document.hidden) return;
    const context = pageContext();
    if (!context) return;
    const chainKey = `${context.ticker}|${context.optionType}|${context.expiration}`;
    if (chainKey !== autoScanChainKey) {
      autoScanChainKey = chainKey;
      lastAutoScanAt = 0;
    }
    const intervalMs = Math.max(Number(settings.autoScanIntervalSeconds) || 30, 15) * 1000;
    if (Date.now() - lastAutoScanAt >= intervalMs) scanVisibleExactQuotes({ automatic: true });
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
              <option value="walkforward">Walk-forward volatility forecast</option>
              <option value="surface">Smoothed market smile</option>
              <option value="forecast">Own forecast + market skew</option>
              <option value="individual">Individual market IV</option>
              <option value="manual">Flat own-vol forecast</option>
            </select>
          </label>
          <label>Forecast ATM IV
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
          <label>Flag edge
            <span><input id="bsfv-gap-threshold" type="number" min="1" max="100" step="1"><small>%</small></span>
          </label>
          <label>Max spread
            <span><input id="bsfv-max-spread" type="number" min="1" max="100" step="1"><small>%</small></span>
          </label>
        </div>
        <label class="bsfv-check"><input id="bsfv-auto-rate" type="checkbox"> Auto Treasury curve by expiration</label>
        <label class="bsfv-check"><input id="bsfv-auto-dividend" type="checkbox"> Auto ticker dividends by expiration</label>
        <label class="bsfv-check"><input id="bsfv-alerts-enabled" type="checkbox"> Highlight high-confidence research flags</label>
        <label class="bsfv-check"><input id="bsfv-auto-scan" type="checkbox"> Continuously refresh exact Mark/IV every <input id="bsfv-auto-scan-seconds" type="number" min="15" max="300" step="5"> seconds</label>
        <label class="bsfv-check"><input id="bsfv-paper-recording" type="checkbox"> Record forward paper outcomes locally</label>
        <button id="bsfv-scan-exact" type="button">REFRESH MARK IV NOW</button>
        <p id="bsfv-status">Waiting for Robinhood’s visible chain…</p>
        <section id="bsfv-alerts" aria-label="Option discrepancy research flags">
          <div><strong>RESEARCH FLAGS</strong><span id="bsfv-alert-count">0</span></div>
          <ol id="bsfv-alert-list"></ol>
          <p id="bsfv-alert-note">Exact Mark IVs refresh automatically while this chain stays open.</p>
        </section>
        <p class="bsfv-disclaimer">Research screen only · no orders · local paper recorder</p>
      </div>`;
    document.documentElement.appendChild(panel);

    panel.querySelector("#bsfv-collapse").addEventListener("click", () => {
      settings.collapsed = !settings.collapsed;
      chrome.storage.sync.set({ collapsed: settings.collapsed });
      syncPanel();
    });
    panel.querySelector("#bsfv-iv-source").addEventListener("change", (event) => {
      settings.ivSource = IV_SOURCES.includes(event.target.value)
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
      ["bsfv-gap-threshold", "gapThreshold"],
      ["bsfv-max-spread", "maxSpreadPercent"],
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
    panel.querySelector("#bsfv-alerts-enabled").addEventListener("change", (event) => {
      settings.alertsEnabled = event.target.checked;
      chrome.storage.sync.set({ alertsEnabled: settings.alertsEnabled });
      scheduleRender();
    });
    panel.querySelector("#bsfv-auto-scan").addEventListener("change", (event) => {
      settings.autoScan = event.target.checked;
      lastAutoScanAt = 0;
      chrome.storage.sync.set({ autoScan: settings.autoScan });
      maybeAutoScan();
      scheduleRender();
    });
    panel.querySelector("#bsfv-auto-scan-seconds").addEventListener("change", (event) => {
      settings.autoScanIntervalSeconds = Math.min(Math.max(Number(event.target.value) || 30, 15), 300);
      chrome.storage.sync.set({ autoScanIntervalSeconds: settings.autoScanIntervalSeconds });
      scheduleRender();
    });
    panel.querySelector("#bsfv-paper-recording").addEventListener("change", (event) => {
      settings.paperRecording = event.target.checked;
      chrome.storage.sync.set({ paperRecording: settings.paperRecording });
      scheduleRender();
    });
    panel.querySelector("#bsfv-scan-exact").addEventListener("click", () => scanVisibleExactQuotes());
    return panel;
  }

  function syncPanel(context = pageContext(), details = {}) {
    const panel = ensurePanel();
    panel.dataset.bsfvBuild = "2.0.1";
    panel.dataset.bsfvForecastRecords = String(volatilityForecast?.records?.length || 0);
    panel.classList.toggle("is-collapsed", settings.collapsed);
    panel.querySelector("#bsfv-panel-body").hidden = settings.collapsed;
    panel.querySelector("#bsfv-collapse").textContent = settings.collapsed ? "+" : "−";
    panel.querySelector("#bsfv-iv-source").value = settings.ivSource;
    panel.querySelector("#bsfv-volatility").value = String(settings.volatility);
    panel.querySelector("#bsfv-volatility").disabled = !["forecast", "manual"].includes(settings.ivSource);
    panel.querySelector("#bsfv-iv-shift").value = String(settings.ivShift);
    panel.querySelector("#bsfv-rate").value = String(settings.rate);
    panel.querySelector("#bsfv-rate").disabled = settings.autoRate;
    panel.querySelector("#bsfv-dividend").value = String(settings.dividend);
    panel.querySelector("#bsfv-dividend").disabled = settings.autoDividend;
    panel.querySelector("#bsfv-auto-rate").checked = settings.autoRate;
    panel.querySelector("#bsfv-auto-dividend").checked = settings.autoDividend;
    panel.querySelector("#bsfv-alerts-enabled").checked = settings.alertsEnabled;
    panel.querySelector("#bsfv-auto-scan").checked = settings.autoScan;
    panel.querySelector("#bsfv-auto-scan-seconds").value = String(settings.autoScanIntervalSeconds);
    panel.querySelector("#bsfv-auto-scan-seconds").disabled = !settings.autoScan;
    panel.querySelector("#bsfv-paper-recording").checked = settings.paperRecording;
    panel.querySelector("#bsfv-gap-threshold").value = String(settings.gapThreshold);
    panel.querySelector("#bsfv-max-spread").value = String(settings.maxSpreadPercent);
    const scanButton = panel.querySelector("#bsfv-scan-exact");
    if (!scanRunning) {
      const exactCount = details.exactCount ?? 0;
      const totalRows = details.totalRows ?? 0;
      scanButton.textContent = totalRows > 0
        ? `REFRESH MARK IV NOW (${exactCount}/${totalRows})`
        : "REFRESH MARK IV NOW";
    }

    const contextLine = panel.querySelector("#bsfv-context");
    const statusLine = panel.querySelector("#bsfv-status");
    if (!context) {
      contextLine.textContent = "Open a Robinhood option chain to begin.";
      statusLine.textContent = "No supported chain detected.";
      panel.querySelector("#bsfv-alert-count").textContent = "0";
      panel.querySelector("#bsfv-alert-list").replaceChildren();
      panel.querySelector("#bsfv-alert-note").textContent = "Open a chain; exact Mark IVs will refresh automatically.";
      return;
    }
    const spotCopy = context.basis === "regular-session close"
      ? `option-aligned spot ${formatMoney(context.spot)} close · live ${formatMoney(context.liveSpot)}`
      : `spot ${formatMoney(context.spot)} live`;
    contextLine.textContent = `${context.ticker} ${context.optionType.toUpperCase()} · ${context.expiration} · ${spotCopy}`;
    const ivCopy = settings.ivSource === "walkforward"
      ? details.forecastRecord
        ? `walk-forward ${details.forecastRecord.forecastVol.toFixed(2)}% · ${details.forecastRecord.modelUsed} · h${details.forecastRecord.horizon} · as of ${details.forecastRecord.asOfDate}`
        : `walk-forward forecast missing for ${context.ticker}; ${volatilityForecast?.records?.length || 0} bundled records loaded`
      : settings.ivSource === "surface"
      ? `neighbor smile from ${details.validIvCount ?? 0}/${details.totalRows ?? 0} visible IVs`
      : settings.ivSource === "forecast"
        ? `own ATM forecast ${Number(settings.volatility).toFixed(2)}% + live market skew`
      : settings.ivSource === "individual"
        ? "individual quote-implied IV (circular at 0 shift)"
        : `flat own-vol forecast ${Number(settings.volatility).toFixed(2)}%`;
    const exactCopy = `exact Mark IV ${details.exactCount ?? 0}/${details.totalRows ?? 0}`;
    const historyCopy = `history buckets ${details.surfaceContextCount ?? 0}/${details.totalRows ?? 0}`;
    const rateCopy = settings.autoRate
      ? `r ${Number(details.rate).toFixed(2)}% CMT (${treasuryCurve.date})`
      : `r ${Number(settings.rate).toFixed(2)}% manual`;
    const dividendCopy = settings.autoDividend
      ? `q ${Number(details.dividend).toFixed(2)}% · ${details.dividendModel || "ticker default"}`
      : `q ${Number(settings.dividend).toFixed(2)}% manual`;
    const autoCopy = settings.autoScan
      ? `auto ${Math.max(Number(settings.autoScanIntervalSeconds) || 30, 15)}s`
      : "auto off";
    const paperCopy = settings.paperRecording
      ? `paper ${paperStudy.records?.length || 0} · 60m ${paperStudy.outcomes60m?.count || 0}`
      : "paper off";
    statusLine.textContent = `${ivCopy} · ${exactCopy} · ${historyCopy} · ${autoCopy} · ${paperCopy} · shift ${Number(settings.ivShift).toFixed(2)}pt · ${rateCopy} · ${dividendCopy}`;

    const alerts = details.alerts || [];
    const alertList = panel.querySelector("#bsfv-alert-list");
    const alertNote = panel.querySelector("#bsfv-alert-note");
    panel.querySelector("#bsfv-alert-count").textContent = String(alerts.length);
    alertList.replaceChildren();
    for (const alert of alerts.slice(0, 5)) {
      const item = document.createElement("li");
      const direction = alert.direction === "below-model" ? "below model" : "above model";
      const side = alert.candidateSide === "long_vol" ? "LONG VOL" : "SHORT VOL";
      const percentile = Number.isFinite(alert.ivPercentile) ? ` · IVP ${alert.ivPercentile.toFixed(0)}` : "";
      item.textContent = `$${Number(alert.strike).toLocaleString()} ${side} · ${direction} · ${alert.edgePercent.toFixed(1)}% past ${alert.direction === "below-model" ? "ask" : "bid"}${percentile} · ${alert.score.toFixed(1)}× spread`;
      alertList.appendChild(item);
    }
    if (!settings.alertsEnabled) {
      alertNote.textContent = "Research flags are turned off.";
    } else if (alerts.length) {
      alertNote.textContent = "Candidates for deeper review—not trade recommendations. Fresh exact quotes only.";
    } else if ((details.exactCount ?? 0) < 3) {
      alertNote.textContent = "Waiting for the automatic exact Mark/IV refresh; estimates cannot trigger flags.";
    } else if (details.alertInputReady === false) {
      alertNote.textContent = ["surface", "individual"].includes(settings.ivSource)
        ? "Research flags require your own walk-forward, forecast, or manual volatility view."
        : "Carry or the walk-forward forecast is not calibrated for this ticker/expiry.";
    } else if ((details.surfaceContextCount ?? 0) === 0) {
      alertNote.textContent = "No matched historical ticker/DTE/moneyness IV bucket; skew-safe flags are suppressed.";
    } else {
      alertNote.textContent = "No fresh contract clears the edge, spread, and liquidity gates.";
    }
  }

  function flushPaperRecords() {
    if (paperWriteRunning || !pendingPaperRecords.length) return;
    paperWriteRunning = true;
    const batch = pendingPaperRecords.splice(0, pendingPaperRecords.length);
    chrome.storage.local.get({ paperStudyV1: paperStudy }, ({ paperStudyV1 }) => {
      const combined = [...(paperStudyV1.records || []), ...batch];
      const deduplicated = thinPaperRecords(combined).slice(-10_000);
      paperStudy = {
        version: PAPER_STUDY_VERSION,
        records: deduplicated,
        updatedAt: Date.now(),
        outcomes15m: computePaperOutcomes(deduplicated, 15),
        outcomes60m: computePaperOutcomes(deduplicated, 60),
      };
      chrome.storage.local.set({ paperStudyV1: paperStudy }, () => {
        paperWriteRunning = false;
        scheduleRender();
        flushPaperRecords();
      });
    });
  }

  function queuePaperSnapshots(context, pricedContracts, modelDetails) {
    if (!settings.paperRecording) return;
    const next = [];
    for (const contract of pricedContracts) {
      const quote = contract.exactQuote;
      if (!quote || !Number.isFinite(Number(quote.capturedAt))) continue;
      const contractKey = exactQuoteKey(context, contract.strike);
      const lastRecordedAt = recordedCaptureTimes.get(contractKey);
      if (Number.isFinite(lastRecordedAt) && quote.capturedAt - lastRecordedAt < PAPER_MIN_SPACING_MS) continue;
      recordedCaptureTimes.set(contractKey, quote.capturedAt);
      next.push({
        id: `${contractKey}|${quote.capturedAt}`,
        contractKey,
        ticker: context.ticker,
        optionType: context.optionType,
        expiration: context.expiration,
        strike: contract.strike,
        observedAt: quote.capturedAt,
        spot: context.spot,
        bid: quote.bid,
        mark: quote.mark,
        ask: quote.ask,
        volume: quote.volume,
        openInterest: quote.openInterest,
        marketIv: contract.marketIv,
        fairIv: contract.fairIv,
        ivEdge: contract.ivEdge,
        impliedVariance: contract.variance.impliedVariance,
        forecastVariance: contract.variance.forecastVariance,
        varianceEdge: contract.variance.varianceEdge,
        dollarGamma: contract.variance.dollarGamma,
        gammaWeightedEdge: contract.variance.gammaWeightedEdge,
        vegaNormalizedEdge: contract.variance.vegaNormalizedEdge,
        candidateSide: contract.variance.candidateSide,
        ivPercentile: contract.variance.ivPercentile,
        surfaceContextPass: contract.variance.surfaceContextPass,
        moneynessBucket: contract.surfaceBenchmark?.moneynessBucket ?? null,
        dteBucket: contract.surfaceBenchmark?.dteBucket ?? null,
        fairValue: contract.fairValue,
        modelUsed: contract.pricing?.modelUsed ?? "black_scholes_dividend_adjusted",
        modelReason: contract.pricing?.modelReason ?? "American-model diagnostics unavailable",
        bsForecastFairValue: contract.pricing?.bsForecastFairValue ?? contract.fairValue,
        americanForecastFairValue: contract.pricing?.americanForecastFairValue ?? null,
        earlyExercisePremium: contract.pricing?.earlyExercisePremium ?? 0,
        blackScholesIv: contract.pricing?.blackScholesIv ?? null,
        americanIv: contract.pricing?.americanIv ?? null,
        pricingWarning: contract.pricing?.pricingWarning ?? null,
        flagDirection: contract.alert.flagged ? contract.alert.direction : null,
        edgePercent: contract.alert.flagged ? contract.alert.edgePercent : null,
        modelMode: settings.ivSource,
        forecastAtmIv: settings.ivSource === "walkforward"
          ? modelDetails.forecastRecord?.forecastVol ?? null
          : ["forecast", "manual"].includes(settings.ivSource) ? Number(settings.volatility) : null,
        forecastHorizon: modelDetails.forecastRecord?.horizon ?? null,
        forecastAsOf: modelDetails.forecastRecord?.asOfDate ?? null,
        forecastModel: modelDetails.forecastRecord?.modelUsed ?? null,
        forecastLambda: modelDetails.forecastRecord?.lambdaUsed ?? null,
        forecastWeights: modelDetails.forecastRecord?.weightsUsed ?? null,
        rate: modelDetails.rate,
        dividend: modelDetails.dividend,
        days: modelDetails.days,
      });
    }
    if (!next.length) return;
    pendingPaperRecords.push(...next);
    flushPaperRecords();
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

    const chainKey = `${context.ticker}|${context.optionType}|${context.expiration}`;
    if (chainKey !== exactQuoteChainKey) {
      exactQuoteChainKey = chainKey;
      exactQuotes = new Map();
    }
    captureExpandedQuotes(context);

    const settlementMinutes = context.ticker === "SPX" ? 16 * 60 : 16 * 60 + 15;
    const days = daysToExpiration(context.expiration, Date.now(), settlementMinutes);
    const interpolatedRate = settings.autoRate
      ? interpolateTreasuryRate(treasuryCurve.points, days)
      : Number(settings.rate);
    const effectiveRate = Number.isFinite(interpolatedRate) ? interpolatedRate : Number(settings.rate);
    const inferredCarry = settings.autoDividend
      ? chainImpliedCarry({
        quotes: [...exactQuotes.values()],
        optionType: context.optionType,
        spot: context.spot,
        days,
        rate: effectiveRate,
      })
      : null;
    const dividendDetails = settings.autoDividend
      ? inferredCarry || dividendAssumption({
          ticker: context.ticker,
          spot: context.spot,
          expiration: context.expiration,
          days,
          rate: effectiveRate,
        })
      : { yield: Number(settings.dividend), count: null, model: "manual" };
    const effectiveDividend = dividendDetails.yield;
    const forecastRecord = settings.ivSource === "walkforward"
      ? selectVolatilityForecast(volatilityForecast, context.ticker, forecastHorizonFromDte(days))
      : null;
    const hasOwnVolatilityView = ["walkforward", "forecast", "manual"].includes(settings.ivSource);
    const alertInputReady = hasOwnVolatilityView && (!settings.autoDividend || Boolean(inferredCarry) ||
      Object.prototype.hasOwnProperty.call(DIVIDEND_DEFAULTS, context.ticker)) &&
      (settings.ivSource !== "walkforward" || Boolean(forecastRecord));
    const rows = [...context.grid.querySelectorAll('[data-testid^="ChainTableRow-"]')];
    const contracts = rows.map((row) => {
      const strikeCell = row.querySelector('[data-testid="OptionChainStrikePriceCell"]');
      const priceCell = row.querySelector('[data-testid="OptionChainValidPriceCell"]');
      const strike = parseMoney(strikeCell?.textContent || "");
      const displayedPrice = parseMoney(textWithoutOverlay(priceCell));
      if (!priceCell || strike == null || displayedPrice == null || days == null) {
        row.querySelector("[data-bsfv-overlay]")?.remove();
        priceCell?.removeAttribute("data-bsfv-cell");
        return null;
      }
      const exactQuote = exactQuotes.get(exactQuoteKey(context, strike));
      const referencePrice = exactQuote?.mark ?? displayedPrice;
      const marketIv = exactQuote?.iv ?? impliedVolatility({
        marketPrice: displayedPrice,
        optionType: context.optionType,
        spot: context.spot,
        strike,
        days,
        rate: effectiveRate,
        dividend: effectiveDividend,
      });
      return { row, priceCell, strike, displayedPrice, referencePrice, exactQuote, marketIv };
    }).filter(Boolean);
    const observations = contracts
      .filter((contract) => contract.marketIv != null)
      .map((contract) => ({ strike: contract.strike, iv: contract.marketIv }));
    const marketSurfaceAtm = smoothedVolatility(context.spot, observations, context.spot);
    const pricedContracts = contracts.map((contract) => {
      const { row, priceCell, strike, displayedPrice, referencePrice, exactQuote, marketIv } = contract;
      const surfaceIv = smoothedVolatility(strike, observations, context.spot);
      const ownForecastVol = settings.ivSource === "walkforward"
        ? forecastRecord?.forecastVol
        : Number(settings.volatility);
      const baseIv = settings.ivSource === "manual"
        ? Number(settings.volatility)
        : ["walkforward", "forecast"].includes(settings.ivSource)
          ? Number.isFinite(surfaceIv) && Number.isFinite(marketSurfaceAtm)
            ? surfaceIv + (ownForecastVol - marketSurfaceAtm)
            : ownForecastVol
          : settings.ivSource === "individual"
            ? marketIv
            : surfaceIv;
      if (!Number.isFinite(baseIv)) {
        row.querySelector("[data-bsfv-overlay]")?.remove();
        priceCell.removeAttribute("data-bsfv-cell");
        return null;
      }
      const fairIv = Math.min(Math.max(baseIv + Number(settings.ivShift), 0.01), 500);
      const pricingInput = {
        optionType: context.optionType,
        spot: context.spot,
        strike,
        days,
        volatility: fairIv,
        rate: effectiveRate,
        dividend: effectiveDividend,
      };
      const pricingCacheKey = [
        context.ticker, context.optionType, context.expiration, context.spot.toFixed(4), strike,
        days.toFixed(6), fairIv.toFixed(4), Number(marketIv).toFixed(4), referencePrice.toFixed(4),
        effectiveRate.toFixed(4), effectiveDividend.toFixed(4), Number(settings.treeSteps || 75),
        exactQuote ? "iv" : "noiv",
      ].join("|");
      let pricing = pricingCache.get(pricingCacheKey);
      if (!pricing && Pricing) {
        try {
          pricing = Pricing.compareModels({
            ...pricingInput,
            ticker: context.ticker,
            marketMid: referencePrice,
            marketIv: Number.isFinite(marketIv) ? marketIv : fairIv,
            forecastVolatility: fairIv,
            treeSteps: Math.min(Math.max(Number(settings.treeSteps) || 75, 25), 500),
            calculateIv: Boolean(exactQuote && Number.isFinite(marketIv)),
          });
          pricingCache.set(pricingCacheKey, pricing);
          if (pricingCache.size > 2_000) pricingCache.delete(pricingCache.keys().next().value);
        } catch {
          pricing = null;
        }
      }
      const fairValue = pricing?.selectedFairValue ?? optionPrice(pricingInput);
      const difference = fairValue - referencePrice;
      const marketGreeks = Number.isFinite(marketIv)
        ? calculateBlackScholes({
            spot: context.spot,
            strike,
            days,
            volatility: marketIv,
            rate: effectiveRate,
            dividend: effectiveDividend,
          })
        : null;
      const surfaceBenchmark = selectSurfaceBenchmark(
        volatilityForecast,
        context.ticker,
        context.optionType,
        days,
        Math.log(strike / context.spot),
      );
      const variance = varianceResearchContext({
        marketIv,
        forecastVol: fairIv,
        priceEdge: difference,
        spot: context.spot,
        gamma: marketGreeks?.gamma,
        vega: marketGreeks?.vega,
        days,
        benchmark: surfaceBenchmark,
      });
      const rawAlert = settings.alertsEnabled && alertInputReady
        ? assessDiscrepancy({
            fairValue,
            referencePrice,
            exactQuote,
            gapThreshold: settings.gapThreshold,
            maxSpreadPercent: settings.maxSpreadPercent,
        })
        : { flagged: false };
      const alert = rawAlert.flagged && variance.surfaceContextPass &&
        ["long_vol", "short_vol"].includes(variance.candidateSide)
        ? rawAlert
        : { flagged: false };
      const ivEdge = Number.isFinite(marketIv) ? fairIv - marketIv : null;
      return {
        ...contract,
        fairIv,
        fairValue,
        difference,
        ivEdge,
        alert,
        variance,
        surfaceBenchmark,
        pricing,
        marketGreeks,
      };
    }).filter(Boolean);
    const alerts = pricedContracts
      .filter((contract) => contract.alert.flagged)
      .map((contract) => ({
        ...contract.alert,
        strike: contract.strike,
        candidateSide: contract.variance.candidateSide,
        ivPercentile: contract.variance.ivPercentile,
        gammaWeightedEdge: contract.variance.gammaWeightedEdge,
      }))
      .sort((a, b) => b.score - a.score);
    queuePaperSnapshots(context, pricedContracts, {
      rate: effectiveRate,
      dividend: effectiveDividend,
      days,
      forecastRecord,
    });
    syncPanel(context, {
      rate: effectiveRate,
      dividend: effectiveDividend,
      dividendModel: dividendDetails.model,
      validIvCount: observations.length,
      totalRows: contracts.length,
      exactCount: contracts.filter((contract) => contract.exactQuote).length,
      surfaceContextCount: pricedContracts.filter((contract) => contract.surfaceBenchmark).length,
      alertInputReady,
      alerts,
      forecastRecord,
    });

    for (const contract of pricedContracts) {
      const {
        row, priceCell, strike, displayedPrice, referencePrice, exactQuote, marketIv,
        fairIv, fairValue, difference, ivEdge, alert, variance, surfaceBenchmark, pricing, marketGreeks,
      } = contract;
      let badge = priceCell.querySelector("[data-bsfv-overlay]");
      if (!badge) {
        badge = document.createElement("span");
        badge.setAttribute("data-bsfv-overlay", "true");
        badge.setAttribute("aria-label", "Multi-model option research value");
        priceCell.setAttribute("data-bsfv-cell", "true");
        priceCell.appendChild(badge);
      }
      const marketIvCopy = marketIv == null
        ? "IV n/a"
        : exactQuote
          ? `RH IV ${marketIv.toFixed(2)}%`
          : `${context.priceHeading.split(" ")[0]} IV ${marketIv.toFixed(1)}%*`;
      const flagCopy = alert.flagged
        ? ` · FLAG ${alert.direction === "below-model" ? "+" : "−"}${alert.edgePercent.toFixed(0)}%`
        : "";
      const ivEdgeCopy = Number.isFinite(ivEdge)
        ? ` · IV EDGE ${ivEdge >= 0 ? "+" : ""}${ivEdge.toFixed(1)}pt`
        : "";
      const varianceEdgeCopy = Number.isFinite(variance.varianceEdge)
        ? ` · VAR ${variance.varianceEdge >= 0 ? "+" : ""}${(variance.varianceEdge * 10_000).toFixed(0)}bp²`
        : "";
      const percentileCopy = Number.isFinite(variance.ivPercentile)
        ? ` · IVP ${variance.ivPercentile.toFixed(0)}`
        : "";
      const modelLabel = pricing?.modelUsed === "binomial_american_crr"
        ? "CRR"
        : pricing?.style === "european" ? "BS-EU" : "BS-q";
      const nextText = `FV ${formatMoney(fairValue)} · ${modelLabel} · ${marketIvCopy}${ivEdgeCopy}${varianceEdgeCopy}${percentileCopy}${flagCopy}`;
      if (badge.textContent !== nextText) badge.textContent = nextText;
      const comparison = difference >= 0 ? `+${formatMoney(difference)}` : `-${formatMoney(Math.abs(difference))}`;
      badge.dataset.signal = Math.abs(difference) < 0.005 ? "flat" : difference > 0 ? "above" : "below";
      badge.dataset.alert = alert.flagged ? alert.direction : "none";
      const referenceCopy = exactQuote
        ? `Robinhood mark ${formatMoney(referencePrice)} (displayed ask ${formatMoney(displayedPrice)})`
        : `Robinhood ${context.priceHeading.toLowerCase()} ${formatMoney(referencePrice)}`;
      const ivBasisCopy = exactQuote ? "Robinhood displayed" : `${context.priceHeading.split(" ")[0]}-implied estimate`;
      const alertCopy = alert.flagged
        ? ` Research flag: ${alert.edgePercent.toFixed(1)}% beyond the executable ${alert.direction === "below-model" ? "ask" : "bid"}, with a ${alert.spreadPercent.toFixed(1)}% spread and ${alert.score.toFixed(1)}× spread coverage. Candidate for review, not a trade recommendation.`
        : "";
      const varianceCopy = Number.isFinite(variance.varianceEdge)
        ? `implied variance ${(variance.impliedVariance * 100).toFixed(3)}%, forecast variance ${(variance.forecastVariance * 100).toFixed(3)}%, implied-minus-forecast ${(variance.varianceEdge * 10_000).toFixed(1)} bp squared`
        : "variance edge unavailable";
      const gammaCopy = Number.isFinite(variance.gammaWeightedEdge)
        ? `Haugh gamma-weighted edge ${variance.gammaWeightedEdge >= 0 ? "+" : ""}${formatMoney(variance.gammaWeightedEdge)} per share over remaining T`
        : "gamma-weighted edge unavailable";
      const historyCopy = surfaceBenchmark && Number.isFinite(variance.ivPercentile)
        ? `historical ${surfaceBenchmark.optionType} ${surfaceBenchmark.moneynessBucket}/${surfaceBenchmark.dteBucket}D IV percentile about ${variance.ivPercentile.toFixed(1)} from ${surfaceBenchmark.observations} observations`
        : "no matched historical IV bucket; research flag suppressed";
      // Full greek set at market IV (delta/theta/rho are per option type; gamma
      // and vega are shared). Theta is per calendar day; vega per vol point;
      // rho per rate point. Matches the research engine's option_rankings.csv.
      const isPutContract = String(context.optionType).toLowerCase() === "put";
      const greeksCopy = marketGreeks
        ? `greeks at market IV: delta ${(isPutContract ? marketGreeks.putDelta : marketGreeks.callDelta).toFixed(3)}, gamma ${marketGreeks.gamma.toFixed(4)}, theta ${formatMoney(isPutContract ? marketGreeks.putTheta : marketGreeks.callTheta)}/day, vega ${formatMoney(marketGreeks.vega)}/pt, rho ${formatMoney(isPutContract ? marketGreeks.putRho : marketGreeks.callRho)}/pt`
        : "greeks unavailable without market IV";
      const modelComparisonCopy = pricing
        ? `selected model ${pricing.modelUsed}: ${pricing.modelReason}; BS forecast-vol value ${formatMoney(pricing.bsForecastFairValue)}; American CRR forecast-vol value ${Number.isFinite(pricing.americanForecastFairValue) ? formatMoney(pricing.americanForecastFairValue) : "n/a"}; trinomial ${Number.isFinite(pricing.trinomialForecastFairValue) ? formatMoney(pricing.trinomialForecastFairValue) : "n/a"}; BAW approximation ${Number.isFinite(pricing.approximationForecastFairValue) ? formatMoney(pricing.approximationForecastFairValue) : "n/a"}; American-vs-BS difference ${formatMoney(pricing.earlyExercisePremium)}; same-tree exercise premium ${formatMoney(pricing.sameTreeExercisePremium)}; BS midpoint IV ${Number.isFinite(pricing.blackScholesIv) ? `${pricing.blackScholesIv.toFixed(2)}%` : "n/a"}; American midpoint IV ${Number.isFinite(pricing.americanIv) ? `${pricing.americanIv.toFixed(2)}%` : "n/a"}${pricing.pricingWarning ? `; warning: ${pricing.pricingWarning}` : ""}`
        : "American-model core unavailable; dividend-adjusted Black-Scholes fallback";
      badge.title = `${formatMoney(fairValue)} selected research value; ${comparison} versus ${referenceCopy}. ${modelComparisonCopy}. Market-IV model value is diagnostic/circular; the research edge uses forecast IV ${fairIv.toFixed(2)}%. ${ivBasisCopy} IV ${marketIv == null ? "unavailable" : `${marketIv.toFixed(2)}%`}; IV edge ${Number.isFinite(ivEdge) ? `${ivEdge >= 0 ? "+" : ""}${ivEdge.toFixed(2)} volatility points` : "unavailable"}; ${varianceCopy}; ${gammaCopy}; vega-normalized price edge ${Number.isFinite(variance.vegaNormalizedEdge) ? `${variance.vegaNormalizedEdge >= 0 ? "+" : ""}${variance.vegaNormalizedEdge.toFixed(2)} vol points` : "unavailable"}; ${greeksCopy}; signal ${variance.candidateSide}; ${historyCopy}; option-aligned spot ${formatMoney(context.spot)} (${context.basis}); CMT rate ${effectiveRate.toFixed(2)}%; dividend/carry input ${effectiveDividend.toFixed(2)}%.${alertCopy}`;
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 80);
  }

  function start() {
    chrome.storage.local.get({
      treasuryCurve: FALLBACK_TREASURY_CURVE,
      paperStudyV1: paperStudy,
      volatilityForecastV1: volatilityForecast,
    }, async (saved) => {
      if (saved.treasuryCurve?.points?.length) treasuryCurve = saved.treasuryCurve;
      const bundledForecast = await loadBundledForecast(saved.volatilityForecastV1);
      if (bundledForecast.payload) {
        volatilityForecast = bundledForecast.payload;
      }
      if (bundledForecast.firstImport) {
        chrome.storage.sync.set({
          ivSource: "walkforward",
          settingsVersion: DEFAULT_SETTINGS.settingsVersion,
        });
      }
      if (Array.isArray(saved.paperStudyV1?.records)) {
        const normalized = thinPaperRecords(saved.paperStudyV1.records).slice(-10_000);
        paperStudy = {
          version: PAPER_STUDY_VERSION,
          records: normalized,
          updatedAt: saved.paperStudyV1.updatedAt || Date.now(),
          outcomes15m: computePaperOutcomes(normalized, 15),
          outcomes60m: computePaperOutcomes(normalized, 60),
        };
        for (const record of normalized) {
          const previous = recordedCaptureTimes.get(record.contractKey) || 0;
          if (Number(record.observedAt) > previous) recordedCaptureTimes.set(record.contractKey, Number(record.observedAt));
        }
        if (saved.paperStudyV1.version !== PAPER_STUDY_VERSION || normalized.length !== saved.paperStudyV1.records.length) {
          chrome.storage.local.set({ paperStudyV1: paperStudy });
        }
      }
      scheduleRender();
    });
    chrome.storage.sync.get(null, (saved) => {
      const needsMigration = Number(saved.settingsVersion || 0) < DEFAULT_SETTINGS.settingsVersion;
      settings = { ...DEFAULT_SETTINGS, ...saved };
      if (!IV_SOURCES.includes(settings.ivSource)) {
        settings.ivSource = "surface";
      }
      settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
      if (needsMigration) chrome.storage.sync.set({
        settingsVersion: settings.settingsVersion,
        alertsEnabled: settings.alertsEnabled,
        gapThreshold: settings.gapThreshold,
        maxSpreadPercent: settings.maxSpreadPercent,
        autoScan: settings.autoScan,
        autoScanIntervalSeconds: settings.autoScanIntervalSeconds,
        paperRecording: settings.paperRecording,
        treeSteps: settings.treeSteps,
      });
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
      setInterval(maybeAutoScan, 1000);
      maybeAutoScan();
      refreshTreasuryCurve();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes.treasuryCurve?.newValue?.points?.length) treasuryCurve = changes.treasuryCurve.newValue;
        if (Array.isArray(changes.paperStudyV1?.newValue?.records)) paperStudy = changes.paperStudyV1.newValue;
        if (changes.volatilityForecastV1?.newValue?.schema === "volatility_forecast.v1") {
          volatilityForecast = changes.volatilityForecastV1.newValue;
        }
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
