# 縦断患者コンテキスト STG再計測

- 実行日時: 2026-07-22T06:44:59.580Z
- Cloud Run revision: fee-api-stg-00166-7zk
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
| exact_copy_forward | fail | 100% | 0 | 0 | あり |
| partial_p_change | pass | 75% | 1 | 1 | あり |
| visit_facts_new_outside_prescription | fail | 75% | 1 | 1 | あり |
| removed_performed_act | fail | 100% | 0 | 1 | あり |
| all_lines_new | pass | 0% | 4 | 4 | あり |

詳細な確定明細・候補差分・visit_facts・trace・使用量は [result.json](./result.json) に保存しています。

## 指標の注意

この制御データはlineKey一致率を意図的に作っています。ここで得られるLLM削減率は機構の上限性能であり、実運用の実効値ではありません。顧客カルテのcopy-forward率（Do記載率）は実データで再計測するまで不明です。UKE一致も既存請求の再現率であり、制度上の正解率とは分けて扱います。
