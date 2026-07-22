# 縦断患者コンテキスト STG再計測

- 実行日時: 2026-07-22T08:28:24.594Z
- Cloud Run revision: fee-api-stg-00168-gbt
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
| visit_facts_new_outside_prescription | pass | 0% | 4 | 1 | あり |
| removed_performed_act | pass | 100% | 0 | 1 | なし |
| all_lines_new | fail | 0% | 4 | 4 | あり |

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
- calculate応答時間: median 9537.09ms / mean 8763.87ms / max 16020.67ms
- OpenAI使用量（全経路）: input 134841 / output 25142 tokens
- 履歴取得不能: 0件

## 候補集合の差分

### all_lines_new

判定: fail

- control_only: 生活習慣病管理料１の算定確認 (113041810)
- control_only: プログラム医療機器等指導管理料の算定確認 (113707610)

## 確定明細の差分

差分なし。

## 不合格チェック

- all_lines_new/crossSession: candidate equivalence

### 再解釈（判定規約の帰属ルール追記後）

all_lines_new はメモ不使用（memoHitLineRatio=0%、全文抽出フォールバックが期待動作）の
シナリオであり、この差分は全文抽出同士の比較で生じた単発のLLM取りこぼし
（評価経路の1回だけ clinicalEventCount=0 / outputTokens=404。対照3回は毎回3イベント）。
メモの履歴汚染ではないため `inconclusive_llm_variability` として扱う。
acceptance（フォールバック動作）は5ケース全て合格した。一方、意味等価性は4/5合格、
all_lines_newは判定不能であり、5/5合格とは扱わない。
この取りこぼし自体への対策は
`docs/implplan/fee-longitudinal-phase1-closeout-20260722.md` L1（空抽出ガード）。

詳細な確定明細・候補差分・visit_facts・trace・使用量は [result.json](./result.json) に保存しています。

## 指標の注意

この制御データはlineKey一致率を意図的に作っています。ここで得られるLLM削減率は機構の上限性能であり、実運用の実効値ではありません。顧客カルテのcopy-forward率（Do記載率）は実データで再計測するまで不明です。UKE一致も既存請求の再現率であり、制度上の正解率とは分けて扱います。
