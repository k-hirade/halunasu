# 実行計画: WX0完了→実測→分岐→shadowまで (2026-07-25)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)。
実装が必要な部分は
[WX0完了ワークオーダー(H1〜H4)](./fee-whitebox-wx0-completion-workorder-20260725.md)。
本ページは**実装以外**(計測・レビュー・判定・展開)の実行手順と完了条件。

## 現在地

- train/development 288ケース(32セル×9、907スパン)完成。バリデータgreen、
  軸クォータ全セル充足、コードは全件マスタ実在検証済み。
- 外来8セルのholdout 16件は平出が人手確認済みとして
  `human_reviewed` で確定。外来8セルはstrict complete。
- strict残: home_visit / house_call / telephoneの24セルにholdout各2件、
  合計48件。blueprintは生成済みだが本文生成・人手レビュー・昇格は未実施。
- H1〜H4の実装は完了。ランタイム(WX1〜WX4)は全フラグoffで、
  実モデル成果物は未製造。

## S1. holdout供給(人手レビュー。WX0の律速)

1. 非外来48件のblueprintを再生成・検証:
   ```bash
   npm run generate:fee-specialty-holdout-blueprints
   npm run test:fee-soap-e2e-v2:blueprints -- \
     --specialty-source data/tests/fee-specialty-matrix/non-outpatient-blueprints.json
   ```
2. OpenAIの別生成系でSOAP本文を生成:
   ```bash
   OPENAI_API_KEY=... npm run generate:fee-specialty-holdout-texts -- \
     --model gpt-5.4-nano \
     --model-revision <immutable-model-revision> \
     --output data/tests/fee-specialty-matrix/non-outpatient-generated-cases.json
   ```
3. 生成結果からqueueを作成:
   ```bash
   npm run prepare:fee-specialty-matrix -- \
     --source data/tests/fee-specialty-matrix/non-outpatient-generated-cases.json \
     --output data/tests/fee-specialty-matrix/non-outpatient-review-queue.json
   ```
4. **人手レビュー**(担当: 平出): 各エントリのanchor候補に対し
   span採否・軸5値・コードを確認/修正し、`reviewedBy`を記入。
   判断基準は既存ケース(wx0-im-outp-0001〜)のラベル流儀に合わせる。
   `approvedSpans` は候補の承認ではなく、本文全体を確認した完成ラベルとする。
5. H1の昇格CLIでまずdry-run、その後atomic merge:
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

完了条件: `node scripts/validate_fee_specialty_matrix.mjs --strict` がerrors 0。

## S2. WX0実験(E3〜E6)の実行(担当: Claude可)

前提: S1完了(holdout成績が主指標のため)。環境: python3.12 venv+
`python/experiments/requirements-wx0.txt`(3.14はonnxruntime wheelなし)。
このvenvはGLiNERを含むWX0実験専用であり、WX1〜WX3成果物製造には使わない。

```bash
python3.12 -m venv .venv-wx0 && .venv-wx0/bin/pip install -r python/experiments/requirements-wx0.txt
PYTHONPATH=python:. .venv-wx0/bin/python -m experiments.wx0_span_zeroshot ...   # E3
PYTHONPATH=python:. .venv-wx0/bin/python -m experiments.wx0_linking ...         # E4
PYTHONPATH=python:. .venv-wx0/bin/python -m experiments.wx0_context_baseline ...# E5
PYTHONPATH=python:. .venv-wx0/bin/python -m experiments.wx0_load ...            # E6
```

- 使用モデルはE1判断表の**採用候補のみ**(gliner_multi-v2.1 / gliner-biomed /
  ruri-v3-30m/130m/310m+reranker / modernbert-ja-130m)。
- 成果物: `docs/2026XXXX-wx0-measurements/README.md` にセル別ヒートマップ
  (span recall / linking recall@1,5 / 文脈軸別F1 / E6のp50,p95×並行度)。
- E6は1/10/40/80並行(Cloud Run既定CONCURRENCY=80)+cold/warm分離+常駐メモリ。

## S3. 分岐判定の記録

WX0ページの分岐表に従い判定し、**親ページのフェーズ表を更新**する:

| 実測 | 決定 |
| --- | --- |
| span recall ≥70%(主要セル) | WX1ゼロショット+閾値ルーティング |
| 40〜70% | WX1はE2合成データFT前提(BIO token labelをtraining viewから機械変換) |
| <40% | L1保留。WX2/WX3先行 |
| linking recall@5がname_scan比+10pt | WX2アーティファクト製造へ即進行 |

E6でp95>500ms@10並行なら専用推論サービス分離(親の決定事項5)。

## S4. モデル成果物の製造とSTG shadow

**前提: S1 strict green、S2/S3のモデル選定、ライセンスの商用利用確認**。
H4の製造CLIは実装済みだが、未選定モデルを仮定して成果物を作らない。

1. fee-apiのONNXランタイム契約と揃えた成果物製造専用venvを作る。
   GLiNERを含む `.venv-wx0` は使わない:
   ```bash
   python3.12 -m venv .venv-whitebox-build
   .venv-whitebox-build/bin/pip install \
     -r python/experiments/requirements-whitebox-build.txt
   ```
2. 学習入力viewを生成し、元データと同期していることを確認:
   ```bash
   npm run prepare:fee-whitebox-training-view
   npm run test:fee-whitebox-training-view
   ```
   このviewにはtrain/developmentの本文・ラベルだけが入り、holdoutはcaseIdだけ。
   WX1/WX3 builderは元の `cases.json` を直接受け付けない。
3. **L1/WX1**: GLiNERはWX0評価器・教師候補として使う。製品成果物は
   採用encoderへBIO token headとrelevance headを付けて学習する:
   ```bash
   PYTHONPATH=python:. .venv-whitebox-build/bin/python \
     scripts/build_wx1_span_artifact.py \
     --base-model <approved-model-id> \
     --model-revision <immutable-revision> \
     --license <commercial-license-id> \
     --license-source-url <official-model-license-url> \
     --license-verified-at <YYYY-MM-DD> \
     --artifact-version <version>
   ```
4. **L3/WX3**: 同じtraining viewから5軸マルチヘッドを学習する:
   ```bash
   PYTHONPATH=python:. .venv-whitebox-build/bin/python \
     scripts/build_wx3_context_artifact.py \
     --base-model <approved-model-id> \
     --model-revision <immutable-revision> \
     --license <commercial-license-id> \
     --license-source-url <official-model-license-url> \
     --license-verified-at <YYYY-MM-DD> \
     --artifact-version <version>
   ```
   両builderともtrainでfit、developmentでcheckpoint選択・較正し、
   holdoutラベルは読み込まない。ONNXを実ランタイムでロードし、
   同一入力100回一致を満たさない成果物は生成しない。
5. **L2索引**: Ruriの採用モデルを事前にONNX化し、ローカルmodel directoryから:
   ```bash
   PYTHONPATH=python:. .venv-whitebox-build/bin/python \
     scripts/build_fee_linker_index.py \
     --master-db python/data/master/standard-master.sqlite \
     --model-dir <local-immutable-model-dir> \
     --output-dir python/data/whitebox/linker-<version> \
     --model-version <model-id> \
     --model-revision <immutable-revision> \
     --license-model-id <model-id> \
     --license-name <commercial-license-id> \
     --license-verified-at <YYYY-MM-DD> \
     --license-source-url <official-model-license-url>
   ```
6. STG展開はF4手順を厳守: E6実測→デプロイ→**readyz確認**
   (`runtimeFeatures`と`whitebox_readiness`のavailable+決定論プローブpassed)→
   `FEE_LINKER_MODE_STG=shadow` で1週間計測(linker候補と人承認の突合)→
   propose切替判断を記録。
7. **L3**: `FEE_CONTEXT_CLASSIFIER_MODE_STG=shadow`
   →合議不一致レビュー→assist。昇格基準はWX3ページ(軸別macro-F1、
   危険方向誤陽性≤1%、ECE≤0.05、反例退行ゼロ)。
8. **L1**: shadow(gold基準recall非劣化+人裁定過半)→
   route(開始時LLM使用率60〜80%可→M1: <50%)。

## S5. トラックB(並行・短時間)

- **B1 W4安定性基線**: `npm run eval:fee-extraction-stability -- --write-baseline ...`
  (fee-longitudinal-e2e-stg)。合格=全ケース確定点数分散0。Jaccard基線を
  目視レビューしてbaseline.jsonをコミット対象に含める。
- **B2**: H3実装後、standing fixture再走で背反受入を自動再現→
  `fee-workorder-monthly-exclusion-enforcement-20260724.md` を完全クローズ。

## S6. PROD展開ゲート(ビジネス日程と同期)

| 項目 | ゲート |
| --- | --- |
| 背反enforce | まず`FEE_MONTHLY_EXCLUSION_MODE_PROD=shadow`で実分布観察→enforce |
| standing facts / extraction memo | 実顧客カルテのcopy-forward率計測後 |
| 白箱L1〜L3 | S4のSTG実績(shadow→切替の各基準)が揃ってから。常にshadowファースト |

## 進捗記録

- 2026-07-25: S1-1 実施。`annotation-queue-20260725.json`(349候補、42 skip)を生成し
  セル充足を分析した。**e2e-v2資産がカバーするのはoutpatient 8セルのみ**
  (im 162 / derm 52 / ped 56 / ent 49 / oph 23 / surg 3 / orth 2 / psy 2——
  後ろ3科は2〜3件ぎりぎりのためレビューで不採用が出たらH2で補充)。
  **home_visit / house_call / telephone の24セルは候補0件**であり、
  H2(生成器の科×区分対応)が必須と確定。レビュー着手順の推奨:
  ①outpatient 8セル(今すぐ可能、16件で8セルstrict化)→②H2実装後に残り24セル。
- 2026-07-25: S1-2/3(外来分)完了。**holdout 16件を作成しマージ**(計304ケース)。
  本文はqueueのfee-soap-e2e-v2生成文を無変更で使用(ビルド時に完全一致assert)、
  ラベルは人手確認済みとして `human_reviewed` + 機械検証で確定。
  **外来8セルがstrict complete**になった。
  strict残はhome_visit/house_call/telephoneの24セルのみ。H2実装と48件の
  blueprint生成は完了しており、本文生成・人手レビュー・昇格待ち。
  精神・整形は在庫全量(各2件)を使用したため、レビューで差し替えが必要になったら
  H2で補充する。外科V2-SURG-PATH-008は本文と請求の乖離が大きく不採用(記録済み)。
- 2026-07-25: H1〜H4を実装。非外来48 blueprint、検証付き昇格、
  月次背反の解決・export再検証、label-isolated training view、
  WX1/WX3のruntime-compatible ONNX builderを追加。実モデル製造・STG展開は
  S1〜S3のゲート通過後に行う。
