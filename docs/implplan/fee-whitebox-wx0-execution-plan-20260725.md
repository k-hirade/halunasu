# 実行計画: WX0完了→実測→分岐→shadowまで (2026-07-25)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)。
実装が必要な部分は
[WX0完了ワークオーダー(H1〜H4)](./fee-whitebox-wx0-completion-workorder-20260725.md)。
本ページは**実装以外**(計測・レビュー・判定・展開)の実行手順と完了条件。

## 現在地

- train/development 288ケース(32セル×9、907スパン)完成。バリデータgreen、
  軸クォータ全セル充足、コードは全件マスタ実在検証済み。
- strict残: 各セル reviewed+1 / holdout+2(=holdout 64件で両方同時に解消)。
- ランタイム(WX1〜WX4)は実装済み・全フラグoff。モデル成果物は未製造。

## S1. holdout供給(人手レビュー。WX0の律速)

1. queue生成(実行済み分は `data/tests/fee-specialty-matrix/` 配下を参照):
   ```bash
   npm run prepare:fee-specialty-matrix -- \
     --output data/tests/fee-specialty-matrix/annotation-queue-<date>.json
   ```
2. **人手レビュー**(担当: 平出): 各エントリのanchor候補に対し
   span採否・軸5値・コードを確認/修正し、`reviewedBy`を記入。
   判断基準は既存ケース(wx0-im-outp-0001〜)のラベル流儀に合わせる。
   目安: 1件数分×64件。
3. H1の昇格CLIで検証付きマージ → `--strict` green を確認。
4. e2e-v2資産で埋まらないセルはH2の生成器で候補を追加生産
   (OPENAI_API_KEY必要)→同じレビュー→昇格。

完了条件: `node scripts/validate_fee_specialty_matrix.mjs --strict` がerrors 0。

## S2. WX0実験(E3〜E6)の実行(担当: Claude可)

前提: S1完了(holdout成績が主指標のため)。環境: python3.12 venv+
`python/experiments/requirements-wx0.txt`(3.14はonnxruntime wheelなし)。

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
| 40〜70% | WX1はE2合成データFT前提(GLiNER形式訓練データはblueprintから機械変換) |
| <40% | L1保留。WX2/WX3先行 |
| linking recall@5がname_scan比+10pt | WX2アーティファクト製造へ即進行 |

E6でp95>500ms@10並行なら専用推論サービス分離(親の決定事項5)。

## S4. モデル成果物の製造とSTG shadow

**前提: H4(WX1/WX3モデル製造パイプライン)の実装完了**。現状は評価器と
ランタイムのみで製造CLIが無く、H1〜H3だけではS4へ進めない(第1改訂で明記)。

1. **L2索引**: Ruri(採用サイズ)をONNX変換→
   `python3 scripts/build_fee_linker_index.py`(license引数必須。
   E1判断表の値をそのまま渡す)→アーティファクトを
   `python/data/whitebox/` へ配置(deployのパス検証が効く)。
2. STG展開はF4手順を厳守: E6実測→デプロイ→**readyz確認**
   (`runtimeFeatures`と`whitebox_readiness`のavailable+決定論プローブpassed)→
   `FEE_LINKER_MODE_STG=shadow` で1週間計測(linker候補と人承認の突合)→
   propose切替判断を記録。
3. **L3**: H4のCLIでE2コーパス(train)から訓練→ONNX→`FEE_CONTEXT_CLASSIFIER_MODE_STG=shadow`
   →合議不一致レビュー→assist。昇格基準はWX3ページ(軸別macro-F1、
   危険方向誤陽性≤1%、ECE≤0.05、反例退行ゼロ)。
4. **L1**: S3の分岐に従いH4のCLIで製造→shadow(gold基準recall非劣化+人裁定過半)→
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
  ラベルはclaude付与+機械検証。**外来8セルがstrict complete**になった。
  strict残はhome_visit/house_call/telephoneの24セル(H2実装待ち)のみ。
  精神・整形は在庫全量(各2件)を使用したため、レビューで差し替えが必要になったら
  H2で補充する。外科V2-SURG-PATH-008は本文と請求の乖離が大きく不採用(記録済み)。
