"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  calculateBlackScholes,
  calculateCrr,
  comparePricingModels,
  daysToExpiration,
  valueForType,
  type ModelInputs,
  type OptionType,
} from "./lib/pricing";

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

type MarketRow = { strike: number; call: Contract | null; put: Contract | null };

type MarketData = {
  source: "alpaca" | "tradier";
  status: "live" | "indicative";
  feed: string;
  symbol: string;
  name: string;
  spot: number;
  change: number;
  changePercent: number;
  asOf: string;
  expirations: string[];
  expiration: string;
  rows: MarketRow[];
  notice?: string;
};

type DataConnection = {
  provider: "alpaca" | "tradier";
  alpacaKeyId: string;
  alpacaSecretKey: string;
  alpacaFeed: "auto" | "indicative" | "opra";
  tradierToken: string;
};

const EMPTY_CONNECTION: DataConnection = {
  provider: "alpaca",
  alpacaKeyId: "",
  alpacaSecretKey: "",
  alpacaFeed: "auto",
  tradierToken: "",
};

const SYMBOLS = ["SPY", "SPX", "QQQ"] as const;
const defaultsBySymbol: Record<string, { dividend: number }> = {
  SPY: { dividend: 1.15 },
  SPX: { dividend: 1.25 },
  QQQ: { dividend: 0.55 },
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
function midpoint(contract: Contract) {
  if (contract.bid >= 0 && contract.ask > 0 && contract.ask >= contract.bid) {
    return (contract.bid + contract.ask) / 2;
  }
  return contract.last;
}

function signed(value: number, digits = 2) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

export default function Home() {
  const [symbol, setSymbol] = useState<(typeof SYMBOLS)[number]>("SPY");
  const [optionType, setOptionType] = useState<OptionType>("call");
  const [expiration, setExpiration] = useState("");
  const [market, setMarket] = useState<MarketData | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [loading, setLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectionReady, setConnectionReady] = useState(false);
  const [connection, setConnection] = useState<DataConnection>(EMPTY_CONNECTION);
  const [connectionDraft, setConnectionDraft] = useState<DataConnection>(EMPTY_CONNECTION);
  const [ivMode, setIvMode] = useState<"market" | "manual">("market");
  const [inputs, setInputs] = useState<ModelInputs>({
    spot: 0,
    strike: 0,
    days: 0.001,
    volatility: 20,
    rate: 4.35,
    dividend: defaultsBySymbol.SPY.dividend,
  });

  useEffect(() => {
    const saved = sessionStorage.getItem("market-data-connection");
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Partial<DataConnection>;
        const restored: DataConnection = {
          ...EMPTY_CONNECTION,
          ...parsed,
          provider: parsed.provider === "tradier" ? "tradier" : "alpaca",
          alpacaFeed: parsed.alpacaFeed === "opra" ? "opra" : "auto",
        };
        setConnection(restored);
        setConnectionDraft(restored);
      } catch {
        sessionStorage.removeItem("market-data-connection");
      }
    }
    setConnectionReady(true);
  }, []);

  const loadMarket = useCallback(async () => {
    setLoading(true);
    setMarketError("");
    try {
      const activeProvider = symbol === "SPX" && connection.tradierToken ? "tradier" : connection.provider;
      const query = new URLSearchParams({ symbol, provider: activeProvider });
      if (expiration) query.set("expiration", expiration);
      const headers: Record<string, string> = {};
      if (activeProvider === "alpaca") {
        if (connection.alpacaKeyId) headers["x-alpaca-key-id"] = connection.alpacaKeyId;
        if (connection.alpacaSecretKey) headers["x-alpaca-secret-key"] = connection.alpacaSecretKey;
        headers["x-alpaca-feed"] = connection.alpacaFeed;
      } else if (connection.tradierToken) {
        headers["x-tradier-token"] = connection.tradierToken;
      }
      const response = await fetch(`/api/market?${query.toString()}`, {
        cache: "no-store",
        headers,
      });
      const payload = (await response.json()) as MarketData & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Market data could not be loaded.");
      setMarket(payload);
      if (payload.expiration !== expiration) setExpiration(payload.expiration);
    } catch (error) {
      setMarket(null);
      setMarketError(error instanceof Error ? error.message : "Market data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [connection, expiration, symbol]);

  useEffect(() => {
    if (!connectionReady) return;
    void loadMarket();
  }, [connectionReady, loadMarket]);

  useEffect(() => {
    if (!market) return;
    const timer = window.setInterval(() => void loadMarket(), 15_000);
    return () => window.clearInterval(timer);
  }, [loadMarket, market]);

  const contracts = useMemo(
    () =>
      (market?.rows ?? [])
        .map((row) => row[optionType])
        .filter((contract): contract is Contract => contract !== null),
    [market, optionType],
  );

  useEffect(() => {
    if (!contracts.length || !market) return;
    const existing = contracts.find((contract) => contract.symbol === selectedSymbol);
    if (existing) return;
    const nearest = [...contracts].sort(
      (a, b) => Math.abs(a.strike - market.spot) - Math.abs(b.strike - market.spot),
    )[0];
    setSelectedSymbol(nearest.symbol);
  }, [contracts, market, selectedSymbol]);

  const selected = useMemo(
    () => contracts.find((contract) => contract.symbol === selectedSymbol) ?? contracts[0] ?? null,
    [contracts, selectedSymbol],
  );

  useEffect(() => {
    if (!selected || !market) return;
    setInputs((current) => ({
      ...current,
      spot: market.spot,
      strike: selected.strike,
      days: daysToExpiration(market.expiration, Date.now(), selected.settlementMinutes),
      volatility: ivMode === "market" && selected.iv != null ? selected.iv : current.volatility,
    }));
  }, [ivMode, market?.asOf, market?.expiration, market?.spot, selected?.symbol, selected?.iv]);

  const result = useMemo(() => calculateBlackScholes(inputs), [inputs]);
  const modelAvailable = Boolean(selected && (ivMode === "manual" || selected.iv != null));
  const marketMid = selected ? midpoint(selected) : 0;
  const pricingComparison = useMemo(() => {
    if (!modelAvailable || !selected) return null;
    return comparePricingModels({
      symbol,
      inputs,
      optionType,
      marketMid,
      marketBid: selected.bid,
      marketAsk: selected.ask,
      marketIv: selected.iv ?? inputs.volatility,
      forecastVolatility: inputs.volatility,
      treeSteps: 400,
      treeTolerance: 0.0025,
    });
  }, [inputs, marketMid, modelAvailable, optionType, selected, symbol]);
  const fairValue = pricingComparison?.selectedFairValue ?? null;
  const difference = fairValue == null ? 0 : fairValue - marketMid;
  const differencePercent = marketMid > 0 ? (difference / marketMid) * 100 : 0;
  const spread = selected ? Math.max(selected.ask - selected.bid, 0) : 0;
  const selectedDelta = optionType === "call" ? result.callDelta : result.putDelta;
  const selectedTheta = optionType === "call" ? result.callTheta : result.putTheta;
  const selectedRho = optionType === "call" ? result.callRho : result.putRho;
  const probability = optionType === "call" ? result.callProbability : result.putProbability;

  const chooseUnderlying = (next: (typeof SYMBOLS)[number]) => {
    setSymbol(next);
    setMarket(null);
    setExpiration("");
    setSelectedSymbol("");
    setInputs((current) => ({ ...current, dividend: defaultsBySymbol[next].dividend }));
    if (next === "SPX" && connection.provider === "alpaca" && !connection.tradierToken) {
      setMarketError("Alpaca does not currently provide SPX index market data. Connect Tradier to load SPX quotes.");
      setConnectionDraft((current) => ({ ...current, provider: "tradier" }));
      setConnectOpen(true);
    }
  };

  const chooseType = (type: OptionType) => {
    setOptionType(type);
    setSelectedSymbol("");
  };

  const connect = () => {
    const next: DataConnection = {
      ...connectionDraft,
      alpacaKeyId: connectionDraft.alpacaKeyId.trim(),
      alpacaSecretKey: connectionDraft.alpacaSecretKey.trim(),
      tradierToken: connectionDraft.tradierToken.trim(),
    };
    if (next.provider === "alpaca" && (!next.alpacaKeyId || !next.alpacaSecretKey)) {
      setMarketError("Enter both your Alpaca key ID and secret key.");
      return;
    }
    if (next.provider === "tradier" && next.tradierToken.length < 12) {
      setMarketError("Enter a valid Tradier production token.");
      return;
    }
    sessionStorage.setItem("market-data-connection", JSON.stringify(next));
    setConnection(next);
    setExpiration("");
    setSelectedSymbol("");
    setMarket(null);
    setMarketError("");
    setConnectOpen(false);
  };

  const disconnect = () => {
    sessionStorage.removeItem("market-data-connection");
    setConnection(EMPTY_CONNECTION);
    setConnectionDraft(EMPTY_CONNECTION);
    setMarket(null);
    setExpiration("");
    setMarketError("");
    setConnectOpen(false);
  };

  const hasSavedCredentials = Boolean(
    connection.alpacaKeyId || connection.alpacaSecretKey || connection.tradierToken,
  );

  return (
    <main id="top">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="FairVal Lab home">
          <span className="brand-mark" aria-hidden="true">ƒ</span>
          <span>FairVal <span className="brand-muted">Lab</span></span>
        </a>
        <div className="header-actions">
          <a className="research-link" href="/research">Outcome study</a>
          <div className={`feed-status ${market?.status === "live" ? "is-live" : market?.status === "indicative" ? "is-indicative" : ""}`}>
            <span className="status-dot" aria-hidden="true" />
            <span>{market ? market.feed : "DATA OFFLINE"}</span>
          </div>
          <button className="connect-button" type="button" onClick={() => setConnectOpen(true)}>
            {market ? "Data settings" : "Connect market data"}
          </button>
        </div>
      </header>

      <section className="market-hero">
        <div className="hero-copy-block">
          <p className="eyebrow">LIVE OPTIONS WORKBENCH</p>
          <h1>Market price,<br /><span>meet model value.</span></h1>
          <p className="hero-copy">
            Compare a live quote with a forecast-volatility value under European Black–Scholes and American exercise-aware trees.
          </p>
        </div>
        <div className="symbol-picker" aria-label="Choose an underlying">
          {SYMBOLS.map((item) => (
            <button
              type="button"
              key={item}
              className={item === symbol ? "active" : ""}
              onClick={() => chooseUnderlying(item)}
              aria-pressed={item === symbol}
            >
              <strong>{item}</strong>
              <span>{item === "SPX" ? (connection.provider === "alpaca" && !connection.tradierToken ? "NEEDS TRADIER" : "INDEX") : "ETF"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="ticker-strip" aria-live="polite">
        <div className="ticker-identity">
          <strong>{symbol}</strong>
          <span>{market?.name ?? "Connect a verified market feed"}</span>
        </div>
        <div className="ticker-price">
          <strong>{market ? money.format(market.spot) : "—"}</strong>
          {market && (
            <span className={market.change >= 0 ? "positive" : "negative"}>
              {signed(market.change)} ({signed(market.changePercent)}%)
            </span>
          )}
        </div>
        <div className="ticker-clock">
          <span>{market ? "LATEST PROVIDER SNAPSHOT" : "NO SAMPLE DATA"}</span>
          <strong>{market ? timeLabel(market.asOf) : loading ? "Connecting…" : "OFFLINE"}</strong>
        </div>
      </section>

      {marketError && (
        <div className="error-banner" role="alert">
          <span>!</span><p>{marketError}</p>
          <button type="button" onClick={() => setConnectOpen(true)}>Check connection</button>
        </div>
      )}

      {market?.status === "indicative" && (
        <div className="demo-banner">
          <div>
            <strong>Indicative data—not Robinhood’s OPRA feed</strong>
            <span>{market.notice}</span>
          </div>
          <button type="button" onClick={() => setConnectOpen(true)}>Change feed</button>
        </div>
      )}

      <section className="terminal-shell">
        <section className="chain-panel" aria-label={`${symbol} option chain`}>
          <div className="panel-topline">
            <div>
              <p className="section-number">01 / OPTION CHAIN</p>
              <h2>Choose a contract</h2>
            </div>
            <button className="refresh-button" type="button" onClick={() => void loadMarket()} disabled={loading}>
              <span className={loading ? "spin" : ""}>↻</span> {loading ? "Updating" : "Refresh"}
            </button>
          </div>

          <div className="chain-controls">
            <label>
              <span>EXPIRATION</span>
              <select
                value={expiration}
                onChange={(event) => {
                  setExpiration(event.target.value);
                  setSelectedSymbol("");
                }}
                disabled={!market?.expirations.length}
              >
                {(market?.expirations ?? []).map((date) => (
                  <option key={date} value={date}>{dateLabel(date)} · {date}</option>
                ))}
              </select>
            </label>
            <div className="type-toggle" role="group" aria-label="Option type">
              <button type="button" className={optionType === "call" ? "active call" : ""} onClick={() => chooseType("call")}>Calls</button>
              <button type="button" className={optionType === "put" ? "active put" : ""} onClick={() => chooseType("put")}>Puts</button>
            </div>
          </div>

          <div className="chain-table-wrap">
            <table className="chain-table">
              <thead>
                <tr>
                  <th>Strike</th>
                  <th>Bid</th>
                  <th>Ask</th>
                  <th>Mark (mid)</th>
                  <th>IV</th>
                  <th>Quote time</th>
                  <th>Model</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((contract) => {
                  const rowFair = contract.iv == null
                    ? null
                    : symbol === "SPX"
                      ? valueForType(calculateBlackScholes({
                        spot: market?.spot ?? inputs.spot,
                        strike: contract.strike,
                        days: market
                          ? daysToExpiration(market.expiration, Date.now(), contract.settlementMinutes)
                          : inputs.days,
                        volatility: contract.iv,
                        rate: inputs.rate,
                        dividend: inputs.dividend,
                      }), optionType)
                      : calculateCrr({
                        spot: market?.spot ?? inputs.spot,
                        strike: contract.strike,
                        days: market
                          ? daysToExpiration(market.expiration, Date.now(), contract.settlementMinutes)
                          : inputs.days,
                        volatility: contract.iv,
                        rate: inputs.rate,
                        dividend: inputs.dividend,
                        optionType,
                        exerciseStyle: "american",
                      }, 50, true).price;
                  const isSelected = contract.symbol === selected?.symbol;
                  return (
                    <tr
                      key={contract.symbol}
                      className={isSelected ? "selected" : ""}
                      onClick={() => setSelectedSymbol(contract.symbol)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") setSelectedSymbol(contract.symbol);
                      }}
                      tabIndex={0}
                      aria-selected={isSelected}
                    >
                      <td><strong>{number.format(contract.strike)}</strong>{Math.abs(contract.strike - (market?.spot ?? 0)) < 0.51 && <small>ATM</small>}</td>
                      <td>{money.format(contract.bid)}</td>
                      <td>{money.format(contract.ask)}</td>
                      <td>{money.format(midpoint(contract))}</td>
                      <td>{contract.iv != null ? `${contract.iv.toFixed(1)}%` : "—"}</td>
                      <td>{contract.quoteTime ? timeLabel(contract.quoteTime) : "—"}</td>
                      <td className="model-cell">{rowFair == null ? "—" : money.format(rowFair)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!contracts.length && !loading && (
              <div className="table-empty">
                <strong>{marketError ? "Market data unavailable" : "Connect a market-data feed"}</strong>
                <span>No fabricated option prices are shown.</span>
                <button type="button" onClick={() => setConnectOpen(true)}>Open data settings</button>
              </div>
            )}
            {loading && !market && <div className="table-empty">Loading the option chain…</div>}
          </div>
          <p className="table-note">Click a row to load it into the model. Live connections refresh every 15 seconds.</p>
        </section>

        <aside className="analysis-panel" aria-label="Selected contract analysis">
          <div className="panel-topline analysis-heading">
            <div>
              <p className="section-number">02 / MODEL VALUE</p>
              <h2>{optionType.toUpperCase()} · {selected ? number.format(selected.strike) : "—"}</h2>
            </div>
            <span className={`option-badge ${optionType}`}>{optionType[0].toUpperCase()}</span>
          </div>

          <div className="fair-value-block">
            <span>{ivMode === "manual" ? "REALIZED-VOLATILITY SCENARIO VALUE" : "MARKET-IV DIAGNOSTIC VALUE"}</span>
            <strong>{fairValue == null ? "—" : money.format(fairValue)}</strong>
            <small>{fairValue == null ? (selected ? "Market IV unavailable—use Manual IV" : "Select a live contract") : `${money.format(fairValue * 100)} per 100-share contract`}</small>
          </div>

          {pricingComparison && (
            <div className="pricing-diagnostics">
              <div><span>MODEL USED</span><strong>{pricingComparison.modelUsed}</strong></div>
              <div><span>BS / FORECAST VOL</span><strong>{money.format(pricingComparison.bsForecastFairValue)}</strong></div>
              <div><span>AMERICAN CRR / FORECAST VOL</span><strong>{pricingComparison.americanForecastFairValue == null ? "N/A" : money.format(pricingComparison.americanForecastFairValue)}</strong></div>
              <div><span>EARLY-EXERCISE PREMIUM</span><strong>{money.format(pricingComparison.earlyExercisePremium)}</strong></div>
              <div><span>PREMIUM MATERIALITY</span><strong>{money.format(pricingComparison.earlyExerciseMaterialityThreshold)} · spread/price adjusted</strong></div>
              <div><span>ADAPTIVE CRR</span><strong>{pricingComparison.treeConvergenceStatus}{pricingComparison.treeStepsUsed ? ` · N=${pricingComparison.treeStepsUsed}` : ""}</strong></div>
              <div><span>LAST ERROR / TOLERANCE</span><strong>{pricingComparison.treeConvergenceError == null ? "N/A" : `${money.format(pricingComparison.treeConvergenceError)} / ${money.format(pricingComparison.treeConvergenceTolerance)}`}</strong></div>
              <p><strong>{pricingComparison.modelReason}</strong> {pricingComparison.pricingWarning}</p>
              {ivMode === "market" && <p className="circular-note">Market-IV value is a diagnostic and will usually reproduce the market. Switch to Manual only when the input is your independent volatility forecast.</p>}
              {ivMode === "manual" && <p className="circular-note">A realized-volatility forecast is a physical-measure scenario input. It is not, by itself, a uniquely identified risk-neutral fair value.</p>}
            </div>
          )}

          {selected && fairValue != null && (
            <div className="comparison-block">
              <div className="comparison-copy">
                <span>VS PROVIDER MARK</span>
                <strong className={difference >= 0 ? "positive" : "negative"}>
                  {signed(differencePercent)}%
                </strong>
              </div>
              <div className="comparison-track" aria-hidden="true">
                <span className="market-marker" style={{ left: "50%" }} />
                <span
                  className="model-marker"
                  style={{ left: `${Math.max(4, Math.min(96, 50 + differencePercent * 2))}%` }}
                />
              </div>
              <p>
                Model is <strong>{money.format(Math.abs(difference))}</strong> {difference >= 0 ? "above" : "below"} the quoted midpoint.
                Robinhood may display a different mark; compare the same contract and timestamp.
              </p>
            </div>
          )}

          <div className="quote-grid">
            <div><span>SELL / BID</span><strong>{selected ? money.format(selected.bid) : "—"}</strong></div>
            <div><span>BUY / ASK</span><strong>{selected ? money.format(selected.ask) : "—"}</strong></div>
            <div><span>MARK / MID</span><strong>{selected ? money.format(marketMid) : "—"}</strong></div>
            <div><span>SPREAD</span><strong>{selected ? money.format(spread) : "—"}</strong></div>
          </div>

          <div className="model-controls">
            <div className="control-heading">
              <div><p className="section-number">03 / ASSUMPTIONS</p><h3>Model inputs</h3></div>
              <div className="iv-mode" role="group" aria-label="Volatility source">
                <button type="button" className={ivMode === "market" ? "active" : ""} onClick={() => setIvMode("market")}>Market IV</button>
                <button type="button" className={ivMode === "manual" ? "active" : ""} onClick={() => setIvMode("manual")}>Manual</button>
              </div>
            </div>
            <div className="input-grid">
              <ModelInput label="Spot" value={inputs.spot} suffix="$" step="0.01" disabled={ivMode === "market"} onChange={(spot) => setInputs((current) => ({ ...current, spot }))} />
              <ModelInput label="Strike" value={inputs.strike} suffix="$" step="0.5" disabled={ivMode === "market"} onChange={(strike) => setInputs((current) => ({ ...current, strike }))} />
              <ModelInput label="Days" value={Number(inputs.days.toFixed(4))} suffix="d" step="0.001" disabled={ivMode === "market"} onChange={(days) => setInputs((current) => ({ ...current, days: Math.max(days, 0.001) }))} />
              <ModelInput label="Volatility" value={Number(inputs.volatility.toFixed(2))} suffix="%" step="0.1" disabled={ivMode === "market"} onChange={(volatility) => setInputs((current) => ({ ...current, volatility: Math.max(volatility, 0.01) }))} />
              <ModelInput label="Risk-free rate" value={inputs.rate} suffix="%" step="0.05" onChange={(rate) => setInputs((current) => ({ ...current, rate }))} />
              <ModelInput label="Dividend yield" value={inputs.dividend} suffix="%" step="0.05" onChange={(dividend) => setInputs((current) => ({ ...current, dividend: Math.max(dividend, 0) }))} />
            </div>
          </div>

          <div className="greeks-block">
            <div><span>DELTA</span><strong>{modelAvailable ? signed(selectedDelta, 4) : "—"}</strong></div>
            <div><span>GAMMA</span><strong>{modelAvailable ? result.gamma.toFixed(4) : "—"}</strong></div>
            <div><span>THETA / DAY</span><strong>{modelAvailable ? signed(selectedTheta, 4) : "—"}</strong></div>
            <div><span>VEGA / PT</span><strong>{modelAvailable ? signed(result.vega, 4) : "—"}</strong></div>
            <div><span>RHO / PT</span><strong>{modelAvailable ? signed(selectedRho, 4) : "—"}</strong></div>
            <div><span>MODEL P(ITM)</span><strong>{modelAvailable ? `${(probability * 100).toFixed(1)}%` : "—"}</strong></div>
          </div>
        </aside>
      </section>

      <section className="methodology">
        <p className="section-number">04 / READ THE NUMBER CORRECTLY</p>
        <div className="method-grid">
          <div><span>01</span><strong>Same contract</strong><p>Match symbol, call or put, expiration, strike, and quote timestamp before comparing with Robinhood.</p></div>
          <div><span>02</span><strong>Same feed quality</strong><p>OPRA is the consolidated options market. Alpaca Basic indicative prices are modified and can differ.</p></div>
          <div><span>03</span><strong>Keep P and Q separate</strong><p>Market-IV value is circular. A realized-volatility input creates a scenario value; adaptive American trees control numerical error and early exercise.</p></div>
        </div>
      </section>

      <footer>
        <div>
          <strong>FairVal Multi-Model Lab</strong>
          <p>European Black–Scholes baseline, convergence-checked American CRR/trinomial comparison, continuous-dividend approximation, and no order execution.</p>
        </div>
        <p className="disclaimer">EDUCATIONAL ANALYTICS · NOT INVESTMENT ADVICE</p>
      </footer>

      {connectOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConnectOpen(false); }}>
          <section className="connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
            <button className="modal-close" type="button" aria-label="Close" onClick={() => setConnectOpen(false)}>×</button>
            <p className="section-number">LIVE MARKET CONNECTION</p>
            <h2 id="connect-title">Connect verified quotes</h2>
            <p className="modal-copy">
              The old sample chain has been removed. Choose Alpaca for SPY/QQQ or Tradier for SPY/SPX/QQQ. Credentials stay in this browser tab and are only forwarded to the selected provider.
            </p>
            <div className="provider-toggle" role="group" aria-label="Market data provider">
              <button type="button" className={connectionDraft.provider === "alpaca" ? "active" : ""} onClick={() => setConnectionDraft((current) => ({ ...current, provider: "alpaca" }))}>Alpaca</button>
              <button type="button" className={connectionDraft.provider === "tradier" ? "active" : ""} onClick={() => setConnectionDraft((current) => ({ ...current, provider: "tradier" }))}>Tradier</button>
            </div>
            {connectionDraft.provider === "alpaca" ? (
              <div className="credential-stack">
                <label className="token-field">
                  <span>ALPACA KEY ID</span>
                  <input type="password" value={connectionDraft.alpacaKeyId} onChange={(event) => setConnectionDraft((current) => ({ ...current, alpacaKeyId: event.target.value }))} placeholder="Paste key ID" autoComplete="off" />
                </label>
                <label className="token-field">
                  <span>ALPACA SECRET KEY</span>
                  <input type="password" value={connectionDraft.alpacaSecretKey} onChange={(event) => setConnectionDraft((current) => ({ ...current, alpacaSecretKey: event.target.value }))} placeholder="Paste secret key" autoComplete="off" />
                </label>
                <label className="token-field">
                  <span>OPTIONS FEED</span>
                  <select value={connectionDraft.alpacaFeed} onChange={(event) => setConnectionDraft((current) => ({ ...current, alpacaFeed: event.target.value === "opra" ? "opra" : event.target.value === "indicative" ? "indicative" : "auto" }))}>
                    <option value="auto">Auto · OPRA if entitled</option>
                    <option value="indicative">Indicative · Alpaca Basic</option>
                    <option value="opra">OPRA · Algo Trader Plus</option>
                  </select>
                </label>
                <p className="provider-note"><strong>Coverage:</strong> SPY and QQQ only. Alpaca says SPX market data is not available yet.</p>
              </div>
            ) : (
              <div className="credential-stack">
                <label className="token-field">
                  <span>TRADIER PRODUCTION TOKEN</span>
                  <input type="password" value={connectionDraft.tradierToken} onChange={(event) => setConnectionDraft((current) => ({ ...current, tradierToken: event.target.value }))} placeholder="Paste token" autoComplete="off" />
                </label>
                <p className="provider-note"><strong>Coverage:</strong> SPY, SPX, and QQQ.</p>
              </div>
            )}
            <div className="modal-actions">
              <button className="primary-action" type="button" onClick={connect}>Connect live feed</button>
              {hasSavedCredentials && <button className="text-action" type="button" onClick={disconnect}>Disconnect</button>}
            </div>
            <p className="modal-footnote">
              Robinhood can show the natural buy/sell price or the mark. Compare our Ask to Robinhood’s buy price, Bid to its sell price, or Mark to Mark at the same timestamp. <a href="https://docs.alpaca.markets/docs/getting-started" target="_blank" rel="noreferrer">Alpaca setup</a>
            </p>
          </section>
        </div>
      )}
    </main>
  );
}

function ModelInput({
  label,
  value,
  suffix,
  step,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  suffix: string;
  step: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="model-input">
      <span>{label}</span>
      <div>
        <input
          type="number"
          value={value}
          step={step}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <small>{suffix}</small>
      </div>
    </label>
  );
}
