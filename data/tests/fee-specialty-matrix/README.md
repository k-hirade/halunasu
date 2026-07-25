# Fee Specialty Matrix

WX0で使う、診療科8種 x 受診区分4種の合成カルテ評価コーパスです。
初期目標は各セル10件、うちholdout 2件以上、合計320件です。入院は対象外です。

## 現在地 (2026-07-25 更新)

- train/development: 288ケース(32セル×9)完成。バリデータgreen・軸クォータ全セル充足。
- **holdout: 外来8セル分16件を作成済み**(計304ケース)。本文はannotation queueの
  fee-soap-e2e-v2生成文を無変更で使用(別生成系要件を充足。ビルド時に
  queue本文との完全一致をassertで保証)、ラベルはclaude-fable-5付与+機械検証。
  reviewPolicy.reviewedByに由来を明記しており、コミット前のスポットチェックを推奨。
- **外来8セルはstrict complete**。strict残はhome_visit/house_call/telephoneの
  24セルのみで、別生成系の本文が存在しないため
  H2(非外来holdout生産パイプライン、`fee-whitebox-wx0-completion-workorder-20260725.md`)
  の実装が前提。

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
   blueprint生成器により別生成系ケースを追加してから同じ手順を踏む。
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

モデルは別venvへ`python/experiments/requirements-wx0.txt`を導入します。
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
