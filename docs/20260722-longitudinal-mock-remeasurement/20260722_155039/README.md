# 縦断患者コンテキスト STG再計測

- 実行日時: 2026-07-22T06:54:54.377Z
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
| exact_copy_forward | pass | 100% | 0 | 0 | なし |
| partial_p_change | pass | 75% | 1 | 1 | あり |
| visit_facts_new_outside_prescription | fail | 75% | 1 | 1 | あり |
| removed_performed_act | pass | 100% | 0 | 1 | なし |
| all_lines_new | pass | 0% | 4 | 4 | あり |

## 完全一致再計算の2経路

| 経路 | メモ受入 | 全文対照との等価性 | memoHitLineRatio | OpenAI呼出し数 |
| --- | --- | --- | ---: | ---: |
| crossSession | pass | pass | 100% | 0 |
| sameSession | pass | pass | 100% | 0 |

## 対照経路と性能

- 全文対照の実行回数: 3回/ケース（合計15呼出し）
- 対照内で確定明細または候補集合が揺れたケース: 0件
- メモ経路のOpenAI呼出し: 3回
- 等価性判定: 不合格あり
- calculate応答時間: median 8581.21ms / mean 7848.48ms / max 11556.11ms
- OpenAI使用量（全経路）: input 133995 / output 23867 tokens
- 履歴取得不能: 0件

## 候補集合の差分

### visit_facts_new_outside_prescription

判定: pass_with_known_limit

- memo_only: 調剤料（内服薬・浸煎薬・屯服薬） (120000710)
- memo_only: 処方料（その他） (120001210)
- control_only: 処方箋料（リフィル以外・その他） (120002910)
- memo_only: 特定疾患処方管理加算の確認 (120005610)
- control_only: 特定疾患処方管理加算の確認 (120005710)

## 確定明細の差分

### visit_facts_new_outside_prescription

- memo_only: アムロジピンＯＤ錠２．５ｍｇ「トーワ」 (620007817) / 30回 / 32点

## 不合格チェック

- visit_facts_new_outside_prescription/crossSession: confirmed equivalence

詳細な確定明細・候補差分・visit_facts・trace・使用量は [result.json](./result.json) に保存しています。

## 指標の注意

この制御データはlineKey一致率を意図的に作っています。ここで得られるLLM削減率は機構の上限性能であり、実運用の実効値ではありません。顧客カルテのcopy-forward率（Do記載率）は実データで再計測するまで不明です。UKE一致も既存請求の再現率であり、制度上の正解率とは分けて扱います。
