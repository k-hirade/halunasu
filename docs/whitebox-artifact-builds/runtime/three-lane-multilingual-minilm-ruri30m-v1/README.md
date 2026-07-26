# Fee White-box Runtime Measurement

- measured at: `2026-07-25T15:58:16.912780Z`
- platform: `Darwin arm64`
- peak RSS: **1620.97 MiB**
- artifact files: **1334.96 MiB**
- span p95: 223.333 ms
- linker p95: 400.856 ms
- context p95: 233.005 ms
- three-lane local p95 sum: **857.194 ms**

This is a single-process local measurement. The peak excludes the rest of fee-api and request concurrency, so Cloud Run needs operational headroom. The STG promotion gate still requires the 32-cell shadow run and independent adjudication.
