# 作業依頼: 分類器入力契約の復旧と train/serve 等価ゲート(R1〜R4) (2026-07-28)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md) /
[WX3 文脈判定](./fee-whitebox-wx3-context-classifier-20260724.md) /
[ゲート再設計(S1〜S4)](./fee-whitebox-gate-redesign-workorder-20260727.md)。

根拠計測:
`docs/20260727-whitebox-gate-redesign-stg-smoke/20260728_144943/`(00196) と
`docs/20260727-whitebox-gate-redesign-stg-smoke/20260728_171046/`(00197)の比較。

## 実装状況（2026-07-28）

**計測結果の分析**: R0〜R6適用後のSTG計測(00198)の評価と次の一手は
[shadow計測分析(T1〜T4)](./fee-whitebox-shadow-measurement-analysis-20260728.md)。
受入は**3/4達成**(算定対象3件・安全除外禁止6件は合格、
`関節腔内注射`の安全除外復帰のみ未達)。未達の原因はR1ではなく
WX3が判定を放棄していること(linkerは`exact_code_top1`で正解済み)であり、
T1のWX3強化後に再判定する。


| 項目 | 状態 | 実装・判定 |
| --- | --- | --- |
| R0 回帰対象固定 | 完了 | 3件の算定対象、1件の安全除外、6件の安全除外禁止をfixture化 |
| R1 既存artifact互換 | 完了 | 既存WX3には行テキスト・行内offsetを渡し、節情報はtraceに保持 |
| R2 train/serve等価ゲート | 完了 | WX1/WX3の20ケースをNode runtimeとPython trainingで比較し、CIコマンドへ接続 |
| R3 節対応契約 | 実装完了・artifact未製造 | lineとgoverning clauseを併記するcontract v3を実装 |
| R4 意味契約 | 完了 | text scope、offset basis/unit、正規化、節分割versionをmanifest/runtimeで検証 |
| R5 構造化事実の評価分離 | 完了 | 処方箋などをlinker失敗・encoder偽陰性から除外し、別レーンで集計 |
| R6 route観測 | 完了 | 節route、mixed line、encoder所有span、visit factsを計測結果へ集約 |
| STG受入 | 未実施 | 同一revisionで診断8件、その後32セル反復が必要 |

この変更はモデルartifactそのものを自動更新しない。既存のWX3 artifactは
旧契約のまま互換経路で動作し、contract v3を採用する場合だけ再学習・較正・
artifact uploadが必要である。

## 事象: joint eligible が 10.2% → 0.0% へ後退

コミット `c6d7d78 "Route fee extraction by evidence clause"`(revision 00197)で:

| 指標 | 00196 | 00197 |
| --- | ---: | ---: |
| **joint eligible (shadow)** | 9/88 (10.2%) | **0/88 (0.0%)** |
| billable inclusion (shadow) | 3/88 | 0/88 |
| `context_unresolved` | 27 | **55** |
| `context_abstain_or_low_confidence` | 56 | 59 |
| 族判定 (shadow) | 26/88 | 24/88 |
| `linker_low_score` (strict) | 30 | 12 |
| `linker_low_margin` (strict) | 62 | 42 |

linker側は改善しているのに、context側が全通過を潰している。
span検出・境界・top1/top5は不変(WX1と索引は同一)。

## 根本原因: WX3の入力が「行」から「節」へ変わり、訓練契約と乖離した

同一114spanの突き合わせで、10件が通過→不通過。理由コードは2パターン:

```
副鼻腔自然口開大処置 / 在宅小児経管栄養法の指導管理
  旧: [classifier_only, current_own_performed]                  → 通過
  新: [classifier_only, context_abstain_or_low_confidence]      → 分類器が確信を失った

カロナール錠300 / ゲンタシン軟膏 / ザイザルシロップ / CRP
  旧: [context_abstain_or_low_confidence, predicate_safe_exclusion] → 通過(安全除外)
  新: [classifier_only, context_abstain_or_low_confidence]          → 述語が信号を失った
```

コード上の差分:

| | `text` | オフセット |
| --- | --- | --- |
| 訓練 (`scripts/whitebox_training_common.py:342`) | `target.text` = **行** | 行内 |
| 実行時 (c6d7d78以降、`services/fee-api/src/whitebox-extraction.js`) | `clause.text` = **節** | 節内 |

WX3は行テキストで学習しているため、節テキストは**未学習の入力分布**になる。
確信度が落ち、abstainが急増して全spanがLLM側へ落ちた。

副次的に、決定論述語も節単位でcueを評価するようになり信号を失った。
継承は `currentVisit` のみ、かつ `!pastOrExternal && !futureOrOrderOnly` の
条件付きで、他のcueは継承されない。

## これは同一バグクラスの3回目である

1. ONNX attention mask(パディングを有効扱い) → span検出がほぼ0
2. 正規化契約の不一致(全角/CRLF/オフセット) → span検出41%
3. **今回: 分類器入力の粒度(行→節)** → joint eligible 0%

3回とも「実行時入力が訓練契約から外れた」「ユニットテストは緑」
「精度だけが崩れた」。今回も **fee-api 342/342 pass** している。
運ではなく**構造的な穴**であり、R2はその穴を塞ぐ作業である。

### 既存ガードが効かなかった理由

`inputContractVersion` は存在し(context v3 manifest = `1`)、
`python/medical_fee_calculation/whitebox_context.py` で検証されている。
しかし守っているのは **シリアライズの形**(どのフィールドをどの順で連結するか)
だけで、「`text` には行テキストが入る」という**意味の契約**は検証していない。
節テキストを入れてもバージョン検査は通る。

なお `scripts/whitebox_training_common.py:23-25` は
`whitebox_context._classifier_text` を**import して共有**している。
つまり**シリアライザは既に単一実装**であり、乖離しているのは
**呼び出し側が渡すフィールド値だけ**である。R2はこの事実を利用する。

---

## R1. [P0] 入力契約の復旧

対象: `services/fee-api/src/whitebox-extraction.js`(`classifyContext` items構築)。

1. 分類器へ渡す `text` を**行テキスト**へ戻す
   (`index >= 0 ? lines[index].text : span.text`)。
2. `charStart` / `charEnd` を**行内オフセット**へ戻す
   (clause.charStart の減算を廃止)。
3. `previousLine` / `nextLine` / `section` / `encounterSetting` /
   `specialty` / `sourceType` は現状維持(訓練側と一致している)。
4. **節情報は捨てない**。用途を次に限定する:
   - 決定論述語(`predicateContextForLine` 系)のスコープ
   - 対象spanがどの節に属するかのtrace記録
   分類器の入力テキストには使わない。

### 述語cueは一律継承しない

再調査では、旧revisionで通過していた10spanをそのまま正解とは扱えなかった。
`カロナール錠300`、`ゲンタシン軟膏`、`ザイザルシロップ`、`CRP`、
`セファレキシン`2件は、別節の過去・否定cueを継承して安全除外にすると
現在実施を消す危険がある。

- `pastOrExternal` / `futureOrOrderOnly` / `negatedService` は対象節の局所cueだけで判定する。
- 行テキストは分類器へ戻すが、決定論述語はgoverning clauseの境界を維持する。
- `currentVisit` の既存限定継承以外は追加しない。
- 混在行の回帰受入は「旧10件を全復旧」ではなく、下記R0 fixtureを真値とする。

### 受入

- 算定対象3件（`鼻処置`、`副鼻腔自然口開大処置`、
  `在宅小児経管栄養法の指導管理`）が算定対象側へ戻ること。
- 真の安全除外1件（`関節腔内注射`）が安全除外側へ戻ること。
- 安全除外禁止6件が安全除外に昇格しないこと。
- linker側の改善(`linker_low_score` 12、`linker_low_margin` 42)は
  維持されること(R1はlinkerに触らない)。

## R2. [P0・最重要] train/serve ペイロード等価ゲート

### 意図

同一バグを3回起こしている。**実行時と訓練時が同じ入力を作ることを
機械で保証する**以外に再発を止める方法がない。

シリアライザ(`_classifier_text`)は既に共有されているため、
比較すべきは**呼び出し側が渡す入力dict**である。

### 実装

1. 実行時ペイロードの**書き出し口**を作る:
   `whitebox-extraction.js` に、`classifyContext` へ渡す items を
   そのまま返す純関数(例 `buildContextClassifierItems({lines, spans, session})`)
   を切り出す(現在はawait呼び出しの中でインラインに構築されている)。
2. 等価テスト(python側 or nodeからJSONを吐いてpythonで突き合わせ):
   - WX0コーパス(train split)から**N件(初期20件)**を選ぶ。
   - 訓練側 `whitebox_training_common` が `_classifier_text` へ渡す入力dictと、
     実行時 `buildContextClassifierItems` が生成する item を、
     **フィールド単位で完全一致**させる。
   - 一致判定は `text` / `spanText` / `charStart` / `charEnd` /
     `previousLine` / `nextLine` / `section` / `encounterSetting` /
     `specialty` / `sourceType` の全てを対象にする。
   - 差分があればテスト失敗。**差分の内容(どのフィールドがどう違うか)を
     エラーメッセージに出す**(今回のようなケースで即座に原因が分かるように)。
3. 同じ枠組みを **WX1(span検出)** にも適用する。span側は
   「行テキスト+正規化」の契約であり、同じ乖離が起こりうる
   (実際1回目・2回目はspan側で起きている)。
4. CIの必須ゲートに入れる。実行は `npm run test:fee-whitebox-runtime` 系へ束ねる。

### 受入

- **現在のmain(c6d7d78)に対してこのテストを走らせると失敗する**こと
  (=今回のバグを検出できることの証明)。R1適用後に通ること。
- WX1側でも同様に、意図的に行テキストを壊した変異でテストが落ちること。

## R3. [P1] 行とgoverning clauseを同一契約で扱う

混在行(「前回CTを確認し、本日は採血を実施」)を節で切る**意図自体は正しい**。
WX3設計の真理値表は span 単位判定を前提にしており、節粒度はその精度を上げうる。

ただし採用する場合は**両側を同時に変える**:

1. `whitebox_training_common.py` とruntimeの双方で、行テキスト、行内offset、
   governing clause、節内span offsetを同じpayloadにする。
2. abstain閾値・温度較正を節粒度の dev で取り直す。
3. `inputContractVersion` を上げ、artifact を再ビルドする(R4)。
4. R2の等価テストが両側の変更を同時に検証する。

**R1で一度契約を戻してから**、R3を独立の判断として評価すること。
今回のように片側だけ変えない。

## R4. [P1] `inputContractVersion` に意味の契約を含める

現在の契約はシリアライズの形だけを守っている。次を追加する:

1. contract定義に**意味の記述**を含める:
   `textScope: "line" | "clause"`、`offsetBasis: "line" | "clause"`。
   manifestへ保存し、実行時に**実際の生成物と照合**する
   (`textScope: "line"` なのに節テキストが来たら検出できる形にする)。
   照合方法は R2 の等価テストと重複させず、**実行時の軽量チェック**
   (例: `text` が対象spanを含む行と一致するかの同一性判定)に留める。
2. 意味の契約を変えたら **version を上げ、artifact 再ビルドを強制**する。
   古い artifact と新しい runtime の組み合わせは
   `available=false`(degraded)にする——既存のfail-closed機構に乗せる。

## 実施順

```
R0(真値固定) → R1(互換復旧) → R2(等価ゲート)
             → R4(意味契約) → R5/R6(評価・観測分離)
             → STG再計測
             → 必要な場合のみR3 contract v3 artifactを製造
```

R2は「R1で直したことを未来にわたって保証する」ためのものなので、
**R1と同一PRで入れる**ことを推奨する。

## 安全性の確認(全項目共通)

- 全レーンは shadow、PROD は off、route は禁止のまま。
  本チケットの変更は**算定候補・確定点数に影響しない**。
- gold 2系統(seed-300 exact / v2 exact)と fee-api 全テストの green を維持する。
- 再計測は同一 revision・同一 artifact で行い、
  `determinism controls` が 32/32 exact であることを確認する。

## 残課題と昇格条件

`diagnostic_measurement_only` / `holdout_not_used` の2件は00196から変化なし。
構造ゲート(matrix 32/32、determinism 32/32、単一revision、degraded 0)は
すべて緑だが、これは`whitebox_router_only`の再現性であり、OpenAIを含む
最終算定結果の決定性を意味しない。

昇格には次がすべて必要:

1. R0 fixtureと診断8件で、入力契約・構造化事実・route集計が意図どおりである。
2. 32セル反復で、算定対象recall、安全除外の偽陽性、linker top-k、
   clause単位LLM残存率、追加latencyを確認する。
3. 品質またはlatencyが基準未達ならcontract v3 artifactをdevで再学習・較正する。
4. holdoutを独立人手レビューし、promotion目的の実行を別途行う。

したがって、残る律速はholdoutだけではない。現時点では
**品質、安全性、実効OpenAI削減率、latency、holdout**の5ゲートである。
