export type OptionType = "call" | "put";

export type ModelInputs = {
  spot: number;
  strike: number;
  days: number;
  volatility: number;
  rate: number;
  dividend: number;
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

export function calculateBlackScholes(input: ModelInputs) {
  const S = Math.max(input.spot, 0.0001);
  const K = Math.max(input.strike, 0.0001);
  const T = Math.max(input.days / 365, 1 / (365 * 24));
  const sigma = Math.max(input.volatility / 100, 0.0001);
  const r = input.rate / 100;
  const q = input.dividend / 100;
  const sqrtT = Math.sqrt(T);
  const discountR = Math.exp(-r * T);
  const discountQ = Math.exp(-q * T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nD1 = normalCdf(d1);
  const nD2 = normalCdf(d2);
  const pdfD1 = normalPdf(d1);

  const call = Math.max(S * discountQ * nD1 - K * discountR * nD2, 0);
  const put = Math.max(K * discountR * normalCdf(-d2) - S * discountQ * normalCdf(-d1), 0);
  const gamma = (discountQ * pdfD1) / (S * sigma * sqrtT);
  const vega = (S * discountQ * pdfD1 * sqrtT) / 100;

  return {
    call,
    put,
    callDelta: discountQ * nD1,
    putDelta: discountQ * (nD1 - 1),
    gamma,
    vega,
    callTheta:
      (-(S * discountQ * pdfD1 * sigma) / (2 * sqrtT) -
        r * K * discountR * nD2 +
        q * S * discountQ * nD1) /
      365,
    putTheta:
      (-(S * discountQ * pdfD1 * sigma) / (2 * sqrtT) +
        r * K * discountR * normalCdf(-d2) -
        q * S * discountQ * normalCdf(-d1)) /
      365,
    callRho: (K * T * discountR * nD2) / 100,
    putRho: (-K * T * discountR * normalCdf(-d2)) / 100,
    callProbability: nD2,
    putProbability: normalCdf(-d2),
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
  const up = Math.exp(sigma * Math.sqrt(dt));
  const down = 1 / up;
  const probability = (Math.exp((rate - dividend) * dt) - down) / (up - down);
  if (!(probability >= 0 && probability <= 1)) throw new Error("CRR risk-neutral probability is invalid for these inputs.");
  const discount = Math.exp(-rate * dt);
  let values = Array.from({ length: steps + 1 }, (_, index) =>
    intrinsic(input, input.spot * up ** index * down ** (steps - index)),
  );
  let firstLayer: { stocks: number[]; values: number[] } | null = null;
  let secondLayer: { stocks: number[]; values: number[] } | null = null;
  for (let step = steps - 1; step >= 0; step -= 1) {
    const stocks = Array.from({ length: step + 1 }, (_, index) => input.spot * up ** index * down ** (step - index));
    values = stocks.map((stock, index) => {
      const continuation = discount * ((1 - probability) * values[index] + probability * values[index + 1]);
      return american ? Math.max(continuation, intrinsic(input, stock)) : continuation;
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

export function calculateTrinomial(input: PricingInputs, steps = 100, american = true) {
  validatePricingInputs(input);
  if (!Number.isInteger(steps) || steps < 2) throw new Error("Trinomial steps must be an integer of at least 2.");
  const time = Math.max(input.days / 365, 1 / (365 * 24 * 60));
  const dt = time / steps;
  const sigma = input.volatility / 100;
  const rate = input.rate / 100;
  const dividend = input.dividend / 100;
  const halfVol = sigma * Math.sqrt(dt / 2);
  const denominator = Math.exp(halfVol) - Math.exp(-halfVol);
  const drift = Math.exp((rate - dividend) * dt / 2);
  const upProbability = ((drift - Math.exp(-halfVol)) / denominator) ** 2;
  const downProbability = ((Math.exp(halfVol) - drift) / denominator) ** 2;
  const middleProbability = 1 - upProbability - downProbability;
  if (Math.min(upProbability, middleProbability, downProbability) < -1e-12) throw new Error("Trinomial probabilities are invalid for these inputs.");
  const discount = Math.exp(-rate * dt);
  const up = Math.exp(sigma * Math.sqrt(2 * dt));
  let values = Array.from({ length: 2 * steps + 1 }, (_, index) => intrinsic(input, input.spot * up ** (index - steps)));
  for (let step = steps - 1; step >= 0; step -= 1) {
    values = Array.from({ length: 2 * step + 1 }, (_, index) => {
      const stock = input.spot * up ** (index - step);
      const continuation = discount * (
        downProbability * values[index] + middleProbability * values[index + 1] + upProbability * values[index + 2]
      );
      return american ? Math.max(continuation, intrinsic(input, stock)) : continuation;
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
): ImpliedVolatilityResult {
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
  const valid: Array<[number, number]> = [];
  for (let index = 0; index < 72; index += 1) {
    const volatility = 0.01 * (500 / 0.01) ** (index / 71);
    try {
      const price = pricingModel.price({ ...input, volatility });
      if (Number.isFinite(price)) valid.push([volatility, price]);
    } catch { /* Low-volatility tree probabilities can be outside their numerical domain. */ }
  }
  const bracketIndex = valid.findIndex((point, index) => index < valid.length - 1 && point[1] <= targetPrice + 1e-8 && targetPrice <= valid[index + 1][1] + 1e-8);
  if (bracketIndex < 0) return { volatility: null, converged: false, status: "unbracketed", reason: "Target is outside the model volatility grid.", iterations: 0 };
  let low = valid[bracketIndex][0];
  let high = valid[bracketIndex + 1][0];
  for (let iteration = 1; iteration <= 100; iteration += 1) {
    const midpoint = (low + high) / 2;
    try {
      const residual = pricingModel.price({ ...input, volatility: midpoint }) - targetPrice;
      if (Math.abs(residual) <= 1e-8 || high - low <= 1e-8) return { volatility: midpoint, converged: true, status: "converged", reason: null, iterations: iteration };
      if (residual < 0) low = midpoint; else high = midpoint;
    } catch (error) {
      return { volatility: null, converged: false, status: "pricing_error", reason: error instanceof Error ? error.message : "Pricing failed.", iterations: iteration };
    }
  }
  return { volatility: null, converged: false, status: "max_iterations", reason: "Solver iteration limit.", iterations: 100 };
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
  marketIv,
  forecastVolatility,
  treeSteps = 75,
}: {
  symbol: string;
  inputs: ModelInputs;
  optionType: OptionType;
  marketMid: number;
  marketIv: number;
  forecastVolatility: number;
  treeSteps?: number;
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
  let modelReason = resolution.style === "european" ? "European-style index option." : "American exercise premium was negligible.";
  const warnings = [resolution.reason];
  if (resolution.style === "american") {
    try {
      const tree = createCrrModel(treeSteps, true);
      americanMarketIvFairValue = tree.price(marketInput);
      americanForecastFairValue = tree.price(forecastInput);
      trinomialForecastFairValue = calculateTrinomial(forecastInput, treeSteps, true).price;
      const sameTreeExercisePremium = Math.max(
        americanForecastFairValue - calculateCrr(forecastInput, treeSteps, false).price,
        0,
      );
      americanIv = impliedVolatility(marketMid, tree, marketInput);
      const difference = Math.abs(americanForecastFairValue - trinomialForecastFairValue);
      const premium = Math.max(americanForecastFairValue - bsForecastFairValue, 0);
      if (difference > Math.max(0.02, americanForecastFairValue * 0.005)) {
        warnings.push(`Tree-model disagreement is $${difference.toFixed(3)}; Black-Scholes fallback used.`);
        modelReason = "Fallback because American tree agreement was poor.";
      } else if (sameTreeExercisePremium >= 0.01 && americanIv.converged) {
        modelUsed = "binomial_american_crr";
        modelReason = "American CRR selected because same-lattice early-exercise premium was material.";
      } else if (!americanIv.converged) {
        warnings.push(`American IV solver failed: ${americanIv.reason ?? americanIv.status}.`);
        modelReason = "Fallback because American-model IV could not be solved.";
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
    blackScholesIv: blackScholesIv.volatility,
    americanIv: americanIv.volatility,
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
