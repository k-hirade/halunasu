# 作業依頼: 白箱ゲートの再設計(S1〜S4) (2026-07-27)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md) /
[WX2 マスタ照合](./fee-whitebox-wx2-master-linking-20260724.md)。
根拠計測: `docs/20260727-whitebox-v2-v3-stg-remeasurement/20260727_165842/`
(revision `fee-api-stg-00193-fkk`、WX1 v2 / WX3 v3 / linker `35bf85df`)。

## 背景: 正規化修正は成功し、律速が入れ替わった

| 指標 | 前回(00191) | 今回(00193) |
| --- | ---: | ---: |
| span検出(当日自院) | 41.2% | **95.5%** (21/22) |
| linker top-1 | 11.8% | **40.9%** |
| linker top-5 | 14.7% | **54.5%** |
| joint eligible (shadow) | 0% | 4.5% |

正規化契約の統一(全角/半角・CRLF・オフセット保持を訓練/評価/実行で共有)が
効き、**span検出は実質解決**した(未検出は29件中1件)。

残る詰まりは、linkerが正解をtop1に当てた13件の内訳に集約される:

- 2件 通過
- **7件 `context_unresolved`**
- **5件 `linker_low_margin`**

以降のS1〜S4はこの13件を通すための作業であり、**モデル再学習ではない**。

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

各エントリへ `familyKey` を追加する。導出は決定論のみ、コード列挙は禁止:

- 名称を正規化(NFKC・全角英数→半角・空白除去)
- **メーカー括弧を除去**: 末尾の `「…」` を削除(薬剤の銘柄差)
- **修飾括弧を除去**: 既存の
  `python/medical_fee_calculation/name_scan.py` の
  `strip_parenthetical_qualifiers` を再利用(`（…）`内の
  サイズ・回数・区分等の修飾)
- 残った語幹 + `kind`(procedure/drug/disease)を `familyKey` とする
- 生成時に**族サイズの分布を統計出力**し、族が過大(例: 100件超)になる
  語幹を検出してレビュー可能にする(過剰マージの検知)

manifestに `familyKeyRule` のバージョンとsha256を記録し、
**索引バージョンを上げる**(既存のsha256検証機構がそのまま効く)。

**(2) worker応答へfamily情報を追加** — `python/medical_fee_calculation/whitebox_linker.py`

`_link_one` の返り値へ:

```
{
  "text": ..., "margin": ...,
  "familyMargin": <top1の族に属さない最良候補とのスコア差>,
  "topFamilyKey": <top1のfamilyKey>,
  "topFamilySize": <top-k内で同一familyKeyの件数>,
  "candidates": [{..., "familyKey": ...}]
}
```

`familyMargin` は「**族をまたいだ識別力**」を表す。族内の兄弟同士の
差は無視され、族が違う候補との差だけが評価される。

**(3) ゲートを族対応にする** — `linkerGateEvaluation`

```js
const familyMarginPass = Number(familyMargin) >= Number(marginThreshold);
const familyResolved = familyMarginPass && topFamilySize > 1;
passed = candidatePresent && scorePass && categoryPass && mentionTypePass
  && (marginPass || exactMarginBypass || familyMarginPass);
```

- `familyResolved === true` の候補は**単一コードとして確定提案しない**。
  族の候補集合+確認事項として提示する
  (WX2設計の「margin < 閾値のときはコード集合の確認事項」規約に一致)。
- 診断へ `linker_family_resolved` を新設し、
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
- ゲート: 族内のみ曖昧→`familyResolved=true`で通過し
  `linker_family_resolved`が付く。族間で曖昧→従来どおり`linker_low_margin`で不通過。
- 索引manifestのsha256/バージョン検証が通る(既存機構)。

### 受入

- 再計測で `linker_low_margin` 5件のうち、族内曖昧に起因するものが
  `linker_family_resolved` へ移り、joint eligible が増える。
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

- exact boundary rate 72.4% → 90%以上。
- 吸着後にlinker top-1が低下していない(境界改善が逆効果でないことの確認)。

## S4. [P1] 閾値のSTG実測較正

### 問題

`spanConfidence: 0.9` がstrictで12件を落としている一方、shadowでは0件。
dev較正値がSTG実測分布と合っていない。

### 実装

1. S1〜S3を入れた再計測の**スコア分布**(span confidence / linker score /
   familyMargin)をセル別に出力する。
2. 分布から **coverage-risk曲線**(閾値を動かしたときの通過率と
   期待コード不一致率)を作り、採用点を決める。
3. 採用点はセル別しきい値ファイル(既存の
   `defaults → *|setting → specialty|* → specialty|setting` 階層)へ書き、
   **設定不正時はrouteせずLLMへ戻す**既存の安全境界を維持する。
4. **500msのp95ゲートは変更しない**(現状781ms)。閾値較正は
   精度ゲートの話であり、レイテンシゲートを緩める根拠にはしない。

### 受入

- strict/shadowの2段構えが維持され、strictの`span_low_confidence`が
  実測分布に基づく値へ更新される。
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
