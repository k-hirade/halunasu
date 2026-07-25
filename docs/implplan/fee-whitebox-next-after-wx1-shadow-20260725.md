# 提案: WX1 shadow投入後の最適な次の一手(N1〜N6) (2026-07-25 深夜)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)。
前提となる現在地: [status-and-next](./fee-whitebox-status-and-next-20260725.md)、
WX1初回shadow(revision fee-api-stg-00182-6sd)。

## 今回の実施内容の検証結果(合格)

- **分岐表どおりの判断**: GLiNERゼロショットは閾値0.1でも最良F1 1.16%
  (biomed系は0%)→ <40%分岐で直接利用を不採用、FTへ。決定論192/192。
  無効だった初回計測(TP=FP=FN=0)は修正のうえ再実施されており、正しい手続き。
- **訓練規律**: train 224 / dev 64でfit・選択、**holdout 16は未使用のまま温存**
  (READMEに明記)。entity別閾値・relevance温度はdevで較正。決定論100回一致。
- **ガバナンス**: ベースモデル(paraphrase-multilingual-MiniLM-L12-v2)は
  revision固定+Apache-2.0をmanifestに記録(E1表へ追記済み)。
  48機械ラベルは`pending_review`のまま昇格せず、実験ビューはnotGold明示、
  nano生成のunpinned aliasまで記録——**正直さの水準が高い**。
- **安全境界**: shadow・PROD off・候補/点数影響なし・readyz/決定論プローブ合格。
- コミット対象リストも妥当(449MB ONNXの除外は正しい。ただしN5参照)。

## ⚠ 認識すべき2つの構造的問題

### A. span単独のshadowは、ルーティング判定材料をほぼ生まない

実装上、行のencoder経路判定は `spanHigh ∧ linkerHigh` の合議で決まり
(`whitebox-extraction.js:487`)、**linker=offでは全行がllm側に落ちる**。
つまり現状のshadowが集められるのは「span検出の件数・レイテンシ・決定性」まで
で、本命の「何%の行をencoderに任せられるか/コード一致率」は**L2 linkerと
L3 contextが揃うまで測定不能**。shadowを1週間流しても切替判断はできない。

### B. STGフラグ落ちが2デプロイ連続で未復元

00181に続き00182でも `extractionMemo=false / standingFacts=false /
monthlyExclusionMode=off`。今回のデプロイコマンドにFEE_*_STGが含まれていない。
縦断メモ・standing lane・背反enforceのSTG検証環境が失われた状態が続いており、
**B2(背反受入の自動再現)もこのままでは実行不能**。

## 提案(優先順)

### N1. [即時] 次回デプロイでSTG envをフルセット復元

```bash
FEE_EXTRACTION_MEMO_STG=true \
FEE_STANDING_FACTS_STG=true \
FEE_MONTHLY_EXCLUSION_MODE_STG=enforce \
FEE_SPAN_DETECTOR_MODE_STG=shadow \
FEE_SPAN_DETECTOR_MANIFEST_PATH_STG=/app/python/data/whitebox/span-wx1-multilingual-minilm-l12-v1/manifest.json \
TARGET_ENV=stg TARGET_SERVICE=fee-api ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

恒久対策として、デプロイスクリプトに**STG期待フラグの宣言ファイル**
(`deploy/stg-feature-flags.env` 等)を導入し、未指定時はそこから読む方式を推奨
(「シェル環境に依存して毎回手で付ける」構造が事故源。3回目を防ぐ)。
復元後にB2を再走してH3をクローズ。

### N2. [最優先の開発] L2/L3成果物を作り、3レーン同時shadowへ

問題Aの帰結として、次に作るべきはWX1の改良ではなく**L2 linker索引とL3文脈分類器**:

1. E4(linking実測)をruri-v3の30m/130mで実行→サイズ選定
2. `build_fee_linker_index.py` で索引製造(license記録・決定論検証込み)
3. `build_wx3_context_artifact.py` でL3を訓練(E5を兼ねる。train/dev規律は
   WX1と同じ、反例テスト文の訓練除外はCLIが強制済み)
4. 3成果物を載せて `linker=shadow / context=shadow / span=shadow` で再デプロイ
   (N1のenv復元と同時に)
5. ここで初めてshadowが「行単位のroutable率・encoder/LLM不一致・コード一致」を
   生み始める——**shadow計測の時計はこの時点から開始**とする

### N3. shadow観測の判定規約を先に固定

計測開始前に合否の物差しを決めておく(後決めは恣意化する):

- 収集: セル別 routable行率 / encoder-only・LLM-only検出 / span-linker合議の
  棄却理由分布 / p50・p95レイテンシ / 決定性(同一入力の再計算一致)
- オフライン評価: devセットでコード単位recall/precision(LLM経路比)。
  **holdout 16件は昇格判定の直前に1回だけ**使う(規律維持)
- 期間: 2週間 or 標準5患者×3反復のL7型再走を2回、の早い方
- 昇格条件(route切替の入口): dev goldでコード単位recallがLLM経路比非劣化+
  「承認なしで確定点数不変」回帰テストgreen(実装済みの3層防御が担保)

### N4. 弱カテゴリの改善ループ(WX4の初回転)

devのentityMetricsはカテゴリ間格差が大きい(F1 0.74〜0.8の主要カテゴリに対し
0.0のカテゴリあり。imaging/material等の低頻度系)。これはWX4の穴レポート→
合成ケース追加→再訓練の**最初の実戦投入対象**:

1. entityMetricsからF1<0.5のカテゴリを列挙
2. 該当カテゴリのspanを含むケースをE2コーパスへ追加生成(train/devに追加。
   テンプレ単位split維持)
3. 再訓練時に**ベースモデル比較を1回だけ実施**: MiniLM-L12(現行) vs
   `sbintuitions/modernbert-ja-130m`(E1採用候補・日本語特化)。
   日本語臨床トークン化の質でmodernbertが上回る可能性が高く、
   v2アーティファクトの選定材料にする

### N5. [運用リスク] 449MB ONNXの保管を個人環境から出す

現在モデル本体はgitignoreされ、**ビルドできるのは1台のローカルだけ**。
デプロイ再現性・災害復旧の穴。提案: GCSバケット
(`gs://halunasu-fee-models/<artifact-version>/`)へmanifestのsha256付きで
アップロードし、デプロイスクリプトが**ビルド前にsha256検証付きで取得**する
ステップを追加(manifestは既にsha256を持っているので照合のみ)。
アップロード/取得スクリプトと手順をH4系に追記。

### N6. コミットはリスト通りでOK(+2点)

提示のgit addリストは適切。追加で:
`docs/implplan/fee-whitebox-wx0-experiments-20260724.md`(E1表へMiniLM追記済み)と
本ページ・status-and-nextページを含めること。

## 実施順まとめ

```
N6 コミット → N1 env復元デプロイ(B2再走でH3クローズ)
            → N2 L2/L3製造 → 3レーンshadow開始(N3の規約で計測)
            → N4 弱カテゴリループ+ベース比較(並行)
            → N5 モデル保管(N2と並行可)
```

WX1単独の精度磨き込みに進まないこと。**律速はL2/L3の不在**であり、
3レーンが揃って初めてこの計画の本丸(routable率とLLM使用率)が測れる。
