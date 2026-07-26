# WX1 Development Category Coverage

This note separates measured model failures from categories that have no
positive development examples. A displayed F1 of zero is not sufficient to
distinguish those cases.

## Measured failures

| category | positive support | true positive | false negative | F1 | interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| `imaging` | 17 | 0 | 17 | 0.0000 | measured recall failure |
| `treatment` | 19 | 0 | 19 | 0.0000 | measured recall failure |

These categories are valid WX4 data-expansion targets.

## Unmeasured categories

| category | positive support | prediction count | interpretation |
| --- | ---: | ---: | --- |
| `material` | 0 | 0 | unmeasured |
| `other` | 0 | 0 | unmeasured |
| `outpatient_basic` | 0 | 0 | unmeasured |
| `pathology` | 0 | 0 | unmeasured |

These rows are coverage gaps, not evidence that the model failed. They require
reviewed development examples before an F1 claim can be made.

The WX1 builder now emits `positiveSupport`, `predictionCount`, and
`qualityStatus` for every category so future artifacts cannot collapse these
two states into the same zero.
