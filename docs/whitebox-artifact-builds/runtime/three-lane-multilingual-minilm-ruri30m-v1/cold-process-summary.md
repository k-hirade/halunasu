# Three-lane Cold-process Summary

- independent processes: 3
- inference repeats per process: 10
- artifact files: 1,399,804,036 bytes
- peak RSS: 1,619.86 / 1,620.19 / **1,650.53 MiB**
- local three-layer p95 sum: 984.102 / 1,252.158 / 1,226.786 ms
- promotion latency gate: 500 ms

## Decision

The existing fee-api default of `4Gi` is retained for STG. It leaves operational
headroom above the measured 1,650.53 MiB model-process peak for Node, the fee
master, Python, and request concurrency.

The local latency result does **not** pass the promotion gate. This is not a
reason to loosen the gate. The three models may run in `shadow`, but `route`,
`propose`, and `assist` promotion remain blocked until end-to-end STG telemetry
and independent adjudication pass the predeclared policy.

These controlled synthetic measurements show mechanism capacity, not an
effective customer routable rate or copy-forward rate.
