export type OptionType = "call" | "put";

export type ModelInputs = {
  spot: number;
  strike: number;
  days: number;
  volatility: number;
  rate: number;
  dividend: number;
  discreteDividends?: Array<{ days: number; amount: number }>;
};

export type ExerciseStyle = "european" | "american";
export type PricingInputs = ModelInputs & { optionType: OptionType; exerciseStyle?: ExerciseStyle };
export type GenericPricingModel = {
  name: string;
  exerciseStyle: ExerciseStyle;
  price: (inputs: PricingInputs) => number;
};
export type ImpliedVolatilityResult = {
  volatility: number | null;
  converged: boolean;
  status: string;
  reason: string | null;
  iterations: number;
};

const normalPdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

function normalCdf(x: number) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const absolute = Math.abs(x);
  if (absolute > 37) return x > 0 ? 1 : 0;
  const exponential = Math.exp((-absolute * absolute) / 2);
  let tail: number;
  if (absolute < 7.07106781186547) {
    let numerator = 3.52624965998911e-2 * absolute + 0.700383064443688;
    numerator = numerator * absolute + 6.37396220353165;
    numerator = numerator * absolute + 33.912866078383;
    numerator = numerator * absolute + 112.079291497871;
    numerator = numerator * absolute + 221.213596169931;
    numerator = numerator * absolute + 220.206867912376;
    let denominator = 8.83883476483184e-2 * absolute + 1.75566716318264;
    denominator = denominator * absolute + 16.064177579207;
    denominator = denominator * absolute + 86.7807322029461;
    denominator = denominator * absolute + 296.564248779674;
    denominator = denominator * absolute + 637.333633378831;
    denominator = denominator * absolute + 793.826512519948;
    denominator = denominator * absolute + 440.413735824752;
    tail = (exponential * numerator) / denominator;
  } else {
    let build = absolute + 0.65;
    build = absolute + 4 / build;
    build = absolute + 3 / build;
    build = absolute + 2 / build;
    build = absolute + 1 / build;
    tail = exponential / build / 2.506628274631;
  }
  return x > 0 ? 1 - tail : tail;
}

export function calculateBlackScholes(input: ModelInputs) {
  const S = Math.max(input.spot, 0.0001);
  const K = Math.max(input.strike, 0.0001);
  const T = Math.max(input.days / 365, 1 / (365 * 24));
  const sigma = Math.max(input.volatility / 100, 0.0001);
  const r = input.rate / 100;
  const q = input.dividend / 100;
  const cashDividendPv = presentValueOfCashDividends({ ...input, optionType: "call" });
  const pricingSpot = S - cashDividendPv;
  if (pricingSpot <= 0) throw new Error("Cash-dividend present value must be below spot.");
  const sqrtT = Math.sqrt(T);
  const discountR = Math.exp(-r * T);
  const discountQ = Math.exp(-q * T);
  const d1 = (Math.log(pricingSpot / K) + (r - q + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nD1 = normalCdf(d1);
  const nD2 = normalCdf(d2);
  const pdfD1 = normalPdf(d1);

  const call = Math.max(pricingSpot * discountQ * nD1 - K * discountR * nD2, 0);
  const put = Math.max(K * discountR * normalCdf(-d2) - pricingSpot * discountQ * normalCdf(-d1), 0);
  const gamma = (discountQ * pdfD1) / (pricingSpot * sigma * sqrtT);
  const vega = (pricingSpot * discountQ * pdfD1 * sqrtT) / 100;

  return {
    call,
    put,
    callDelta: discountQ * nD1,
    putDelta: discountQ * (nD1 - 1),
    gamma,
    vega,
    callTheta:
      (-(pricingSpot * discountQ * pdfD1 * sigma) / (2 * sqrtT) -
        r * K * discountR * nD2 +
        q * pricingSpot * discountQ * nD1) /
      365,
    putTheta:
      (-(pricingSpot * discountQ * pdfD1 * sigma) / (2 * sqrtT) +
        r * K * discountR * normalCdf(-d2) -
        q * pricingSpot * discountQ * normalCdf(-d1)) /
      365,
    callRho: (K * T * discountR * nD2) / 100,
    putRho: (-K * T * discountR * normalCdf(-d2)) / 100,
    callProbability: nD2,
    putProbability: normalCdf(-d2),
    dividendModel: cashDividendsBeforeExpiry({ ...input, optionType: "call" }).length
      ? "escrowed_cash_dividend_adjustment"
      : "continuous_dividend_yield",
    cashDividendPresentValue: cashDividendPv,
  };
}

export function valueForType(result: ReturnType<typeof calculateBlackScholes>, type: OptionType) {
  return type === "call" ? result.call : result.put;
}

function validatePricingInputs(input: PricingInputs) {
  if (![input.spot, input.strike, input.days, input.volatility, input.rate, input.dividend].every(Number.isFinite)) {
    throw new Error("Pricing inputs must be finite.");
  }
  if (input.spot <= 0 || input.strike <= 0 || input.days < 0 || input.volatility <= 0) {
    throw new Error("Spot, strike and volatility must be positive; DTE cannot be negative.");
  }
}

function intrinsic(input: PricingInputs, spot = input.spot) {
  return input.optionType === "call" ? Math.max(spot - input.strike, 0) : Math.max(input.strike - spot, 0);
}

function cashDividendsBeforeExpiry(input: PricingInputs) {
  return (input.discreteDividends || [])
    .map((item) => ({ days: Number(item.days), amount: Number(item.amount) }))
    .filter((item) => Number.isFinite(item.days) && Number.isFinite(item.amount) && item.days > 0 && item.amount > 0 && item.days <= input.days + 1e-12)
    .sort((left, right) => left.days - right.days);
}

function presentValueOfCashDividends(input: PricingInputs, elapsedYears = 0) {
  const rate = input.rate / 100;
  return cashDividendsBeforeExpiry(input)
    .filter((item) => item.days / 365 > elapsedYears + 1e-12)
    .reduce((total, item) => total + item.amount * Math.exp(-rate * (item.days / 365 - elapsedYears)), 0);
}

export function createBlackScholesModel(dividendAdjusted = true): GenericPricingModel {
  return {
    name: dividendAdjusted ? "black_scholes_dividend_adjusted" : "black_scholes_european",
    exerciseStyle: "european",
    price: (input) => valueForType(calculateBlackScholes({
      ...input,
      dividend: dividendAdjusted ? input.dividend : 0,
    }), input.optionType),
  };
}

export function calculateCrr(
  input: PricingInputs,
  steps = 100,
  american = true,
) {
  validatePricingInputs(input);
  if (!Number.isInteger(steps) || steps < 2) throw new Error("CRR steps must be an integer of at least 2.");
  const time = Math.max(input.days / 365, 1 / (365 * 24 * 60));
  const dt = time / steps;
  const sigma = input.volatility / 100;
  const rate = input.rate / 100;
  const dividend = input.dividend / 100;
  const cashDividendPv = presentValueOfCashDividends(input);
  const latticeSpot = input.spot - cashDividendPv;
  if (latticeSpot <= 0) throw new Error("Cash-dividend present value must be below spot.");
  const remainingCash = Array.from({ length: steps + 1 }, (_, step) =>
    presentValueOfCashDividends(input, step * dt));
  const up = Math.exp(sigma * Math.sqrt(dt));
  const down = 1 / up;
  const probability = (Math.exp((rate - dividend) * dt) - down) / (up - down);
  if (!(probability >= 0 && probability <= 1)) throw new Error("CRR risk-neutral probability is invalid for these inputs.");
  const discount = Math.exp(-rate * dt);
  const stockRatio = up / down;
  let terminalStock = latticeSpot * down ** steps;
  let values = new Array<number>(steps + 1);
  for (let index = 0; index <= steps; index += 1) {
    values[index] = intrinsic(input, terminalStock + remainingCash[steps]);
    terminalStock *= stockRatio;
  }
  let firstLayer: { stocks: number[]; values: number[] } | null = null;
  let secondLayer: { stocks: number[]; values: number[] } | null = null;
  for (let step = steps - 1; step >= 0; step -= 1) {
    const stocks = new Array<number>(step + 1);
    let stock = latticeSpot * down ** step;
    for (let index = 0; index <= step; index += 1) {
      stocks[index] = stock + remainingCash[step];
      stock *= stockRatio;
    }
    values = stocks.map((nodeStock, index) => {
      const continuation = discount * ((1 - probability) * values[index] + probability * values[index + 1]);
      return american ? Math.max(continuation, intrinsic(input, nodeStock)) : continuation;
    });
    if (step === 2) secondLayer = { stocks, values: [...values] };
    if (step === 1) firstLayer = { stocks, values: [...values] };
  }
  const price = Math.max(values[0], american ? intrinsic(input) : 0);
  let delta: number | null = null;
  let gamma: number | null = null;
  let theta: number | null = null;
  if (firstLayer && secondLayer) {
    delta = (firstLayer.values[1] - firstLayer.values[0]) / (firstLayer.stocks[1] - firstLayer.stocks[0]);
    const deltaDown = (secondLayer.values[1] - secondLayer.values[0]) / (secondLayer.stocks[1] - secondLayer.stocks[0]);
    const deltaUp = (secondLayer.values[2] - secondLayer.values[1]) / (secondLayer.stocks[2] - secondLayer.stocks[1]);
    gamma = (deltaUp - deltaDown) / ((secondLayer.stocks[2] - secondLayer.stocks[0]) / 2);
    theta = (secondLayer.values[1] - price) / (2 * dt * 365);
  }
  return { price, delta, gamma, theta, steps, model: american ? "binomial_american_crr" : "binomial_european_crr" };
}

export function calculateSmoothedCrr(
  input: PricingInputs,
  steps: number,
  american = true,
) {
  const primary = calculateCrr(input, steps, american);
  const adjacent = calculateCrr(input, steps + 1, american);
  return {
    ...primary,
    price: (primary.price + adjacent.price) / 2,
    rawPrice: primary.price,
    adjacentPrice: adjacent.price,
    smoothing: "adjacent_step_average" as const,
  };
}

export function calculateAdaptiveCrr(
  input: PricingInputs,
  {
    minSteps = 50,
    maxSteps = 400,
    tolerance = 0.0025,
    american = true,
  }: { minSteps?: number; maxSteps?: number; tolerance?: number; american?: boolean } = {},
) {
  const cleanMin = Math.max(2, Math.floor(Number(minSteps) || 50));
  const cleanMax = Math.max(cleanMin, Math.floor(Number(maxSteps) || 400));
  const cleanTolerance = Math.max(1e-8, Number(tolerance) || 0.0025);
  const schedule: number[] = [];
  for (let steps = cleanMin; steps < cleanMax; steps *= 2) schedule.push(steps);
  if (!schedule.length || schedule.at(-1) !== cleanMax) schedule.push(cleanMax);
  const history: Array<{
    steps: number;
    adjacentSteps: number;
    price: number;
    rawPrice: number;
    adjacentPrice: number;
    differenceFromPrevious: number | null;
    errorEstimate: number | null;
  }> = [];
  let previousPrice: number | null = null;
  let selected: ReturnType<typeof calculateSmoothedCrr> | null = null;
  let converged = false;
  for (const steps of schedule) {
    const result = calculateSmoothedCrr(input, steps, american);
    const differenceFromPrevious = previousPrice == null ? null : result.price - previousPrice;
    const errorEstimate = differenceFromPrevious == null ? null : Math.abs(differenceFromPrevious);
    history.push({
      steps,
      adjacentSteps: steps + 1,
      price: result.price,
      rawPrice: result.rawPrice,
      adjacentPrice: result.adjacentPrice,
      differenceFromPrevious,
      errorEstimate,
    });
    selected = result;
    if (history.length >= 3 && errorEstimate != null && errorEstimate <= cleanTolerance) {
      converged = true;
      break;
    }
    previousPrice = result.price;
  }
  if (!selected) throw new Error("Adaptive CRR produced no lattice result.");
  return {
    ...selected,
    converged,
    status: converged ? "converged" : "max_steps_reached",
    tolerance: cleanTolerance,
    maxSteps: cleanMax,
    errorEstimate: history.at(-1)?.errorEstimate ?? null,
    history,
    method: "adaptive_crr_step_doubling_adjacent_smoothed" as const,
  };
}

export function calculateTrinomial(input: PricingInputs, steps = 100, american = true) {
  validatePricingInputs(input);
  if (!Number.isInteger(steps) || steps < 2) throw new Error("Trinomial steps must be an integer of at least 2.");
  const time = Math.max(input.days / 365, 1 / (365 * 24 * 60));
  const dt = time / steps;
  const sigma = input.volatility / 100;
  const rate = input.rate / 100;
  const dividend = input.dividend / 100;
  const cashDividendPv = presentValueOfCashDividends(input);
  const latticeSpot = input.spot - cashDividendPv;
  if (latticeSpot <= 0) throw new Error("Cash-dividend present value must be below spot.");
  const remainingCash = Array.from({ length: steps + 1 }, (_, step) =>
    presentValueOfCashDividends(input, step * dt));
  const halfVol = sigma * Math.sqrt(dt / 2);
  const denominator = Math.exp(halfVol) - Math.exp(-halfVol);
  const drift = Math.exp((rate - dividend) * dt / 2);
  const upProbability = ((drift - Math.exp(-halfVol)) / denominator) ** 2;
  const downProbability = ((Math.exp(halfVol) - drift) / denominator) ** 2;
  const middleProbability = 1 - upProbability - downProbability;
  if (Math.min(upProbability, middleProbability, downProbability) < -1e-12) throw new Error("Trinomial probabilities are invalid for these inputs.");
  const discount = Math.exp(-rate * dt);
  const up = Math.exp(sigma * Math.sqrt(2 * dt));
  let terminalStock = latticeSpot * up ** (-steps);
  let values = new Array<number>(2 * steps + 1);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = intrinsic(input, terminalStock + remainingCash[steps]);
    terminalStock *= up;
  }
  for (let step = steps - 1; step >= 0; step -= 1) {
    let stock = latticeSpot * up ** (-step);
    values = Array.from({ length: 2 * step + 1 }, (_, index) => {
      const nodeStock = stock + remainingCash[step];
      stock *= up;
      const continuation = discount * (
        downProbability * values[index] + middleProbability * values[index + 1] + upProbability * values[index + 2]
      );
      return american ? Math.max(continuation, intrinsic(input, nodeStock)) : continuation;
    });
  }
  return { price: Math.max(values[0], american ? intrinsic(input) : 0), steps, model: american ? "trinomial_american" : "trinomial_european" };
}

export function createCrrModel(steps = 100, american = true): GenericPricingModel {
  return {
    name: american ? "binomial_american_crr" : "binomial_european_crr",
    exerciseStyle: american ? "american" : "european",
    price: (input) => calculateCrr(input, steps, american).price,
  };
}

export function impliedVolatility(
  targetPrice: number,
  pricingModel: GenericPricingModel,
  input: PricingInputs,
  options: { lower?: number; upper?: number; tolerance?: number; maxIterations?: number; initialGuess?: number } = {},
): ImpliedVolatilityResult {
  const lower = options.lower ?? 0.01;
  const upper = options.upper ?? 500;
  const tolerance = options.tolerance ?? 1e-8;
  const maxIterations = Math.max(10, Math.floor(options.maxIterations ?? 60));
  if (!Number.isFinite(targetPrice) || targetPrice < 0) {
    return { volatility: null, converged: false, status: "invalid_target", reason: "Target price is invalid.", iterations: 0 };
  }
  try { validatePricingInputs(input); } catch (error) {
    return { volatility: null, converged: false, status: "invalid_inputs", reason: error instanceof Error ? error.message : "Invalid inputs.", iterations: 0 };
  }
  if (pricingModel.exerciseStyle === "american" && targetPrice < intrinsic(input) - 1e-8) {
    return { volatility: null, converged: false, status: "below_lower_bound", reason: "Target is below American intrinsic value.", iterations: 0 };
  }
  if (pricingModel.exerciseStyle === "american" && intrinsic(input) > 0 && Math.abs(targetPrice - intrinsic(input)) <= 1e-8) {
    return { volatility: null, converged: false, status: "intrinsic_boundary", reason: "Target equals intrinsic value, so IV is not uniquely identifiable.", iterations: 0 };
  }
  const evaluate = (volatility: number) => {
    try {
      const price = pricingModel.price({ ...input, volatility });
      return Number.isFinite(price) ? price : null;
    } catch { return null; }
  };
  const seed = Math.min(Math.max(options.initialGuess ?? input.volatility, lower), upper);
  const seedPrice = evaluate(seed);
  if (seedPrice != null && Math.abs(seedPrice - targetPrice) <= tolerance) {
    return { volatility: seed, converged: true, status: "converged", reason: null, iterations: 0 };
  }
  let bracket: [[number, number], [number, number]] | null = null;
  if (seedPrice != null && seedPrice < targetPrice) {
    let lowPoint: [number, number] = [seed, seedPrice];
    let volatility = seed;
    for (let index = 0; index < 24 && volatility < upper; index += 1) {
      const next = Math.min(upper, Math.max(volatility + 0.25, volatility * 1.35));
      if (next === volatility) break;
      volatility = next;
      const price = evaluate(volatility);
      if (price == null) continue;
      if (price + tolerance >= targetPrice) { bracket = [lowPoint, [volatility, price]]; break; }
      lowPoint = [volatility, price];
    }
  } else if (seedPrice != null) {
    let highPoint: [number, number] = [seed, seedPrice];
    let volatility = seed;
    for (let index = 0; index < 24 && volatility > lower; index += 1) {
      const next = Math.max(lower, Math.min(volatility - 0.01, volatility / 1.35));
      if (next === volatility) break;
      volatility = next;
      const price = evaluate(volatility);
      if (price == null) continue;
      if (price - tolerance <= targetPrice) { bracket = [[volatility, price], highPoint]; break; }
      highPoint = [volatility, price];
    }
  }
  const valid: Array<[number, number]> = [];
  if (!bracket) for (let index = 0; index < 24; index += 1) {
    const volatility = lower * (upper / lower) ** (index / 23);
    const price = evaluate(volatility);
    if (price != null) valid.push([volatility, price]);
  }
  if (!bracket) {
    const bracketIndex = valid.findIndex((point, index) => index < valid.length - 1 && point[1] <= targetPrice + tolerance && targetPrice <= valid[index + 1][1] + tolerance);
    if (bracketIndex >= 0) bracket = [valid[bracketIndex], valid[bracketIndex + 1]];
  }
  if (!bracket) return { volatility: null, converged: false, status: "unbracketed", reason: "Target is outside the model volatility grid.", iterations: 0 };
  let low = bracket[0][0];
  let high = bracket[1][0];
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const midpoint = (low + high) / 2;
    try {
      const residual = pricingModel.price({ ...input, volatility: midpoint }) - targetPrice;
      if (Math.abs(residual) <= tolerance || high - low <= 1e-8) return { volatility: midpoint, converged: true, status: "converged", reason: null, iterations: iteration };
      if (residual < 0) low = midpoint; else high = midpoint;
    } catch (error) {
      return { volatility: null, converged: false, status: "pricing_error", reason: error instanceof Error ? error.message : "Pricing failed.", iterations: iteration };
    }
  }
  return { volatility: null, converged: false, status: "max_iterations", reason: "Solver iteration limit.", iterations: maxIterations };
}

export function resolveContractStyle(symbol: string) {
  if (["SPX", "SPXW", "XSP"].includes(symbol.toUpperCase())) {
    return { style: "european" as const, verified: false, reason: "European-style index option inferred from configurable symbol map." };
  }
  return { style: "american" as const, verified: false, reason: "American-style U.S. equity/ETF option inferred from configurable symbol map." };
}

export function comparePricingModels({
  symbol,
  inputs,
  optionType,
  marketMid,
  marketBid,
  marketAsk,
  marketIv,
  forecastVolatility,
  treeSteps = 400,
  treeTolerance = 0.0025,
  treeMinSteps = 50,
}: {
  symbol: string;
  inputs: ModelInputs;
  optionType: OptionType;
  marketMid: number;
  marketBid?: number;
  marketAsk?: number;
  marketIv: number;
  forecastVolatility: number;
  treeSteps?: number;
  treeTolerance?: number;
  treeMinSteps?: number;
}) {
  const resolution = resolveContractStyle(symbol);
  const marketInput: PricingInputs = { ...inputs, optionType, volatility: marketIv, exerciseStyle: resolution.style };
  const forecastInput: PricingInputs = { ...inputs, optionType, volatility: forecastVolatility, exerciseStyle: resolution.style };
  const bs = createBlackScholesModel(true);
  const bsMarketIvFairValue = bs.price(marketInput);
  const bsForecastFairValue = bs.price(forecastInput);
  const blackScholesIv = impliedVolatility(marketMid, bs, marketInput);
  let americanMarketIvFairValue: number | null = null;
  let americanForecastFairValue: number | null = null;
  let trinomialForecastFairValue: number | null = null;
  let americanIv: ImpliedVolatilityResult = { volatility: null, converged: false, status: "not_applicable", reason: null, iterations: 0 };
  let modelUsed = "black_scholes_dividend_adjusted";
  let modelReason = resolution.style === "european" ? "European index option: using dividend-adjusted Black-Scholes." : "American exercise premium was negligible.";
  const warnings = [resolution.reason];
  let sameTreeExercisePremium = 0;
  let treeDifference: number | null = null;
  let treeStepsUsed: number | null = null;
  let treeConverged: boolean | null = null;
  let treeConvergenceError: number | null = null;
  let treeConvergenceStatus = "not_applicable";
  let treeHistory: ReturnType<typeof calculateAdaptiveCrr>["history"] = [];
  const quotedSpread = Number.isFinite(marketBid) && Number.isFinite(marketAsk) && Number(marketAsk) > Number(marketBid)
    ? Number(marketAsk) - Number(marketBid) : 0;
  const premiumThresholdComponents = {
    absolute: 0.01,
    spreadAdjusted: 0.10 * quotedSpread,
    priceRelative: 0.005 * Math.max(Math.abs(marketMid), 0),
  };
  const earlyExerciseMaterialityThreshold = Math.max(...Object.values(premiumThresholdComponents));
  if (resolution.style === "american") {
    try {
      const forecastTree = calculateAdaptiveCrr(forecastInput, {
        minSteps: treeMinSteps,
        maxSteps: treeSteps,
        tolerance: treeTolerance,
        american: true,
      });
      treeStepsUsed = forecastTree.steps;
      treeConverged = forecastTree.converged;
      treeConvergenceError = forecastTree.errorEstimate;
      treeConvergenceStatus = forecastTree.status;
      treeHistory = forecastTree.history;
      const marketTree = calculateSmoothedCrr(marketInput, treeStepsUsed, true);
      const europeanForecastTree = calculateSmoothedCrr(forecastInput, treeStepsUsed, false);
      const tree = createCrrModel(treeStepsUsed, true);
      americanMarketIvFairValue = marketTree.price;
      americanForecastFairValue = forecastTree.price;
      trinomialForecastFairValue = calculateTrinomial(forecastInput, treeStepsUsed, true).price;
      sameTreeExercisePremium = Math.max(
        americanForecastFairValue - europeanForecastTree.price,
        0,
      );
      americanIv = impliedVolatility(marketMid, tree, marketInput, {
        initialGuess: marketIv,
        tolerance: 1e-6,
        maxIterations: 60,
      });
      treeDifference = Math.abs(americanForecastFairValue - trinomialForecastFairValue);
      if (!treeConverged) {
        warnings.push(`CRR did not converge to $${treeTolerance.toFixed(4)} by ${treeStepsUsed} steps; last error estimate was ${treeConvergenceError == null ? "unavailable" : `$${treeConvergenceError.toFixed(4)}`}.`);
        modelReason = "Fallback because the American tree did not meet its convergence tolerance.";
      } else if (treeDifference > Math.max(0.02, americanForecastFairValue * 0.005)) {
        warnings.push(`Tree-model disagreement is $${treeDifference.toFixed(3)}; Black-Scholes fallback used.`);
        modelReason = "Fallback because American tree agreement was poor.";
      } else if (sameTreeExercisePremium >= earlyExerciseMaterialityThreshold) {
        modelUsed = "binomial_american_crr";
        modelReason = `American ETF/equity option: CRR selected because the $${sameTreeExercisePremium.toFixed(4)} same-lattice early-exercise premium exceeds the $${earlyExerciseMaterialityThreshold.toFixed(4)} spread/price-adjusted threshold.`;
      } else {
        modelReason = `American ETF/equity option: Black-Scholes retained because the $${sameTreeExercisePremium.toFixed(4)} same-lattice early-exercise premium is below the $${earlyExerciseMaterialityThreshold.toFixed(4)} spread/price-adjusted threshold.`;
      }
      if (!americanIv.converged) {
        warnings.push(`American IV solver failed: ${americanIv.reason ?? americanIv.status}.`);
      }
    } catch (error) {
      warnings.push(`American pricing failed: ${error instanceof Error ? error.message : "unknown error"}`);
      modelReason = "Fallback because American pricing failed.";
    }
  }
  const selectedFairValue = modelUsed === "binomial_american_crr" && americanForecastFairValue != null
    ? americanForecastFairValue : bsForecastFairValue;
  return {
    selectedFairValue,
    modelUsed,
    modelReason,
    pricingWarning: warnings.join(" "),
    bsMarketIvFairValue,
    bsForecastFairValue,
    americanMarketIvFairValue,
    americanForecastFairValue,
    trinomialForecastFairValue,
    earlyExercisePremium: Math.max((americanForecastFairValue ?? bsForecastFairValue) - bsForecastFairValue, 0),
    sameTreeExercisePremium,
    earlyExerciseMaterialityThreshold,
    premiumThresholdComponents,
    treeDifference,
    treeStepsUsed,
    treeMaxSteps: treeSteps,
    treeConvergenceTolerance: treeTolerance,
    treeConvergenceError,
    treeConverged,
    treeConvergenceStatus,
    treeHistory,
    blackScholesIv: blackScholesIv.volatility,
    americanIv: americanIv.volatility,
    blackScholesIvStatus: blackScholesIv.status,
    blackScholesIvIterations: blackScholesIv.iterations,
    americanIvStatus: americanIv.status,
    americanIvIterations: americanIv.iterations,
  };
}

function timeZoneOffset(timestamp: number, timeZone: string) {
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

function newYorkSettlement(expiration: string, settlementMinutes: number) {
  const [year, month, day] = expiration.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return Number.NaN;
  const hour = Math.floor(settlementMinutes / 60);
  const minute = settlementMinutes % 60;
  const localSettlementAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = timeZoneOffset(localSettlementAsUtc, "America/New_York");
  const firstPass = localSettlementAsUtc - firstOffset;
  return localSettlementAsUtc - timeZoneOffset(firstPass, "America/New_York");
}

export function daysToExpiration(
  expiration: string,
  now = Date.now(),
  settlementMinutes = 16 * 60 + 15,
) {
  const settlement = newYorkSettlement(expiration, settlementMinutes);
  if (!Number.isFinite(settlement)) return 1 / 24;
  return Math.max((settlement - now) / 86_400_000, 1 / (24 * 60));
}
