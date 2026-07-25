# 現在地と次の一手: 白箱抽出 (2026-07-25 夜時点)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md) /
[H1〜H4ワークオーダー](./fee-whitebox-wx0-completion-workorder-20260725.md) /
[WX0実行計画](./fee-whitebox-wx0-execution-plan-20260725.md)

## 直近2コミットの棚卸し(4ccbd6d "Add data" / b0ea7a1 "Impl GLiNER")

**H1〜H4は全て実装された**(計28,201行):

| 項目 | 実装物 | 状態 |
| --- | --- | --- |
| H1 昇格CLI | `promote_fee_specialty_matrix_annotations.mjs` + promotion lib+テスト | 済 |
| H2 非外来holdout生産 | blueprint生成(`generate_fee_specialty_holdout_blueprints/texts.mjs`)+generation lib+validator拡張+`non-outpatient-blueprints.json`(24セル分) | 済 |
| H3 背反ハーネス | `fee-monthly-exclusion-evaluation.mjs`+monthly harness拡張 | 実装済・**STG再走は未**(下記env問題) |
| H4 モデル製造 | `build_wx1_span_artifact.py`(677行)/`build_wx3_context_artifact.py`(651行)/`whitebox_training_common.py`/training-view生成 | 済(モデル成果物は未製造) |
| holdout 16件 | **平出さんの人手レビュー済み**(reviewedBy記録・human_reviewed) | 済。外来8セルstrict complete |
| 非外来生成 | 24セル×2=48ケースの本文生成済み(`non-outpatient-generated-cases.json`、未コミット) | **ラベル未付与** |
| 実験用機械ビュー | `experimental-machine-holdout.json`(352件、humanReviewSkipped明示) | 未コミット |

レビュー指摘(P1×4+P2×2)は、P1-2(split規律)/P1-1(GLiNERは評価専用・製品はBIO+relevance訓練)/P2×2(100回・PYTHONPATH)がコミットで反映済み。P1-3はユーザーの実レビューで解消。P1-4(非外来請求契約の文言)は本日doc修正済み。

## GCP実測(fee-api-stg)

- revision: `fee-api-stg-00181-prk`。whitebox 3レーンはoff+not_configured(モデル未配置なので想定どおり)。
- **⚠ フラグ落ちを検出**: `extractionMemoEnabled=false / standingFactsEnabled=false /
  monthlyExclusionMode=off`。以前のSTGは memo=true / standing=true / exclusion=enforce
  だった。意図的でなければ、次回デプロイで
  `FEE_EXTRACTION_MEMO_STG=true FEE_STANDING_FACTS_STG=true FEE_MONTHLY_EXCLUSION_MODE_STG=enforce`
  を付けて復元すること(env未指定デプロイで既定値に戻る、過去に一度起きた事故と同型)。
  **H3の受入再走(B2)はこの復元が前提**。

## ⚠ WX0初回計測(gliner-multi-v2.1)は無効

`docs/20260725-whitebox-stg-shadow/wx0/gliner-multi-v2.1/` の全セルF1=0.0000は
**モデルの実力値ではない**。result.jsonは `TP=FP=FN=0`——本当に全滅なら
FN=gold総数になるはずで、**goldも予測も1件も評価器に入っていない**
(実行時のデータセットビューにexpectedSpansが乗っていなかった+予測も0件)。
現在の`experimental-machine-holdout.json`は全ケースspanありを確認済み。
作業ツリーの未コミット修正(`wx0_span_zeroshot.py`のラベル由来集計等)を仕上げて
**再実行が必要**。この数字で分岐判定(S3)をしないこと。

## 次の一手(優先順)

1. **WX0 span再実行**: 未コミット修正を完成→gliner-multi-v2.1 / gliner-biomedで
   再計測。①gold集計=human_reviewed 16件のみ ②experimental集計=機械ラベル込み、
   を必ず分離して出す(実装済みのnotGold機構)。**閾値スイープ(0.1/0.2/0.3/0.5)**を
   追加——予測0件は閾値0.5が日本語で高すぎる可能性があり、0%と閾値問題を
   切り分けるため。
2. **STG envの復元**(上記⚠)。復元後にB2(背反受入の自動再現)を再走してクローズ。
3. **48非外来ケースのラベル付け**: 本文は生成済み(nano=別生成系)。
   ラベルはclaude付与→機械検証→`experimental-machine-holdout.json`更新で
   実験には即使える。**gold昇格には平出さんのレビュー**(H1の昇格CLI経由)。
4. E4(linking)/E5(文脈)/E6(負荷)の実行(実行計画S2)。
5. S3分岐判定は**goldスコア(human_reviewed分)のみ**を根拠に記録。
6. 分岐に応じてH4で成果物製造→S4のshadow手順へ。

## コミット待ち(ユーザー判断)

未コミット: `experimental-machine-holdout.json` / `non-outpatient-generated-cases.json` /
`wx0_span_zeroshot.py`修正 / experimental holdout系スクリプト3本 /
`docs/20260725-whitebox-stg-shadow/`(※無効計測の注記を本ページから参照) /
本日のdocs修正(P1-4文言・本ページ)。
