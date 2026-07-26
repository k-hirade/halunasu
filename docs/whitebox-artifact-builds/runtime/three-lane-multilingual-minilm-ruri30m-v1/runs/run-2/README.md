# Fee White-box Runtime Measurement

- measured at: `2026-07-25T15:59:16.045092Z`
- platform: `Darwin arm64`
- peak RSS: **1620.19 MiB**
- artifact files: **1334.96 MiB**
- span p95: 285.595 ms
- linker p95: 545.695 ms
- context p95: 420.868 ms
- three-lane local p95 sum: **1252.158 ms**

This is a single-process local measurement. The peak excludes the rest of fee-api and request concurrency, so Cloud Run needs operational headroom. The STG promotion gate still requires the 32-cell shadow run and independent adjudication.
