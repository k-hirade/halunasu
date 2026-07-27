# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260726135911458-912b48`
- status: **complete**
- revision: `fee-api-stg-00190-886`
- measurement cases: 12 / 12
- total calculations: 12 / 12
- determinism controls: 0 / 0 exact
- cells: 12 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no
- expected current-own spans detected: 14/34 (41.2%)
- expected code semantic top-1 / top-5: 4/34 (11.8%) / 5/34 (14.7%)
- expected code shadow top-1 / top-5: 4/34 (11.8%) / 5/34 (14.7%)
- strict / shadow joint eligible spans: 0/34 (0.0%) / 0/34 (0.0%)

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.
