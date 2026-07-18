# 作業依頼: H1-R 頻度上限「当該請求数量のみ」判定の入院回帰修正 (2026-07-18)

コミット `3aba3fa`(H1: 頻度上限の限度回数対応)のレビューで検出した**必須修正1件**と、
同レビューで挙がった付随作業2件。元チケットは
`docs/implplan/fee-workorder-frequency-limit-20260716.md`(H1)を参照。

## 背景

H1の実装は高品質で、本来の目的は達成している(検証済み):

- 週次訪問(暦週違い)が除外されない / 同一暦週で上限3回を超えた4回目だけ除外される /
  日曜起算の週境界が正しい / 除外理由に「上限N回・期間内履歴M回・当該請求K回」が明示される。
- v2 exactゲート 138/138 緑、全ユニットスイート緑。

一方、元チケットの仕様「窓内履歴件数**+当claim数量** > 限度回数」を忠実に実装した結果、
仕様側が想定していなかった副作用が出た:

**`npm run test:fee-gold:engine`(seed-300)が26件失敗**。全て入院の複数日ケース
(急性期一般入院料1の2〜12日、L1-009、L1-050等)で **engine total 0**。

### 故障メカニズム(確認済み)

`electronic_rules.py` の `_find_frequency_limit_breaches` は、履歴イベントが0件でも

```python
exact_breach = limit.limit_count > 0 and history_occurrences + current_quantity > limit.limit_count
```

で breach を作る(`matched_from: "current_claim_quantity"`)。
入院基本料(190117710)は**quantity=入院日数**で1行に載るため、「日」上限1回(限度回数1)に対し
`quantity=12` が「12回 > 1回」と誤判定され、`claim_adjustments.py` が入院料全行を
`excluded_from_total` に落として合計が0になる。

「日1回」の意味は**1日につき1回**であり、複数日行の quantity=N は「N日×1回/日」で正当。
つまり **quantityの意味(同日内の回数か、日数か)を頻度判定側が区別できない**ことが根本原因。

### なぜチケット仕様がこうなっていたか(意図の記録)

元仕様の「当claim数量を加算」は、**単日クレーム内で同一コードをquantity 2以上積んだケース**
(例: 日1回の処置を同日2回)を履歴なしでも検知する意図だった。外来は単日クレームなので
quantity=同日内回数と解釈してよいが、入院はquantity=日数であり前提が崩れる。
seed-300(入院ケースを含む)ゲートがこれを検知した — v2 exact(外来単日のみ)は素通りしており、
**両ゲート実行の必要性の実証例**でもある。

---

## R1. [P0] 当該請求数量のみの超過は「自動除外しない」

### 設計判断

1. **履歴イベント由来の超過だけが自動除外(demote)できる**。窓内の実績件数という
   客観カウントに基づくため。→ 現行実装のこの部分は変更しない。
2. **当該請求数量のみの超過は警告(needs_review)止まり**にする。当claim内の数量は
   利用者が直接見て入力している値であり、複数日(入院)・複数部位・左右等の正当な
   quantity>1 を機械では区別できない。「確度が足りないものを確定除外しない」原則の適用。
3. **複数日クレーム(入院)では当該請求数量のみの頻度チェック自体をスキップ**する。
   入院はquantity=日数のため、「日1回×N日」が常に形式超過になり、警告でも全入院クレームで
   ノイズになる。日数情報なしに正しく判定できないものは出さない。

### 実装仕様

対象: `python/medical_fee_calculation/electronic_rules.py` / `claim_adjustments.py` /
`lab_calculator.py`

1. `ElectronicRuleContext` に `multi_day_claim: bool = False` を追加。
   `lab_calculator` のcontext構築箇所で
   `claim_context.encounter.is_outpatient == False または inpatient_basic.basic_fee_days > 1`
   のとき True を渡す(入院=複数日前提。単日入院でも安全側に倒れるだけで害はない)。
2. `_find_frequency_limit_breaches` を変更:
   - `matching_events` が**非空**の場合のみ、従来どおり
     `history + current > limit` で `limit_exceeded_certain=True` の breach
     (自動除外対象)を作る。
   - `matching_events` が**空**の場合:
     - `context.multi_day_claim` なら breach を作らない(スキップ)。
     - 単日クレームで `current_quantity > limit_count > 0` なら、
       `matched_from="current_claim_quantity"`, `occurrence_count_known=True`,
       **`limit_exceeded_certain=False`** の breach を作る(警告のみ)。
   - set形式(`_find_set_based_frequency_breach`)の扱いは現行維持
     (「最低1回」の下限だけで超過確定できる場合のみ demote)。
3. `claim_adjustments.py` は既に `limit_exceeded_certain` で demote を分岐しているため
   変更不要のはず(確認のみ)。`lab_calculator._format_frequency_breach_detail` に
   `current_claim_quantity` 用の文言を追加:
   「当該請求内の数量{K}回が{limit_name}の上限{N}回を超えています。複数部位等の
   正当な理由がないか確認してください。」

### テスト

`python/tests/test_electronic_frequency_limits.py` に追加:

1. **回帰再現**: 入院(multi_day_claim=True)・日上限1回・quantity=12・履歴なし →
   breachなし、demoteなし(修正前に失敗することを確認してから直す)。
2. 単日外来・日上限1回・quantity=2・履歴なし → 警告のみ(demoteされず合計に入る)、
   メッセージに「当該請求内の数量」を含む。
3. 履歴イベントあり(同一暦週3回)+当該請求1回・週上限3回 → 従来どおりdemote(不変)。
4. multi_day_claim=True でも**履歴イベント由来**の超過は demote される
   (入院でも過去実績由来の判定は生きる)。

### 完了ゲート

- `npm run test:fee-gold:engine` が **exact 150/150(errors 0)** に戻る。
- v2 exact 138/138 維持。
- Python全スイート、fee-api/fee-core/contracts/medical-core 全パス。
- 実機確認(前回レビューと同じ5シナリオ):
  週次訪問非除外 / 暦週3回超過demote / 2回非除外 / 日1回同日履歴demote / 土→日境界。

---

## R2. [小] デプロイノート: `blockExportOnErrors` デフォルト反転の明示

`3aba3fa` で `defaultFeeSettings.receiptPolicy.blockExportOnErrors` が false→true に変更された
(意図テストあり)。安全側だが、**receiptPolicyを明示設定していない既存組織の実効挙動が
「エラーがあってもUKE出力可」→「出力ブロック」に変わる**。

- デプロイ手順書/リリースノートに1行明記する。
- STGの既存デモ組織(nishiyama/yamamoto)で、検証エラーを含むレセのUKE出力がブロックされる
  ことを1回確認し、想定外の業務停止がないことを見る(必要なら該当組織のみ明示的にfalse設定)。

## R3. [小] 再計算時の採用判断リセットのUI告知

`applyCalculationResult` が `reviewDecisions: {}` で**再計算のたびに候補の採用/却下判断を
全リセット**するようになった(意図テスト index.test.js:409 あり)。stale判断の混入防止として
設計意図は妥当だが、利用者からは「採用したのに再計算で外れた」に見える。

- fee-web の再計算ボタン付近に「再計算すると候補の採用・確認状態はリセットされます」を表示する
  (確認ダイアログまたは常設の注記。実装者判断)。
- 月次候補の畳み(fee-core)が既に「approved/rejected を除外」している前提のため、
  リセット後の月次表示が候補に戻ることをテストで1本固定する。

---

## 実施順

R1(即・デプロイ前必須)→ R2/R3(同一リリースに同乗可)。
R1完了までは `3aba3fa` を含むイメージを本番系へ出さないこと(入院算定が0点になる)。
