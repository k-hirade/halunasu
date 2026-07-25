# 作業依頼: WX0完了に必要な実装(H1〜H4) (2026-07-25, 実装完了版)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)。
実行手順(非実装タスク)は
[WX0実行計画](./fee-whitebox-wx0-execution-plan-20260725.md) を参照。

## 実装結果

- H1〜H4のコード実装と単体テストは完了。
- train/development 288ケースに加え、外来8セルのholdout 16件を
  平出が人手確認済みとして `human_reviewed` で確定した。
- 非外来24セル向けに48件のblueprintを生成済み。SOAP本文生成、人手レビュー、
  昇格は未実施であり、strict greenまでの運用作業として残る。
- WX1/WX3は製造CLIまで実装済み。実モデルの選定、ライセンス確認、学習、
  holdout評価、STG shadowは未実施。

## H1. [P1] annotation queue → cases.json 昇格CLI

### 意図

`prepare_fee_specialty_matrix_annotations.mjs` はqueueを作るだけで、
昇格(cases.jsonへの書き戻し)は意図的に自動化されていない。人手レビュー後の
昇格を手作業のJSON編集にすると、オフセット・provenance・split検査を
すり抜ける編集ミスが混入するため、**検証付き昇格CLI**を作る。

### 仕様

`scripts/promote_fee_specialty_matrix_annotations.mjs`:

1. 入力: レビュー済みqueueファイル(各エントリに人手確認の結果として
   `reviewedBy`(自由文字列)、`approvedSpans`(採否・修正済みspan配列)、
   `specialty` / `encounterSetting` / `split:"holdout"` が付与された状態)。
2. 変換: ケースへ次を強制付与——`synthetic: true`、
   `annotationStatus: "reviewed"`、
   入力由来の `generationProvenance`、
   `holdoutProvenance: {source: "human_reviewed"}`、
   `reviewPolicy: {expectedSpansReviewed: true, reviewedBy, reviewedAt}`。
3. 検証: マージ前に既存validate(lib)を丸ごと実行し、オフセット再計算
   (text+occurrence→charStart/charEnd)・コードのマスタ実在
   (`standard-master.sqlite`)・軸enum・split/生成系リークを機械検証。
   1件でもエラーなら**全件マージしない**(部分マージ禁止)。
4. **caseId衝突の扱い(改訂: 「同一caseIdは置換」は危険なため変更)**:
   - 衝突は**既定で拒否**(エラー終了。train/developmentの既存ケースを
     holdoutで静かに上書きする事故を構造的に防ぐ)。
   - 置換を許すのは `--replace` 明示時のみ、かつ**置換先が既存holdoutで、
     sourceCaseIdとgenerationProvenanceが完全一致する場合に限る**。
     それ以外(splitが違う・由来が違う)は--replaceがあっても拒否。
5. **atomicの意味の明確化**: 「部分マージ禁止」とは、入力された
   レビュー済みバッチ(1ファイル)単位で全件成功か全件不採用か、の意味。
   バッチ内1件のエラーでファイル全体をマージしない。複数バッチの直列実行は可。
6. `--dry-run` あり。

### テスト

- 昇格後ケースがvalidator green/holdoutProvenance・reviewPolicyの強制付与/
  エラー1件で全体不マージ/dry-run無変更。

## H2. [P1] 非外来holdout生産パイプライン(第1改訂: 実装前提を実態に修正)

### 意図と前提の訂正

holdoutは別生成系の本文が必須だが、home_visit/house_call/telephoneの24セルには
候補が存在しない。**初版の前提が誤っていた**: 既存の
`generate_fee_soap_e2e_v2_blueprints.mjs` は**静的blueprint生成器であり、
OpenAIを呼ばず、SOAP本文も生成しない**。さらに以下が外来前提で
ハードコードされている(`:363` is_outpatient / `:371-373` 初診・再診の
outpatient_basic / `:403` setting="outpatient")。
「--specialtyを足すだけ」では成立しないため、パイプライン全体を実装する。

### 仕様(5構成要素)

1. **非外来blueprint契約**: blueprintスキーマへ
   `encounterSetting: home_visit | house_call | telephone` を追加し、
   区分ごとのExpected Claim Context契約を定義する——
   訪問診療: 訪問診療料(114001110/114030310)+`encounterDetails`
   (sameBuilding/singleBuildingPatientCount。本文の居住状況と整合必須)、
   往診: **初診料または再診料+往診料114000110+当日行為**(時間帯加算の任意変種。
   既存goldの往診ケースと同形)、
   電話: 電話等再診料112007950を基本とし、**当日交付した処方箋料120002910は許可**。
   物理的な処置・検査を「実施」として期待することは禁止(既存goldの電話ケースと同形。
   実装済みの `TELEPHONE_ALLOWED_CODES = {112007950, 120002910}` と一致させる)。
   基本料コード・区分・同一建物条件はblueprint生成時にマスタ照合して埋める。
2. **本文の別生成系経路(新規)**: SOAP本文を生成する実経路を作る。
   `scripts/generate_fee_specialty_holdout_texts.mjs`(新規、OpenAI API使用。
   OPENAI_API_KEY必須・STG系の既存モデル=gpt-5.4-nano系を使用し
   generatorFamilyは `openai-fee-specialty-holdout-v1` として記録)。入力=非外来blueprint+
   科別style(`data/tests/fee-specialty-matrix/README.md`の科別記載習慣)、
   出力=blueprintに`chart.standard`を埋めたケース。
   **trainの生成系(claude-fable-5)は使用禁止**(リーク検査の趣旨)。
3. **source batchへの取り込み**: 生成結果をe2e-v2互換のsource document
   (`fee-soap-e2e-v2-cases.v2`)として出力し、
   `prepare_fee_specialty_matrix_annotations.mjs --source <生成結果>` で
   queueに載る形にする。既存のe2e-v2データセットへ追記しない。
4. **validator拡張**: `validate_fee_soap_e2e_v2_blueprints.mjs` に
   非外来ケースの検証(区分と基本料コードの整合・電話ケースに
   処置/検査の期待が無いこと・訪問ケースのsameBuilding整合)を追加する。
5. パイプライン(生成→blueprint検証→取り込み→prepare→ラベル付け→H1昇格)を
   READMEに追記する。

### テスト

- 非外来blueprint契約のvalidator(整合・禁止事項)。
- API鍵なしdry-runでの引数検証。生成済みサンプルのprepare互換。
- 電話blueprintに処置期待が混入した合成入力→validator失敗。

## H3. [P1] 背反ハーネス2拡張(トラックB2。X受入の自動再現)

`fee-workorder-monthly-exclusion-enforcement-20260724.md` の受入結果欄に
記録済みの残作業。`scripts/evaluate_fee_monthly_chart_e2e.mjs` へ:

1. **exclusion指標のper-run記録**: monthly応答から
   `exclusionMode / exclusionConstraintsStatus / exclusionConflicts /
   blockedLines / blockedLinesPreview / unresolvedExclusionCount` を
   result.jsonのmonthlyレコードへ保存し、summaryへ集計を追加。
2. **解決ステップ**: `--resolve-exclusions <action>`(例: choose_a)を追加。
   反復ごとに未解決の2コードconflictを検出したら、解決API
   (`PUT /v1/fee/monthly-exclusion-resolutions`、CSRF付き)へ
   指定actionを保存→月次を再取得して確定点数を記録する。
   複雑成分・unsupportedはスキップして件数を報告。
3. 受入: standing fixture再走で「未解決検知→エクスポート409→choose_a→
   3,502点×3反復一致→CSV/UKEに140003810なし」が**プローブなしで**再現される。

## H4. [P1] WX1/WX3モデル製造パイプライン

### 意図

実行計画S4は「L1/L3を製造→shadow」とするが、現在あるのは
**GLiNERのゼロショット評価器(experiments)と汎用ONNXランタイムだけ**で、
製品成果物を作るCLIが存在しない。H1〜H3が済んでもS4へ進めない。

### 仕様

1. **学習入力の物理分離**:
   - `prepare_fee_whitebox_training_view.py` が `cases.json` から
     train/development本文・ラベルだけを `training-view.json` へ出力する。
   - holdoutはcaseIdだけを残し、本文・span・軸ラベルを学習プロセスへ渡さない。
   - WX1/WX3 builderはtraining-viewスキーマ以外を拒否する。元の
     `cases.json` を直接指定してholdoutラベルを読む経路はfail closed。
2. **WX1(span検出器)製造CLI** `scripts/build_wx1_span_artifact.py`:
   - 入力: 商用利用可能性を確認したベースencoderのモデルID、immutable revision、
     license記録、E2コーパスのtrain/development view。
   - GLiNERはWX0のゼロショット評価・候補選定に使うが、製品ONNXを直接変換する
     前提にはしない。製品ランタイム契約に合わせ、encoderへ
     BIO token headと行relevance headを付けて学習する。
   - trainだけでfitし、development lossでcheckpointを選び、developmentで
     entity別閾値とrelevance temperatureを較正する。閾値評価は本番と同じ
     「全token labelのargmax後にカテゴリ閾値を適用」で行う。
   - ONNX変換(opset固定)後、実ランタイムローダーでmanifestを検証し、
     同一入力100回一致を必須にする。
   - 出力: `python/data/whitebox/span-<version>/`
3. **WX3(文脈分類器)訓練+変換CLI** `scripts/build_wx3_context_artifact.py`:
   - 入力: ベースモデル(ModernBERT-Ja系、license必須)、E2コーパス(train split。
     反例テスト文は訓練除外をコードで強制)
   - 処理: encoder+5軸マルチヘッドをtrainだけで訓練し、development lossで
     checkpointを選択→軸別温度較正→axis別abstainThresholds算出
     (WX3受入基準のcoverage-risk曲線から)→ONNX変換→決定論自己検証→manifest
   - ONNX変換後に実ランタイムローダーで検証し、同一入力100回一致を必須にする。
   - 出力: `python/data/whitebox/context-<version>/`
   - 評価レポート(軸別macro-F1・クラス別P/R・危険方向誤陽性・ECE)を
     `docs/` へ自動出力(昇格判定の材料)
4. **L2索引は既存** `build_fee_linker_index.py` を使用する。成果物manifestは
   WX1/WX3と同じ `whitebox_artifacts` 検証境界を通す。
5. WX1/WX3はimmutableなversion directoryとmanifest/checksumを生成する。
   `wx_retrain.py` を含む昇格判定は別工程とし、builderは自動昇格しない。
   **本番昇格は人の判断**の原則は不変。
6. WX0のGLiNER実験依存は `python/experiments/requirements-wx0.txt`、
   WX1〜WX3の成果物製造依存は
   `python/experiments/requirements-whitebox-build.txt` に分離する。
   GLiNERが要求する新しいTransformers/Tokenizersと、fee-apiのONNXランタイム
   契約に合わせた成果物製造環境を同じvenvへ混在させない。
   **いずれもランタイムイメージへは持ち込まない**
   (`requirements-fee-runtime.txt`はonnxruntime系のみを維持)。

### テスト

- license欠落でmanifest生成拒否/元matrix直接指定拒否/holdoutラベルの
  training-view混入拒否/反例テスト文が訓練データに混入したら失敗/
  変換後の決定論100回一致/manifestがランタイムローダーの検証を通る。

## 実施順

コード実装は H1 → H2 → H3/H4 の順で完了した。
残る運用順は、非外来本文生成→人手レビュー→H1昇格→strict green→
WX0実測→モデル選定→H4で成果物製造→holdout評価→STG shadowである。
