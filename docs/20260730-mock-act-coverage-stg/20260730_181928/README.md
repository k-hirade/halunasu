# mock HOMIS 行為欄カバレッジ

- status: complete
- generatedAt: 2026-07-30T09:19:38.857Z
- claimMonths: 2026-06, 2026-07
- caseCount: 52
- repeatCount: 2
- actCoverageRecall: 58.90%
- billableReadyMatchRate: 58.47%
- confirmedBillableRate: 41.10%
- commentDetectionRate: 0.00%
- falseProposalCount: 83
- dangerousFalsePositiveCount: 5
- candidatePrecision: 26.42%
- mappedReferencePointTotal: 172986
- billableReadyExpectedPointTotal: 33817
- detectedBillableReadyPointTotal: 33613
- pointTotalsMatch: false
- deterministicOutputs: false

行為欄は評価専用であり、算定APIへの入力には使用していません。
患者名とカルテ本文は保存せず、本文はSHA-256のみを記録しています。
採用不可・区分未確定の候補はactCoverageRecallには含めますが、billableReadyMatchRateと点数合計には含めません。
