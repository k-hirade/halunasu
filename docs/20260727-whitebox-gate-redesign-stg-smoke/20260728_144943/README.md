# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260728054943270-796703`
- status: **running**
- revision: `fee-api-stg-00196-q5b`
- measurement cases: 6 / 32
- total calculations: 16 / 96
- determinism controls: 5 / 5 exact
- cells: 6 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no
- eligible for promotion review: no
- promotion-review blockers: run_incomplete, diagnostic_measurement_only, holdout_not_used, matrix_incomplete, determinism_controls_incomplete
- exact span boundaries: 21/24 (87.5%)
- overlapping span detections: 23/24 (95.8%)
- boundary mismatches: 2/24 (8.3%)
- expected current-own spans detected: 18/19 (94.7%)
- expected code semantic top-1 / top-5: 7/19 (36.8%) / 10/19 (52.6%)
- expected code shadow top-1 / top-5: 7/19 (36.8%) / 10/19 (52.6%)
- expected family identified (strict / shadow): 0/19 (0.0%) / 4/19 (21.1%)
- strict / shadow joint eligible spans: 0/19 (0.0%) / 2/19 (10.5%)
- strict / shadow billable inclusion: 0/19 (0.0%) / 1/19 (5.3%)
- strict / shadow standing facts: n/a / n/a
- strict / shadow safe exclusions: 0/5 (0.0%) / 1/5 (20.0%)
- retrieval outcomes: boundary_or_alias_gap=1, exact_code_top1=7, exact_code_top5=3, retrieval_miss=4, span_not_detected=1, underspecified_family=3
- current-own strict blockers: classifier_requests_llm=1, context_abstain_or_low_confidence=12, context_unresolved=6, linker_expected_code_not_in_top5=8, linker_expected_code_not_top1=3, linker_family_low_margin=9, linker_low_margin=15, linker_low_score=5, span_low_confidence=9, span_not_detected=1
- current-own shadow blockers: classifier_requests_llm=1, context_abstain_or_low_confidence=12, context_unresolved=6, linker_expected_code_not_in_top5=8, linker_expected_code_not_top1=3, linker_family_low_margin=5, linker_low_margin=9, span_not_detected=1
- threshold calibration eligible: no (sample-ready cells 0/6; independent review required)

This diagnostic run is for bottleneck discovery only. It cannot be used as promotion evidence, even when every sampled case succeeds.

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.
