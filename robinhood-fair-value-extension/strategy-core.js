(function initializeFairValStrategies(root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    maxQuoteAgeMs: 120_000,
    maxSpreadPercent: 20,
    minimumVolume: 10,
    minimumOpenInterest: 100,
    minimumEdgePercent: 5,
    minimumSpreadCoverage: 1,
    maximumVerticalSteps: 3,
    maxCandidates: 8,
    requireHistoricalContext: true,
  });

  const finite = (value) => value !== null && value !== "" && Number.isFinite(Number(value));
  const optionLetter = (optionType) => String(optionType).toLowerCase() === "put" ? "P" : "C";

  function normalizeContract(contract, options) {
    const quote = contract?.exactQuote || contract?.quote || contract || {};
    const optionType = String(contract?.optionType || options.optionType || "").toLowerCase();
    const marketGreeks = contract?.marketGreeks || {};
    const delta = finite(contract?.delta)
      ? Number(contract.delta)
      : optionType === "put" ? Number(marketGreeks.putDelta) : Number(marketGreeks.callDelta);
    const normalized = {
      source: contract,
      ticker: String(contract?.ticker || options.ticker || "").toUpperCase(),
      optionType,
      expiration: String(contract?.expiration || options.expiration || ""),
      strike: Number(contract?.strike),
      fairValue: Number(contract?.fairValue),
      marketIv: Number(contract?.marketIv),
      forecastIv: Number(contract?.fairIv ?? contract?.forecastIv),
      candidateSide: contract?.variance?.candidateSide || contract?.candidateSide || "neutral",
      surfaceContextPass: Boolean(contract?.variance?.surfaceContextPass ?? contract?.surfaceContextPass),
      historyMatched: Boolean(contract?.surfaceBenchmark) || finite(contract?.variance?.ivPercentile) || finite(contract?.ivPercentile),
      ivPercentile: Number(contract?.variance?.ivPercentile ?? contract?.ivPercentile),
      bid: Number(quote.bid),
      ask: Number(quote.ask),
      mark: Number(quote.mark),
      volume: Number(quote.volume),
      openInterest: Number(quote.openInterest),
      capturedAt: Number(quote.capturedAt),
      delta,
      gamma: Number(contract?.gamma ?? marketGreeks.gamma),
      vega: Number(contract?.vega ?? marketGreeks.vega),
    };
    if (!finite(normalized.mark) && finite(normalized.bid) && finite(normalized.ask)) {
      normalized.mark = (normalized.bid + normalized.ask) / 2;
    }
    return normalized;
  }

  function quoteQuality(contract, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const reasons = [];
    if (![contract.strike, contract.fairValue, contract.bid, contract.ask, contract.mark].every(finite)) {
      reasons.push("missing executable quote or fair value");
    } else {
      if (contract.ask < contract.bid || contract.bid < 0) reasons.push("invalid bid/ask");
      const spreadPercent = contract.mark > 0
        ? ((contract.ask - contract.bid) / contract.mark) * 100
        : Number.POSITIVE_INFINITY;
      if (spreadPercent > Number(config.maxSpreadPercent)) reasons.push("wide spread");
      if (contract.mark < 0.10) reasons.push("penny option");
    }
    if (!finite(contract.capturedAt) || Number(config.now) - contract.capturedAt > Number(config.maxQuoteAgeMs)) {
      reasons.push("stale or estimated quote");
    }
    if (!(contract.volume >= Number(config.minimumVolume) || contract.openInterest >= Number(config.minimumOpenInterest))) {
      reasons.push("insufficient volume/open interest");
    }
    if (config.requireHistoricalContext && !contract.historyMatched) reasons.push("historical bucket unavailable");
    return { pass: reasons.length === 0, reasons };
  }

  function structurePayoff(legs, underlying) {
    return legs.reduce((total, leg) => {
      const intrinsic = leg.contract.optionType === "put"
        ? Math.max(leg.contract.strike - underlying, 0)
        : Math.max(underlying - leg.contract.strike, 0);
      return total + leg.weight * intrinsic;
    }, 0);
  }

  function payoffBounds(legs, marketCost, spot) {
    const strikes = legs.map((leg) => leg.contract.strike).sort((a, b) => a - b);
    const range = Math.max(strikes.at(-1) - strikes[0], Number(spot) * 0.05, 1);
    const checkpoints = [0, ...strikes, strikes.at(-1) + 4 * range];
    const pnl = checkpoints.map((underlying) => structurePayoff(legs, underlying) - marketCost);
    const callSlope = legs
      .filter((leg) => leg.contract.optionType === "call")
      .reduce((total, leg) => total + leg.weight, 0);
    const maximum = Math.abs(callSlope) > 1e-10 && callSlope > 0
      ? Number.POSITIVE_INFINITY
      : Math.max(...pnl);
    const minimum = Math.abs(callSlope) > 1e-10 && callSlope < 0
      ? Number.NEGATIVE_INFINITY
      : Math.min(...pnl);
    return {
      maxProfitContract: Number.isFinite(maximum) ? Math.max(maximum, 0) * 100 : null,
      maxLossContract: Number.isFinite(minimum) ? Math.max(-minimum, 0) * 100 : null,
    };
  }

  function buildCandidate({ family, label, thesis, legs, spot, paperOnly = false }, options) {
    const marketCost = legs.reduce(
      (total, leg) => total + leg.weight * (leg.weight > 0 ? leg.contract.ask : leg.contract.bid),
      0,
    );
    const fairValue = legs.reduce((total, leg) => total + leg.weight * leg.contract.fairValue, 0);
    const edge = fairValue - marketCost;
    const quotedRoundTrip = legs.reduce(
      (total, leg) => total + Math.abs(leg.weight) * (leg.contract.ask - leg.contract.bid),
      0,
    );
    const edgePercent = edge / Math.max(Math.abs(marketCost), 0.10) * 100;
    const minimumEdge = Math.max(0.02, quotedRoundTrip * Number(options.minimumSpreadCoverage));
    if (!(edge > minimumEdge) || !(edgePercent >= Number(options.minimumEdgePercent))) return null;

    const netDelta = legs.reduce((total, leg) => total + leg.weight * leg.contract.delta, 0);
    const netGamma = legs.reduce((total, leg) => total + leg.weight * leg.contract.gamma, 0);
    const netVega = legs.reduce((total, leg) => total + leg.weight * leg.contract.vega, 0);
    const familyBonus = family === "butterfly" ? 1.25 : family === "vertical" ? 1.10 : 1;
    const score = (edge / Math.max(quotedRoundTrip, 0.01)) * familyBonus / (1 + Math.abs(netDelta));
    const bounds = payoffBounds(legs, marketCost, spot);
    return {
      family,
      label,
      thesis,
      paperOnly,
      marketCost,
      entryType: marketCost >= 0 ? "debit" : "credit",
      fairValue,
      edge,
      edgePercent,
      quotedRoundTrip,
      spreadCoverage: edge / Math.max(quotedRoundTrip, 0.01),
      score,
      netDelta,
      netGamma,
      netVega,
      hedgeSharesPerContract: -netDelta * 100,
      ...bounds,
      legs: legs.map((leg) => ({
        weight: leg.weight,
        strike: leg.contract.strike,
        optionType: leg.contract.optionType,
        bid: leg.contract.bid,
        ask: leg.contract.ask,
        fairValue: leg.contract.fairValue,
      })),
      legText: legs.map((leg) => `${leg.weight > 0 ? "+" : ""}${leg.weight} ${leg.contract.strike}${optionLetter(leg.contract.optionType)}`).join(" / "),
    };
  }

  function buildSpyStrategyStudy(rawContracts, rawOptions = {}) {
    const options = { ...DEFAULTS, ...rawOptions, now: finite(rawOptions.now) ? Number(rawOptions.now) : Date.now() };
    const ticker = String(options.ticker || rawContracts?.[0]?.ticker || "").toUpperCase();
    if (ticker !== "SPY") {
      return {
        ticker,
        candidates: [],
        diagnostics: { reason: "SPY-only research mode", contractsSeen: rawContracts?.length || 0, eligibleContracts: 0, structuresTested: 0 },
      };
    }

    const normalized = (rawContracts || [])
      .map((contract) => normalizeContract(contract, { ...options, ticker }))
      .filter((contract) => contract.ticker === "SPY" && ["call", "put"].includes(contract.optionType));
    const quality = normalized.map((contract) => ({ contract, quality: quoteQuality(contract, options) }));
    const eligible = quality.filter((row) => row.quality.pass).map((row) => row.contract);
    const rejectionCounts = {};
    for (const row of quality.filter((item) => !item.quality.pass)) {
      for (const reason of row.quality.reasons) rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
    }

    const candidates = [];
    let structuresTested = 0;
    for (const contract of eligible) {
      const longSide = contract.candidateSide === "long_vol" && contract.surfaceContextPass;
      const shortSide = contract.candidateSide === "short_vol" && contract.surfaceContextPass;
      if (!longSide && !shortSide) continue;
      const weight = longSide ? 1 : -1;
      structuresTested += 1;
      const candidate = buildCandidate({
        family: "delta_hedged_variance",
        label: `PAPER Δ-HEDGED ${longSide ? "LONG" : "SHORT"} ${contract.optionType.toUpperCase()}`,
        thesis: longSide
          ? "Forecast variance exceeds implied variance; isolate the volatility thesis with a stock delta hedge."
          : "Implied variance exceeds forecast variance; test the short-vol sign with a stock delta hedge.",
        legs: [{ contract, weight }],
        spot: options.spot,
        paperOnly: true,
      }, options);
      if (candidate) candidates.push(candidate);
    }

    for (const optionType of ["call", "put"]) {
      const chain = eligible.filter((contract) => contract.optionType === optionType).sort((a, b) => a.strike - b.strike);
      for (let first = 0; first < chain.length; first += 1) {
        for (let second = first + 1; second <= Math.min(first + Number(options.maximumVerticalSteps), chain.length - 1); second += 1) {
          const low = chain[first];
          const high = chain[second];
          const baseLegs = optionType === "call"
            ? [{ contract: low, weight: 1 }, { contract: high, weight: -1 }]
            : [{ contract: low, weight: -1 }, { contract: high, weight: 1 }];
          for (const direction of [1, -1]) {
            structuresTested += 1;
            const isDebit = direction === 1;
            const candidate = buildCandidate({
              family: "vertical",
              label: `${optionType.toUpperCase()} ${isDebit ? "DEBIT" : "CREDIT"} VERTICAL`,
              thesis: isDebit
                ? "Defined-risk directional/relative-value structure whose model value exceeds its executable debit."
                : "Defined-risk premium structure whose executable credit exceeds its model liability.",
              legs: baseLegs.map((leg) => ({ ...leg, weight: leg.weight * direction })),
              spot: options.spot,
            }, options);
            if (candidate) candidates.push(candidate);
          }
        }
      }

      for (let index = 0; index + 2 < chain.length; index += 1) {
        const left = chain[index];
        const middle = chain[index + 1];
        const right = chain[index + 2];
        const leftWidth = middle.strike - left.strike;
        const rightWidth = right.strike - middle.strike;
        if (Math.abs(leftWidth - rightWidth) > 1e-8 || leftWidth <= 0) continue;
        for (const direction of [1, -1]) {
          structuresTested += 1;
          const candidate = buildCandidate({
            family: "butterfly",
            label: `${direction === 1 ? "LONG" : "SHORT"} ${optionType.toUpperCase()} BUTTERFLY`,
            thesis: direction === 1
              ? "Low-delta curvature structure whose modeled convexity exceeds its executable debit."
              : "Defined-risk curvature sale whose executable credit exceeds its model liability.",
            legs: [
              { contract: left, weight: direction },
              { contract: middle, weight: -2 * direction },
              { contract: right, weight: direction },
            ],
            spot: options.spot,
          }, options);
          if (candidate) candidates.push(candidate);
        }
      }
    }

    const unique = [...new Map(candidates.map((candidate) => [
      `${candidate.label}|${candidate.legText}`,
      candidate,
    ])).values()]
      .sort((a, b) => b.score - a.score || b.edge - a.edge)
      .slice(0, Math.max(Number(options.maxCandidates), 1));

    return {
      ticker: "SPY",
      generatedAt: options.now,
      candidates: unique,
      diagnostics: {
        contractsSeen: normalized.length,
        eligibleContracts: eligible.length,
        structuresTested,
        rejectionCounts,
        noCandidateReason: unique.length
          ? null
          : eligible.length < 2
            ? "Not enough fresh liquid exact quotes with historical context."
            : "No structure cleared its executable spread and minimum-edge gates.",
      },
    };
  }

  root.FairValStrategies = Object.freeze({
    DEFAULTS,
    buildSpyStrategyStudy,
    quoteQuality,
  });
})(typeof globalThis === "undefined" ? window : globalThis);
