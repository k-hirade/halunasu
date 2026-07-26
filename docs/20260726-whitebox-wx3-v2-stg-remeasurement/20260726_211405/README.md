# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260726121405775-54c916`
- status: **complete**
- revision: `fee-api-stg-00189-jtt`
- measurement cases: 8 / 8
- total calculations: 8 / 8
- determinism controls: 0 / 0 exact
- cells: 8 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.
