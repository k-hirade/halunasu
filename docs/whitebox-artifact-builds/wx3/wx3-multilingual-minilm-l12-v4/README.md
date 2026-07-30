# WX3 Context Artifact Build

- artifact: `wx3-multilingual-minilm-l12-v4`
- model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@86741b4e3f5cb7765a600d3a3d55a0f6a6cb443d`
- input contract: 4
- clause segmentation: `fee-evidence-clause-v2`
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
| actionStatus | 0.0790 | 0.3483 | 0.0161 | 0.0000 | 0.0256 | 0.956164 |
| temporalRelation | 0.3870 | 0.5309 | 0.0053 | 0.0055 | 0.0192 | 0.977810 |
| sourceOrigin | 0.2187 | 0.3511 | 0.0000 | 0.0000 | 0.0244 | 0.996727 |
| providerOwnership | 0.0850 | 0.1348 | 0.0208 | 0.0000 | 0.0113 | 0.992536 |
| standingStatus | 0.4391 | 0.8371 | 0.0302 | 0.0095 | 0.0267 | 0.891584 |

Holdout labels were not read by the builder. Promotion requires separate holdout and counterexample gates.
