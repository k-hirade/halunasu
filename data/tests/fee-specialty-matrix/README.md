# Fee Specialty Matrix

WX0で使う、診療科8種 x 受診区分4種の合成カルテ評価コーパスです。
初期目標は各セル10件、うちholdout 2件以上、合計320件です。入院は対象外です。

## 現在地

`cases.json` はまだ症例作成前です。空のままでも構造検証は通りますが、厳格検証は
全32セルの不足を返します。未作成ケースを実測済み・gold済みとして扱わないための
意図的な状態です。

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
