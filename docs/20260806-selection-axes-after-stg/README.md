# mock HOMIS 行為欄カバレッジ

- status: failed
- generatedAt: 2026-08-05T12:14:29.528Z
- claimMonths: 2026-06, 2026-07
- caseCount: 0
- repeatCount: 1
- actCoverageRecall: n/a
- billableReadyMatchRate: n/a
- confirmedBillableRate: n/a
- commentDetectionRate: n/a
- commentGeneratedCount: 0
- commentInputRequiredCount: 0
- falseProposalCount: 0
- dangerousFalsePositiveCount: 0
- candidatePrecision: n/a
- mappedReferencePointTotal: 0
- billableReadyExpectedPointTotal: 0
- detectedBillableReadyPointTotal: 0
- pointTotalsMatch: false
- completedRepeatCount: 0/1
- repeatCoverageComplete: false
- deterministicOutputs: false
- rateLimitRetryCount: 0
- standingLaneObservedRuns: 0
- standingLaneDisabledReasons: none
- standingLaneTopReasons: none
- standingLaneTopMissingFacts: none

行為欄は評価専用であり、算定APIへの入力には使用していません。
患者名とカルテ本文は保存せず、本文はSHA-256のみを記録しています。
採用不可・区分未確定の候補はactCoverageRecallには含めますが、billableReadyMatchRateと点数合計には含めません。
コメント検知は構造化comments/noticesのtargetCode・commentCode・statusを優先します。generatedとinput_requiredはいずれも義務検知として数え、状態別件数を別記します。
