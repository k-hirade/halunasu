# Fee White-box Runtime Measurement

- measured at: `2026-07-26T11:12:53.017736Z`
- platform: `Darwin arm64`
- peak RSS: **1304.2 MiB**
- artifact files: **1334.96 MiB**
- span p95: 266.189 ms
- linker p95: 750.485 ms
- context p95: 675.668 ms
- three-lane local p95 sum: **1692.342 ms**

This is a single-process local measurement. The peak excludes the rest of fee-api and request concurrency, so Cloud Run needs operational headroom. The STG promotion gate still requires the 32-cell shadow run and independent adjudication.
