# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260728100824381-718f82`
- status: **complete**
- revision: `fee-api-stg-00198-wzq`
- measurement cases: 32 / 32
- total calculations: 96 / 96
- determinism controls: 32 / 32 exact
- determinism scope: whitebox_router_only
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
- structured visit facts resolved (strict / shadow): 20/20 (100.0%) / 20/20 (100.0%)
- expected code semantic top-1 / top-5: 35/68 (51.5%) / 49/68 (72.1%)
- expected code shadow top-1 / top-5: 35/68 (51.5%) / 49/68 (72.1%)
- expected family identified (strict / shadow): 0/68 (0.0%) / 24/68 (35.3%)
- strict / shadow joint eligible spans: 0/68 (0.0%) / 3/68 (4.4%)
- strict / shadow billable inclusion: 0/68 (0.0%) / 3/68 (4.4%)
- strict / shadow standing facts: n/a / n/a
- strict / shadow safe exclusions: 0/25 (0.0%) / 1/25 (4.0%)
- retrieval outcomes: boundary_or_alias_gap=3, exact_code_top1=35, exact_code_top5=14, retrieval_miss=8, span_not_detected=4, structured_visit_fact=20, underspecified_family=4
- current-own strict blockers: classifier_requests_llm=11, context_abstain_or_low_confidence=52, context_unresolved=49, linker_category_mismatch=2, linker_expected_code_not_in_top5=15, linker_expected_code_not_top1=14, linker_family_low_margin=22, linker_low_margin=42, linker_low_score=12, span_low_confidence=47, span_not_detected=4
- current-own shadow blockers: classifier_requests_llm=11, context_abstain_or_low_confidence=52, context_unresolved=49, linker_category_mismatch=2, linker_expected_code_not_in_top5=15, linker_expected_code_not_top1=14, linker_family_low_margin=10, linker_low_margin=20, span_not_detected=4
- threshold calibration eligible: no (sample-ready cells 0/32; independent review required)
- shadow routable lines: 74/128 (57.8%)
- shadow routable span-bearing lines: 9/62 (14.5%)
- shadow expected LLM clauses: 133/239 (55.6%)

This diagnostic run is for bottleneck discovery only. It cannot be used as promotion evidence, even when every sampled case succeeds.

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.
