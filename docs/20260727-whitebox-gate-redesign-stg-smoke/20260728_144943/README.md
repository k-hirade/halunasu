# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260728054943270-796703`
- status: **complete**
- revision: `fee-api-stg-00196-q5b`
- measurement cases: 32 / 32
- total calculations: 96 / 96
- determinism controls: 32 / 32 exact
- cells: 32 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no
- eligible for promotion review: no
- promotion-review blockers: diagnostic_measurement_only, holdout_not_used
- exact span boundaries: 97/114 (85.1%)
- overlapping span detections: 108/114 (94.7%)
- boundary mismatches: 11/114 (9.6%)
- expected current-own spans detected: 84/88 (95.5%)
- expected code semantic top-1 / top-5: 35/88 (39.8%) / 49/88 (55.7%)
- expected code shadow top-1 / top-5: 35/88 (39.8%) / 49/88 (55.7%)
- expected family identified (strict / shadow): 0/88 (0.0%) / 26/88 (29.5%)
- strict / shadow joint eligible spans: 1/88 (1.1%) / 9/88 (10.2%)
- strict / shadow billable inclusion: 0/88 (0.0%) / 3/88 (3.4%)
- strict / shadow standing facts: n/a / n/a
- strict / shadow safe exclusions: 0/25 (0.0%) / 2/25 (8.0%)
- retrieval outcomes: boundary_or_alias_gap=3, exact_code_top1=35, exact_code_top5=14, retrieval_miss=26, span_not_detected=4, underspecified_family=6
- current-own strict blockers: classifier_requests_llm=9, context_abstain_or_low_confidence=56, context_unresolved=27, linker_category_mismatch=2, linker_expected_code_not_in_top5=35, linker_expected_code_not_top1=14, linker_family_low_margin=24, linker_low_margin=62, linker_low_score=30, span_low_confidence=48, span_not_detected=4
- current-own shadow blockers: classifier_requests_llm=9, context_abstain_or_low_confidence=56, context_unresolved=27, linker_category_mismatch=2, linker_expected_code_not_in_top5=35, linker_expected_code_not_top1=14, linker_family_low_margin=10, linker_low_margin=38, span_not_detected=4
- threshold calibration eligible: no (sample-ready cells 0/32; independent review required)

This diagnostic run is for bottleneck discovery only. It cannot be used as promotion evidence, even when every sampled case succeeds.

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.
