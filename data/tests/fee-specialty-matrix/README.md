# Fee Specialty Matrix

WX0で使う、診療科8種 x 受診区分4種の合成カルテ評価コーパスです。
初期目標は各セル10件、うちholdout 2件以上、合計320件です。入院は対象外です。

## 現在地 (2026-07-26 更新)

- train/development: 288ケース(32セル×9)完成。バリデータgreen・軸クォータ全セル充足。
- P4用のtraining-only対立コーパスを96件追加した。全32セルに
  `past` / `other_provider` / `patient_reported` /
  `same_day_but_unknown`を各3 span以上配置し、WX1弱カテゴリだった
  `imaging` / `treatment`も各セル6 spanずつ含めた。
  `training-view.json`は合計384件(train 288 / development 96)になった。
  この96件は`notGold=true`かつholdoutを含まず、昇格評価には使用しない。
- **holdout: 外来8セル分16件を作成済み**(計304ケース)。本文はannotation queueの
  fee-soap-e2e-v2生成文を無変更で使用(別生成系要件を充足。ビルド時に
  queue本文との完全一致をassertで保証)。平出がラベルを確認済みとして承認し、
  `holdoutProvenance.source: human_reviewed`、
  `reviewPolicy.reviewedBy: hiradekeishi` を記録済み。
- **外来8セルはstrict complete**。strict残はhome_visit/house_call/telephoneの
  24セルのみ。非外来48件のblueprintは生成済みで、別生成系によるSOAP本文生成、
  人手レビュー、昇格が残る。
- P5用に全32セルへ1件ずつ、16行・13 span以上の別生成系supplementを作成した。
  既存の非外来48件と合わせたレビューqueueは80件で、レビュー後に全32セルが
  3実行・20行・10 span以上になる。監査上の準備済み範囲は3実行、
  24〜59行、17〜32 span/セル。
- **重要**: supplement 32件とqueue 80件はすべて未レビューであり、
  `reviewed complete`は0/32セル。`test:fee-specialty-matrix:strict`が
  現時点で失敗するのは正しいfail-closed動作である。

執筆フロー:

1. **train/development**: claude-fable-5(primary_generator)が執筆。
   ドラフト(spanはtext+occurrence指定)を執筆ハーネスに通し、
   ①コードポイント単位オフセットの自動計算 ②全コードのマスタ実在検証
   ③軸・カテゴリenum検証 を経て `cases.json` にマージする。
   マージは調整役が直列に行う(並列書き込み禁止)。
2. **holdout(各セル2件)**: 生成系ファミリをtrain側と共有できないため、
   既存のfee-soap-e2e-v2 blueprint(別生成系)から
   `npm run prepare:fee-specialty-matrix` でannotation候補を作り、
   **人手でspan・軸ラベルを確認**して昇格する(human_reviewed)。
   e2e-v2に該当セルの症例がない場合は、OPENAI_API_KEYのある環境で
   `openai-fee-specialty-holdout-v1` 生成系のケースを追加してから同じ手順を踏む。
3. 執筆ケースの正解例は internal_medicine × outpatient の9件
   (wx0-im-outp-0001〜0009)。軸の多様性(past/other_provider/
   not_performed/planned/continued)を各セルに必ず含める。
4. 制度上の簡略化(判断料・採取料の省略、院外処方薬剤のレセプト除外等)は
   各ケースの `expectedClaimContext.notes` に明記する。

```bash
npm run test:fee-specialty-matrix
npm run test:fee-specialty-matrix:strict
npm run prepare:fee-specialty-matrix -- \
  --output /private/tmp/fee-specialty-matrix-annotation-queue.json
```

最後のコマンドは既存v2合成カルテからannotation候補を作るだけです。
`cases.json`への書き戻しやgold昇格はしません。

## Phase 2データの再生成と監査

P4の訓練専用対立コーパスとP5のholdout候補は、次のコマンドで再現できます。

```bash
npm run generate:fee-whitebox-phase2-context
npm run generate:fee-whitebox-phase2-holdout
npm run prepare:fee-whitebox-phase2-holdout-review
npm run audit:fee-whitebox-phase2-data
npm run prepare:fee-whitebox-training-view
npm run test:fee-whitebox-training-view
```

`audit:fee-whitebox-phase2-data`は、32セルすべてにレビュー後の必要母数が
用意されていることを検査する。ただしレビュー完了とは判定しない。
`draftSpanSuggestions`は人手作業の候補であり、すべて
`approved=false` / `suggestion_only`として出力される。

生成物:

- `context-contrast-cases.json`: P4訓練専用96件
- `phase2-holdout-supplement.json`: P5未レビュー候補32件
- `phase2-holdout-review-queue.json`: 既存48件とsupplement 32件のレビューqueue
- `training-view.json`: holdout本文を物理的に含まないWX1/WX3入力

## 非外来holdoutの生成と昇格

```bash
# 8診療科 x 3受診区分 x 2件 = 48 blueprintを生成
npm run generate:fee-specialty-holdout-blueprints

# 非外来契約を含むblueprint validator
npm run test:fee-soap-e2e-v2:blueprints -- \
  --specialty-source data/tests/fee-specialty-matrix/non-outpatient-blueprints.json

# APIを呼ばず入力・出力契約だけ確認
npm run generate:fee-specialty-holdout-texts -- --dry-run

# immutable model revisionを記録して合成SOAP本文を生成
OPENAI_API_KEY=... npm run generate:fee-specialty-holdout-texts -- \
  --model gpt-5.4-nano \
  --model-revision <immutable-model-revision>

# 生成本文をreview queueへ変換
npm run prepare:fee-specialty-matrix -- \
  --source data/tests/fee-specialty-matrix/non-outpatient-generated-cases.json \
  --output data/tests/fee-specialty-matrix/non-outpatient-review-queue.json
```

`non-outpatient-review-queue.json` の各項目について、本文全体を対象に
`approvedSpans`、5軸、コード、`reviewedBy`を人手確認します。anchor suggestionは
候補にすぎず、候補外の算定可能表現も確認します。レビュー完了後:

```bash
npm run promote:fee-specialty-matrix -- \
  --input data/tests/fee-specialty-matrix/non-outpatient-review-queue.json \
  --reviewed-at 2026-07-25 \
  --dry-run

npm run promote:fee-specialty-matrix -- \
  --input data/tests/fee-specialty-matrix/non-outpatient-review-queue.json \
  --reviewed-at 2026-07-25 \
  --strict
```

昇格はバッチ単位でatomicです。caseId衝突、オフセット不整合、未知コード、
provenance不整合が1件でもあれば `cases.json` を更新しません。

## 症例契約

1ケースは少なくとも次を持ちます。

- `specialty`, `encounterSetting`, `split`, `templateId`
- `synthetic: true`
- `generationProvenance`: 生成系または人手作成の由来。generator familyを
  holdoutと非holdoutで共有しない
- `clinicalText`
- `expectedSpans`: Unicodeコードポイント単位の`charStart`/`charEnd`、コード、
  category、5つの文脈軸
- `expectedClaimContext`
- `annotationStatus: reviewed | pending_review`
- holdoutの場合は`holdoutProvenance`

5軸とcategoryの正は
`packages/medical-core/generated/clinical-axes.schema.json`です。JavaScriptや
Pythonにenumを再定義しません。

## 作成・分割規約

- SOAP本文は既存の`fee-soap-e2e-v2/style-spec.md`に従い、1件ずつ作成します。
  患者属性や日付だけを置換した量産物は別ケースとして数えません。
- 同じ`templateId`を異なるsplitへ入れません。
- holdoutは別生成系、またはexpected spanを人が確認済みのケースだけです。
- 実カルテは入れません。医療事務確認前のケースはproduction goldではありません。
- `reviewed`だけがセル充足数と実験指標の分母に入ります。

制御コーパスのcopy-forward率や表現分布は実運用値ではありません。顧客カルテから
本文を保存せず統計量だけ取得するまで、ここでの削減率・精度は機構評価値です。

## 実験ランナー

WX0のGLiNER実験は専用venvへ
`python/experiments/requirements-wx0.txt`を導入します。この環境は
GLiNERが要求するTransformers/Tokenizersを使うため、WX1〜WX3成果物製造環境と
混在させません。
Hugging Faceのbranch名ではなく、モデルカードでライセンスを再確認した
immutable commit SHAを`--revision`へ渡します。

```bash
npm run eval:fee-whitebox-span -- \
  --model urchade/gliner_multi-v2.1 \
  --revision "$MODEL_REVISION" \
  --output-dir docs/202607xx-wx0-span

npm run eval:fee-whitebox-linking -- \
  --backend both \
  --model cl-nagoya/ruri-v3-30m \
  --revision "$MODEL_REVISION" \
  --output-dir docs/202607xx-wx0-linking

npm run eval:fee-whitebox-context -- \
  --output-dir docs/202607xx-wx0-context
```

reviewed症例がない状態では各ランナーは失敗します。空母集団を0%や100%として
レポートしないための仕様です。

## WX1/WX3製造入力

成果物製造は別venvへ
`python/experiments/requirements-whitebox-build.txt`を導入します。この環境の
Tokenizersはfee-apiのONNXランタイムと同じ版に固定します。

```bash
python3.12 -m venv .venv-whitebox-build
.venv-whitebox-build/bin/pip install \
  -r python/experiments/requirements-whitebox-build.txt
```

モデル製造時にはholdoutラベルを物理的に分離したviewだけを使います。

```bash
npm run prepare:fee-whitebox-training-view
npm run test:fee-whitebox-training-view
```

`training-view.json` はtrain/developmentの本文・ラベルだけを持ち、
holdoutはcaseIdだけです。WX1/WX3 builderはこのスキーマ以外を拒否します。
GLiNERはWX0のゼロショット評価・教師候補であり、製品ランタイムへ直接配置する
モデルではありません。製品成果物は既存ONNXランタイム契約に合わせた
BIO+relevance head（WX1）と5軸head（WX3）を学習して生成します。

```bash
PYTHONPATH=python:. .venv-whitebox-build/bin/python \
  scripts/build_wx1_span_artifact.py \
  --base-model <approved-model-id> \
  --model-revision <immutable-revision> \
  --license <commercial-license-id> \
  --license-source-url <official-license-url> \
  --license-verified-at <YYYY-MM-DD> \
  --artifact-version <version>

PYTHONPATH=python:. .venv-whitebox-build/bin/python \
  scripts/build_wx3_context_artifact.py \
  --base-model <approved-model-id> \
  --model-revision <immutable-revision> \
  --license <commercial-license-id> \
  --license-source-url <official-license-url> \
  --license-verified-at <YYYY-MM-DD> \
  --artifact-version <version>
```

builderはtrainで学習し、developmentでcheckpoint選択と較正を行います。
ONNX manifest/checksum、実ランタイムload、同一入力100回一致を通過しない限り
成果物ディレクトリを確定しません。holdout評価とSTG/PROD昇格は別工程です。

### P4のベースモデル比較

MiniLMの再学習は上記`.venv-whitebox-build`を使う。ModernBERT比較は
Transformers 4.48以降を必要とし、fee-api runtimeのTokenizers契約とも異なるため、
専用venvへ隔離する。

```bash
python3.12 -m venv .venv-whitebox-modernbert-build
.venv-whitebox-modernbert-build/bin/pip install \
  -r python/experiments/requirements-whitebox-modernbert-build.txt
```

比較対象は次のimmutable revisionに固定する。

- `sbintuitions/modernbert-ja-130m@28c180b16463ba6f3fa79b48756fbf21586fe23e`
- license: MIT
- license source:
  `https://huggingface.co/sbintuitions/modernbert-ja-130m/blob/28c180b16463ba6f3fa79b48756fbf21586fe23e/LICENSE`

比較専用venvで生成できてもruntime互換とはみなさない。生成したtokenizer/ONNXを
`python/requirements-fee-runtime.txt`の環境でloadし、100回決定論プローブと
`eval:fee-whitebox-runtime`を通過したartifactだけがSTG upload候補になる。
P2のSTG baselineを取得するまでは比較学習を開始しない。
