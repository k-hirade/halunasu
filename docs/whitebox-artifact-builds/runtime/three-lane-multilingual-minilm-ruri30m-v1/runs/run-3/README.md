# Fee White-box Runtime Measurement

- measured at: `2026-07-25T15:59:39.910634Z`
- platform: `Darwin arm64`
- peak RSS: **1650.53 MiB**
- artifact files: **1334.96 MiB**
- span p95: 261.05 ms
- linker p95: 591.439 ms
- context p95: 374.297 ms
- three-lane local p95 sum: **1226.786 ms**

This is a single-process local measurement. The peak excludes the rest of fee-api and request concurrency, so Cloud Run needs operational headroom. The STG promotion gate still requires the 32-cell shadow run and independent adjudication.
