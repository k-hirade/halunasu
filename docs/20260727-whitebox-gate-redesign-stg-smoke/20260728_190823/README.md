# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260728100824381-718f82`
- status: **running**
- revision: `fee-api-stg-00198-wzq`
- measurement cases: 30 / 32
- total calculations: 89 / 96
- determinism controls: 30 / 30 exact
- determinism scope: whitebox_router_only
- cells: 30 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no
- eligible for promotion review: no
- promotion-review blockers: run_incomplete, diagnostic_measurement_only, holdout_not_used, matrix_incomplete, determinism_controls_incomplete
- exact span boundaries: 90/107 (84.1%)
- overlapping span detections: 101/107 (94.4%)
- boundary mismatches: 11/107 (10.3%)
- expected current-own spans detected: 79/83 (95.2%)
- structured visit facts resolved (strict / shadow): 19/19 (100.0%) / 19/19 (100.0%)
- expected code semantic top-1 / top-5: 33/64 (51.6%) / 45/64 (70.3%)
- expected code shadow top-1 / top-5: 33/64 (51.6%) / 45/64 (70.3%)
- expected family identified (strict / shadow): 0/64 (0.0%) / 21/64 (32.8%)
- strict / shadow joint eligible spans: 0/64 (0.0%) / 3/64 (4.7%)
- strict / shadow billable inclusion: 0/64 (0.0%) / 3/64 (4.7%)
- strict / shadow standing facts: n/a / n/a
- strict / shadow safe exclusions: 0/23 (0.0%) / 1/23 (4.3%)
- retrieval outcomes: boundary_or_alias_gap=3, exact_code_top1=33, exact_code_top5=12, retrieval_miss=8, span_not_detected=4, structured_visit_fact=19, underspecified_family=4
- current-own strict blockers: classifier_requests_llm=11, context_abstain_or_low_confidence=50, context_unresolved=47, linker_category_mismatch=2, linker_expected_code_not_in_top5=15, linker_expected_code_not_top1=12, linker_family_low_margin=22, linker_low_margin=41, linker_low_score=12, span_low_confidence=44, span_not_detected=4
- current-own shadow blockers: classifier_requests_llm=11, context_abstain_or_low_confidence=50, context_unresolved=47, linker_category_mismatch=2, linker_expected_code_not_in_top5=15, linker_expected_code_not_top1=12, linker_family_low_margin=10, linker_low_margin=20, span_not_detected=4
- threshold calibration eligible: no (sample-ready cells 0/30; independent review required)
- shadow routable lines: 71/120 (59.2%)
- shadow routable span-bearing lines: 9/57 (15.8%)
- shadow expected LLM clauses: 122/225 (54.2%)

This diagnostic run is for bottleneck discovery only. It cannot be used as promotion evidence, even when every sampled case succeeds.

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.
