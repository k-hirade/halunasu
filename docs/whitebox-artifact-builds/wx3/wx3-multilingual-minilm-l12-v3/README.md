# WX3 Context Artifact Build

- artifact: `wx3-multilingual-minilm-l12-v3`
- model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@86741b4e3f5cb7765a600d3a3d55a0f6a6cb443d`
- selected epoch: 6
- pooling: `mean`
- class weighting: `sqrt_inverse`
- calibration: `onnx_runtime`
- train/development: 288 / 96 cases
- holdout withheld: 16 cases
- counterexample texts withheld: 6
- deterministic runs: 100

| axis | macro F1 | coverage | risk | dangerous FP | ECE | threshold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| actionStatus | 0.3180 | 0.7051 | 0.0000 | 0.0000 | 0.0099 | 0.955472 |
| temporalRelation | 0.2676 | 0.3961 | 0.0071 | 0.0055 | 0.0217 | 0.985346 |
| sourceOrigin | 0.2755 | 0.5421 | 0.0052 | 0.0000 | 0.0169 | 0.993759 |
| providerOwnership | 0.7132 | 0.9073 | 0.0093 | 0.0000 | 0.0079 | 0.967436 |
| standingStatus | 0.4001 | 0.8202 | 0.0240 | 0.0095 | 0.0288 | 0.920918 |

Holdout labels were not read by the builder. Promotion requires separate holdout and counterexample gates.
