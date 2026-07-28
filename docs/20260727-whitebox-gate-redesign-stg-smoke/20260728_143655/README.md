# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260728053655716-b40642`
- status: **complete**
- revision: `fee-api-stg-00196-q5b`
- measurement cases: 8 / 8
- total calculations: 8 / 8
- determinism controls: 0 / 0 exact
- cells: 8 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no
- eligible for promotion review: no
- promotion-review blockers: diagnostic_measurement_only, holdout_not_used, matrix_incomplete, determinism_controls_incomplete, determinism_mismatch
- exact span boundaries: 25/29 (86.2%)
- overlapping span detections: 27/29 (93.1%)
- boundary mismatches: 2/29 (6.9%)
- expected current-own spans detected: 21/22 (95.5%)
- expected code semantic top-1 / top-5: 10/22 (45.5%) / 13/22 (59.1%)
- expected code shadow top-1 / top-5: 10/22 (45.5%) / 13/22 (59.1%)
- expected family identified (strict / shadow): 0/22 (0.0%) / 5/22 (22.7%)
- strict / shadow joint eligible spans: 0/22 (0.0%) / 2/22 (9.1%)
- strict / shadow billable inclusion: 0/22 (0.0%) / 1/22 (4.5%)
- strict / shadow standing facts: n/a / n/a
- strict / shadow safe exclusions: 0/7 (0.0%) / 1/7 (14.3%)
- retrieval outcomes: boundary_or_alias_gap=1, exact_code_top1=10, exact_code_top5=3, retrieval_miss=4, span_not_detected=1, underspecified_family=3
- current-own strict blockers: classifier_requests_llm=2, context_abstain_or_low_confidence=14, context_unresolved=8, linker_expected_code_not_in_top5=8, linker_expected_code_not_top1=3, linker_family_low_margin=9, linker_low_margin=17, linker_low_score=5, span_low_confidence=12, span_not_detected=1
- current-own shadow blockers: classifier_requests_llm=2, context_abstain_or_low_confidence=14, context_unresolved=8, linker_expected_code_not_in_top5=8, linker_expected_code_not_top1=3, linker_family_low_margin=5, linker_low_margin=9, span_not_detected=1
- threshold calibration eligible: no (sample-ready cells 0/8; independent review required)

This diagnostic run is for bottleneck discovery only. It cannot be used as promotion evidence, even when every sampled case succeeds.

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.
