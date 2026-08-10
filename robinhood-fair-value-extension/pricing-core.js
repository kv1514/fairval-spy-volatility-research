(function fairValPricingCore(root) {
  "use strict";

  const MIN_TIME = 1 / (365 * 24 * 60);
  const STYLE_MAP = {
    SPX: { style: "european", instrumentType: "index" },
    SPXW: { style: "european", instrumentType: "index" },
    XSP: { style: "european", instrumentType: "index" },
    SPY: { style: "american", instrumentType: "etf" },
    QQQ: { style: "american", instrumentType: "etf" },
    IWM: { style: "american", instrumentType: "etf" },
  };

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

  const normalPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  function validate(input) {
    const clean = {
      spot: Number(input.spot), strike: Number(input.strike), days: Number(input.days),
      volatility: Number(input.volatility), rate: Number(input.rate || 0), dividend: Number(input.dividend || 0),
      optionType: String(input.optionType || "call").toLowerCase(),
      exerciseStyle: String(input.exerciseStyle || "european").toLowerCase(),
    };
    if (![clean.spot, clean.strike, clean.days, clean.volatility, clean.rate, clean.dividend].every(Number.isFinite)) {
      throw new Error("pricing inputs must be finite");
    }
    if (clean.spot <= 0 || clean.strike <= 0 || clean.days < 0 || clean.volatility <= 0) {
      throw new Error("spot, strike and volatility must be positive; DTE cannot be negative");
    }
    if (!["call", "put"].includes(clean.optionType)) throw new Error("optionType must be call or put");
    return clean;
  }

  function intrinsic(input, spot = Number(input.spot)) {
    return String(input.optionType).toLowerCase() === "put"
      ? Math.max(Number(input.strike) - spot, 0)
      : Math.max(spot - Number(input.strike), 0);
  }

  function blackScholes(input, dividendAdjusted = true) {
    const x = validate(input);
    const T = Math.max(x.days / 365, MIN_TIME);
    const sigma = x.volatility / 100;
    const r = x.rate / 100;
    const q = dividendAdjusted ? x.dividend / 100 : 0;
    const sqrtT = Math.sqrt(T);
    const discountR = Math.exp(-r * T);
    const discountQ = Math.exp(-q * T);
    const d1 = (Math.log(x.spot / x.strike) + (r - q + sigma * sigma / 2) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const call = Math.max(x.spot * discountQ * normalCdf(d1) - x.strike * discountR * normalCdf(d2), 0);
    const put = Math.max(x.strike * discountR * normalCdf(-d2) - x.spot * discountQ * normalCdf(-d1), 0);
    const density = normalPdf(d1);
    const thetaCommon = -(x.spot * discountQ * density * sigma) / (2 * sqrtT);
    return {
      price: x.optionType === "put" ? put : call,
      call,
      put,
      delta: x.optionType === "put" ? -discountQ * normalCdf(-d1) : discountQ * normalCdf(d1),
      gamma: discountQ * density / (x.spot * sigma * sqrtT),
      theta: x.optionType === "put"
        ? (thetaCommon + r * x.strike * discountR * normalCdf(-d2) - q * x.spot * discountQ * normalCdf(-d1)) / 365
        : (thetaCommon - r * x.strike * discountR * normalCdf(d2) + q * x.spot * discountQ * normalCdf(d1)) / 365,
      vega: x.spot * discountQ * density * sqrtT / 100,
      rho: x.optionType === "put"
        ? -x.strike * T * discountR * normalCdf(-d2) / 100
        : x.strike * T * discountR * normalCdf(d2) / 100,
      model: dividendAdjusted ? "black_scholes_dividend_adjusted" : "black_scholes_european",
    };
  }

  function crr(input, { steps = 100, american = true, details = false } = {}) {
    const x = validate(input);
    if (!Number.isInteger(steps) || steps < 2) throw new Error("CRR steps must be an integer >= 2");
    const T = Math.max(x.days / 365, MIN_TIME);
    const dt = T / steps;
    const sigma = x.volatility / 100;
    const r = x.rate / 100;
    const q = x.dividend / 100;
    const u = Math.exp(sigma * Math.sqrt(dt));
    const d = 1 / u;
    const probability = (Math.exp((r - q) * dt) - d) / (u - d);
    if (!(probability >= 0 && probability <= 1)) throw new Error(`invalid CRR probability ${probability.toFixed(6)}`);
    const discount = Math.exp(-r * dt);
    let values = Array.from({ length: steps + 1 }, (_, index) => {
      const stock = x.spot * u ** index * d ** (steps - index);
      return intrinsic(x, stock);
    });
    let layerOne = null;
    let layerTwo = null;
    const boundary = [];
    for (let step = steps - 1; step >= 0; step -= 1) {
      const next = new Array(step + 1);
      const stocks = new Array(step + 1);
      const exerciseSpots = [];
      for (let index = 0; index <= step; index += 1) {
        const stock = x.spot * u ** index * d ** (step - index);
        stocks[index] = stock;
        const continuation = discount * ((1 - probability) * values[index] + probability * values[index + 1]);
        const exercise = intrinsic(x, stock);
        next[index] = american ? Math.max(continuation, exercise) : continuation;
        if (details && american && exercise > continuation + 1e-12 && exercise > 0) exerciseSpots.push(stock);
      }
      values = next;
      if (details && exerciseSpots.length) boundary.push({
        timeStep: step,
        daysRemaining: x.days * (steps - step) / steps,
        spotBoundary: x.optionType === "call" ? Math.min(...exerciseSpots) : Math.max(...exerciseSpots),
      });
      if (step === 2) layerTwo = { stocks, values: [...values] };
      if (step === 1) layerOne = { stocks, values: [...values] };
    }
    const price = Math.max(values[0], american ? intrinsic(x) : 0);
    let greeks = null;
    if (details && layerOne && layerTwo) {
      const delta = (layerOne.values[1] - layerOne.values[0]) / (layerOne.stocks[1] - layerOne.stocks[0]);
      const deltaDown = (layerTwo.values[1] - layerTwo.values[0]) / (layerTwo.stocks[1] - layerTwo.stocks[0]);
      const deltaUp = (layerTwo.values[2] - layerTwo.values[1]) / (layerTwo.stocks[2] - layerTwo.stocks[1]);
      greeks = {
        delta,
        gamma: (deltaUp - deltaDown) / ((layerTwo.stocks[2] - layerTwo.stocks[0]) / 2),
        theta: (layerTwo.values[1] - price) / (2 * dt * 365),
      };
    }
    return { price, greeks, boundary: boundary.reverse(), steps, model: american ? "binomial_american_crr" : "binomial_european_crr" };
  }

  function trinomial(input, { steps = 100, american = true, details = false } = {}) {
    const x = validate(input);
    if (!Number.isInteger(steps) || steps < 2) throw new Error("trinomial steps must be an integer >= 2");
    const T = Math.max(x.days / 365, MIN_TIME);
    const dt = T / steps;
    const sigma = x.volatility / 100;
    const r = x.rate / 100;
    const q = x.dividend / 100;
    const halfVol = sigma * Math.sqrt(dt / 2);
    const denominator = Math.exp(halfVol) - Math.exp(-halfVol);
    const drift = Math.exp((r - q) * dt / 2);
    const pu = ((drift - Math.exp(-halfVol)) / denominator) ** 2;
    const pd = ((Math.exp(halfVol) - drift) / denominator) ** 2;
    const pm = 1 - pu - pd;
    if (Math.min(pu, pm, pd) < -1e-12 || Math.max(pu, pm, pd) > 1 + 1e-12) throw new Error("invalid trinomial probabilities");
    const discount = Math.exp(-r * dt);
    const u = Math.exp(sigma * Math.sqrt(2 * dt));
    let values = Array.from({ length: 2 * steps + 1 }, (_, index) => intrinsic(x, x.spot * u ** (index - steps)));
    let layerOne = null;
    const boundary = [];
    for (let step = steps - 1; step >= 0; step -= 1) {
      const next = new Array(2 * step + 1);
      const stocks = new Array(2 * step + 1);
      const exerciseSpots = [];
      for (let index = 0; index < next.length; index += 1) {
        const stock = x.spot * u ** (index - step);
        stocks[index] = stock;
        const continuation = discount * (pd * values[index] + pm * values[index + 1] + pu * values[index + 2]);
        const exercise = intrinsic(x, stock);
        next[index] = american ? Math.max(continuation, exercise) : continuation;
        if (details && american && exercise > continuation + 1e-12 && exercise > 0) exerciseSpots.push(stock);
      }
      values = next;
      if (details && exerciseSpots.length) boundary.push({
        timeStep: step,
        daysRemaining: x.days * (steps - step) / steps,
        spotBoundary: x.optionType === "call" ? Math.min(...exerciseSpots) : Math.max(...exerciseSpots),
      });
      if (step === 1) layerOne = { stocks, values: [...values] };
    }
    const price = Math.max(values[0], american ? intrinsic(x) : 0);
    let greeks = null;
    if (details && layerOne) {
      const deltaDown = (layerOne.values[1] - layerOne.values[0]) / (layerOne.stocks[1] - layerOne.stocks[0]);
      const deltaUp = (layerOne.values[2] - layerOne.values[1]) / (layerOne.stocks[2] - layerOne.stocks[1]);
      greeks = {
        delta: (layerOne.values[2] - layerOne.values[0]) / (layerOne.stocks[2] - layerOne.stocks[0]),
        gamma: (deltaUp - deltaDown) / ((layerOne.stocks[2] - layerOne.stocks[0]) / 2),
        theta: (layerOne.values[1] - price) / (dt * 365),
      };
    }
    return { price, greeks, boundary: boundary.reverse(), steps, model: american ? "trinomial_american" : "trinomial_european" };
  }

  function baw(input) {
    const x = validate(input);
    const T = Math.max(x.days / 365, MIN_TIME);
    const sigma = x.volatility / 100;
    const r = x.rate / 100;
    const q = x.dividend / 100;
    if (x.optionType === "call" && q <= 0) return { price: blackScholes(x, true).price, model: "american_approximation_baw" };
    if (r <= 0) throw new Error("BAW requires a positive rate; use a tree model");
    const b = r - q;
    const sigma2 = sigma * sigma;
    const kappa = 1 - Math.exp(-r * T);
    const m = 2 * r / sigma2;
    const n = 2 * b / sigma2;
    const squareRoot = Math.sqrt((n - 1) ** 2 + 4 * m / kappa);
    const qPower = x.optionType === "call" ? (-(n - 1) + squareRoot) / 2 : (-(n - 1) - squareRoot) / 2;
    const discountQ = Math.exp(-q * T);
    const d1 = (spot) => (Math.log(spot / x.strike) + (b + sigma2 / 2) * T) / (sigma * Math.sqrt(T));
    const coefficient = (spot) => x.optionType === "call"
      ? (spot / qPower) * (1 - discountQ * normalCdf(d1(spot)))
      : -(spot / qPower) * (1 - discountQ * normalCdf(-d1(spot)));
    const equation = (spot) => {
      const european = blackScholes({ ...x, spot }, true).price;
      return x.optionType === "call"
        ? spot - x.strike - european - coefficient(spot)
        : x.strike - spot - european - coefficient(spot);
    };
    let low = x.optionType === "call" ? x.strike : Math.max(x.strike * 1e-8, 1e-10);
    let high = x.optionType === "call" ? Math.max(x.strike * 2, x.spot * 2) : x.strike;
    let fLow = equation(low);
    let fHigh = equation(high);
    for (let iteration = 0; iteration < 60 && fLow * fHigh > 0 && x.optionType === "call"; iteration += 1) {
      high *= 2;
      fHigh = equation(high);
    }
    if (fLow * fHigh > 0) throw new Error("BAW exercise boundary could not be bracketed");
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const middle = (low + high) / 2;
      const fMiddle = equation(middle);
      if (Math.abs(fMiddle) < 1e-10) { low = middle; high = middle; break; }
      if (fLow * fMiddle <= 0) { high = middle; fHigh = fMiddle; } else { low = middle; fLow = fMiddle; }
    }
    const boundary = (low + high) / 2;
    if ((x.optionType === "call" && x.spot >= boundary) || (x.optionType === "put" && x.spot <= boundary)) {
      return { price: intrinsic(x), boundary, model: "american_approximation_baw" };
    }
    return {
      price: Math.max(blackScholes(x, true).price + coefficient(boundary) * (x.spot / boundary) ** qPower, intrinsic(x)),
      boundary,
      model: "american_approximation_baw",
    };
  }

  function modelPrice(model, input) {
    if (typeof model === "function") return Number(model(input));
    if (model && typeof model.price === "function") return Number(model.price(input));
    throw new Error("pricing model must expose price(inputs)");
  }

  function impliedVolatility(targetPrice, pricingModel, input, options = {}) {
    const target = Number(targetPrice);
    const lower = Number(options.lower || 0.01);
    const upper = Number(options.upper || 500);
    const tolerance = Number(options.tolerance || 1e-8);
    if (!Number.isFinite(target) || target < 0) return { volatility: null, converged: false, status: "invalid_target", reason: "target must be finite and nonnegative", iterations: 0 };
    let clean;
    try { clean = validate(input); } catch (error) {
      return { volatility: null, converged: false, status: "invalid_inputs", reason: error.message, iterations: 0 };
    }
    const american = pricingModel?.exerciseStyle === "american" || clean.exerciseStyle === "american";
    if (american && target < intrinsic(clean) - tolerance) {
      return { volatility: null, converged: false, status: "below_lower_bound", reason: "target is below American intrinsic value", iterations: 0 };
    }
    if (american && intrinsic(clean) > 0 && Math.abs(target - intrinsic(clean)) <= tolerance) {
      return { volatility: null, converged: false, status: "intrinsic_boundary", reason: "target equals intrinsic value; IV is not uniquely identifiable", iterations: 0 };
    }
    const points = [];
    let lastError = null;
    for (let index = 0; index < 72; index += 1) {
      const volatility = lower * (upper / lower) ** (index / 71);
      try {
        const price = modelPrice(pricingModel, { ...clean, volatility });
        if (Number.isFinite(price)) points.push([volatility, price]);
      } catch (error) { lastError = error.message; }
    }
    let bracket = null;
    for (let index = 0; index < points.length - 1; index += 1) {
      if (points[index][1] - tolerance <= target && target <= points[index + 1][1] + tolerance) {
        bracket = [points[index], points[index + 1]];
        break;
      }
    }
    if (!bracket) return { volatility: null, converged: false, status: "unbracketed", reason: lastError || "target outside model volatility grid", iterations: 0 };
    let [low, lowPrice] = bracket[0];
    let [high] = bracket[1];
    let middle = low;
    let price = lowPrice;
    for (let iteration = 1; iteration <= 100; iteration += 1) {
      middle = (low + high) / 2;
      try { price = modelPrice(pricingModel, { ...clean, volatility: middle }); }
      catch (error) { return { volatility: null, converged: false, status: "pricing_error", reason: error.message, iterations: iteration }; }
      const residual = price - target;
      if (Math.abs(residual) <= tolerance || high - low <= 1e-8) {
        return { volatility: middle, converged: true, status: "converged", reason: null, iterations: iteration, residual };
      }
      if (residual < 0) low = middle; else high = middle;
    }
    return { volatility: middle, converged: false, status: "max_iterations", reason: "solver iteration limit", iterations: 100, residual: price - target };
  }

  const blackScholesModel = (dividendAdjusted = true) => ({
    name: dividendAdjusted ? "black_scholes_dividend_adjusted" : "black_scholes_european",
    exerciseStyle: "european",
    price: (input) => blackScholes(input, dividendAdjusted).price,
    greeks: (input) => blackScholes(input, dividendAdjusted),
  });
  const crrModel = (steps = 100, american = true) => ({
    name: american ? "binomial_american_crr" : "binomial_european_crr",
    exerciseStyle: american ? "american" : "european",
    price: (input) => crr(input, { steps, american }).price,
    greeks: (input) => crr(input, { steps, american, details: true }).greeks,
  });
  const trinomialModel = (steps = 100, american = true) => ({
    name: american ? "trinomial_american" : "trinomial_european",
    exerciseStyle: american ? "american" : "european",
    price: (input) => trinomial(input, { steps, american }).price,
    greeks: (input) => trinomial(input, { steps, american, details: true }).greeks,
  });

  function resolveStyle(ticker, explicitStyle = null, instrumentType = null, customMap = {}) {
    const explicit = String(explicitStyle || "").toLowerCase();
    if (["american", "european"].includes(explicit)) return { style: explicit, instrumentType: instrumentType || "unknown", verified: true, warning: null };
    const symbol = String(ticker || "").toUpperCase();
    const mapped = { ...STYLE_MAP, ...customMap }[symbol];
    if (mapped) return { ...mapped, verified: false, warning: `option style inferred from configurable ticker map for ${symbol}` };
    // Robinhood's stock-option route is sufficient context to infer the usual
    // U.S. equity exercise convention, but it is still labeled as inferred.
    return { style: "american", instrumentType: instrumentType || "equity", verified: false, warning: "American style inferred from Robinhood equity option context" };
  }

  function compareModels(input) {
    const {
      ticker, marketMid, marketIv, forecastVolatility, treeSteps = 75,
      optionStyle = null, instrumentType = null, calculateIv = false,
    } = input;
    const style = resolveStyle(ticker, optionStyle, instrumentType, input.styleMap || {});
    const marketInput = { ...input, volatility: marketIv, exerciseStyle: style.style };
    const forecastInput = { ...input, volatility: forecastVolatility, exerciseStyle: style.style };
    const bsMarket = blackScholes(marketInput, true);
    const bsForecast = blackScholes(forecastInput, true);
    const bsIv = calculateIv
      ? impliedVolatility(marketMid, blackScholesModel(true), marketInput)
      : { volatility: null, converged: false, status: "not_requested" };
    const warnings = style.warning ? [style.warning] : [];
    let binomialMarket = null;
    let binomialForecast = null;
    let trinomialForecast = null;
    let approximationForecast = null;
    let americanIv = { volatility: null, converged: false, status: "not_applicable" };
    let americanGreeks = null;
    let modelUsed = "black_scholes_dividend_adjusted";
    let modelReason = style.style === "european"
      ? "European-style index option"
      : "Black-Scholes selected because American early-exercise premium was negligible";
    let selectedFairValue = bsForecast.price;
    let earlyExercisePremium = 0;
    let sameTreeExercisePremium = 0;
    let treeDifference = null;
    if (style.style === "american") {
      try {
        const binMarketResult = crr(marketInput, { steps: treeSteps, american: true, details: true });
        const binForecastResult = crr(forecastInput, { steps: treeSteps, american: true });
        const triForecastResult = trinomial(forecastInput, { steps: treeSteps, american: true });
        binomialMarket = binMarketResult.price;
        binomialForecast = binForecastResult.price;
        trinomialForecast = triForecastResult.price;
        americanGreeks = binMarketResult.greeks;
        treeDifference = Math.abs(binomialForecast - trinomialForecast);
        earlyExercisePremium = Math.max(binomialForecast - bsForecast.price, 0);
        sameTreeExercisePremium = Math.max(
          binomialForecast - crr(forecastInput, { steps: treeSteps, american: false }).price,
          0,
        );
        try { approximationForecast = baw(forecastInput).price; }
        catch (error) { warnings.push(`BAW unavailable: ${error.message}`); }
        if (calculateIv) americanIv = impliedVolatility(marketMid, crrModel(treeSteps, true), marketInput);
        const poorAgreement = treeDifference > Math.max(0.02, 0.005 * Math.max(binomialForecast, 1));
        if (poorAgreement) {
          warnings.push(`tree convergence warning: CRR/trinomial differ by $${treeDifference.toFixed(3)}`);
          modelReason = "Black-Scholes fallback because American tree agreement was poor";
        } else if (sameTreeExercisePremium >= 0.01) {
          modelUsed = "binomial_american_crr";
          selectedFairValue = binomialForecast;
          modelReason = "American CRR selected because same-lattice early-exercise premium was material";
          warnings.push("early exercise premium is material");
        }
        if (calculateIv && modelUsed === "binomial_american_crr" && !americanIv.converged) {
          modelUsed = "black_scholes_dividend_adjusted";
          selectedFairValue = bsForecast.price;
          modelReason = "Black-Scholes fallback because American IV solver failed";
          warnings.push(`American IV solver failed: ${americanIv.reason || americanIv.status}`);
        }
      } catch (error) {
        modelReason = "Black-Scholes fallback because American pricing failed";
        warnings.push(`American pricing failed: ${error.message}`);
      }
      if (input.optionType === "put" && Number(input.strike) / Number(input.spot) >= 1.1) warnings.push("deep ITM put; early exercise may be relevant");
      if (input.optionType === "call" && Number(input.dividend) > 0) warnings.push("continuous dividend yield used; no discrete dividend schedule supplied");
    }
    const priceEdgeBs = bsForecast.price - Number(marketMid);
    const priceEdgeAmerican = (binomialForecast ?? bsForecast.price) - Number(marketMid);
    return {
      style: style.style,
      styleVerified: style.verified,
      bsMarketIvFairValue: bsMarket.price,
      bsForecastFairValue: bsForecast.price,
      americanMarketIvFairValue: binomialMarket,
      americanForecastFairValue: binomialForecast,
      trinomialForecastFairValue: trinomialForecast,
      approximationForecastFairValue: approximationForecast,
      selectedFairValue,
      priceEdgeBs,
      priceEdgeAmerican,
      earlyExercisePremium,
      sameTreeExercisePremium,
      treeDifference,
      blackScholesIv: bsIv.volatility,
      americanIv: americanIv.volatility,
      ivSolverStatus: modelUsed === "binomial_american_crr" ? americanIv.status : bsIv.status,
      modelUsed,
      modelReason,
      pricingWarning: [...new Set(warnings)].join("; "),
      blackScholesGreeks: bsMarket,
      americanGreeks,
    };
  }

  function convergenceReport(kind, input, stepCounts = [50, 100, 250, 500, 1000], tolerance = 0.0025) {
    let previous = null;
    return stepCounts.map((steps) => {
      const started = typeof performance !== "undefined" ? performance.now() : Date.now();
      try {
        const result = kind === "trinomial"
          ? trinomial(input, { steps, american: input.exerciseStyle === "american" })
          : crr(input, { steps, american: input.exerciseStyle === "american" });
        const runtimeMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
        const differenceFromPrevious = previous == null ? null : result.price - previous;
        previous = result.price;
        return { steps, price: result.price, differenceFromPrevious, runtimeMs, stabilized: differenceFromPrevious != null && Math.abs(differenceFromPrevious) <= tolerance };
      } catch (error) {
        return { steps, price: null, differenceFromPrevious: null, runtimeMs: null, stabilized: false, warning: error.message };
      }
    });
  }

  root.FairValPricing = {
    STYLE_MAP,
    blackScholes,
    blackScholesModel,
    crr,
    crrModel,
    trinomial,
    trinomialModel,
    baw,
    impliedVolatility,
    resolveStyle,
    compareModels,
    convergenceReport,
  };
})(globalThis);
