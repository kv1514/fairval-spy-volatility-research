import { calculateBlackScholes, daysToExpiration, valueForType, type OptionType } from "../../lib/pricing";

export const dynamic = "force-dynamic";

type Contract = {
  symbol: string;
  type: OptionType;
  strike: number;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  iv: number | null;
  root: string;
};

type Row = { strike: number; call: Contract | null; put: Contract | null };

const SYMBOLS = ["SPY", "SPX", "QQQ"] as const;

function arrayify<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseExpirations(payload: Record<string, unknown>) {
  const expirations = payload.expirations as { date?: unknown } | undefined;
  return arrayify(expirations?.date)
    .map((date) => String(typeof date === "object" && date !== null && "date" in date ? (date as { date: unknown }).date : date))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
}

function normalizeIv(greeks: Record<string, unknown> | null | undefined) {
  if (!greeks) return null;
  const raw = number(greeks.smv_vol ?? greeks.mid_iv ?? 0);
  if (raw <= 0) return null;
  return raw > 3 ? raw : raw * 100;
}

function normalizeContract(raw: Record<string, unknown>): Contract | null {
  const type = raw.option_type === "put" ? "put" : raw.option_type === "call" ? "call" : null;
  const strike = number(raw.strike);
  if (!type || strike <= 0) return null;
  return {
    symbol: String(raw.symbol ?? ""),
    type,
    strike,
    bid: number(raw.bid),
    ask: number(raw.ask),
    last: number(raw.last),
    volume: number(raw.volume),
    openInterest: number(raw.open_interest),
    iv: normalizeIv(raw.greeks as Record<string, unknown> | undefined),
    root: String(raw.root_symbol ?? raw.underlying ?? ""),
  };
}

function pairContracts(contracts: Contract[], spot: number) {
  const byStrike = new Map<number, Row>();
  for (const contract of contracts) {
    const current = byStrike.get(contract.strike) ?? { strike: contract.strike, call: null, put: null };
    current[contract.type] = contract;
    byStrike.set(contract.strike, current);
  }
  return [...byStrike.values()]
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, 41)
    .sort((a, b) => a.strike - b.strike);
}

async function tradier(path: string, token: string) {
  const response = await fetch(`https://api.tradier.com/v1/markets${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    const message = response.status === 401 ? "That Tradier token was not accepted." : `Tradier returned ${response.status}.`;
    throw new Error(message);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function liveResponse(symbol: string, requestedExpiration: string | null, token: string) {
  const expirationPayload = await tradier(`/options/expirations?symbol=${symbol}&includeAllRoots=true`, token);
  const expirations = parseExpirations(expirationPayload);
  if (!expirations.length) throw new Error(`No option expirations were returned for ${symbol}.`);
  const expiration = requestedExpiration && expirations.includes(requestedExpiration) ? requestedExpiration : expirations[0];
  const [quotePayload, chainPayload] = await Promise.all([
    tradier(`/quotes?symbols=${symbol}&greeks=false`, token),
    tradier(`/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`, token),
  ]);
  const quoteNode = (quotePayload.quotes as { quote?: unknown } | undefined)?.quote;
  const quote = arrayify(quoteNode as Record<string, unknown> | Record<string, unknown>[])[0] ?? {};
  const spot = number(quote.last, (number(quote.bid) + number(quote.ask)) / 2);
  const optionNode = (chainPayload.options as { option?: unknown } | undefined)?.option;
  const contracts = arrayify(optionNode as Record<string, unknown> | Record<string, unknown>[])
    .map(normalizeContract)
    .filter((contract): contract is Contract => contract !== null);

  return {
    source: "tradier",
    status: "live",
    symbol,
    name: symbol === "SPX" ? "S&P 500 Index" : symbol === "SPY" ? "SPDR S&P 500 ETF" : "Invesco QQQ Trust",
    spot,
    change: number(quote.change),
    changePercent: number(quote.change_percentage),
    asOf: new Date(number(quote.trade_date, Date.now())).toISOString(),
    expirations,
    expiration,
    rows: pairContracts(contracts, spot),
  };
}

function nextWeekdays(count: number) {
  const dates: string[] = [];
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function demoResponse(symbol: string, requestedExpiration: string | null) {
  const presets: Record<string, { name: string; spot: number; iv: number; dividend: number; step: number }> = {
    SPY: { name: "SPDR S&P 500 ETF", spot: 741.82, iv: 18.4, dividend: 1.15, step: 2 },
    SPX: { name: "S&P 500 Index", spot: 6896.40, iv: 17.2, dividend: 1.25, step: 20 },
    QQQ: { name: "Invesco QQQ Trust", spot: 611.36, iv: 22.8, dividend: 0.55, step: 2 },
  };
  const preset = presets[symbol];
  const expirations = nextWeekdays(8);
  const expiration = requestedExpiration && expirations.includes(requestedExpiration) ? requestedExpiration : expirations[0];
  const center = Math.round(preset.spot / preset.step) * preset.step;
  const rows: Row[] = [];
  for (let offset = -10; offset <= 10; offset += 1) {
    const strike = center + offset * preset.step;
    const smile = preset.iv + Math.abs(strike / preset.spot - 1) * 75 + (strike < preset.spot ? 0.8 : 0);
    const model = calculateBlackScholes({
      spot: preset.spot,
      strike,
      days: daysToExpiration(expiration),
      volatility: smile,
      rate: 4.35,
      dividend: preset.dividend,
    });
    const make = (type: OptionType): Contract => {
      const theoretical = valueForType(model, type);
      const spread = Math.max(theoretical * 0.035, symbol === "SPX" ? 0.35 : 0.03);
      const mid = Math.max(theoretical * (1 + Math.sin(strike) * 0.006), 0.01);
      return {
        symbol: `${symbol}-${expiration}-${type[0].toUpperCase()}-${strike}`,
        type,
        strike,
        bid: Math.max(mid - spread / 2, 0),
        ask: mid + spread / 2,
        last: mid,
        volume: Math.max(4, Math.round(2200 * Math.exp(-Math.abs(offset) / 4))),
        openInterest: Math.max(25, Math.round(9800 * Math.exp(-Math.abs(offset) / 5))),
        iv: smile,
        root: symbol,
      };
    };
    rows.push({ strike, call: make("call"), put: make("put") });
  }
  return {
    source: "demo",
    status: "simulated",
    symbol,
    name: preset.name,
    spot: preset.spot,
    change: symbol === "SPX" ? 22.14 : symbol === "SPY" ? 1.84 : -0.72,
    changePercent: symbol === "SPX" ? 0.32 : symbol === "SPY" ? 0.25 : -0.12,
    asOf: new Date().toISOString(),
    expirations,
    expiration,
    rows,
    notice: "Illustrative chain. Connect a Tradier production token for live quotes.",
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "SPY").toUpperCase();
  const expiration = url.searchParams.get("expiration");
  if (!SYMBOLS.includes(symbol as (typeof SYMBOLS)[number])) {
    return Response.json({ error: "Supported symbols are SPY, SPX, and QQQ." }, { status: 400 });
  }

  const requestToken = request.headers.get("x-tradier-token")?.trim();
  const token = requestToken || process.env.TRADIER_TOKEN?.trim();
  try {
    const payload = token ? await liveResponse(symbol, expiration, token) : demoResponse(symbol, expiration);
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Market data could not be loaded.";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
