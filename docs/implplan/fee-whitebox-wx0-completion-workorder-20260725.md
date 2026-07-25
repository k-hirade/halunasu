# 作業依頼: WX0完了に必要な実装(H1〜H4) (2026-07-25, 第1改訂)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)。
実行手順(非実装タスク)は
[WX0実行計画](./fee-whitebox-wx0-execution-plan-20260725.md) を参照。

現状: train/development 288ケース(32セル×9)は完成・バリデータgreen。
strict greenに必要な残りは各セル「reviewed +1件、holdout +2件」で、
holdout供給の道具立てに以下の実装が要る。

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
   `generationProvenance: {source: "separate_generator", generatorFamily: "fee-soap-e2e-v2"}`
   (由来がe2e-v2 blueprintの場合)、
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
   往診: 往診料114000110(+時間帯加算の任意変種)、
   電話: 電話等再診料112007950のみ(処置・検査の当日実施禁止)。
   基本料コード・区分・同一建物条件はblueprint生成時にマスタ照合して埋める。
2. **本文の別生成系経路(新規)**: SOAP本文を生成する実経路を作る。
   `scripts/generate_fee_specialty_holdout_texts.mjs`(新規、OpenAI API使用。
   OPENAI_API_KEY必須・STG系の既存モデル=gpt-5.4-nano系を使用し
   generatorFamilyは `fee-soap-e2e-v2` 系として記録)。入力=非外来blueprint+
   科別style(`data/tests/fee-specialty-matrix/README.md`の科別記載習慣)、
   出力=blueprintに`chart.standard`を埋めたケース。
   **trainの生成系(claude-fable-5)は使用禁止**(リーク検査の趣旨)。
3. **source batchへの取り込み**: 生成ケースを既存のe2e-v2 source batch形式
   (`data/tests/fee-soap-e2e-v2/sources/` 配下)へ追記する変換を実装し、
   `prepare_fee_specialty_matrix_annotations.mjs` が追加改修なしで
   queueに載る形にする(prepareの入力契約を正とする)。
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

## H4. [P1] WX1/WX3モデル製造パイプライン(第1改訂で追加)

### 意図

実行計画S4は「L1/L3を製造→shadow」とするが、現在あるのは
**GLiNERのゼロショット評価器(experiments)と汎用ONNXランタイムだけ**で、
製品成果物を作るCLIが存在しない。H1〜H3が済んでもS4へ進めない。

### 仕様

1. **WX1(span検出器)製造CLI** `scripts/build_wx1_span_artifact.py`:
   - 入力: ベースモデルID(E1判断表の採用候補のみ・license引数必須)、
     モード(zero_shot=そのまま変換 / ft=E2コーパスtrain splitからGLiNER形式
     `{text, entities}` を機械変換して微調整→変換)
   - 処理: エンティティタイプ集合(`wx0_entity_types`の生成物)を焼き込み、
     ONNX変換(opset固定)→決定論設定での自己検証(同一入力20回一致)→
     `whitebox_artifacts` manifest生成(license/modelRevision/タイプ集合hash必須)
   - 出力: `python/data/whitebox/span-<version>/`
2. **WX3(文脈分類器)訓練+変換CLI** `scripts/build_wx3_context_artifact.py`:
   - 入力: ベースモデル(ModernBERT-Ja系、license必須)、E2コーパス(train split。
     反例テスト文は訓練除外をコードで強制)
   - 処理: 5軸マルチヘッド訓練→温度較正→axis別abstainThresholds算出
     (WX3受入基準のcoverage-risk曲線から)→ONNX変換→決定論自己検証→manifest
   - 出力: `python/data/whitebox/context-<version>/`
   - 評価レポート(軸別macro-F1・クラス別P/R・危険方向誤陽性・ECE)を
     `docs/` へ自動出力(昇格判定の材料)
3. **L2索引は既存** `build_fee_linker_index.py` を使用(Ruri ONNX変換部分のみ
   共通ヘルパー化して1/2と共有)。
4. 3CLIとも `wx_retrain.py` のゲート昇格フローに接続する(manifest生成の
   共通化。**本番昇格は人の判断**の原則は不変)。
5. 訓練系依存(torch等)は `python/experiments/requirements-wx0.txt` 側に置き、
   **ランタイムイメージへは持ち込まない**(requirements-fee-runtime.txtは
   onnxruntime系のみを維持)。

### テスト

- license欠落でmanifest生成拒否/反例テスト文が訓練データに混入したら失敗/
  変換後の決定論20回一致/manifestがランタイムローダーの検証を通る。

## 実施順

H1 → H2(WX0クリティカルパス) → H4(S4の前提) → H3(独立・トラックB)。
holdoutレビュー・ラベル付けはH1完了後から並行開始できる。
