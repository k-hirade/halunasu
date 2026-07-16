# 作業依頼: H1 頻度上限の限度回数対応(P0) / H2 除外理由の可視化 / H3 受診単位の入力契約 / H5 病名レーン精度 (2026-07-16)

yamamoto-demo-stg 評価
(`docs/20260716-yamamoto-demo-stg-5patients-20260716_205643/`、`…-additional-3patients-…/`)の
分析で特定した問題の修正チケット。根拠となる分析はこの直前のレビュー(会話ログ)と各READMEを参照。

確定済みの事実(再検証済み):

- 週次訪問患者(1004/1006/1002)のセッション別確定点数は `969 / 79 / 79 / 79`。
  1012は `969(6/8) / 969(6/16) / 79(6/22)` — **前回受診から7日以内の受診だけ**
  訪問診療料890点が `excluded_from_total` で自動除外されている。
- 原因は `python/medical_fee_calculation/electronic_rules.py`:
  - `FREQUENCY_LIMIT_DAY_WINDOWS = {"週": 7}` + `_history_event_matches_frequency_limit` の
    `0 <= (service_date - history_date).days <= 7` → 「週」を**暦週ではなくローリング窓(7日差を
    含む=実質8日間)**で判定。
  - `_find_frequency_limit_breaches` は**限度回数を一切読まず**、窓内に履歴1件でもあれば
    breach を作る。マスタ `electronic_frequency_limits` の raw_row_json[5] には限度回数
    (114001110は「週」=**3**回、「日」=1回)が入っており、`checks_api.py:134` は同じ raw[5] を
    既に max_count として解釈している(意味の裏付け)。
  - `claim_adjustments.py:263` がその breach で無条件 demote(合計除外)する。
- 実害: 週3回まで算定できる訪問診療を週1回ペースでも2回目以降除外。890点×3回/患者の確定欠落。

---

## H1. [P0] 頻度上限違反の判定を「限度回数ベース+暦週」に修正する

### H1-1. 限度回数の取得

対象: `python/medical_fee_calculation/electronic_rules.py`

1. `_find_frequency_limits`(304行)のSELECTに
   `COALESCE(json_extract(raw_row_json, '$[5]'), '0') AS limit_count` を追加する
   (`ExclusionHit.special_condition` を `$[6]` で読んだ前例と同じ方式。カラム化はしない)。
2. `FrequencyLimitHit` に `limit_count: int = 0` を追加(intへの変換は `int(str(...) or "0")`、
   変換不能は0)。`limit_count == 0` は「回数情報なし」を意味し、**回数判定はしない**(後述の
   セットベース扱い)。

### H1-2. 違反判定の書き換え

対象: `_find_frequency_limit_breaches` / `_matching_frequency_history_events`(382〜445行)

1. **イベントベース判定(件数が数えられる場合)**:
   - `window_events = _matching_frequency_history_events(limit, context)` の件数と、
     **当claim内の同一コード数量**(下記H1-4でcontextに追加)の合計が
     `limit.limit_count` を**超える**場合のみ breach とする:
     `limit_count > 0 and (len(window_events) + current_quantity) > limit_count`
   - breach に `limit_count` と `windowOccurrences = len(window_events)` を持たせ、
     demoteメッセージへ「上限{limit_count}回・直近{scope}内{windowOccurrences}回」を出す。
   - 履歴イベントはコード×日付でdedupe済み(server側)のため「1イベント=1回」とみなす。
     履歴側のquantityは現データ粒度では取れない旨をコメントに残す。
2. **セットベース判定(`same_*_history_codes`: 件数不明)**:
   - `_find_set_based_frequency_breach` は breach を返してよいが、
     **`claim_adjustments.py` 側で demote しない**(警告メッセージのみ、status needs_review どまり)。
     件数を数えられない履歴で確定除外するのは確度不足(「確度が足りないものは
     ブラックリスト確定にしない」原則)。breach に `matched_from` があるので
     `matched_from == "procedure_history_event"` のときだけ demote する分岐を
     `claim_adjustments.py:263` のループに入れる。
   - イベントベース判定が可能なコード(同一 procedure_code の履歴イベントが存在)については
     セットベース breach を出さない(二重警告防止)。

### H1-3. 「週」の窓を暦週にする

1. **支払基金「電子点数表」仕様書で「週」の定義(起算曜日)を確認し、確認した文書名・版を
   docstringに記載する**(推測実装禁止。raw[13]誤認の教訓)。確認結果が出るまでの暫定実装は
   **日曜起算の暦週**とする。
2. `_history_event_matches_frequency_limit` の「週」判定をローリング窓から
   暦週一致(`week_start(history) == week_start(service)`)へ変更。「日」は同日一致のまま。
   「２週」等の複数週窓は同仕様書で定義を確認し、確認できるまで現行ローリングを維持
   (該当コードが少ないため優先度低。コメントで明示)。
3. `services/fee-api/src/server.js` の `isSameIsoWeek`(7092行、現在**月曜起算**)を
   Python側と同一定義に統一する。両実装のコメントに相互参照を書く
   (`same_week_history_codes` の生成側と消費側で週定義がずれると誤判定になるため)。

### H1-4. 当claim数量のcontext追加

- `ElectronicRuleContext` に `current_code_quantities: Mapping[str, float]`(既定空)を追加し、
  呼び出し側(`lab_calculator._claim_level_electronic_messages` 付近)で
  claim lines の code→quantity合計 を渡す。H1-2の `current_quantity` に使う
  (同一セッションで同コード2行のケースを正しく数えるため。無ければ1として扱う)。

### H1-5. テスト(python/tests)

1. **バグ再現回帰**: 週3回上限(limit_count=3)・窓内履歴1件 → demoteされず総点数に入る
   (今回の1004ケースの最小再現。修正前は落ちることを確認してから直す)。
2. 週3回上限・同暦週の履歴3件 → 4回目はdemote、メッセージに「上限3回」を含む。
3. 暦週境界: 前週同曜日(7日前)の履歴 → 「週」判定に該当しない。
4. セットベース(same_week_history_codesのみ) → 警告は出るがdemoteされない。
5. 「日」上限1回・同日履歴1件 → demote(既存挙動の維持確認)。
6. `limit_count=0`(回数情報なし)の行 → イベントベースdemoteをしない。

### H1-6. 受け入れ条件

- 1004/1006/1002 の再計測で、確定月次に訪問診療料が受診回数分(890×4等)入る。
- gold 2系統は不変(seed-300 / v2 exact。履歴なしケースのため影響しないはず。変わったら要調査)。

---

## H2. [P1] 合計除外行の理由をレビュー面と評価rawに出す

### 現状

エンジンは除外時に理由(「算定回数上限のため合計から除外…」等)を line.reason と messages に
出しているが、候補ワークベンチと評価rawに残らず、STGレポート作成者が原因を追えなかった。

### 変更仕様

1. `buildCandidateWorkbench`(server.js 2998行付近から呼ばれる)の出力に、
   `excludedFromTotal === true` または `inclusionStatus === "pending"` の明細を
   「合計除外の確認」項目として含める(title=行名、reason=除外理由、actionType=confirm_required、
   canAdopt=true相当の承認動線があるならそれを維持)。既に同等の表示があるなら、
   評価スクリプトから見える形(counts/lines)になっているかだけ確認して直す。
2. `scripts/evaluate_fee_monthly_chart_e2e.mjs` の visitRecord(415行付近)に追加:
   ```js
   excludedLines: lineSource
     .filter((line) => line.excludedFromTotal || line.inclusionStatus === "pending")
     .map((line) => ({
       code: String(line.code || ""),
       name: String(line.name || ""),
       totalPoints: Number(line.totalPoints || 0),
       reason: String(line.reason || "").slice(0, 160),
       source: String(line.source || "")
     }))
   ```
   ※ reason はエンジン定型文+マスタ名称のみでカルテ本文を含まないことを確認して記録する
   (万一カルテ由来文字列が混ざる形式ならreasonは先頭の定型部分のみに切る)。
3. 月次側 `sanitizeMonthlyReceipt` にも `excludedOccurrenceCount`(セッション横断の除外行数)を
   追加する(月次と確定一致の差を説明できるように)。

### 受け入れ条件

- 評価rawだけで「どのコードが・何故・何回合計除外されたか」を追える。

---

## H3. [P1] 受診単位の入力契約(電話再診・訪問区分・同一建物)

### 背景

1003: 電話再診2回を訪問診療として算定(訪問診療料+ベースアップ評価料を過剰計上)。
1002/1004: 既存UKEは同一建物向けコード(ベースアップ評価料ロ等)だが当社はイ固定。
現行は全受診に単一の `--encounter-setting home_visit` しか渡せない。

### 変更仕様

1. **契約(packages/fee-contracts)**: セッションに任意フィールド `encounterDetails` を追加:
   ```js
   encounterDetails: {
     visitKind: "scheduled_home_visit" | "urgent_house_call" | "telephone_revisit" | null,
     sameBuilding: true | false | null
   }
   ```
   - normalize/PATCH対応(receptionTime と同様、null はクリア)。不正値は validationError。
   - `setting`(大区分)はそのまま。encounterDetails は詳細条件の上乗せ。
2. **fee-api**:
   - `visitKind === "telephone_revisit"` のとき、施設恒常算定ルール
     (`applyAutoBillingRulesToPreparation`)の `settings: ["home_visit"]` ルールを適用しない
     (訪問していない受診に訪問診療料を自動追加しない)。かつ警告
     「電話等再診: 訪問系の自動算定を停止しています。電話等再診料の算定要件を確認してください」
     を追加。電話等再診料自体の自動算定は本チケットの範囲外(候補化は次段)。
   - `sameBuilding === true` のとき: autoBillingRule に任意フィールド `sameBuildingCode` を追加し
     (fee-contracts の normalizeAutoBillingRules も更新)、指定があればそのコードで確定追加する。
     yamamoto の `samples/yamamoto-demo-stg/fee-settings.json` に同一建物向けコード
     (ベースアップ評価料ロ、訪問診療料の同一建物区分。**実コードはマスタで名称確認して設定**)を
     追記する。
   - `encounterDetails` は claimContext(encounter)にも透過し、trace に記録する。
3. **評価CLI(evaluate_fee_monthly_chart_e2e.mjs)**:
   - charts.jsonl の各行の任意フィールド `visit_kind` / `same_building` を読み、
     セッション作成payloadの `encounterDetails` に渡す。無ければ従来どおり。
   - mock_partner データへの付与(1002/1003/1004の該当受診)は既存UKEと突合して手で行う
     (データ整備はこのチケットの検証作業に含める)。
4. **fee-web**: 受診区分の詳細(訪問/往診/電話・同一建物)の表示と手動上書きUIは
   別チケット(後続)。API契約が先。

### テスト

- fee-contracts: encounterDetails の normalize/PATCH/validation。
- server.test.js: telephone_revisit で home_visit 系autoルールが乗らない/警告が出る。
  sameBuilding=true で sameBuildingCode が使われる。
- 評価CLI: charts.jsonl のフィールドがセッションへ透過する(スパイ)。

### 受け入れ条件

- 1003 再計測で訪問診療料の計上が既存UKEと同回数になる。
- 1004 再計測でベースアップ評価料が同一建物向けコードで一致する。

---

## H5. [P2・小] 病名レーンの精度改善2件

STGで確認した実測に基づく(1006: 成人患者に「小児悪性腫瘍患者指導管理料」候補、
「膵臓癌 末期（多発肝転移）」が病名未解決)。

1. **年齢ガード**: `disease_act_candidates`(checks_api.py)の候補構築時、
   `medical_procedures` の `age_min_code` / `age_max_code`(カラム化済み)で patient_age と
   突合して範囲外コードを落とす。コード値のデコードは既存 `apply_age_range_guard`
   (claim_adjustments.py)のデコード関数を共有化して使う(重複実装しない)。
   patient_age が無い場合はフィルタしない(現状維持)。
2. **修飾語つき病名の解決フォールバック**: `resolve_diseases` の `_resolve_one_disease` が
   失敗した場合、①全角/半角括弧内を除去、②空白で分割した先頭語、の順で再試行する
   (「膵臓癌 末期（多発肝転移）」→「膵臓癌」)。再試行で解決した場合は結果に
   `resolvedVia: "fallback_head"` 等を残し、traceで区別できるようにする。
3. テスト: seeded fixture で ①成人に小児限定行為が出ない ②「膵臓癌 末期（多発肝転移）」が
   解決される ③フォールバックしても「疑い」判定が正しく維持される。

---

## 共通の完了ゲート

1. 全テストスイート(fee-api / fee-core / fee-contracts / medical-core / Python)パス。
2. goldゲート2系統(seed-300 exact 150 / v2 exact 138)。**H1はエンジン挙動の変更だが、
   gold は履歴なし入力のため不変のはず。変わった場合は原因を特定してから進める。**
3. 反例コーパス パス。
4. STG再計測(H1/H3後): 1002/1003/1004/1006 を各1回→確定月次の訪問診療料回数と
   ベースアップ評価料コードを既存UKEと突合。その後3反復で安定性確認。
5. 実施順の推奨: **H1(単体で効果最大)→ H2(次回計測の観測性)→ H3 → H5**。
   コミットは H1 / H2 / H3 / H5 で分ける。

## 別途相談(このチケットでは着手しない)

**H4: 患者単位の恒常算定プロファイル** — 在宅酸素・人工呼吸器等「患者の常態」に紐づく
管理料・機器加算(1002の人工呼吸器管理料等が候補にすら出ない問題の本質解)。
施設単位の autoBillingRules と対になる「患者×月の恒常算定」概念で、契約・UI・月次集計に
またがる設計判断が必要。設計案を先に作って合意してから着手する。
