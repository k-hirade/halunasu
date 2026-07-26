# WX3 Context Artifact Build

- artifact: `wx3-multilingual-minilm-l12-v1`
- model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@86741b4e3f5cb7765a600d3a3d55a0f6a6cb443d`
- selected epoch: 6
- train/development: 224 / 64 cases
- holdout withheld: 16 cases
- counterexample texts withheld: 6
- deterministic runs: 100

| axis | macro F1 | coverage | risk | dangerous FP | ECE | threshold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| actionStatus | 0.4801 | 0.8640 | 0.0203 | 0.0000 | 0.0426 | 0.88 |
| temporalRelation | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0112 | 1.00 |
| sourceOrigin | 0.1623 | 0.9035 | 0.0000 | 0.0000 | 0.0288 | 0.96 |
| providerOwnership | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0153 | 1.00 |
| standingStatus | 0.4631 | 1.0000 | 0.0482 | 0.0053 | 0.0247 | 0.50 |

Holdout labels were not read by the builder. Promotion requires separate holdout and counterexample gates.
