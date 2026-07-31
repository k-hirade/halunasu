# mock HOMIS 行為欄カバレッジ

- status: complete
- generatedAt: 2026-07-30T15:27:38.891Z
- claimMonths: 2026-06
- caseCount: 16
- repeatCount: 2
- actCoverageRecall: 87.01%
- billableReadyMatchRate: 57.14%
- confirmedBillableRate: 38.96%
- commentDetectionRate: 0.00%
- falseProposalCount: 42
- dangerousFalsePositiveCount: 0
- candidatePrecision: 38.14%
- mappedReferencePointTotal: 68925
- billableReadyExpectedPointTotal: 11025
- detectedBillableReadyPointTotal: 11025
- pointTotalsMatch: true
- deterministicOutputs: true
- standingLaneObservedRuns: 16
- standingLaneDisabledReasons: none
- standingLaneTopReasons: required_positive_fact_missing=131, parent_family_missing=122, matched=51
- standingLaneTopMissingFacts: clinical.deviceTypes=43, clinical.explicitMedicationReductionTwoOrMore=16, clinical.hasNarcoticAnalgesicPrescription=16, encounter.residenceType=16, clinical.hasCancerPainDiagnosis=15, encounter.monthlyVisitDayCount=12, encounter.withinThreeMonthsOfPatientStart=12, care.ictCoordination=9

行為欄は評価専用であり、算定APIへの入力には使用していません。
患者名とカルテ本文は保存せず、本文はSHA-256のみを記録しています。
採用不可・区分未確定の候補はactCoverageRecallには含めますが、billableReadyMatchRateと点数合計には含めません。
