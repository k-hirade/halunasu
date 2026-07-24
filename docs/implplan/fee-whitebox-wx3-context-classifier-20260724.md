# WX3: 文脈判定レイヤ(L3) — 時制・実施性の小型分類器 (2026-07-24)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)。前提: WX0のE5。

## 実装ステータス (2026-07-24)

多軸ONNX runtime、abstain、真理値表、決定論述語との合議、文字オフセットに基づく
span指定、span単位trace、mixed行集約、過去・他所・未実施の除外、
`calls/overrides/disagreements/modelVersion` metricsは実装済み。学習済み分類器と
精度・較正ゲートは未完了のため、`FEE_CONTEXT_CLASSIFIER_MODE`の既定値は`off`であり、
`assist`は未有効化。

## 意図

「その表現は当日この施設で実施されたのか」は算定の生死を分ける判定であり、
現在は ①LLMのline_role/checklist status ②決定論の語彙述語
(継続/否定/予定/過去・他院の正規表現群)の2层で扱っている。
①は揺れる、②は語彙の網羅に限界がある(「〜しておいた」「〜施行す」等の
言い換え、係り受けを跨ぐ否定)。この判定を**専用の小型分類器**に切り出す。
分類は生成より圧倒的に揺れず、決定論述語が取れない表現をAIが補う——
本計画の「ルールベースで取れない部分をAIで補う」の最小完結例。

## タスク定義(第1改訂: 多軸へ変更)

初版の排他的5値は既存契約と1:1でない(P1-2指摘)。現行契約は
`openai-fee-clinical-facts.js` で `ACTION_STATUSES`(performed/prescribed/
administered/ordered/planned/considered/instruction_only…)等を持ち、
line_role・standing_mentions・checklist statusと**複数軸**で意味を表す。
「継続処方」は当日処方(performed系)であると同時に継続管理でもあり、
単一5値では情報が落ちる。

入力: (行テキスト, 対象スパン, 前後1行の文脈)
出力: **既存契約のenumをそのまま予測する多軸分類**(第2改訂で値を実contractに一致):

```
action_status      : ACTION_STATUSES そのまま
                     (performed/prescribed/administered/ordered/planned/
                      considered/instruction_only/not_performed/unknown)
temporal_relation  : TEMPORAL_RELATIONS そのまま
                     (current_visit/same_day_but_unknown/past/future/unknown)
source_origin      : SOURCE_ORIGINS そのまま
                     (own_clinic_record/patient_reported/external_document/
                      carried_in_result/other_provider_record/unknown)
provider_ownership : PROVIDER_OWNERSHIPS そのまま
                     (own_clinic/same_institution_other_department/
                      other_provider/unknown)
standing_status    : standing_mentions.status そのまま + none
                     (continued/changed/stopped/none)
```

初版の `negated`→正しくは `not_performed`、`this_clinic`→`own_clinic`、
`patient_self`→ownershipではなく`source_origin.patient_reported`、
`same_day_but_unknown` の欠落、continuityの独自2値、はいずれも誤りだった
(レビュー指摘どおり)。

- **enumの一元管理(必須)**: 値の正は
  `packages/medical-core/src/fee/openai-fee-clinical-facts.js` の定数とする。
  実装タスク: ①これらをexportし、②`scripts/build_clinical_axes_schema.mjs` で
  JSON Schema生成物(`packages/medical-core/generated/clinical-axes.schema.json`)を
  作り、③python側(分類器・worker)とblueprint生成はこの生成物だけを読む。
  文書・python・promptでの値の重複定義を禁止し、生成物の鮮度は
  CIで検証する(定数変更→生成物未更新でテスト失敗)。
- **出力契約(第3改訂: abstainを構造化)**: `unknown` は「本文から判定不能」という
  **正しい判定**でもあるため、低確信(モデルが自信を持てない)とは別物。
  `standing_status=none` も「継続管理記載なし」という正の判定である。
  分類結果は軸ごとに3つ組で返す:
  ```
  {value: <軸enumの値>, confidence: 0..1, abstained: boolean}
  ```
  `abstained=true` は「confidenceが軸別閾値未満のため valueを主張しない」。
  `value=unknown ∧ abstained=false` は「判定不能と高確信で判定した」であり
  区別される。worker APIの `classify_context` 応答はこの3つ組を必須とする
  (confidenceなしでは下流の合議・ルーティングが実装不能)。

- **spanからの判定と行への集約(第4改訂で規約化)**: 分類は**span単位**で行い、
  各clinical_eventにはspan固有の軸値をそのまま残す(現行契約のイベントは既に
  `temporal_relation` / `source_origin` / `provider_ownership` フィールドを持つ
  `openai-fee-clinical-facts.js:380-382`。同じ場所に格納する)。
  `line_review.line_role` だけを行単位に集約する。
  「前回CTを確認し、本日は採血を実施」の行は、CT span=past・採血span=performedを
  イベントに保持しつつ line_role=performed になる。

- **span単位の真理値表(上から順に評価。第4改訂で評価順を修正——
  除外系を先に置かないと「前医で在宅酸素療法を継続中」がstandingに誤マッチする)**:

  | # | 条件(実enum) | span判定 |
  | --- | --- | --- |
  | 1 | いずれかの軸が `abstained=true` | **要LLM** |
  | 2 | temporal_relation = `same_day_but_unknown` | **要LLM**(当該受診内か断定禁止) |
  | 3 | action_status = not_performed | `excluded`(否定。降格ゲートの入力) |
  | 4 | temporal_relation = past ∨ provider_ownership = other_provider ∨ source_origin ∈ {patient_reported, external_document, carried_in_result, other_provider_record} | `excluded`(過去・他所。checklistのpast_or_external意味論と一致。**standing・plan判定より必ず先**) |
  | 5 | action_status ∈ {performed, prescribed, administered, instruction_only} ∧ temporal_relation = current_visit ∧ provider_ownership = own_clinic ∧ source_origin = own_clinic_record | `performed_span`(instruction_onlyを含む——v15プロンプトの「issued or instructed」と整合。action_status=instruction_onlyはイベントに保持し、下流が非算定・確認扱いを決める。**noneへ変えるならv16契約改定が必要であり本計画ではしない**) |
  | 6 | standing_status ∈ {continued, changed, stopped} ∧ temporal_relation = current_visit ∧ source_origin = own_clinic_record ∧ provider_ownership = own_clinic ∧ action_status ∉ {ordered, planned, considered} | `standing_span`(第5改訂: 全軸ガード。「次回から在宅酸素療法を継続予定」「次回、人工呼吸器管理を中止予定」はここに該当せず#7へ) |
  | 7 | temporal_relation = future ∨ action_status ∈ {ordered, planned, considered} | `plan_span` |
  | 8 | 上記いずれにも該当しない組合せ(軸間矛盾を含む) | **要LLM** |

  `same_institution_other_department` の扱い(自院他科=算定主体か)は
  一次資料(同一医療機関の取り扱い)を確認して#5に含めるか決め、
  出典コメント付きで確定する(推測で含めない)。

- **行の所有権(第5改訂)**: 要LLM行になった行の結果は**LLMが単独所有**する。
  同一行のencoder高確信イベントは採用せず、shadow/trace
  (`encoder_shadow_events`)にのみ残す(WX1の突合・WX4の教師シグナルには使う)。
  encoderとLLMの結果を同一行でmergeしない——採血・検査等の二重生成を
  構造的に防ぐ(mergeする将来案を採る場合は lineId+正規化イベント種別+
  リンク済みコード の決定論重複排除が前提条件)。
  `route=encoder` の行はencoder結果のみ、`route=llm` の行はLLM結果のみ。
- **行への集約規約**(spanの判定結果から line_role を決める):
  1. 行内に**要LLM span**が1つでもあれば行全体を要LLM行へ(WX1。
     所有権は上記のとおりLLM単独)。
  2. `performed_span` が1つでもあれば `line_role = performed`。
  3. なければ `standing_span` があれば `management_continuation`
     (standing_mentionsはこの場合のみ生成)。
  4. なければ `plan_span` があれば `plan`。
  5. すべて `excluded` または spanなし(かつ行関連性判定が「関連なし」)は `none`。
- 降格ゲート: #3・#4が既存の決定論述語ゲートへの入力になる
  (述語は安全網として恒久併置。WX3 §2の合議規約どおり)。
- 必須テストケース: 「前医で在宅酸素療法を継続中」→ #4でexcluded、
  standing_mentions**非生成**。「前回CTを確認し、本日は採血を実施」→
  line_role=performed かつ CTイベントはpast軸を保持。
  「吸引を実施し、管理を継続」→ #5と#6が同一行内の別spanに立ち、
  集約規約2でperformed。**mixed行ではstanding_mentionsを生成しない**
  (現行v15テストは当該行で `standing_mentions: []` を期待する
  `services/fee-api/test/clinical-candidate-proposals.test.js:771-`。
  span粒度のstanding_mentionsが必要になったらv16契約として
  スキーマ・全テストの回帰範囲を定義してから変更する)。

## 実装

### 1. モデルと訓練

- ベース: ModernBERT-Ja小型(WX0 E1のライセンス確認後に確定)。
  スパン位置はマーカートークン(`[SPAN]…[/SPAN]`)で与える。
- 訓練データ(全て合成・機械生成):
  1. WX0 E2コーパスのexpectedSpans(temporalityを5軸ラベル(実enum)へ拡張して生成。
     E2の生成仕様に軸を追加する)
  2. 既存の決定論述語からの弱教師: 現行正規表現群を合成文テンプレートへ適用して
     ラベル付き文を量産(述語が正解を保証できる範囲のみ)
  3. **既存反例テスト文を全て評価split(訓練に入れない)へ**:
     「中止も検討したが継続」「吸引を実施し、管理を継続」
     「先週電話で相談。本日対面」等——これらが合否の関門
- 較正: 温度スケーリングで確信度を較正し、閾値はWX0マトリクスで科別に検証。

### 2. ワーカーAPIと統合

- worker dispatchに `classify_context` を追加(バッチ入力)。
  envelope型(status: complete / model_unavailable)。
- 統合位置: `clinical-calculation-input.js` の降格ゲート
  (`downgradeManagementContinuationEvents`)と各時制述語の**手前**に置き、
  合議制にする:
  1. 分類器と決定論述語が一致 → その判定(高確信)
  2. 分類器 high-conf ∧ 述語ヒットなし → 分類器に従う(AIが穴を埋めるケース。
     trace に `context_classifier_override` を記録)
  3. 不一致(述語ヒット ∧ 分類器が逆) → **安全側**(算定に不利な方=降格・確認事項)
     +確認事項で人に提示
  4. status != complete → 現行の述語のみで継続(fail-open許容。このレイヤは
     確認補助であり提出ゲートではないため)
- **決定論述語は削除しない**。安全網+訓練の弱教師源として恒久併置。

### 3. フラグ・展開・観測

- `FEE_CONTEXT_CLASSIFIER_MODE = off | shadow | assist`。
- shadow計測: 現行判定との一致率、不一致サンプルの内訳(=どちらが正しいかを
  人がレビューし、そのままWX4の教師データ様式で記録)。
- metrics: `contextClassifier: {calls, overrides, disagreements, modelVersion}`。

## テスト

- 既存反例テスト文の全件green(最重要。1件でも退行したら昇格不可)。
- 決定論: 同一入力100回同一出力。
- 合議の分岐(一致/override/不一致→安全側/model_unavailable→述語継続)。
- gold 2系統+安定性コーパス: assist有効で差分ゼロ、または一次資料照合済みの
  改善のみ。

## 受入基準(第3改訂: 多軸分類として強化)

頻出クラス(own_clinic・none等)に引っ張られる集計を禁止し、以下を全て満たす:

- **軸別macro-F1**: 決定論述語ベースライン比 +5pt以上(全軸)。
- **クラス別precision/recall の全表**を成果物にし、少数クラス
  (not_performed / other_provider / carried_in_result 等)のrecallを個別確認。
- **危険方向の誤陽性上限**: 算定を有効化する方向
  (performed系 / current_visit / own_clinic)の誤陽性率 ≤ 1%
  (真値が否定・過去・他所なのに実施と判定する誤り。ここが過剰算定リスクの源)。
- **較正**: ECE ≤ 0.05(または Brier scoreをベースライン比で改善)。
  confidenceが較正されていなければabstain閾値もルーティングも機能しない。
- **abstain後のcoverage-risk**: abstain閾値を掃引した曲線を基線化し、
  「coverage(非abstain率)と残り誤り率」の採用点を明記する。
- 反例集合で退行ゼロ(従来どおり最重要)。
- STG shadowでの不一致レビューで「分類器が正しい」割合が過半。
