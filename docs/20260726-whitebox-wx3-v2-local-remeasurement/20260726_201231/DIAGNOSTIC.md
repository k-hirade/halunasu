# WX3 v2 Local Diagnostic

## Scope

- Artifact: `wx3-multilingual-minilm-l12-v2`
- Base model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
- Training view: 288 train cases / 96 development cases
- Holdout: 16 cases withheld from training and calibration
- Comparison sample: the same 8 development cases used by the reduced STG diagnostic

The 8-case result is an implementation check, not promotion evidence. These cases are
development data and cannot be used as independent accuracy evidence.

## Build Result

The artifact was calibrated against the final ONNX logits, not the pre-export PyTorch
outputs. Every axis satisfied non-empty calibration coverage, the configured risk and
dangerous-false-positive gates, the semantic probe, and 100 deterministic inference
runs.

| Axis | Coverage | Risk | Dangerous FP rate | Threshold |
| --- | ---: | ---: | ---: | ---: |
| actionStatus | 70.51% | 0.00% | 0.00% | 0.955472 |
| temporalRelation | 39.61% | 0.71% | 0.55% | 0.985346 |
| sourceOrigin | 54.21% | 0.52% | 0.00% | 0.993759 |
| providerOwnership | 90.73% | 0.93% | 0.00% | 0.967436 |
| standingStatus | 82.02% | 2.40% | 0.95% | 0.920918 |

## v1 vs v2 Reduced Diagnostic

The comparison used 29 reviewed spans from the same eight development cases.

| Metric | v1 | v2 |
| --- | ---: | ---: |
| All five axes non-abstained | 0 / 29 | 7 / 29 |
| All five axes non-abstained ratio | 0.00% | 24.14% |
| All five axes correct and non-abstained | 0 / 29 | 6 / 29 |

The one fully classified mismatch was a historical own-clinic act classified as
patient-reported/other-provider. Its temporal axis was still `past`, so both truth and
prediction route to exclusion. It is a safe over-exclusion in this diagnostic, not an
unsafe billing adoption.

## Local Runtime

- Peak RSS: 1304.2 MiB
- Span p95: 266.189 ms
- Linker p95: 750.485 ms
- Context p95: 675.668 ms
- Sequential three-lane p95 sum: 1692.342 ms

Cloud Run latency and routable-line rate must be remeasured after the v2 artifact is
uploaded and the STG shadow profile is deployed. Shadow mode remains non-authoritative
and cannot alter billing candidates or points.
