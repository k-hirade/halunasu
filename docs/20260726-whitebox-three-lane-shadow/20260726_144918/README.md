# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260726054919186-75ee06`
- status: **complete**
- revision: `fee-api-stg-00186-9fv`
- measurement cases: 96 / 96
- total calculations: 160 / 160
- determinism controls: 32 / 32 exact
- cells: 32 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.

## Measurement result

- Cloud Logging coverage: 160 / 160 sessions
- Measurement population: 96 cases across 32 / 32 cells
- Determinism controls: 32 / 32 groups matched exactly across three runs
- Cloud Run revision: `fee-api-stg-00186-9fv` only
- Degraded runs: 0
- Routable lines: 0 / 384
- Span-bearing lines: 1 / 384
- Context evaluation: 1 span; 1 abstained
- Route reasons:
  - `visit_facts_sensitive_change`: 204 lines
  - `span_missing_nontrivial_line`: 180 lines

The selected 96 reviewed cases contain 317 reviewed spans and 235 occurrences
of current-visit, own-clinic expected codes across 89 cases. The runtime
produced no encoder codes and no shadow comparison. Therefore this run does
not provide usable L2 linker or L3 context quality evidence.

## Latency

The following values use only the 96 measurement runs. The 64 determinism
controls are excluded.

| Metric | Median | p95 | Max |
| --- | ---: | ---: | ---: |
| Total calculation | 11,077 ms | 16,047 ms | 19,045 ms |
| OpenAI provider | 8,431 ms | 12,584 ms | 14,770 ms |
| White-box lanes | 731 ms | 781 ms | 1,191 ms |
| Span detector | 731 ms | 776 ms | 797 ms |
| Python calculator | 32 ms | 69 ms | 80 ms |

The white-box p95 exceeds the current 500 ms gate. Total latency remains
dominated by the existing OpenAI path because no line was routed to the
encoder path.

## Interpretation

The phase plan predicted that span-bearing lines would reach L3 and then
abstain. The observed result does not support that prediction: WX1 found only
one span-bearing line, so L2 and L3 were almost never exercised.

The same WX1 ONNX artifact was invoked locally with reviewed development case
`wx0-im-outp-0008`. It classified all four lines as `irrelevant` and returned
zero spans, while the artifact build report records strong development token
metrics for that case's lab and medication categories. This reproduces the
problem outside Cloud Run and rules out STG networking, GCS download, and
revision drift as the primary cause. The remaining fault domain is the WX1
artifact export/runtime parity or the build-time evaluation contract.

Do not proceed to L3 retraining or promotion from this result. First add a
full-development PyTorch-to-ONNX parity gate, identify and fix the mismatch,
rebuild and upload WX1, and rerun this same diagnostic matrix. Latency
optimization follows correctness restoration.

The generated gate report remains `blocked`, as expected for a diagnostic run
without independent adjudication. It also fails the 500 ms white-box p95 gate.
