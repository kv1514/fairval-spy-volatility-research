export const dynamic = "force-dynamic";

type OptionType = "call" | "put";

type Contract = {
  symbol: string;
  type: OptionType;
  strike: number;
  bid: number;
  ask: number;
  last: number;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  root: string;
  quoteTime: string | null;
  settlementMinutes: number;
};

type Row = { strike: number; call: Contract | null; put: Contract | null };
type AlpacaFeed = "auto" | "opra" | "indicative";
type AlpacaCredentials = { keyId: string; secretKey: string; feed: Exclude<AlpacaFeed, "auto"> };

class MarketDataError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const SYMBOLS = ["SPY", "SPX", "QQQ"] as const;
const NAMES: Record<string, string> = {
  SPY: "SPDR S&P 500 ETF",
  SPX: "S&P 500 Index",
  QQQ: "Invesco QQQ Trust",
};

function arrayify<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function numeric(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isoTime(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
    .slice(0, 51)
    .sort((a, b) => a.strike - b.strike);
}

function parseOccSymbol(symbol: string) {
  const match = symbol.match(/^(.+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;
  const [, root, yy, mm, dd, side, rawStrike] = match;
  return {
    root,
    expiration: `20${yy}-${mm}-${dd}`,
    type: side === "C" ? ("call" as const) : ("put" as const),
    strike: Number(rawStrike) / 1000,
  };
}

function dateOffset(days: number) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function alpacaFetch(path: string, credentials: AlpacaCredentials) {
  const response = await fetch(`https://data.alpaca.markets${path}`, {
    headers: {
      "APCA-API-KEY-ID": credentials.keyId,
      "APCA-API-SECRET-KEY": credentials.secretKey,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === "string") detail = payload.message;
    } catch {
      // Alpaca occasionally returns an empty error response.
    }
    if (response.status === 401) throw new MarketDataError("Alpaca rejected that key ID or secret key.", 401);
    if (response.status === 403) {
      throw new MarketDataError(
        credentials.feed === "opra"
          ? "This Alpaca account does not have OPRA access. Choose Indicative or add the Algo Trader Plus data plan."
          : "This Alpaca account is not entitled to the requested market data.",
        403,
      );
    }
    if (response.status === 429) {
      throw new MarketDataError("Alpaca rate limit reached. Wait a moment and refresh.", 429);
    }
    throw new MarketDataError(detail || `Alpaca returned ${response.status}.`, response.status);
  }
  return (await response.json()) as Record<string, unknown>;
}

function snapshotMap(payload: Record<string, unknown>) {
  const raw = payload.snapshots;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, Record<string, unknown>>)
    : {};
}

function normalizeAlpacaContract(symbol: string, snapshot: Record<string, unknown>): Contract | null {
  const parsed = parseOccSymbol(symbol);
  if (!parsed) return null;
  const quote = (snapshot.latestQuote ?? snapshot.latest_quote ?? {}) as Record<string, unknown>;
  const trade = (snapshot.latestTrade ?? snapshot.latest_trade ?? {}) as Record<string, unknown>;
  const rawIv = numeric(snapshot.impliedVolatility ?? snapshot.implied_volatility);
  return {
    symbol,
    type: parsed.type,
    strike: parsed.strike,
    bid: numeric(quote.bp ?? quote.bid_price),
    ask: numeric(quote.ap ?? quote.ask_price),
    last: numeric(trade.p ?? trade.price),
    volume: null,
    openInterest: null,
    iv: rawIv > 0 ? (rawIv > 3 ? rawIv : rawIv * 100) : null,
    root: parsed.root,
    quoteTime: isoTime(quote.t ?? quote.timestamp) ?? isoTime(trade.t ?? trade.timestamp),
    settlementMinutes: 16 * 60 + 15,
  };
}

async function alpacaResponse(
  symbol: string,
  requestedExpiration: string | null,
  credentials: AlpacaCredentials,
) {
  if (symbol === "SPX") {
    throw new Error(
      "Alpaca does not currently provide SPX through its Market Data API. Use Tradier for SPX, or choose SPY/QQQ with Alpaca.",
    );
  }

  const stockFeed = credentials.feed === "opra" ? "sip" : "iex";
  const stockPayload = await alpacaFetch(
    `/v2/stocks/${encodeURIComponent(symbol)}/snapshot?feed=${stockFeed}`,
    credentials,
  );
  const latestQuote = (stockPayload.latestQuote ?? stockPayload.latest_quote ?? {}) as Record<string, unknown>;
  const latestTrade = (stockPayload.latestTrade ?? stockPayload.latest_trade ?? {}) as Record<string, unknown>;
  const dailyBar = (stockPayload.dailyBar ?? stockPayload.daily_bar ?? {}) as Record<string, unknown>;
  const previousBar = (stockPayload.prevDailyBar ?? stockPayload.prev_daily_bar ?? {}) as Record<string, unknown>;
  const quoteBid = numeric(latestQuote.bp ?? latestQuote.bid_price);
  const quoteAsk = numeric(latestQuote.ap ?? latestQuote.ask_price);
  const tradePrice = numeric(latestTrade.p ?? latestTrade.price);
  const spot = quoteBid > 0 && quoteAsk > 0 ? (quoteBid + quoteAsk) / 2 : tradePrice || numeric(dailyBar.c);
  if (spot <= 0) throw new Error(`Alpaca did not return a usable ${symbol} underlying quote.`);

  const feedQuery = `feed=${credentials.feed}`;
  const strikeFloor = Math.max(0.01, spot * 0.84).toFixed(2);
  const strikeCeiling = (spot * 1.16).toFixed(2);
  const discoveryPayload = await alpacaFetch(
    `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}?${feedQuery}` +
      `&expiration_date_gte=${dateOffset(0)}&expiration_date_lte=${dateOffset(45)}` +
      `&strike_price_gte=${strikeFloor}&strike_price_lte=${strikeCeiling}&limit=1000`,
    credentials,
  );
  const discoveredExpirations = [...new Set(
    Object.keys(snapshotMap(discoveryPayload))
      .map((contractSymbol) => parseOccSymbol(contractSymbol)?.expiration)
      .filter((date): date is string => Boolean(date)),
  )].sort().slice(0, 12);
  if (!discoveredExpirations.length) throw new Error(`Alpaca returned no active ${symbol} option expirations.`);

  const expiration = requestedExpiration && discoveredExpirations.includes(requestedExpiration)
    ? requestedExpiration
    : discoveredExpirations[0];
  const chainPayload = await alpacaFetch(
    `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}?${feedQuery}` +
      `&expiration_date=${expiration}&strike_price_gte=${strikeFloor}` +
      `&strike_price_lte=${strikeCeiling}&limit=1000`,
    credentials,
  );
  const contracts = Object.entries(snapshotMap(chainPayload))
    .map(([contractSymbol, snapshot]) => normalizeAlpacaContract(contractSymbol, snapshot))
    .filter((contract): contract is Contract => contract !== null);
  if (!contracts.length) throw new Error(`Alpaca returned no ${symbol} contracts for ${expiration}.`);

  const previousClose = numeric(previousBar.c);
  const change = previousClose > 0 ? spot - previousClose : 0;
  const times = [
    isoTime(latestQuote.t ?? latestQuote.timestamp),
    isoTime(latestTrade.t ?? latestTrade.timestamp),
    ...contracts.map((contract) => contract.quoteTime),
  ].filter((value): value is string => Boolean(value));
  const asOf = times.length
    ? new Date(Math.max(...times.map((value) => Date.parse(value)))).toISOString()
    : new Date().toISOString();

  return {
    source: "alpaca",
    status: credentials.feed === "opra" ? "live" : "indicative",
    feed: credentials.feed === "opra" ? "OPRA + SIP" : "ALPACA INDICATIVE + IEX",
    symbol,
    name: NAMES[symbol],
    spot,
    change,
    changePercent: previousClose > 0 ? (change / previousClose) * 100 : 0,
    asOf,
    expirations: discoveredExpirations,
    expiration,
    rows: pairContracts(contracts, spot),
    notice:
      credentials.feed === "indicative"
        ? "Alpaca Basic is a modified indicative feed, not OPRA. Differences from Robinhood and other retail brokers are expected."
        : "Consolidated OPRA option quotes with SIP underlying data.",
  };
}

function parseExpirations(payload: Record<string, unknown>) {
  const expirations = payload.expirations as { date?: unknown } | undefined;
  return arrayify(expirations?.date)
    .map((date) => String(typeof date === "object" && date !== null && "date" in date ? (date as { date: unknown }).date : date))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
}

function normalizeTradierIv(greeks: Record<string, unknown> | null | undefined) {
  if (!greeks) return null;
  const raw = numeric(greeks.smv_vol ?? greeks.mid_iv);
  if (raw <= 0) return null;
  return raw > 3 ? raw : raw * 100;
}

function normalizeTradierContract(raw: Record<string, unknown>): Contract | null {
  const type = raw.option_type === "put" ? "put" : raw.option_type === "call" ? "call" : null;
  const strike = numeric(raw.strike);
  if (!type || strike <= 0) return null;
  const rawTradeTime = numeric(raw.trade_date);
  return {
    symbol: String(raw.symbol ?? ""),
    type,
    strike,
    bid: numeric(raw.bid),
    ask: numeric(raw.ask),
    last: numeric(raw.last),
    volume: nullableNumber(raw.volume),
    openInterest: nullableNumber(raw.open_interest),
    iv: normalizeTradierIv(raw.greeks as Record<string, unknown> | undefined),
    root: String(raw.root_symbol ?? raw.underlying ?? ""),
    quoteTime: rawTradeTime > 0 ? new Date(rawTradeTime).toISOString() : null,
    settlementMinutes: String(raw.root_symbol ?? "").toUpperCase() === "SPX" ? 9 * 60 + 30 : 16 * 60 + 15,
  };
}

async function tradier(path: string, token: string) {
  const response = await fetch(`https://api.tradier.com/v1/markets${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    const message = response.status === 401 ? "Tradier rejected that production token." : `Tradier returned ${response.status}.`;
    throw new Error(message);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function tradierResponse(symbol: string, requestedExpiration: string | null, token: string) {
  const expirationPayload = await tradier(`/options/expirations?symbol=${symbol}&includeAllRoots=true`, token);
  const expirations = parseExpirations(expirationPayload);
  if (!expirations.length) throw new Error(`Tradier returned no option expirations for ${symbol}.`);
  const expiration = requestedExpiration && expirations.includes(requestedExpiration) ? requestedExpiration : expirations[0];
  const [quotePayload, chainPayload] = await Promise.all([
    tradier(`/quotes?symbols=${symbol}&greeks=false`, token),
    tradier(`/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`, token),
  ]);
  const quoteNode = (quotePayload.quotes as { quote?: unknown } | undefined)?.quote;
  const quote = arrayify(quoteNode as Record<string, unknown> | Record<string, unknown>[])[0] ?? {};
  const quoteBid = numeric(quote.bid);
  const quoteAsk = numeric(quote.ask);
  const spot = quoteBid > 0 && quoteAsk > 0 ? (quoteBid + quoteAsk) / 2 : numeric(quote.last);
  const optionNode = (chainPayload.options as { option?: unknown } | undefined)?.option;
  const contracts = arrayify(optionNode as Record<string, unknown> | Record<string, unknown>[])
    .map(normalizeTradierContract)
    .filter((contract): contract is Contract => contract !== null);
  if (spot <= 0 || !contracts.length) throw new Error(`Tradier returned an incomplete ${symbol} market snapshot.`);
  const rawTradeTime = numeric(quote.trade_date);

  return {
    source: "tradier",
    status: "live",
    feed: "TRADIER CONSOLIDATED",
    symbol,
    name: NAMES[symbol],
    spot,
    change: numeric(quote.change),
    changePercent: numeric(quote.change_percentage),
    asOf: rawTradeTime > 0 ? new Date(rawTradeTime).toISOString() : new Date().toISOString(),
    expirations,
    expiration,
    rows: pairContracts(contracts, spot),
    notice: "Tradier consolidated option quotes.",
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "SPY").toUpperCase();
  const expiration = url.searchParams.get("expiration");
  const provider = url.searchParams.get("provider") === "tradier" ? "tradier" : "alpaca";
  if (!SYMBOLS.includes(symbol as (typeof SYMBOLS)[number])) {
    return Response.json({ error: "Supported symbols are SPY, SPX, and QQQ." }, { status: 400 });
  }

  try {
    if (provider === "tradier") {
      const token = request.headers.get("x-tradier-token")?.trim() || process.env.TRADIER_TOKEN?.trim();
      if (!token) {
        return Response.json(
          { error: "Connect a Tradier production token to load real quotes. Sample prices are no longer shown." },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(await tradierResponse(symbol, expiration, token), {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const keyId = request.headers.get("x-alpaca-key-id")?.trim() || process.env.ALPACA_API_KEY_ID?.trim();
    const secretKey = request.headers.get("x-alpaca-secret-key")?.trim() || process.env.ALPACA_API_SECRET_KEY?.trim();
    const requestedFeed = request.headers.get("x-alpaca-feed")?.trim() || process.env.ALPACA_FEED?.trim();
    const feed: AlpacaFeed = requestedFeed === "opra" || requestedFeed === "indicative" ? requestedFeed : "auto";
    if (!keyId || !secretKey) {
      return Response.json(
        { error: "Connect Alpaca keys to load real market data. Sample prices are no longer shown." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    let payload;
    if (feed === "auto") {
      try {
        payload = await alpacaResponse(symbol, expiration, { keyId, secretKey, feed: "opra" });
      } catch (error) {
        if (!(error instanceof MarketDataError) || error.status !== 403) throw error;
        payload = await alpacaResponse(symbol, expiration, { keyId, secretKey, feed: "indicative" });
      }
    } else {
      payload = await alpacaResponse(symbol, expiration, { keyId, secretKey, feed });
    }
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Market data could not be loaded.";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
