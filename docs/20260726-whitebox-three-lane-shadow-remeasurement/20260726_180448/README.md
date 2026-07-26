# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260726090448391-fbd4b5`
- status: **complete**
- revision: `fee-api-stg-00187-fxd`
- measurement cases: 8 / 8
- total calculations: 16 / 16
- determinism controls: 8 / 8 exact
- cells: 8 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.

## Diagnostic result

- Runtime health: pass. Span, linker, and context artifacts were available on `fee-api-stg-00187-fxd`; all 16 calculations completed without degradation.
- WX1 span regression: fixed. The 8 measurement runs detected 30 spans from 32 lines, and every selected cell produced at least one span. Including identical-input controls, 60 spans were detected from 64 lines.
- Determinism: pass for this reduced sample. All 8 measurement/control pairs had identical white-box fingerprints.
- Three-lane routing: not ready for promotion. The context classifier evaluated 60 spans and abstained on all 60. Consequently, no span-bearing line was routable to the encoder, `encoderLineCount` remained 0, and the expected LLM line ratio remained 1.0.
- Safety: intact. All modes remained `shadow`, so white-box output did not alter billing candidates or points.

The previous zero-span runtime failure is no longer the blocker. The next blocker is WX3 context classification, especially temporal relation and provider ownership confidence. This reduced run covers 8 of 32 required cells and is diagnostic only; it is not promotion evidence.

## Observed latency

Cloud Run performance logs for the 16 calculations reported:

- total request: min 9,944 ms, mean 16,052 ms, max 30,194 ms
- span detector: mean 837 ms
- master linker: mean 631 ms
- context classifier: mean 764 ms

These values include cold/warm runtime variation and a small synthetic sample. They establish that the three artifacts executed in STG, but are not a production latency baseline.
