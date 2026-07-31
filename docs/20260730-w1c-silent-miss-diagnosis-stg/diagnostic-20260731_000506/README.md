# mock HOMIS 行為欄カバレッジ

- status: complete
- generatedAt: 2026-07-30T15:05:17.310Z
- claimMonths: 2026-06
- caseCount: 16
- repeatCount: 1
- actCoverageRecall: 67.53%
- billableReadyMatchRate: 55.84%
- confirmedBillableRate: 38.96%
- commentDetectionRate: 0.00%
- falseProposalCount: 38
- dangerousFalsePositiveCount: 0
- candidatePrecision: 31.88%
- mappedReferencePointTotal: 68925
- billableReadyExpectedPointTotal: 10875
- detectedBillableReadyPointTotal: 10875
- pointTotalsMatch: true
- deterministicOutputs: true
- standingLaneObservedRuns: 16
- standingLaneDisabledReasons: none
- standingLaneTopReasons: parent_family_missing=172, required_positive_fact_missing=111, matched=21
- standingLaneTopMissingFacts: clinical.deviceTypes=43, clinical.currentManagementOrCounselingCount=28, clinical.explicitMedicationReductionTwoOrMore=16, clinical.hasNarcoticAnalgesicPrescription=16, encounter.residenceType=16, clinical.hasCancerPainDiagnosis=15, care.ictCoordination=2, encounter.monthlyVisitDayCount=2

行為欄は評価専用であり、算定APIへの入力には使用していません。
患者名とカルテ本文は保存せず、本文はSHA-256のみを記録しています。
採用不可・区分未確定の候補はactCoverageRecallには含めますが、billableReadyMatchRateと点数合計には含めません。
