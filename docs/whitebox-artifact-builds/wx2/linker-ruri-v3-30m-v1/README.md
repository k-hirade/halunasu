# WX2 Master Linker Artifact

- artifact: `fee_master_linker/ca0b72af0ea8ed861525941e`
- model: `cl-nagoya/ruri-v3-30m@24899e5de370b56d179604a007c0d727bf144504`
- source master: `26737b6719ede79ea0ba532a3ac91cc8c5a2ecacbe3af040b73de21bcb3376d1`
- documents: 57,925
- embedding dimension: 256
- license: Apache-2.0

## Selection result

The development set contains 228 reviewed spans. Exact-alias recall@5 was
32.46%. Ruri recall@5 was 57.89%, an absolute improvement of 25.44 percentage
points. This exceeds the predeclared 10-point selection threshold.

The final ONNX/SQLite runtime was evaluated separately with the same 228
queries. It preserved recall@1 at 37.72% and recall@5 at 57.89%. This confirms
that query/document prefixes, ONNX export, SQLite serialization, and runtime
category adjustment do not reduce top-five recall.

This is not a production-activation result. The artifact is accepted only for
three-lane STG shadow. Promotion still requires the 32-cell telemetry and
independently adjudicated precision/recall gate.

## Reproducibility

The index uses one document per master code and the same normalized alias
concatenation used by the E4 evaluation. Runtime parity was checked on eight
probes with a minimum cosine of 1.0 against a required minimum of 0.999.

The 419 MB runtime payload is intentionally excluded from Git. The tracked
manifest declares SHA-256 for the SQLite index, ONNX model, and tokenizer. It
must be uploaded to the immutable GCS artifact registry before deployment.
