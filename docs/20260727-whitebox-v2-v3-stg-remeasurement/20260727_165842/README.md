# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260727075842779-f68e4f`
- status: **complete**
- revision: `fee-api-stg-00193-fkk`
- measurement cases: 8 / 8
- total calculations: 8 / 8
- determinism controls: 0 / 0 exact
- cells: 8 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no
- eligible for promotion review: no
- promotion-review blockers: diagnostic_measurement_only, holdout_not_used, matrix_incomplete, determinism_controls_incomplete, determinism_mismatch
- exact span boundaries: 21/29 (72.4%)
- overlapping span detections: 27/29 (93.1%)
- boundary mismatches: 6/29 (20.7%)
- expected current-own spans detected: 21/22 (95.5%)
- expected code semantic top-1 / top-5: 9/22 (40.9%) / 12/22 (54.5%)
- expected code shadow top-1 / top-5: 9/22 (40.9%) / 12/22 (54.5%)
- strict / shadow joint eligible spans: 0/22 (0.0%) / 1/22 (4.5%)
- strict / shadow billable inclusion: 0/22 (0.0%) / 1/22 (4.5%)
- strict / shadow standing facts: n/a / n/a
- strict / shadow safe exclusions: 0/7 (0.0%) / 1/7 (14.3%)

This diagnostic run is for bottleneck discovery only. It cannot be used as promotion evidence, even when every sampled case succeeds.

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.
