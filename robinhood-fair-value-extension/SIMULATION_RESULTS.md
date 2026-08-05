# Synthetic Simulation Results — v1.3.0

These results validate formula inversion and anomaly-screen implementation, not profitability. Version 1.3.0 adds a separate 264-contract Robinhood trade-bar replay; that replay did not find a profitable threshold. See [ROBINHOOD_REPLAY_RESULTS.md](ROBINHOOD_REPLAY_RESULTS.md).

## Outcome

The final deterministic run passed every configured test gate. The simulation exposed a real false-positive problem in the original neighbor interpolation, which was fixed with an outlier-resistant local volatility fit before the final runs.

### Default seeded run

- Seed: `0x5eed1200`
- Formula inversion cases: 5,000
- Synthetic option chains: 1,000
- Calls and puts: both included
- Expirations: 7, 14, 30, 60, 90, 180, and 365 days
- Underlying prices: $20–$1,200
- ATM volatility range: 15%–95%
- Injected contract mispricing: 20%–40%
- Alert settings: 10% minimum executable edge; 20% maximum spread

Final screening results:

- Eligible injected anomalies: 960
- Correctly detected: 956
- Recall: 99.58%
- Precision: 93.65%
- Normal contracts evaluated: 13,310
- False-positive rate: 0.49%
- Stale-quote rejection: passed
- Illiquid-quote rejection: passed
- Wide-spread rejection: passed

Formula and carry checks:

- Identifiable IV inversions: 4,775 of 5,000; the remaining low-vega cases were rejected instead of returning an unstable IV.
- IV inversion absolute error: p95 `4.92e-12` volatility points; maximum `1.69e-7`.
- Chain-carry calibration: 1,000 of 1,000 chains; p95 absolute error `5.76e-13` yield points.

### Independent seed sweep

Five additional seeds ran 400 chains and 2,000 formula cases each:

| Seed | Precision | Recall | False-positive rate | Verdict |
| --- | ---: | ---: | ---: | --- |
| `0x101` | 93.70% | 99.74% | 0.490% | Pass |
| `0x202` | 93.86% | 99.48% | 0.450% | Pass |
| `0x303` | 95.24% | 99.74% | 0.357% | Pass |
| `0x404` | 90.76% | 99.74% | 0.713% | Pass |
| `0x505` | 92.14% | 99.73% | 0.587% | Pass |

All six runs together covered 3,000 synthetic chains and 15,000 formula cases.

## Defect found and corrected

The initial run detected 99.69% of eligible anomalies but produced only 39.17% precision and an 11.00% false-positive rate. A deliberately corrupted contract IV was contaminating the fair-IV estimates of adjacent strikes.

The extension now uses a leave-one-out, distance-weighted local fit initialized with a robust median-slope estimate and iteratively downweights large residuals. It also rejects implied-volatility results when option vega is too small to identify volatility reliably.

## Limitations

This is synthetic validation, not a profitability backtest:

- Synthetic prices and recovery calculations use the same European Black–Scholes family, so the carry-error result measures implementation consistency rather than real dividend-forecast accuracy.
- American early exercise, discrete corporate dividends, earnings jumps, halts, assignment risk, transaction fees, slippage, order-book depth, and fill probability are not simulated.
- The injected discrepancies are controlled 20%–40% shocks; real discrepancies may be smaller, shorter-lived, or untradeable.
- A historical validation requires timestamp-aligned OPRA/NBBO option quotes, underlying prices, corporate actions, and later executable outcomes. Robinhood's visible page does not provide that history.

The research flag should therefore be treated as a candidate generator. It is not evidence that a contract should be bought or sold.
