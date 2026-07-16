# 候補安定化 T1〜T5 実装レビュー結果とフォローアップ (2026-07-16)

`docs/implplan/fee-candidate-stability-tickets-20260715.md` の実装に対するレビュー結果と、
レビューで見つかった残作業のチケット。

## レビュー結果: T1〜T5 承認

全チケットが仕様に準拠していることをコードレビューで確認し、完了ゲートを独立に再実行して再現した:

- fee-api 176 / fee-core 53 / fee-contracts 10 / medical-core 78 / Python 44 — 全パス
- seed-300 engine gold: exact 150/150(errors 0)
- fee-soap-e2e-v2 engine gold: exact 138/138
- 反例コーパス(病名駆動ケース含む)パス

仕様を超えて良かった点:

- **T1**: コード未確定候補の0点化を集計側でも強制(`points = code ? … : 0`)。生成元が誤って
  点数を渡しても月次合計に混入しない防御的設計。
- **T4**: `nyugai`/`utagai` の値意味を検証済み移植元(`recept-checker/r05_act_indication.py`)
  への参照付きでdocstringに明記(推測実装の回避)。
- **T4**: 置換ポリシーが安全側 — 実施イベント・辞書照合由来の候補(根拠が強い)は温存し、
  LLM抽出に揺れる知識レーン(`clinical_billing_knowledge:*`)だけを病名駆動候補で置換。
- **T3**: 外来管理加算ブロックが `!isHomeCareEncounter && !isInpatientEncounter` の外側ガード
  内にあることを確認済み。冗長条件の削除は挙動を変えない。

構造上の問題は見つからなかった。以下は残作業。

---

## F1. [小・T6の前に] 評価スクリプトに病名レーンの所要時間を記録する

### 現状

`scripts/evaluate_fee_monthly_chart_e2e.mjs` の `sanitizeCalculationMetrics`(505行付近)は
`clinicalStructuring` / `ruleBasedClinicalInference` / `stageTimings` のみを通し、
今回追加された `metrics.diseaseIndicationScan`(clinical-calculation-input.js 761行付近で記録)
を落としている。T6でレイテンシ増が出たとき、病名レーン起因かを帰属できない。

### 変更仕様

`sanitizeCalculationMetrics` の返り値に追加:

```js
diseaseIndicationScanMs: Number(metrics.diseaseIndicationScan?.durationMs || 0),
diseaseIndicationCandidateCount: Number(metrics.diseaseIndicationScan?.candidateCount || 0),
diseaseIndicationFailed: metrics.diseaseIndicationScan?.failed === true || undefined
```

`summarizePerformance` の集計対象にも `diseaseIndicationScanMs` を加える(中央値/最大)。

### 受け入れ条件

- T6のraw結果に病名レーンの所要時間が患者Run単位で記録される。

---

## F2. [T6実施後・中] 知識ルールの段階的撤廃 — ただし対象は実データで個別判定する

### 重要な前提(実マスタで検証済み)

「病名レーンが安定稼働したら知識ルール10件を段階撤廃」という当初想定は**そのままでは成立しない**。
`cc_act_indications` の行為prefix分布を確認した結果:

| prefix | 適応データを持つ行為数 |
| --- | ---: |
| 160(検査) | 695 |
| 150(手術) | 529 |
| 140(処置) | 138 |
| 180(その他) | 81 |
| **113(医学管理)** | **63** |
| **114(在宅指導管理)** | **ほぼ0** |

知識ルールの対象コードを個別確認したところ、適応病名データを持つのは
`113001810`(特定疾患療養管理料、4,003病名)と `113002850`(110病名)のみで、
**在宅系(C101自己注射/C103在宅酸素/C107_2 CPAP=114系)と、がん性疼痛緩和指導管理料
(113012810)には適応行が存在しない**。つまり病名レーンはこれらを代替できない。

### 作業内容

1. 各ルールについて「解決コード(codeCandidates含む)が `cc_act_indications` に適応行を持つか」を
   スクリプトで機械判定し、結果を本ファイルに追記する。
2. **適応行があり、かつT6で病名レーンが同候補を安定提示したルールのみ削除**する
   (現時点の見込みでは特定疾患療養管理料に相当するルールは存在しないため、削除対象は
   ほぼ無い可能性が高い。その場合「撤廃せず併存が正」でクローズしてよい)。
3. 適応行が無いルール(在宅系・がん性疼痛等)は**維持**し、ルール冒頭コメントに
  「病名レーン代替不可(cc_act_indicationsに適応なし)」と根拠を書く。

### 受け入れ条件

- 全10ルールに「病名レーン代替可否」の判定記録が残り、削除/維持の根拠が明文化されている。

---

## F3. [P2・小] 初診/再診判定の残存LLM依存(外来管理加算候補の揺れ残り)

### 現状

T3で外来管理加算候補は `fee_kind === "revisit"` の決定論条件になったが、`fee_kind` 自体は

- 患者ID+受診歴があるとき: 履歴上書きで決定論(`inferOutpatientBasicFromPatientHistory`)
- **患者IDまたは履歴が無いとき: LLMの `visit_type` 由来**

のため、履歴の無い患者では visit_type の抽出揺れが候補の有無に伝播しうる(T6は履歴seed
ありで測るため顕在化しない。顕在化するのは新規患者の初回受診)。

### 変更仕様(いずれか)

- 案A(推奨・小): 本文の決定論手掛かり(「初診」「再診」「初めて」等の表記)で visit_type を
  先に確定し、手掛かりが無いときだけLLM判定を使う。判定根拠(history/text/llm)を
  trace に記録する。
- 案B: fee_kind が LLM由来のときも外来管理加算候補を常に提示し、conditionText に
  「初診の場合は算定できません」を追記する(候補の存在は安定するが初診時ノイズになる)。

### 受け入れ条件

- 履歴なし患者の同一カルテ3反復で外来管理加算候補の有無が揺れない。

---

## F4. [判断記録・作業なし] 病名レーンのprefix拡大は保留する

`act_code_prefixes` を 160/150/140(検査・手術・処置)へ広げる案は**保留**とする。根拠:

- 適応データの大半は検査・手術系で、病名→検査の逆引きは「実施していない検査」を大量に
  候補化するノイズ源になる(検査・処置は実施事実ベースのイベント/辞書レーンが担当)。
- 患者1012の未検知コード(180016110/180725810/180725910/114系)は**適応行を持たない**ことを
  確認済みで、prefix拡大では届かない。1012の在宅系未検知の残りは
  ①入力契約(T6の home_visit 区分+施設基準)と②本文側照合(改革2第2段=埋め込み/文字重なり)の領域。

再検討する場合は、ノイズ計測(一般外来カルテでの誤候補数)とセットで行うこと。

---

## F5. [P2・中] 候補採用時の決定論再検証

外部レビュー原提言の未消化分。「人が候補を採用するときも、併算定不可行為・回数上限・
年齢/性別・マスタ有効期間を決定論的に再検証すべき」。

### 現状

- 月次集計の `conflicts` / `frequencyLimits` 注釈(fee-core)が表示上の警告として存在する。
- しかし採用操作(candidateLine の確定明細化)自体は検証なしで通る。

### 変更仕様(概要 — 着手時に詳細化)

1. fee-api に採用前検証を追加: 採用対象コード+当月確定明細を入力に、
   電子点数表背反(`electronic_exclusions`、特例=1は警告のみ)・回数上限
   (`electronic_frequency_limits`)・年齢/性別・適用期間を既存エンジン機構
   (`apply_electronic_consistency` 相当のチェック側API)で判定する。
2. 違反時は採用をブロックせず `review_required` として理由つきで返す
   (最終判断は人。ただし理由の明示は必須)。
3. コード未確定(codeCandidates)候補の採用時は区分選択を必須にする(現状 `canAdopt=false` の
   維持を確認)。

### 受け入れ条件

- 背反する確定明細がある状態で候補を採用すると、理由つきの確認が返る。

---

## 次のアクション順序

1. **F1**(小、T6の計測精度のため先に入れる)
2. **T6**(STG再計測 — 手順は `fee-candidate-stability-tickets-20260715.md` T6のとおり。
   候補点数KPIは0点化仕様変更後の値になることをREADMEに明記)
3. T6の結果を見て F2(判定記録)/F3(揺れが実測されたら)/F5 の順で着手
