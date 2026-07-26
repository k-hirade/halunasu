# Fee White-box Shadow Report

- policy: `fee-whitebox-shadow-promotion-v1`
- gate: **blocked**
- run manifest: `fee-whitebox-shadow-20260726054919186-75ee06`
- manifest log coverage: 160/160
- unrelated performance logs ignored: 0
- runs: 96
- routable line ratio: 0.0000
- span-bearing routable line ratio: 0.0000
- degraded run rate: 0.0000
- white-box p95: 781.0 ms
- lane p95: spanDetector=776.0 ms, linker=0.0 ms, contextClassifier=0.0 ms
- missing lane durations: {"contextClassifier": 0, "linker": 0, "spanDetector": 0}
- context abstain rate: 1.0000
- failed checks: 2
- Cloud Run revisions: fee-api-stg-00186-9fv
- extractor versions: whitebox-v1:6a5f6b981446aa90d8689d0a

## Routing diagnostics

- route reasons: {"span_missing_nontrivial_line": 180, "visit_facts_sensitive_change": 204}
- context uncertain axes: {"actionStatus": 1, "providerOwnership": 1, "sourceOrigin": 1, "standingStatus": 1, "temporalRelation": 1}

## Cell coverage

| specialty / setting | runs | routable lines | span-bearing routable | degraded |
| --- | ---: | ---: | ---: | ---: |
| `internal_medicine|outpatient` | 3 | 0.0000 | n/a | 0 |
| `internal_medicine|home_visit` | 3 | 0.0000 | n/a | 0 |
| `internal_medicine|house_call` | 3 | 0.0000 | n/a | 0 |
| `internal_medicine|telephone` | 3 | 0.0000 | n/a | 0 |
| `pediatrics|outpatient` | 3 | 0.0000 | n/a | 0 |
| `pediatrics|home_visit` | 3 | 0.0000 | n/a | 0 |
| `pediatrics|house_call` | 3 | 0.0000 | n/a | 0 |
| `pediatrics|telephone` | 3 | 0.0000 | n/a | 0 |
| `dermatology|outpatient` | 3 | 0.0000 | n/a | 0 |
| `dermatology|home_visit` | 3 | 0.0000 | n/a | 0 |
| `dermatology|house_call` | 3 | 0.0000 | n/a | 0 |
| `dermatology|telephone` | 3 | 0.0000 | n/a | 0 |
| `orthopedics|outpatient` | 3 | 0.0000 | n/a | 0 |
| `orthopedics|home_visit` | 3 | 0.0000 | n/a | 0 |
| `orthopedics|house_call` | 3 | 0.0000 | n/a | 0 |
| `orthopedics|telephone` | 3 | 0.0000 | n/a | 0 |
| `psychiatry|outpatient` | 3 | 0.0000 | n/a | 0 |
| `psychiatry|home_visit` | 3 | 0.0000 | n/a | 0 |
| `psychiatry|house_call` | 3 | 0.0000 | n/a | 0 |
| `psychiatry|telephone` | 3 | 0.0000 | n/a | 0 |
| `ophthalmology|outpatient` | 3 | 0.0000 | 0.0000 | 0 |
| `ophthalmology|home_visit` | 3 | 0.0000 | n/a | 0 |
| `ophthalmology|house_call` | 3 | 0.0000 | n/a | 0 |
| `ophthalmology|telephone` | 3 | 0.0000 | n/a | 0 |
| `otolaryngology|outpatient` | 3 | 0.0000 | n/a | 0 |
| `otolaryngology|home_visit` | 3 | 0.0000 | n/a | 0 |
| `otolaryngology|house_call` | 3 | 0.0000 | n/a | 0 |
| `otolaryngology|telephone` | 3 | 0.0000 | n/a | 0 |
| `surgery|outpatient` | 3 | 0.0000 | n/a | 0 |
| `surgery|home_visit` | 3 | 0.0000 | n/a | 0 |
| `surgery|house_call` | 3 | 0.0000 | n/a | 0 |
| `surgery|telephone` | 3 | 0.0000 | n/a | 0 |

## Encoder / LLM code differences

This is a machine precheck and is not clinical ground truth.

- none

## Failed checks

- `telemetry.whiteboxDurationMs.p95`: actual `781.0`, expected `<=500`
- `adjudication`: actual `None`, expected `fee-whitebox-adjudication-v1 input`

A blocked result is expected until all 32 cells and an independently adjudicated evaluation file satisfy the policy. LLM shadow agreement alone is not gold truth.
