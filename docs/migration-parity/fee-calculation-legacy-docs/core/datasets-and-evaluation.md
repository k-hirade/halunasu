# データセットと評価設計

## 結論

公開でそのまま使える大規模な「診療内容 -> 正解点数」の教師データセットは見つかっていない。

現実的な最良データは、自院または提携医療機関の `電子カルテ/オーダー + 医事会計 + 確定レセプト + 査定返戻結果 + 再審査結果` である。これを使い、審査後に通った請求を正例、査定や返戻を負例、医学的判断が分かれるものを確認対象として扱う。

## 公開データの位置づけ

### 1. 厚労科研の検体検査実験

厚労科研の研究で、検体検査に限定し、電子カルテ情報と電子レセプト情報を使って、レセプト結果を正解データとして扱う検証が行われている。

ただし、公開されているのは報告書と対象選定フローであり、個別症例の正解ラベルCSVや実データ本体は公開されていない。

報告書上の重要な知見。

- 検査オーダーから診療行為への変換は、症例により 73.7% から 97.1% の正答率。
- 総合正答率は症例により大きく異なる。
  - 潰瘍性大腸炎ケース: 79.9%
  - 術前検査ケース: 6.5%
  - 糖尿病ケース: 0.6%
- LLM は単一ルールでは一定精度を示すが、複合的、統合的なルール判定で精度が落ちる。
- 入力情報が曖昧な検査項目では精度が低下する。
- 従来プログラムによる機械的処理と、LLM による非構造化データ処理を組み合わせるハイブリッド方式が示唆されている。

対象選定フローでは、正解データを作成できる症例として、次のような条件で絞り込んでいる。

- 包括が発生しない。
- 管理料による検査実施料の算定がない。
- 検査結果の陽性/陰性による算定ルールがない。
- 算定における整合性の考慮が必要ない。
- 同月2回目以降の検査を除外する。
- 同日複数科の受診を除外する。
- LLM のトークン制約に抵触しない。

これは、初期ベンチマーク設計の参考になる。

### 2. NDB オープンデータ

NDB オープンデータは、医科診療行為、歯科診療行為、調剤行為、処方薬、特定保険医療材料などの集計表を提供している。

使える用途。

- 算定回数の分布確認。
- 都道府県別、性年齢別、診療月別の頻度確認。
- 異常値検知。
- 実装後のアウトプットが実態分布から大きく外れていないかの検証。

使えない用途。

- 個別症例の正解ラベル。
- 診療録から正しい点数を導出する教師データ。
- 査定/返戻の直接ラベル。

### 3. 支払基金の審査情報提供事例

審査情報提供事例は、個別の診療行為について、審査上の一般的な取扱いを示す。

使える用途。

- 単体テスト。
- 査定リスクルール。
- `human_review` 条件の設計。
- 医学的必要性が問題になりやすい項目の警告。

使えない用途。

- 全症例に画一的に適用する正解ラベル。
- 大規模教師データ。

支払基金は、公表事例がすべての個別診療内容に一律適用されるものではないと明記している。

### 4. 商用レセプトデータベース

JMDC Claims Database や REZULT などは、レセプト、診療行為、算定日、算定回数、薬剤、材料、健診などのデータを提供している。

使える可能性。

- 実請求データから頻度、併用パターン、月次履歴を学習する。
- 院外の分布と比較する。
- 医療経済、疫学、コード出現パターンの分析。

注意点。

- 商用契約が必要。
- 実請求データは「実際に請求されたデータ」であり、制度上の完全な正解とは限らない。
- 診療録や未請求の請求漏れは含まれない。
- 査定/返戻結果まで含むかは契約データ仕様を確認する必要がある。

## 自前の正解ラベル設計

最も実用的な gold dataset は、次のデータを結合して作る。

```text
電子カルテ/オーダー
  + 実施情報
  + 医事会計データ
  + 提出レセプト
  + 支払基金/国保連の審査結果
  + 査定/返戻/再審査結果
  + 医事担当者による補正履歴
```

ラベル分類。

- `accepted`
  - 審査後に通った請求。
- `adjusted`
  - 査定、返戻、再請求、再審査で変更された請求。
- `omitted_candidate`
  - 診療データ上は算定候補だが、請求されていないもの。
- `overbilling_risk`
  - 請求されたが、根拠不足または算定要件未充足の疑いがあるもの。
- `needs_review`
  - 医学的判断、診療録確認、施設基準確認が必要なもの。

実装上のgold JSONLは、既存の `ClaimContext` 入力に `expected` を足す。検体検査だけでなく、共通 `ClaimContext` で扱う初再診、投薬、注射、処置、画像診断、入院基本料、DPC reviewも同じ評価入口で比較できる。

```json
{
  "record_id": "gold-1",
  "claim_context_template": {"encounter": {"service_date": "2026-06-03"}},
  "procedure_codes": ["160000410", "160000310"],
  "expected": {
    "status": "ok",
    "total_points": 217,
    "candidate_codes": ["160000410", "160000310", "160061710"]
  }
}
```

評価CLI。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli evaluate-gold-claim-batch \
  --db data/work/standard-master.sqlite \
  --input <gold.jsonl> \
  --format markdown \
  --output <gold-evaluation.md> \
  --classification-output <gold-classification.md> \
  --backlog-output <gold-backlog.md> \
  --action-plan-output <gold-action-plan.md> \
  --fail-on-error \
  --fail-on-mismatch
```

`evaluate-gold-outpatient-lab-claim-batch` は互換用aliasとして残す。

出力は `overall_verdict`、`point_verdict`、`code_verdict`、期待点数、実点数、差分、期待コード不足、余剰コードを返す。`overall_verdict` は `match`、`under`、`over`、`code_mismatch`、`needs_review`、`status_mismatch`、`error`、`unlabeled` のいずれかにする。`expected.status=needs_review` を明示したレコードは、実際の算定結果も `needs_review` で、点数/コード差分がなければ `match` とする。これにより、DPCのように現時点ではレビューへ止めることが正解のレコードをgold datasetへ入れられる。

`--classification-output` を付けると、gold差分をロジック改善へ戻すための分類レポートも出す。分類は `under_claim_missing_code`、`over_claim_extra_code`、`code_substitution_gap`、`required_comment_input`、`facility_standard_input`、`history_input`、`master_mapping_gap`、`outpatient_basic_input`、`medication_input`、`injection_input`、`treatment_input`、`imaging_input`、`inpatient_input`、`dpc_input`、`gold_label_missing`、`batch_execution_error` などに分かれ、各行に `feedback_target`、`priority`、`recommended_action` を付ける。これにより、差分を「算定ロジック修正」「施設基準/マスター補正」「入力contract拡張」「gold label確認」「engine error修正」に分けて戻せる。

`--backlog-output` は分類行を `priority`、`feedback_target`、`classification`、`recommended_action` ごとに束ね、件数、代表record、代表コード、message source、理由を出す。実装順はまず `priority=high`、次に件数が多い項目から見る。

`--action-plan-output` はbacklogを `owner`、`implementation_step`、`acceptance_gate` つきの修正単位へ変換する。これにより、実CSVと確定レセプトの差分を、入力contract、施設基準/マスター、算定ロジック、gold label確認のどこへ戻すかを機械的に並べられる。

実オーダーCSVからgold JSONLを作る場合は、`convert-order-csv-to-claim-jsonl` に正解列を含める。標準列は `expected_total_points`、`expected_status`、`expected_candidate_codes`。日本語presetでは `正解点数`、`期待点数`、`確定点数`、`請求点数`、`合計点数`、`正解ステータス`、`期待ステータス`、`確定ステータス`、`正解コード`、`期待コード`、`確定コード`、`請求コード` を同じ意味にmappingする。`明細種別` / `剤種` が `正解`、`期待`、`確定`、`請求`、`請求済` の行は算定入力に混ぜず、`expected.candidate_codes` だけに追加する。

これにより、レセコン/EHRの実施明細と確定レセプトの点数・コードを同じCSVに載せて、変換後のJSONLをそのまま `evaluate-gold-claim-batch` に流せる。

実データを変換する前に、列mappingをprofileする。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli profile-order-csv-columns \
  --csv <orders.csv> \
  --column-map-preset japanese \
  --format markdown \
  --output <orders-column-profile.md> \
  --fail-on-warning
```

profileは、入力行数、列数、標準列へのmapping、未対応列、`record_id` または複合キー、`item_kind`、コード列、gold label列の有無、値mapping例を出す。病院ごとのCSV受入時は、このprofileを先にレビューしてからJSONL変換とgold評価へ進む。

病院ごとにmapping contractを固定すると、受入条件を機械的にpass/failできる。

最初のcontractは、実CSVのprofileから雛形生成できる。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli generate-order-csv-contract-template \
  --csv <orders.csv> \
  --column-map-preset japanese \
  --contract-id <hospital-order-contract-v1> \
  --hospital-name <hospital-name> \
  --regional-bureau <regional-bureau> \
  --medical-institution-code <medical-institution-code> \
  --output <hospital-order-contract.json>
```

生成されるcontractは、観測された `record_id`、患者ID、診療日、地方厚生局、医療機関コード、`item_kind`、コード列、gold label列を必須候補にし、未対応列を `allowed_unmapped_columns` に初期配置する。未対応列を許容したくない場合は `--strict-unmapped` を付ける。gold labelがないCSVでもgold必須にしたい場合は `--require-gold-labels` を付ける。

```json
{
  "contract_id": "hospital-001-orders-v1",
  "hospital_name": "Example Hospital",
  "regional_bureau": "tohoku",
  "medical_institution_code": "0410001",
  "column_map_preset": "japanese",
  "required_target_fields": [
    "record_id",
    "patient_id",
    "service_date",
    "regional_bureau",
    "medical_institution_code",
    "item_kind",
    "code",
    "expected_total_points",
    "expected_candidate_codes"
  ],
  "required_source_columns": ["レコードID", "診療行為コード"],
  "allowed_unmapped_columns": ["院内メモ"],
  "require_gold_labels": true,
  "minimum_row_count": 1
}
```

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-contract \
  --csv <orders.csv> \
  --contract <hospital-order-contract.json> \
  --format markdown \
  --output <orders-contract-validation.md> \
  --fail-on-error
```

contract検証は、base必須列、contract上の必須target field、必須source column、gold label有無、未対応列が許容リスト内か、最小行数を確認する。これにより、病院別のCSV仕様変更や列抜けを変換前に止められる。

一連の受入処理はpipelineとしてまとめて実行できる。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline \
  --db data/work/standard-master.sqlite \
  --csv <orders.csv> \
  --contract <hospital-order-contract.json> \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --profile-output <orders-column-profile.md> \
  --contract-output <orders-contract-validation.md> \
  --converted-output <orders.jsonl> \
  --conversion-report-output <orders-conversion.md> \
  --output <claim-results.md> \
  --audit-output <claim-audit.csv> \
  --gold-output <gold-evaluation.md> \
  --gold-classification-output <gold-classification.md> \
  --gold-backlog-output <gold-backlog.md> \
  --gold-action-plan-output <gold-action-plan.md> \
  --fail-on-contract-error \
  --fail-on-error \
  --fail-on-mismatch
```

pipelineは、profile、contract検証、JSONL変換、外来claim batch、audit summary、gold評価、gold差分分類、改善バックログ、改善Action Planを同じ入力から実行する。`--gold-output`、`--gold-classification-output`、`--gold-backlog-output`、`--gold-action-plan-output`、または `--evaluate-gold` を付けた場合は、変換済みJSONLの `expected` を使ってgold評価も行う。

複数病院分は `contracts/order-csv/` 配下にcontractとmanifestを置き、batch runnerでまとめて実行する。

```text
contracts/order-csv/
  manifest.example.json
  <regional_bureau>/
    <medical_institution_code>/
      order-contract.json
```

このリポジトリには、書式例として `contracts/order-csv/tohoku/0410001/order-contract.json` を置いている。実病院に適用する前に、病院名、医療機関コード、必須列、gold label必須有無、未対応列の扱いをレビューする。

manifest例。

```json
{
  "entries": [
    {
      "id": "tohoku-0410001",
      "csv": "../../data/work/example-orders/tohoku-0410001/orders.csv",
      "contract": "tohoku/0410001/order-contract.json",
      "template_jsonl": "../../data/work/nationwide-claim-contexts-2026-06-01.jsonl",
      "evaluate_gold": true
    }
  ]
}
```

batch前にmanifest全体を検証する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.example.json \
  --output data/work/order-csv-pipeline/manifest-validation.md \
  --fail-on-error
```

`manifest-validation.md` の `Ready: yes` は、CSV/contract/templateが存在し、contract validationが通り、gold評価対象のentryにgold labelがあることを示す。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.example.json \
  --output-root data/work/order-csv-pipeline \
  --output data/work/order-csv-pipeline/summary.md \
  --review-index-output data/work/order-csv-pipeline/review-index.md \
  --fail-on-contract-error \
  --fail-on-error \
  --fail-on-mismatch \
  --fail-on-batch-error
```

各entryの成果物は `--output-root/<entry id>/` に保存する。summaryはentry別にcontract通過、注意理由、変換warning、算定record数、batch error/review、gold error/review/mismatch、gold差分分類action数、high priority分類数、最多分類、最多戻し先、成果物ディレクトリを集計する。Markdown summaryには全entry横断の `Gold Classification Counts` と `Gold Feedback Target Counts` も出る。`--summary-format` は `markdown`、`json`、`csv`、`tsv` に対応し、CSV/TSVは横断集計やスプレッドシート確認に使う。batch実行では `evaluate_gold` が有効なentryごとに `gold-action-plan` も保存する。

`--review-index-output` を付けると、`attention_reasons` を `contract_failed`、`conversion_warning`、`batch_review`、`gold_mismatch` などの理由別に束ね、見るべき `contract-validation`、`conversion`、`claim-results`、`claim-audit`、`gold-action-plan`、`gold-backlog`、`gold-classification`、`gold-evaluation` へのindexを出す。`--review-index-format json` も指定できる。

Step2の非PHI回帰サンプルとして、`contracts/order-csv/manifest.backlog.example.json` を用意している。このmanifestはcontract validationは通るが、必須コメント入力を意図的に抜いているため、`gold-backlog.md` と `gold-action-plan.md` に `required_comment_input` が出る。通常の `manifest.example.json` は同じ症例の修正版で、コメント行を追加して `gold mismatch 0` に戻る。

Step7の非PHI回帰サンプルとして、`contracts/order-csv/manifest.step7.example.json` と `contracts/order-csv/manifest.step7-backlog.example.json` を用意している。通常Step7 manifestは外来gold、入院基本料gold、DPC期待reviewを含み、`Gold mismatches: 0` になる。backlog manifestは必須コメント不足と入院施設基準不足を含み、`required_comment_input` と `inpatient_input` のAction Planを生成する。

## ベンチマークの段階設計

### レベル1: マスター一致

目的は、院内名称やオーダー名を標準コードへ変換できるかを見ること。

評価指標。

- Top-1 accuracy。
- Top-3 accuracy。
- 未対応率。
- 誤対応率。

### レベル2: 単純出来高

包括や同時算定不可が少ない領域で、点数計算を確認する。

対象例。

- 単独検査。
- 単純な画像診断。
- 単純な処置。

評価指標。

- コード一致率。
- 点数一致率。
- 合計点数一致率。

### レベル3: グルーピングと加算

検体検査の項目数算定、判断料、採取料、加算などを評価する。

評価指標。

- グループ構成一致率。
- 加算追加の precision/recall。
- 削除すべき項目の除外率。
- 合計点数一致率。

### レベル4: 包括、同時算定不可、回数制限

制度上の制約解決を評価する。

評価指標。

- 包括除外の正確性。
- 同時算定不可の解決率。
- 回数制限違反の検出率。
- 請求漏れ候補の検出率。

### レベル5: DPC、手術、麻酔、材料

高難度領域。初期は自動確定ではなく、人間確認前提の評価にする。

評価指標。

- 候補提示 recall。
- 危険な過剰請求の抑制率。
- `needs_review` の適切性。
- 人間確認後の採用率。

## 評価指標

単純な合計点数一致だけでは不足する。

- `code_precision`
  - 算定したコードのうち正しい割合。
- `code_recall`
  - 正解コードをどれだけ拾えたか。
- `points_exact_match`
  - 合計点数が完全一致した割合。
- `points_error_abs`
  - 点数差の絶対値。
- `overbilling_amount`
  - 過剰請求方向の点数差。
- `underbilling_amount`
  - 請求漏れ方向の点数差。
- `review_precision`
  - 人間確認に回したものが本当に確認対象だった割合。
- `unsafe_auto_confirm_rate`
  - 自動確定してはいけないものを確定した割合。最重要。

## テストデータの作り方

1. まず検体検査に限定する。
2. 包括が発生しない症例に絞る。
3. 初診または条件が明確な外来に絞る。
4. 同月2回目以降、同日複数科、特殊管理料、陽性/陰性分岐をいったん除外する。
5. 医事担当者が正解ラベルをレビューする。
6. 徐々に難度を上げる。

推奨する拡張順。

```text
単純検体検査
  -> 複数検体検査
  -> 画像診断
  -> 外来投薬/注射
  -> 処置
  -> 外来管理料
  -> 入院出来高
  -> DPC
  -> 手術/麻酔/材料
```

## 参照

- 厚労科研 診療行為の構造化と生成AI等を活用した標準化されたレセプト作成機能開発: https://mhlw-grants.niph.go.jp/project/178124
- 厚労科研 分担研究報告書2: https://mhlw-grants.niph.go.jp/system/files/report_pdf/202406031A-buntan2.pdf
- 厚労科研 対象選定フロー図: https://mhlw-grants.niph.go.jp/system/files/report_pdf/202406031A-sonota6.pdf
- NDB オープンデータ: https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000177182.html
- 支払基金 審査情報提供事例 医科: https://www.ssk.or.jp/smph/shinryohoshu/sinsa_jirei/teikyojirei/ika/index.html
- JMDC Claims Database: https://www.jmdc.co.jp/jmdc-claims-database/
- REZULT データセット提供: https://www.rezult-lp.com/dataset/
