# mock HOMIS 行為欄カバレッジ

- status: complete
- generatedAt: 2026-08-05T12:20:04.713Z
- claimMonths: 2026-06, 2026-07
- caseCount: 52
- repeatCount: 1
- actCoverageRecall: 86.02%
- billableReadyMatchRate: 58.05%
- confirmedBillableRate: 41.10%
- commentDetectionRate: 100.00%
- commentGeneratedCount: 0
- commentInputRequiredCount: 0
- falseProposalCount: 477
- dangerousFalsePositiveCount: 7
- candidatePrecision: 14.85%
- mappedReferencePointTotal: 174526
- billableReadyExpectedPointTotal: 37777
- detectedBillableReadyPointTotal: 37573
- pointTotalsMatch: false
- completedRepeatCount: 1/1
- repeatCoverageComplete: true
- deterministicOutputs: false
- rateLimitRetryCount: 0
- standingLaneObservedRuns: 52
- standingLaneDisabledReasons: none
- standingLaneTopReasons: required_positive_fact_missing=420, parent_family_missing=354, matched=214
- standingLaneTopMissingFacts: clinical.deviceTypes=141, clinical.hasNarcoticAnalgesicPrescription=52, encounter.residenceType=52, clinical.explicitMedicationReductionTwoOrMore=50, clinical.hasCancerPainDiagnosis=47, care.ictCoordination=38, encounter.withinThreeMonthsOfPatientStart=38, encounter.monthlyVisitDayCount=30

行為欄は評価専用であり、算定APIへの入力には使用していません。
患者名とカルテ本文は保存せず、本文はSHA-256のみを記録しています。
採用不可・区分未確定の候補はactCoverageRecallには含めますが、billableReadyMatchRateと点数合計には含めません。
コメント検知は構造化comments/noticesのtargetCode・commentCode・statusを優先します。generatedとinput_requiredはいずれも義務検知として数え、状態別件数を別記します。
