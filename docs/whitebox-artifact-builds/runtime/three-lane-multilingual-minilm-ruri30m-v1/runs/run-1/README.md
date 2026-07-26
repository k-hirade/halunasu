# Fee White-box Runtime Measurement

- measured at: `2026-07-25T15:58:50.029703Z`
- platform: `Darwin arm64`
- peak RSS: **1619.86 MiB**
- artifact files: **1334.96 MiB**
- span p95: 269.43 ms
- linker p95: 363.497 ms
- context p95: 351.175 ms
- three-lane local p95 sum: **984.102 ms**

This is a single-process local measurement. The peak excludes the rest of fee-api and request concurrency, so Cloud Run needs operational headroom. The STG promotion gate still requires the 32-cell shadow run and independent adjudication.
