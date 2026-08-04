"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  calculateBlackScholes,
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
  volume: number;
  openInterest: number;
  iv: number | null;
  root: string;
};

type MarketRow = { strike: number; call: Contract | null; put: Contract | null };

type MarketData = {
  source: "tradier" | "demo";
  status: "live" | "simulated";
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
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function midpoint(contract: Contract) {
  if (contract.bid > 0 && contract.ask > 0) return (contract.bid + contract.ask) / 2;
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
  const [loading, setLoading] = useState(true);
  const [marketError, setMarketError] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [liveToken, setLiveToken] = useState("");
  const [ivMode, setIvMode] = useState<"market" | "manual">("market");
  const [inputs, setInputs] = useState<ModelInputs>({
    spot: 741.82,
    strike: 742,
    days: 1,
    volatility: 18.4,
    rate: 4.35,
    dividend: defaultsBySymbol.SPY.dividend,
  });

  useEffect(() => {
    const saved = sessionStorage.getItem("tradier-session-token") ?? "";
    if (saved) {
      setLiveToken(saved);
      setTokenDraft(saved);
    }
  }, []);

  const loadMarket = useCallback(async () => {
    setLoading(true);
    setMarketError("");
    try {
      const query = new URLSearchParams({ symbol });
      if (expiration) query.set("expiration", expiration);
      const response = await fetch(`/api/market?${query.toString()}`, {
        cache: "no-store",
        headers: liveToken ? { "x-tradier-token": liveToken } : {},
      });
      const payload = (await response.json()) as MarketData & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Market data could not be loaded.");
      setMarket(payload);
      if (payload.expiration !== expiration) setExpiration(payload.expiration);
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : "Market data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [expiration, liveToken, symbol]);

  useEffect(() => {
    void loadMarket();
  }, [loadMarket]);

  useEffect(() => {
    if (market?.status !== "live") return;
    const timer = window.setInterval(() => void loadMarket(), 15_000);
    return () => window.clearInterval(timer);
  }, [loadMarket, market?.status]);

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
      days: daysToExpiration(market.expiration),
      volatility: ivMode === "market" && selected.iv ? selected.iv : current.volatility,
    }));
  }, [ivMode, market?.asOf, market?.expiration, market?.spot, selected?.symbol, selected?.iv]);

  const result = useMemo(() => calculateBlackScholes(inputs), [inputs]);
  const fairValue = valueForType(result, optionType);
  const marketMid = selected ? midpoint(selected) : 0;
  const difference = fairValue - marketMid;
  const differencePercent = marketMid > 0 ? (difference / marketMid) * 100 : 0;
  const spread = selected ? Math.max(selected.ask - selected.bid, 0) : 0;
  const selectedDelta = optionType === "call" ? result.callDelta : result.putDelta;
  const selectedTheta = optionType === "call" ? result.callTheta : result.putTheta;
  const selectedRho = optionType === "call" ? result.callRho : result.putRho;
  const probability = optionType === "call" ? result.callProbability : result.putProbability;

  const chooseUnderlying = (next: (typeof SYMBOLS)[number]) => {
    setSymbol(next);
    setExpiration("");
    setSelectedSymbol("");
    setInputs((current) => ({ ...current, dividend: defaultsBySymbol[next].dividend }));
  };

  const chooseType = (type: OptionType) => {
    setOptionType(type);
    setSelectedSymbol("");
  };

  const connect = () => {
    const token = tokenDraft.trim();
    if (token.length < 12) {
      setMarketError("Enter a valid Tradier production token.");
      return;
    }
    sessionStorage.setItem("tradier-session-token", token);
    setLiveToken(token);
    setExpiration("");
    setConnectOpen(false);
  };

  const disconnect = () => {
    sessionStorage.removeItem("tradier-session-token");
    setLiveToken("");
    setTokenDraft("");
    setExpiration("");
    setMarketError("");
    setConnectOpen(false);
  };

  return (
    <main id="top">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="BlackScholes Lab home">
          <span className="brand-mark" aria-hidden="true">ƒ</span>
          <span>BlackScholes <span className="brand-muted">Lab</span></span>
        </a>
        <div className="header-actions">
          <div className={`feed-status ${market?.status === "live" ? "is-live" : ""}`}>
            <span className="status-dot" aria-hidden="true" />
            <span>{market?.status === "live" ? "LIVE FEED" : "DEMO FEED"}</span>
          </div>
          <button className="connect-button" type="button" onClick={() => setConnectOpen(true)}>
            {market?.status === "live" ? "Data settings" : "Connect live data"}
          </button>
        </div>
      </header>

      <section className="market-hero">
        <div className="hero-copy-block">
          <p className="eyebrow">LIVE OPTIONS WORKBENCH</p>
          <h1>Market price,<br /><span>meet model value.</span></h1>
          <p className="hero-copy">
            Select a live contract, load its market assumptions, and compare the quoted price with a Black–Scholes theoretical value.
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
              <span>{item === "SPX" ? "INDEX" : "ETF"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="ticker-strip" aria-live="polite">
        <div className="ticker-identity">
          <strong>{symbol}</strong>
          <span>{market?.name ?? "Loading market…"}</span>
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
          <span>{market?.status === "live" ? "LATEST QUOTE" : "ILLUSTRATIVE SNAPSHOT"}</span>
          <strong>{market ? timeLabel(market.asOf) : "Connecting…"}</strong>
        </div>
      </section>

      {marketError && (
        <div className="error-banner" role="alert">
          <span>!</span><p>{marketError}</p>
          <button type="button" onClick={() => setConnectOpen(true)}>Check connection</button>
        </div>
      )}

      {market?.status === "simulated" && (
        <div className="demo-banner">
          <div>
            <strong>Demo market is active</strong>
            <span>{market.notice}</span>
          </div>
          <button type="button" onClick={() => setConnectOpen(true)}>Connect Tradier</button>
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
                  <th>Mid</th>
                  <th>IV</th>
                  <th>Volume</th>
                  <th>Open int.</th>
                  <th>Model</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((contract) => {
                  const iv = contract.iv ?? inputs.volatility;
                  const model = calculateBlackScholes({
                    spot: market?.spot ?? inputs.spot,
                    strike: contract.strike,
                    days: market ? daysToExpiration(market.expiration) : inputs.days,
                    volatility: iv,
                    rate: inputs.rate,
                    dividend: inputs.dividend,
                  });
                  const rowFair = valueForType(model, optionType);
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
                      <td>{contract.iv ? `${contract.iv.toFixed(1)}%` : "—"}</td>
                      <td>{integer.format(contract.volume)}</td>
                      <td>{integer.format(contract.openInterest)}</td>
                      <td className="model-cell">{money.format(rowFair)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!contracts.length && !loading && <div className="table-empty">No contracts returned for this expiration.</div>}
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
            <span>BLACK–SCHOLES FAIR VALUE</span>
            <strong>{selected ? money.format(fairValue) : "—"}</strong>
            <small>{selected ? `${money.format(fairValue * 100)} per 100-share contract` : "Select a contract"}</small>
          </div>

          {selected && (
            <div className="comparison-block">
              <div className="comparison-copy">
                <span>VS MARKET MIDPOINT</span>
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
                This is a model comparison, not a trade recommendation.
              </p>
            </div>
          )}

          <div className="quote-grid">
            <div><span>BID</span><strong>{selected ? money.format(selected.bid) : "—"}</strong></div>
            <div><span>ASK</span><strong>{selected ? money.format(selected.ask) : "—"}</strong></div>
            <div><span>MID</span><strong>{selected ? money.format(marketMid) : "—"}</strong></div>
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
              <ModelInput label="Spot" value={inputs.spot} suffix="$" step="0.01" onChange={(spot) => setInputs((current) => ({ ...current, spot }))} />
              <ModelInput label="Strike" value={inputs.strike} suffix="$" step="0.5" onChange={(strike) => setInputs((current) => ({ ...current, strike }))} />
              <ModelInput label="Days" value={Number(inputs.days.toFixed(3))} suffix="d" step="0.01" onChange={(days) => setInputs((current) => ({ ...current, days: Math.max(days, 0.01) }))} />
              <ModelInput label="Volatility" value={Number(inputs.volatility.toFixed(2))} suffix="%" step="0.1" disabled={ivMode === "market"} onChange={(volatility) => setInputs((current) => ({ ...current, volatility: Math.max(volatility, 0.01) }))} />
              <ModelInput label="Risk-free rate" value={inputs.rate} suffix="%" step="0.05" onChange={(rate) => setInputs((current) => ({ ...current, rate }))} />
              <ModelInput label="Dividend yield" value={inputs.dividend} suffix="%" step="0.05" onChange={(dividend) => setInputs((current) => ({ ...current, dividend: Math.max(dividend, 0) }))} />
            </div>
          </div>

          <div className="greeks-block">
            <div><span>DELTA</span><strong>{signed(selectedDelta, 4)}</strong></div>
            <div><span>GAMMA</span><strong>{result.gamma.toFixed(4)}</strong></div>
            <div><span>THETA / DAY</span><strong>{signed(selectedTheta, 4)}</strong></div>
            <div><span>VEGA / PT</span><strong>{signed(result.vega, 4)}</strong></div>
            <div><span>RHO / PT</span><strong>{signed(selectedRho, 4)}</strong></div>
            <div><span>MODEL P(ITM)</span><strong>{(probability * 100).toFixed(1)}%</strong></div>
          </div>
        </aside>
      </section>

      <section className="methodology">
        <p className="section-number">04 / READ THE NUMBER CORRECTLY</p>
        <div className="method-grid">
          <div><span>01</span><strong>Market data enters</strong><p>Spot, strike, expiration, bid, ask, and volatility are loaded from the selected chain.</p></div>
          <div><span>02</span><strong>The model recalculates</strong><p>Change volatility, rates, or dividends to test your own view without changing the quote.</p></div>
          <div><span>03</span><strong>Compare—not predict</strong><p>The difference is a theoretical model gap. Liquidity, exercise style, and execution still matter.</p></div>
        </div>
      </section>

      <footer>
        <div>
          <strong>BlackScholes Lab</strong>
          <p>European-style Black–Scholes with continuous dividends. SPY and QQQ are American-style contracts, so model values are approximations.</p>
        </div>
        <p className="disclaimer">EDUCATIONAL ANALYTICS · NOT INVESTMENT ADVICE</p>
      </footer>

      {connectOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConnectOpen(false); }}>
          <section className="connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
            <button className="modal-close" type="button" aria-label="Close" onClick={() => setConnectOpen(false)}>×</button>
            <p className="section-number">LIVE MARKET CONNECTION</p>
            <h2 id="connect-title">Connect Tradier</h2>
            <p className="modal-copy">
              A Tradier production token unlocks live SPY, SPX, and QQQ option chains. The token stays in this browser session and is never saved by the site.
            </p>
            <label className="token-field">
              <span>PRODUCTION TOKEN</span>
              <input
                type="password"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder="Paste token"
                autoComplete="off"
              />
            </label>
            <div className="modal-actions">
              <button className="primary-action" type="button" onClick={connect}>Connect live feed</button>
              {liveToken && <button className="text-action" type="button" onClick={disconnect}>Disconnect</button>}
            </div>
            <p className="modal-footnote">
              No account yet? <a href="https://docs.tradier.com/docs/getting-started" target="_blank" rel="noreferrer">See Tradier setup</a>. Until connected, the site remains fully usable with clearly labeled simulated data.
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
