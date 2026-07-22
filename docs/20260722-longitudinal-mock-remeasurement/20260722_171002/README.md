# 縦断患者コンテキスト STG再計測

- 実行日時: 2026-07-22T08:15:31.984Z
- Cloud Run revision: fee-api-stg-00167-mj5
- 対照経路: 同一入力を新規の合成患者へ全文投入、各ケース3回
- 履歴取得不能: 0件

## 合格基準

- 確定明細はコード・名称・数量・点数が対照経路と完全一致すること。
- 候補集合の差分は全件記録し、既知のvisit_facts制約に由来する処方関連差分以外は許容しない。
- 対照3回自体が揺れた場合は、メモの不具合と断定せず「対照揺れのため判定不能」とする。
- 履歴障害はSTGへ故意に注入しない。fail-closedはユニットテスト、STGはunavailableが0件であることを確認する。

## 結果

| ケース | 判定 | memoHitLineRatio | 新規行 | 消失行 | OpenAI呼出し |
| --- | --- | ---: | ---: | ---: | --- |
| exact_copy_forward | fail | 0% | 4 | 0 | あり |
| partial_p_change | fail | 0% | 4 | 0 | あり |
| visit_facts_new_outside_prescription | fail | 0% | 4 | 0 | あり |
| removed_performed_act | fail | 0% | 4 | 0 | あり |
| all_lines_new | fail | 0% | 4 | 0 | あり |

## 完全一致再計算の2経路

| 経路 | メモ受入 | 全文対照との等価性 | memoHitLineRatio | OpenAI呼出し数 |
| --- | --- | --- | ---: | ---: |
| crossSession | fail | pass | 0% | 1 |
| sameSession | fail | pass | 0% | 1 |

## 対照経路と性能

- 全文対照の実行回数: 3回/ケース（合計15呼出し）
- 対照内で確定明細または候補集合が揺れたケース: 1件
- メモ経路のOpenAI呼出し: 6回
- 等価性判定: 不合格あり
- calculate応答時間: median 10063.92ms / mean 11695.72ms / max 60766.6ms
- OpenAI使用量（全経路）: input 147563 / output 28323 tokens
- 履歴取得不能: 0件

## 候補集合の差分

### partial_p_change

判定: inconclusive_control_variability

- memo_only: 生活習慣病管理料１の算定確認 (113041810)
- memo_only: プログラム医療機器等指導管理料の算定確認 (113707610)

## 確定明細の差分

差分なし。

## 不合格チェック

- exact_copy_forward/crossSession: memoUsed
- exact_copy_forward/crossSession: memoHitLineRatio
- exact_copy_forward/crossSession: continuedLineCount
- exact_copy_forward/crossSession: newLineCount
- exact_copy_forward/crossSession: noOpenAiCall
- exact_copy_forward/sameSession: memoUsed
- exact_copy_forward/sameSession: memoHitLineRatio
- exact_copy_forward/sameSession: continuedLineCount
- exact_copy_forward/sameSession: newLineCount
- exact_copy_forward/sameSession: noOpenAiCall
- partial_p_change/crossSession: memoUsed
- partial_p_change/crossSession: memoHitLineRatio
- partial_p_change/crossSession: continuedLineCount
- partial_p_change/crossSession: newLineCount
- partial_p_change/crossSession: removedLineCount
- visit_facts_new_outside_prescription/crossSession: removedLineCount
- removed_performed_act/crossSession: memoUsed
- removed_performed_act/crossSession: memoHitLineRatio
- removed_performed_act/crossSession: continuedLineCount
- removed_performed_act/crossSession: newLineCount
- removed_performed_act/crossSession: removedLineCount
- removed_performed_act/crossSession: noOpenAiCall
- removed_performed_act: removedLineRecorded
- all_lines_new/crossSession: removedLineCount

詳細な確定明細・候補差分・visit_facts・trace・使用量は [result.json](./result.json) に保存しています。

## 指標の注意

この制御データはlineKey一致率を意図的に作っています。ここで得られるLLM削減率は機構の上限性能であり、実運用の実効値ではありません。顧客カルテのcopy-forward率（Do記載率）は実データで再計測するまで不明です。UKE一致も既存請求の再現率であり、制度上の正解率とは分けて扱います。
