# Medical Fee Calculation

Migrated calculation engine from `halunasu-fee-calculation/src/medical_fee_calculation`.

The calculation engine should remain mostly independent from web/API storage concerns.

P5 keeps the package in `python/medical_fee_calculation` so `fee-api` can move to Platform auth and shared master data without copying old operator auth or tenant storage.
