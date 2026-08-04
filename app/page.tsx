"use client";

import { useMemo, useState } from "react";

type Inputs = {
  spot: number;
  strike: number;
  days: number;
  volatility: number;
  rate: number;
  dividend: number;
  multiplier: number;
};

type InputKey = keyof Inputs;

const DEFAULTS: Inputs = {
  spot: 187.42,
  strike: 190,
  days: 32,
  volatility: 28.5,
  rate: 4.35,
  dividend: 0.52,
  multiplier: 100,
};

const fieldGroups: Array<{
  title: string;
  fields: Array<{
    key: InputKey;
    label: string;
    suffix: string;
    step: string;
    min: string;
    max?: string;
  }>;
}> = [
  {
    title: "Contract",
    fields: [
      { key: "spot", label: "Underlying price", suffix: "$", step: "0.01", min: "0.01" },
      { key: "strike", label: "Strike price", suffix: "$", step: "0.50", min: "0.01" },
      { key: "days", label: "Days to expiration", suffix: "days", step: "1", min: "1", max: "3650" },
    ],
  },
  {
    title: "Market assumptions",
    fields: [
      { key: "volatility", label: "Implied volatility", suffix: "%", step: "0.10", min: "0.01", max: "500" },
      { key: "rate", label: "Risk-free rate", suffix: "%", step: "0.05", min: "-20", max: "100" },
      { key: "dividend", label: "Dividend yield", suffix: "%", step: "0.05", min: "0", max: "100" },
    ],
  },
];

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

function calculateBlackScholes(input: Inputs) {
  const S = input.spot;
  const K = input.strike;
  const T = input.days / 365;
  const sigma = input.volatility / 100;
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

  const call = S * discountQ * nD1 - K * discountR * nD2;
  const put = K * discountR * normalCdf(-d2) - S * discountQ * normalCdf(-d1);
  const gamma = (discountQ * pdfD1) / (S * sigma * sqrtT);
  const vega = (S * discountQ * pdfD1 * sqrtT) / 100;
  const callTheta =
    (-(S * discountQ * pdfD1 * sigma) / (2 * sqrtT) -
      r * K * discountR * nD2 +
      q * S * discountQ * nD1) /
    365;
  const putTheta =
    (-(S * discountQ * pdfD1 * sigma) / (2 * sqrtT) +
      r * K * discountR * normalCdf(-d2) -
      q * S * discountQ * normalCdf(-d1)) /
    365;

  return {
    call,
    put,
    callDelta: discountQ * nD1,
    putDelta: discountQ * (nD1 - 1),
    gamma,
    vega,
    callTheta,
    putTheta,
    callRho: (K * T * discountR * nD2) / 100,
    putRho: (-K * T * discountR * normalCdf(-d2)) / 100,
    callIntrinsic: Math.max(S - K, 0),
    putIntrinsic: Math.max(K - S, 0),
    callProbability: nD2,
    putProbability: normalCdf(-d2),
  };
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const signed = (value: number, digits = 4) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

export default function Home() {
  const [inputs, setInputs] = useState<Inputs>(DEFAULTS);

  const error = useMemo(() => {
    if (!Number.isFinite(inputs.spot) || inputs.spot <= 0) return "Underlying price must be greater than zero.";
    if (!Number.isFinite(inputs.strike) || inputs.strike <= 0) return "Strike price must be greater than zero.";
    if (!Number.isFinite(inputs.days) || inputs.days < 1) return "Enter at least one day to expiration.";
    if (!Number.isFinite(inputs.volatility) || inputs.volatility <= 0) return "Volatility must be greater than zero.";
    if (!Number.isFinite(inputs.multiplier) || inputs.multiplier < 1) return "Contract multiplier must be at least one.";
    if (inputs.dividend < 0) return "Dividend yield cannot be negative.";
    return "";
  }, [inputs]);

  const result = useMemo(() => (error ? null : calculateBlackScholes(inputs)), [inputs, error]);
  const moneyness = ((inputs.spot - inputs.strike) / inputs.strike) * 100;
  const moneynessLabel = Math.abs(moneyness) < 0.5 ? "NEAR THE MONEY" : moneyness > 0 ? "ABOVE STRIKE" : "BELOW STRIKE";

  const update = (key: InputKey, value: string) => {
    setInputs((current) => ({ ...current, [key]: value === "" ? 0 : Number(value) }));
  };

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="BlackScholes Lab home">
          <span className="brand-mark" aria-hidden="true">ƒ</span>
          <span>BlackScholes<span className="brand-muted"> Lab</span></span>
        </a>
        <div className="header-meta">
          <span className="live-dot" aria-hidden="true" />
          <span>LIVE CALCULATION</span>
          <span className="header-rule" aria-hidden="true" />
          <span>EUROPEAN OPTIONS</span>
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">OPTIONS PRICING WORKBENCH</p>
          <h1>Price the contract.<br /><span>Know the risk.</span></h1>
        </div>
        <p className="hero-copy">
          Enter your assumptions and get a theoretical fair value for calls and puts—updated instantly with the full Greek profile.
        </p>
      </section>

      <section className="workspace" aria-label="Black-Scholes calculator">
        <aside className="input-panel">
          <div className="panel-heading">
            <div>
              <p className="section-number">01 / INPUTS</p>
              <h2>Price assumptions</h2>
            </div>
            <button className="reset-button" type="button" onClick={() => setInputs(DEFAULTS)}>Reset</button>
          </div>

          {fieldGroups.map((group) => (
            <fieldset key={group.title}>
              <legend>{group.title}</legend>
              <div className="field-grid">
                {group.fields.map((field) => (
                  <label className="field" key={field.key} htmlFor={field.key}>
                    <span className="field-label">{field.label}</span>
                    <span className="input-shell">
                      {field.suffix === "$" && <span className="input-prefix">$</span>}
                      <input
                        id={field.key}
                        type="number"
                        inputMode="decimal"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={inputs[field.key]}
                        onChange={(event) => update(field.key, event.target.value)}
                        className={field.suffix === "$" ? "has-prefix" : ""}
                      />
                      {field.suffix !== "$" && <span className="input-suffix">{field.suffix}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}

          <div className="multiplier-row">
            <label htmlFor="multiplier">
              <span className="field-label">Contract multiplier</span>
              <span className="field-help">Standard U.S. equity option = 100 shares</span>
            </label>
            <span className="input-shell compact-input">
              <input
                id="multiplier"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={inputs.multiplier}
                onChange={(event) => update("multiplier", event.target.value)}
              />
              <span className="input-suffix">shares</span>
            </span>
          </div>

          <div className={`model-status ${error ? "status-error" : ""}`} role="status" aria-live="polite">
            <span aria-hidden="true">{error ? "!" : "✓"}</span>
            <div>
              <strong>{error || "Model inputs valid"}</strong>
              <small>{error ? "Fix the highlighted assumption to calculate." : "Continuous compounding · 365-day year"}</small>
            </div>
          </div>
        </aside>

        <section className="results-panel" aria-live="polite" aria-atomic="true">
          <div className="results-heading">
            <div>
              <p className="section-number">02 / FAIR VALUE</p>
              <h2>Theoretical prices</h2>
            </div>
            {!error && (
              <div className="moneyness">
                <span>{moneynessLabel}</span>
                <strong>{signed(moneyness, 2)}%</strong>
              </div>
            )}
          </div>

          {result ? (
            <>
              <div className="price-grid">
                <article className="price-card call-card">
                  <div className="option-label">
                    <span className="option-icon">C</span>
                    <div><p>CALL OPTION</p><small>RIGHT TO BUY</small></div>
                  </div>
                  <div className="primary-price">
                    <span>Fair value / share</span>
                    <strong>{currency.format(result.call)}</strong>
                  </div>
                  <div className="contract-price">
                    <span>CONTRACT VALUE</span>
                    <strong>{currency.format(result.call * inputs.multiplier)}</strong>
                  </div>
                  <dl className="value-breakdown">
                    <div><dt>Intrinsic value</dt><dd>{currency.format(result.callIntrinsic)}</dd></div>
                    <div><dt>Time value</dt><dd>{currency.format(Math.max(result.call - result.callIntrinsic, 0))}</dd></div>
                    <div><dt>Break-even at expiry</dt><dd>{currency.format(inputs.strike + result.call)}</dd></div>
                  </dl>
                </article>

                <article className="price-card put-card">
                  <div className="option-label">
                    <span className="option-icon">P</span>
                    <div><p>PUT OPTION</p><small>RIGHT TO SELL</small></div>
                  </div>
                  <div className="primary-price">
                    <span>Fair value / share</span>
                    <strong>{currency.format(result.put)}</strong>
                  </div>
                  <div className="contract-price">
                    <span>CONTRACT VALUE</span>
                    <strong>{currency.format(result.put * inputs.multiplier)}</strong>
                  </div>
                  <dl className="value-breakdown">
                    <div><dt>Intrinsic value</dt><dd>{currency.format(result.putIntrinsic)}</dd></div>
                    <div><dt>Time value</dt><dd>{currency.format(Math.max(result.put - result.putIntrinsic, 0))}</dd></div>
                    <div><dt>Break-even at expiry</dt><dd>{currency.format(inputs.strike - result.put)}</dd></div>
                  </dl>
                </article>
              </div>

              <div className="greeks-section">
                <div className="greeks-title">
                  <div><p className="section-number">03 / SENSITIVITIES</p><h3>Greeks at a glance</h3></div>
                  <p>Per share · Theta per day · Vega/Rho per 1 point</p>
                </div>
                <div className="greeks-table" role="table" aria-label="Option Greeks">
                  <div className="greeks-row greeks-header" role="row">
                    <span role="columnheader">GREEK</span><span role="columnheader">CALL</span><span role="columnheader">PUT</span><span role="columnheader">MEASURES</span>
                  </div>
                  <GreekRow name="Delta" call={signed(result.callDelta)} put={signed(result.putDelta)} description="Price sensitivity" />
                  <GreekRow name="Gamma" call={result.gamma.toFixed(4)} put={result.gamma.toFixed(4)} description="Delta acceleration" />
                  <GreekRow name="Theta" call={signed(result.callTheta)} put={signed(result.putTheta)} description="Daily time decay" />
                  <GreekRow name="Vega" call={signed(result.vega)} put={signed(result.vega)} description="Volatility sensitivity" />
                  <GreekRow name="Rho" call={signed(result.callRho)} put={signed(result.putRho)} description="Rate sensitivity" />
                </div>
              </div>

              <div className="model-notes">
                <div><span>CALL P(ITM)</span><strong>{(result.callProbability * 100).toFixed(1)}%</strong></div>
                <div><span>PUT P(ITM)</span><strong>{(result.putProbability * 100).toFixed(1)}%</strong></div>
                <p>Risk-neutral probabilities based on the model’s inputs—not a market forecast.</p>
              </div>
            </>
          ) : (
            <div className="empty-result">
              <span aria-hidden="true">ƒ</span>
              <h3>Waiting for valid inputs</h3>
              <p>Correct the assumption on the left and both option values will update here.</p>
            </div>
          )}
        </section>
      </section>

      <footer>
        <div>
          <strong>Model assumptions</strong>
          <p>European-style exercise, constant volatility and rates, lognormal returns, continuous dividends, and no transaction costs.</p>
        </div>
        <p className="disclaimer">EDUCATIONAL TOOL · NOT INVESTMENT ADVICE</p>
      </footer>
    </main>
  );
}

function GreekRow({ name, call, put, description }: { name: string; call: string; put: string; description: string }) {
  return (
    <div className="greeks-row" role="row">
      <strong role="cell">{name}</strong>
      <span role="cell">{call}</span>
      <span role="cell">{put}</span>
      <small role="cell">{description}</small>
    </div>
  );
}
