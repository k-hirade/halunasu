# mock HOMIS 行為欄カバレッジ

- status: failed
- generatedAt: 2026-07-30T22:29:14.773Z
- claimMonths: 2026-06
- caseCount: 16
- repeatCount: 2
- actCoverageRecall: 97.40%
- billableReadyMatchRate: 57.14%
- confirmedBillableRate: 38.96%
- commentDetectionRate: 0.00%
- commentGeneratedCount: 0
- commentInputRequiredCount: 0
- falseProposalCount: 89
- dangerousFalsePositiveCount: 0
- candidatePrecision: 29.61%
- mappedReferencePointTotal: 68925
- billableReadyExpectedPointTotal: 11025
- detectedBillableReadyPointTotal: 11025
- pointTotalsMatch: true
- deterministicOutputs: true
- standingLaneObservedRuns: 16
- standingLaneDisabledReasons: none
- standingLaneTopReasons: required_positive_fact_missing=142, parent_family_missing=102, matched=60
- standingLaneTopMissingFacts: clinical.deviceTypes=43, clinical.explicitMedicationReductionTwoOrMore=16, clinical.hasNarcoticAnalgesicPrescription=16, encounter.monthlyVisitDayCount=16, encounter.residenceType=16, encounter.withinThreeMonthsOfPatientStart=16, clinical.hasCancerPainDiagnosis=15, care.ictCoordination=13

行為欄は評価専用であり、算定APIへの入力には使用していません。
患者名とカルテ本文は保存せず、本文はSHA-256のみを記録しています。
採用不可・区分未確定の候補はactCoverageRecallには含めますが、billableReadyMatchRateと点数合計には含めません。
コメント検知は構造化comments/noticesのtargetCode・commentCode・statusを優先します。generatedとinput_requiredはいずれも義務検知として数え、状態別件数を別記します。
