export type OptionType = "call" | "put";

export type ModelInputs = {
  spot: number;
  strike: number;
  days: number;
  volatility: number;
  rate: number;
  dividend: number;
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

export function daysToExpiration(expiration: string) {
  const settlement = Date.parse(`${expiration}T20:00:00.000Z`);
  return Math.max((settlement - Date.now()) / 86_400_000, 1 / 24);
}
