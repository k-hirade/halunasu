# 作業依頼: 白箱ゲートの再設計(S1〜S4) (2026-07-27)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md) /
[WX2 マスタ照合](./fee-whitebox-wx2-master-linking-20260724.md)。
根拠計測: `docs/20260727-whitebox-v2-v3-stg-remeasurement/20260727_165842/`
(revision `fee-api-stg-00193-fkk`、WX1 v2 / WX3 v3 / linker `35bf85df`)。

## 実装状況

2026-07-27時点でS1〜S4のローカル実装と回帰確認は完了した。

- S1: context理由・unknown/uncertain軸を診断traceへ保持。
- S2: schema v3の構造化family索引と
  `exact_code` / `family_only` / `unresolved` の3値ゲートを実装。
  `family_only` はコード・点数へ昇格しない。
- S3: 元spanの位置整合性を確認したうえで、一意な最長aliasへ拡張する
  fail-closed境界補正を実装。
- S4: 全span・当日自院・安全除外の集計を分離し、機械事前点検だけでは
  閾値更新不可となる較正メタデータを実装。

回帰結果は fee-api 336/336、Python 196件成功(7件skip)、
seed-300 engine gold 300/300、v2 exact engine gold 138/138。

STG反映は未実施。family対応を計測する前に schema v3 のlinker索引を
再構築・artifact registryへ登録し、STG shadow profileを新manifestへ
更新してデプロイする必要がある。既存schema v2索引のままではS2のfamily
診断は有効にならない。

## 背景: 正規化修正は成功し、律速が入れ替わった

| 指標 | 前回(00191) | 今回(00193) |
| --- | ---: | ---: |
| span検出(当日自院) | 41.2% | **95.5%** (21/22) |
| linker top-1 | 11.8% | **40.9%** |
| linker top-5 | 14.7% | **54.5%** |
| joint eligible (shadow) | 0% | 4.5% |

正規化契約の統一(全角/半角・CRLF・オフセット保持を訓練/評価/実行で共有)が
効き、**span検出は実質解決**した(未検出は29件中1件)。

残る詰まりは、当日自院の期待span 22件に対して、linkerが正解を
top1に当てた9件を含むゲート診断へ集約される。旧集計には全spanと
当日自院spanの分母が混在していたため、S4でスコープ別に分離する。

- shadow通過 1件
- **8件 `context_unresolved`**
- **15件 `linker_low_margin`**

ブロッカーは同一spanで重複するため、上記件数は足し上げない。

以降のS1〜S4はこれらのブロッカーを分解・解消する作業であり、
**モデル再学習ではない**。

### 実装時の安全補正

元案の `familyResolved` を `passed=true` とする設計は採用しない。
現行ルータは `passed=true` の先頭候補を具体的なコード・点数へ変換するため、
本文だけでは銘柄・区分を一意化できない族を通すと誤算定になる。

実装は次の3値とする。

1. `exact_code`: 単一コードを確定でき、従来のゲート通過対象。
2. `family_only`: 族までは特定できるが、具体コードは選ばず確認候補のみ。
3. `unresolved`: 族間でも曖昧、または族が過大で確認不能。

`family_only` は `jointEligible=false`、encoder event生成なし、点数影響なしを
反例テストで固定する。

---

## S1. [P0] 診断コードの可視化(最小工数・最優先)

### 問題

`gateBlockerReasonCodes`(`services/fee-api/src/whitebox-extraction.js`)が
理由コードを次の3種にフィルタしている:

```js
reason === "span_low_confidence"
  || reason.startsWith("linker_")
  || reason === "context_unresolved"
```

このため `contextConsensus` が返す
`classifier_requests_llm` / `classifier_predicate_disagreement` /
`classifier_predicate_disagreement_safe_downgrade` /
`predicate_safe_exclusion` と、`contextRoleFromAxes` が返す
`context_abstain_or_low_confidence` / `same_day_but_unknown` が**全て捨てられる**。

結果、context起因の7件が **①軸のabstain ②真理値表の取りこぼし
③分類器と決定論述語の不一致** のどれなのか判別できず、S3の投資判断ができない。

### 実装

1. `gateBlockerReasonCodes` のフィルタに以下を追加(既存3種は維持):
   - `context_abstain_or_low_confidence`
   - `same_day_but_unknown`
   - `classifier_requests_llm`
   - `classifier_predicate_disagreement`
   - `classifier_predicate_disagreement_safe_downgrade`
   実装は列挙集合(`CONTEXT_BLOCKER_REASON_CODES`)にして、
   `contextRoleFromAxes` / `contextConsensus` の返す全コードとの
   **網羅性テスト**を書く(将来コードを増やしたときに落ちないようにする)。
2. 併せて `uncertainAxes` を診断へ残す。`context_unresolved` を
   出すときに、どの軸が unknown だったかを
   `contextUnknownAxes: ["temporalRelation", ...]` として付与する
   (現状 `uncertainAxes` は abstain 時のみ埋まり、fallthrough時は空)。

### 受入

- 同一データで再計測し、`context_unresolved` 7件が上記の細分コードへ分解される。
- 網羅性テスト: `contextRoleFromAxes`/`contextConsensus` の全returnパスの
  reasonCodeが、診断に残るか意図的に除外されるかのどちらかに分類されている。

## S2. [P0] margin ゲートのコード族(family)対応 — 最重要

### 問題(構造的で、モデル改善では解決しない)

診療報酬マスタは**修飾語だけが違う兄弟コード**を多数持つ。実査結果:

```
アムロジピンＯＤ錠２．５ｍｇ「トーワ」    620007817
アムロジピンＯＤ錠２．５ｍｇ「ＴＣＫ」    621931301
アムロジピンＯＤ錠２．５ｍｇ「明治」      621931901
アムロジピンＯＤ錠２．５ｍｇ「武田テバ」  621934403
```

カルテ本文は「アムロジピンＯＤ錠２．５ｍｇ」までしか書かず、**メーカー名は
本文に存在しない**。よって埋め込み類似度は4件ほぼ同値になり、
`margin ≥ 0.05` は**原理的に通らない**。処方箋料
(`120002910`その他 / `120002710`７種類以上内服薬)も同型で、区別は
薬剤数という**span文字列の外**の情報で決まる。

つまり現在のmarginゲートは「本文にない情報で一意化せよ」と要求しており、
どんな埋め込みモデルでも通せない。**修正対象はモデルではなくゲート設計**。

なお本計画は既に正しい原則を持っている——WX2設計の
「**コード集合として返す**(top1に潰さない)」と、standing laneで確立した
「**ファミリで保持し、実コードは当月の決定論入力から選ぶ**」。
S2はこの原則をlinkerゲートへ適用する作業である。

### 実装

**(1) 索引ビルド時にfamilyKeyを付与** — `scripts/build_fee_linker_index.py`

各エントリへ `familyKey` を追加する。導出は決定論のみ、コード列挙は禁止。
名称だけで全種別をまとめず、マスタの構造化キーを優先する:

- 診療行為: 点数表階層 + 修飾括弧を除いた名称語幹。
- 薬剤: 薬価基準収載医薬品コードを優先し、剤形・単位を加える。
  取得できない場合のみ製品関連コード、メーカー括弧除去名へ順次fallback。
- 傷病名: コード単位。異なる傷病名コードを名称類似だけで族にしない。
- 生成時に**族サイズの分布を統計出力**し、族が過大(例: 100件超)になる
  語幹を検出してレビュー可能にする(過剰マージの検知)

manifestに `familyKeyRule` のバージョンとsha256を記録し、
**索引バージョンを上げる**(既存のsha256検証機構がそのまま効く)。

実マスタでは22族が25件を超え、最大175件だった。確認画面に列挙できる
上限は25件とし、26件以上は `linker_family_too_broad` でfail closedする。
アムロジピンOD錠2.5mg族は21件で、確認可能範囲に収まる。

**(2) worker応答へfamily情報を追加** — `python/medical_fee_calculation/whitebox_linker.py`

`_link_one` の返り値へ:

```
{
  "text": ..., "margin": ...,
  "familyMargin": <top1の族に属さない最良候補とのスコア差>,
  "topFamilyKey": <top1のfamilyKey>,
  "topFamilyMemberCount": <有効期間内の同一familyKeyの全コード数>,
  "topFamilyReviewable": <2〜25件ならtrue>,
  "topFamilyMembers": <確認可能な場合の全コード集合>,
  "candidates": [{..., "familyKey": ...}]
}
```

`familyMargin` は「**族をまたいだ識別力**」を表す。族内の兄弟同士の
差は無視され、族が違う候補との差だけが評価される。族サイズはtop-k内の
見かけの件数ではなく、索引全体から有効期間で絞った実数を返す。

**(3) ゲートを族対応にする** — `linkerGateEvaluation`

```js
exactCodeResolved = basePass && (marginPass || exactMarginBypass);
familyIdentified = basePass
  && !exactCodeResolved
  && familyMarginPass
  && topFamilyReviewable;
passed = exactCodeResolved;
```

- `familyIdentified === true` の候補は**単一コードとして確定提案しない**。
  族の候補集合+確認事項として提示する
  (WX2設計の「margin < 閾値のときはコード集合の確認事項」規約に一致)。
- 診断へ `linker_family_identified` を新設し、
  `linker_low_margin` と区別できるようにする
  (族内曖昧=前進 / 族間曖昧=未解決 を混ぜない)。

**(4) 実コード選択は決定論側の責務**(本チケットでは提案までで止める)

族から具体コードへの絞り込みは、施設の採用薬・薬剤数・面積等の
決定論入力を持つエンジン/施設設定の仕事であり、candidateOnly原則も不変。
**S2の完了条件は「族まで絞れたことを正しく表現できること」**とし、
実コード自動選択は別チケットとする。

### テスト

- familyKey導出: アムロジピンOD錠2.5mgの4銘柄が同一familyKey /
  末梢血液一般検査と末梢血液像(鏡検法)は**別**familyKey /
  処方箋料の各区分が同一familyKey。
- 族サイズ統計が出力され、過大族が検出できる。
- ゲート: 族内のみ曖昧→`familyIdentified=true`だが`passed=false`、
  `linker_family_identified`が付く。族間で曖昧→従来どおり
  `linker_low_margin`で不通過。26件以上の族も不通過。
- 索引manifestのsha256/バージョン検証が通る(既存機構)。

### 受入

- 再計測で `linker_low_margin` のうち、族内曖昧に起因するものが
  `linker_family_identified` へ移る。これは確認可能性の改善であり、
  `joint eligible` の増加条件にはしない。
- gold 2系統・fee-api全テストが不変(linkerはshadowのため算定影響なしを確認)。

## S3. [P1] span境界の後処理

### 問題

exact boundary 21/29(72.4%)、境界ズレ8件。実測:

```
IoU 0.875  '末梢血液一般検査'  (先頭1文字欠け)
IoU 0.929  '在宅小児経管栄養法の指導管理'
IoU 0.800  'ラコールNF配合経腸用半固形剤'
IoU 0.333  'CRP' / '骨塩定量検査'
IoU 0.714  '訪問看護指示書'
```

高IoUのズレ(1文字欠け)は linker クエリを劣化させ、
低IoU(0.333)はほぼ別語になっている。

### 実装

WX1のBIO復号後、**確定的な境界吸着**を1段入れる(モデルは触らない):

1. 検出spanの前後 ±N文字(初期N=4)の窓を取る。
2. 窓内の部分文字列のうち、**辞書スキャン(`name_scan`)のalias集合と
   最長一致**するものがあれば、その境界へ吸着する。
3. 吸着は「一致長が検出spanより長い」場合のみ行い、**短縮はしない**
   (過剰吸着でspanが痩せるのを防ぐ)。
4. 吸着した場合は `boundarySnapped: true` と元境界をtraceへ残す
   (白箱原則: 位置の改変を必ず可視化)。
5. 助詞・記号の剥離(`を`『』等の末尾)は既存正規化と同じ規約で行う。

### テスト

- 「末梢血液一般検査」の先頭1文字欠け→吸着して完全一致になる。
- 吸着によりspanが短くならない(単調性)。
- 吸着なしでも既存の動作が変わらない(辞書に無い語)。
- 決定論: 同一入力100回で同一境界。

### 受入

- 辞書に一意な最長拡張がある境界ズレは完全一致へ補正される。
- 辞書にない語、複数族に一致する語、短縮が必要な語は変更しない。
- exact boundary rateの改善量は再計測値として記録する。10件程度の
  診断subsetに対して90%を強制せず、吸着後にlinker top-1が低下して
  いないことを必須条件とする。

## S4. [P1] 閾値のSTG実測較正

### 問題

`spanConfidence: 0.9` がstrictで12件を落としている一方、shadowでは0件。
dev較正値がSTG実測分布と合っていない。

### 実装

1. S1〜S3を入れた再計測の**スコア分布**(span confidence / linker score /
   code margin / familyMargin)をセル別と全体で出力する。
2. ブロッカーは「全span」「当日自院」「安全除外」のスコープ別に集計し、
   単一コード一致・族特定・top5・取得失敗を別分類にする。
3. 1セル20件未満、または独立レビュー未完のデータから閾値を自動更新しない。
   診断subsetは分布収集のみで `thresholdUpdateEligible=false` とする。
   現行STGハーネスの出力は `machine_precheck_only` であるため、20件を
   満たしても独立レビュー完了とは扱わず、更新可否は常にfalseのままにする。
4. 十分な標本でcoverage-riskを評価した後、採用点はセル別しきい値ファイル(既存の
   `defaults → *|setting → specialty|* → specialty|setting` 階層)へ書き、
   **設定不正時はrouteせずLLMへ戻す**既存の安全境界を維持する。
5. **500msのp95ゲートは変更しない**(現状781ms)。閾値較正は
   精度ゲートの話であり、レイテンシゲートを緩める根拠にはしない。

### 受入

- strict/shadowの2段構えが維持される。今回の診断subsetでは閾値を
  更新せず、分布と更新可否が機械出力される。
- 閾値変更の前後で「承認なしで確定点数不変」回帰テストがgreen。

---

## 実施順と原則

```
S1(診断) → S2(family) → S3(境界) → S4(閾値較正) → 32セル再計測
```

S1を最初に置くのは、context起因7件の対策(abstain対応か真理値表拡張か
述語調整か)を**データで決めるため**。S1なしにWX3を再学習しない。

**再学習を先に行わないこと**: 発見された律速はモデル品質ではなく
ゲート設計とマスタ構造の不整合である。この状態で再学習すると
「本文にない情報を当てろ」という不可能なタスクを学習させることになる
(マスク不整合のときと同じ判断)。

**安全境界は不変**: 全レーンshadow、PROD off、route禁止、
candidateOnly 3層防御、gold 2系統green。S1〜S4はいずれも
算定候補・確定点数に影響しない。
