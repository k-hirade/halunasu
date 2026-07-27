# WX1 Span Artifact Build

- artifact: `wx1-multilingual-minilm-l12-v2`
- model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42`
- selected epoch: 4
- train/development: 288 / 96 cases
- holdout withheld: 16 cases
- relevance accuracy: 0.9941
- exact entity F1: 0.8477
- exact boundary matches: 309 / 356
- boundary mismatches: 36
- deterministic runs: 100

| category | positive support | precision | recall | F1 | status |
| --- | ---: | ---: | ---: | ---: | --- |
| counseling | 24 | 0.9091 | 0.8333 | 0.8696 | measured |
| exam | 168 | 0.8012 | 0.7679 | 0.7842 | measured |
| imaging | 369 | 1.0000 | 0.9946 | 0.9973 | measured |
| injection | 36 | 1.0000 | 0.8889 | 0.9412 | measured |
| lab | 101 | 0.9318 | 0.8119 | 0.8677 | measured |
| management | 28 | 1.0000 | 0.7500 | 0.8571 | measured |
| material | 0 | 0.0000 | 0.0000 | 0.0000 | unmeasured |
| medication | 699 | 0.9774 | 0.9900 | 0.9837 | measured |
| other | 0 | 0.0000 | 0.0000 | 0.0000 | unmeasured |
| outpatient_basic | 0 | 0.0000 | 0.0000 | 0.0000 | unmeasured |
| pathology | 0 | 0.0000 | 0.0000 | 0.0000 | unmeasured |
| procedure | 151 | 0.9267 | 0.9205 | 0.9236 | measured |
| treatment | 211 | 1.0000 | 0.9810 | 0.9904 | measured |

`unmeasured` means that development contained no positive token for the category; it is not evidence of model failure or success.

This report does not evaluate or expose holdout labels. Promotion remains a separate human decision.
