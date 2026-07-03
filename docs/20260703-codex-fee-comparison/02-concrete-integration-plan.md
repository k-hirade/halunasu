# Concrete Integration Plan

作成日: 2026-07-03

## 目的

前回の全体比較を、実装に移せる粒度まで落とした。ここでは「外部リポジトリのどのロジックを、halunasu fee のどこへ、どのデータ契約で入れるか」を具体化する。

結論:

- まず入れるべきは `recept-checker` 由来の「UKE/レセプト正規化モデル」と「receipt check finding」。
- 次に `mediaclAI_recept` 由来の「ゴールデンケース評価」と「RuleTrace/source provenance」。
- UIを大きく変える必要はない。既存の再算定差分診断、月次点検、レセプト案、reviewItemsに接続する。

## 1. 現行 halunasu の具体的な状態

### 1.1 既存レセ取込はあるが、UKEモデルが薄い

現在の主な実装:

- `python/medical_fee_calculation/baseline_adapter.py`
- `python/medical_fee_calculation/baseline_api.py`
- `services/fee-api/src/python-calculator.js`
- `services/fee-api/src/server.js`

現行 `baseline_adapter.py` の特徴:

- `parse_uke()` は `RE` を患者境界として、`SI/IY/TO` のコード・点数・回数だけを `BaselineClaim` に集約する。
- `UkeLayout` でフィールド位置を上書きできる。
- `SY` 病名、`CO` コメント、`SJ` 症状詳記、`IR` 医療機関、`GO` 合計、`KO` 公費、剤の代表行/継続行の扱いは薄い。

このため、現状の再算定差分診断は「コード/点数の突合」には使えるが、以下の診断には弱い。

- 病名不足の理由付け
- コメント不足
- 症状詳記不足
- UKE全体の合計点検算
- 診療実日数
- 公費/負担区分
- 剤単位の薬剤/材料のまとまり
- 未対応レコードの可視化

### 1.2 再算定差分診断の土台はすでにある

主な実装:

- `packages/fee-core/src/index.js`
  - `buildBaselineDiagnosis()`
  - `buildMonthlyBaselineDiagnosis()`
  - `BASELINE_COMPARISON_STATUS`
  - `BASELINE_DIFF_CATEGORY`
- `python/medical_fee_calculation/baseline_diagnosis.py`
  - `BaselineClaim`
  - `EngineClaim`
  - `DiagnosisFinding`
  - `diagnose_claim()`
- `services/fee-api/src/server.js`
  - `parseRecalculationDiffDatasetFromBody()`
  - `mergeZipDatasetSources()`
  - `buildCalculationPayloadsFromRecalculationDiffDataset()`
  - `claimContextFromDatasetGroup()`

既にできていること:

- `baselineReceipt`
- `patients`
- `charts`
- `orders`
- `diagnoses`
- `facility`
- `calculationPayloads`

これらをZIP/JSON/CSV/JSONLから読み、患者×診療日単位の再算定payloadにできる。

既にある差分分類:

- `baseline_only`: 既存のみ
- `engine_only`: 当社のみ
- `both_delta`: 両方差分あり
- `matched`: 一致

不足していること:

- 「再算定元ordersにはあるが、当社エンジンに出なかった」ことを `reproducibility` として独立管理すること。
- UKE側の病名/コメント/症状詳記を差分理由に使うこと。
- parserのunknown/parse warningをUIに出すこと。
- 差分行に「なぜそうなったか」の点検Findingを添えること。

### 1.3 レセプト案のUKE出力はあるが、自己検証が薄い

主な実装:

- `packages/fee-core/src/index.js`
  - `buildReceiptDenshin()`
  - `serializeUke()`
  - `buildReceiptExportValidation()`
- `services/fee-api/src/server.js`
  - `/v1/fee/sessions/:id/receipt.uke`
  - `/v1/fee/monthly-receipt.uke`

現状の `buildReceiptExportValidation()` は、未設定項目や点数0などの表層的validationが中心。

`recept-checker` 由来のUKE parserを入れると、次ができる。

- halunasuが出したUKEを再パースして、構造として読めるか確認する。
- `HO.total_points` と明細合計の差を検出する。
- `CO/SJ` の空本文、コメントコード不明を検出する。
- `SI/IY/TO` の日別算定回数や剤の行数を扱える。

## 2. recept-checker から具体的に活かすもの

### 2.1 データモデル

確認ファイル:

- `/Users/hiradekeishi/medical-ai/recept-checker/receipt_checker/models.py`

特に有用なクラス:

| recept-checker | 使う理由 | halunasu側の対応 |
|---|---|---|
| `Finding` | rule_id/category/severity/message/target/detail/suggestion が揃う | `reviewIssues` / `receiptCheckFindings` へ変換 |
| `Facility` | IRレコードを保持 | `receiptDraft.facilitySnapshot` / parsed UKE context |
| `Insurance` | HOレコード、実日数、合計点 | baseline claim total / validation |
| `Kohi` | KO公費レコード | 公費併用・負担区分の点検 |
| `Disease` | SY病名、疑い、未コード、転帰、修飾語 | 病名不足・病名整理・再審査理由 |
| `CommentItem` | COコメントコード/本文 | コメント不足・不明コメントコード |
| `ServiceItem` | SI/IY/TO共通、点数、回数、日別回数、剤行数 | line normalization / UKE validation |
| `SymptomDetail` | SJ症状詳記 | 症状詳記ドラフト/不足確認 |
| `Receipt` | 1レセプト単位の集約 | `ParsedReceipt` として移植 |
| `ClaimFile` | UKEファイル全体 | `ParsedClaimFile` として移植 |

halunasuで作るべき型:

```python
@dataclass(frozen=True)
class ParsedReceiptLine:
    record_type: str           # SI / IY / TO
    code: str
    name: str = ""
    points: float | None = None
    count: float = 1
    quantity: float | None = None
    shinryo_identification: str = ""
    day_counts: tuple[int, ...] = ()
    comments: tuple["ParsedReceiptComment", ...] = ()
    line_no: int = 0
    zai_row_count: int = 1

@dataclass(frozen=True)
class ParsedReceipt:
    receipt_no: int
    patient_id: str
    claim_month: str
    patient_name: str = ""
    sex: str = ""
    birthdate: str = ""
    total_points: float | None = None
    actual_days: int | None = None
    lines: tuple[ParsedReceiptLine, ...] = ()
    diseases: tuple[ParsedReceiptDisease, ...] = ()
    comments: tuple[ParsedReceiptComment, ...] = ()
    symptom_details: tuple[ParsedSymptomDetail, ...] = ()
```

ポイント:

- 既存 `BaselineClaim` は残す。
- `ParsedReceipt` から `BaselineClaim` を派生させる。
- UKEの詳細は `ParsedReceipt` に保持し、差分理由や点検に使う。

### 2.2 UKE parser

確認ファイル:

- `/Users/hiradekeishi/medical-ai/recept-checker/receipt_checker/parser/uke_parser.py`

活かすべき具体ロジック:

| 機能 | recept-checker実装 | halunasuでの必要性 |
|---|---|---|
| 文字コード判定 | BOM UTF-8 -> UTF-8 -> cp932 | 病院UKE/CSVはShift_JISが多い |
| EOF 0x1A除去 | `data.rstrip(b"\x1a")` | レセ電ファイル互換 |
| 行分割 | `\r\n|\r|\n` | UKEの改行差分に対応 |
| 単純カンマ分割 | csv quote解釈を使わない | レセ電仕様に合わせる |
| 未知レコード | parse errorではなくINFO Finding | DPC/将来レコードを止めない |
| RE境界 | REでReceiptを開始 | 患者×月集約 |
| SI/IY/TO共通化 | `ServiceItem` | 差分診断で行為/薬剤/材料を同一処理 |
| 剤の継続行 | 代表行の点数/回数/日別情報を継続行へ引き継ぐ | 薬剤/材料の実回数を誤らない |
| CO紐付け | 直前itemに紐付け、なければstandalone | コメント不足判定 |
| SJ保持 | 症状詳記区分/本文を保持 | 詳記不足/再審査支援 |

halunasuに作るファイル案:

- `python/medical_fee_calculation/receipt_uke.py`
- `python/tests/test_receipt_uke.py`

既存ファイルの変更:

- `python/medical_fee_calculation/baseline_adapter.py`
  - `parse_uke()` は新parserを呼び、`ParsedReceipt` から `BaselineClaim` に変換する。
  - API互換は維持する。
- `python/medical_fee_calculation/baseline_api.py`
  - 既存の `baselineClaims` に加えて `parseWarnings`, `unknownRecords`, `parsedReceiptStats` を返せるようにする。

返す例:

```json
{
  "baselineClaims": [
    {
      "patientId": "1001",
      "claimMonth": "2026-06",
      "lines": [{ "code": "112007410", "name": "再診料", "points": 76, "count": 1 }],
      "totalPoints": 1392,
      "actualDays": 9
    }
  ],
  "parsedReceiptStats": {
    "receiptCount": 1,
    "lineCount": 18,
    "diseaseCount": 4,
    "commentCount": 2,
    "symptomDetailCount": 1,
    "unknownRecordCount": 0
  },
  "parseWarnings": []
}
```

### 2.3 CheckEngine/Finding

確認ファイル:

- `receipt_checker/engine.py`
- `receipt_checker/rules/base.py`
- `receipt_checker/rules/*.py`

具体的な構成:

- `CheckEngine.run()` がレセプトごとに `all_rules()` を実行する。
- 診療年月に応じて `masters.for_ym(ym)` でマスター版を選ぶ。
- `settings.filter_findings()` で除外設定を適用する。
- 結果は `Finding` に集約される。

halunasuで作るべき対応:

- `python/medical_fee_calculation/receipt_checks.py`
- `ReceiptCheckFinding`
- `run_receipt_checks(parsed_claim_file, options)`

データ契約:

```json
{
  "findingId": "receipt_check_CM-001_1001_120002910",
  "source": "receipt_check",
  "ruleId": "CM-001",
  "ruleName": "摘要記載の漏れ",
  "category": "comment",
  "severity": "warning",
  "patientId": "1001",
  "claimMonth": "2026-06",
  "receiptNo": 1,
  "targetCode": "120002910",
  "targetName": "処方箋料（リフィル以外・その他）",
  "messageForStaff": "処方箋料に必要なレセプトコメントがありません。",
  "detail": "コメントコードまたは症状詳記で理由を確認してください。",
  "suggestion": "カルテ記載とレセプトコメントを確認してください。",
  "chartInsertionText": "",
  "receiptCommentDraft": "",
  "autoBillable": false
}
```

JS側の接続:

- `services/fee-api/src/server.js`
  - Python calculatorに `receipt_check` opを追加。
  - `calculationResult.reviewIssues` に変換して既存 `buildReviewItems()` に流す。
- `packages/fee-core/src/index.js`
  - `normalizeReviewIssues()` が受けられるshapeに寄せる。
  - `shouldHideReviewIssueFromWorkspace()` は内部警告だけ非表示。receipt checkは原則表示。

### 2.4 最初に入れるルール

`recept-checker` の全ルールを一気に入れない。最初はhalunasuの既存マスター/データで判定しやすいものに絞る。

| 優先 | rule | 外部クラス | halunasuでの実装 |
|---|---|---|---|
| P0 | UKE形式 | `RequiredFieldsRule`, `DateConsistencyRule` | `buildReceiptExportValidation()` 強化 |
| P0 | 未知コード | `UnknownCodeRule` | halunasu master search/DBで存在確認 |
| P0 | 合計点 | `TotalPointsRule` | `HO.total_points` と明細合計を比較 |
| P0 | 固定点数 | `FixedPointsRule` | master points とUKE pointsを比較 |
| P0 | コメント | `CommentRequirementRule`, `UnknownCommentCodeRule` | 既存コメント要件/コメントマスターと接続 |
| P0 | 基本診療料なし | `NoBaseVisitFeeRule` | line code prefix/基本料カテゴリで検出 |
| P0 | 処方料/処方箋料 | `NoPrescriptionFeeRule` | 薬剤行があるのにF100/F400相当なし |
| P0 | 同日初再診 | `SameDayFirstAndRevisitRule` | 同一receipt内の初診/再診重複 |
| P1 | 縦覧回数 | `LongitudinalFrequencyRule` | 月次/既存レセ履歴DBが必要 |
| P1 | 病名整理 | `NoDiseaseRule`, `UncodedDiseaseRule` | parsed SY + diagnosis records |
| P1 | 併算定/包括 | `OfficialHaihanRule`, `OfficialHokatsuRule` | 電子点数表DBの整備状況次第 |
| P2 | 医薬品適応/禁忌 | `DrugIndicationRule`, `KinkiDiseaseRule` | 支払基金チェックマスター相当が必要 |
| P2 | 用量制限 | `DailyDoseRule`, `DaysLimitRule`, `GroupDoseRule` | 薬剤投与量データの粒度が必要 |

注意:

- `recept-checker` の文言には「収益の損失」寄りの表現がある。halunasuではそのまま使わず、「実施事実・要件確認のうえ判断」に置き換える。
- ルールのON/OFFは最初からDB判定に影響させない。表示抑制だけにする。

### 2.5 返戻・査定データ

確認ファイル:

- `/Users/hiradekeishi/medical-ai/recept-checker/receipt_checker/henrei.py`

具体的に扱っているもの:

- `RECEIPTC.HEN`
- `RECEIPTC.SAH`
- 増減点連絡書CSV
- `HR` 返戻理由
- 増減点事由 `A/B/C/D/F/G/H/K`

データモデル:

- `AssessmentEntry`
  - `kind`: `henrei` / `satei`
  - `shinryo_ym`
  - `receipt_no`
  - `patient_name`
  - `karte_no`
  - `shikibetsu`
  - `reason_code`
  - `reason_text`
  - `points`
  - `before_text`
  - `after_text`
  - `search_no`

halunasuに入れる場所:

- Phase 10相当の査定/再審査支援
- 月次画面の「過去査定と類似」
- 再審査請求ドラフト

作るファイル案:

- `python/medical_fee_calculation/assessment_feedback.py`
- `python/tests/test_assessment_feedback.py`

API案:

- `POST /v1/fee/assessment-feedback/import`
- STG限定から開始。

### 2.6 設定/除外

確認ファイル:

- `receipt_checker/settings.py`

具体的な良い点:

- `exclusions` は `rule_id`, `target`, `patient_name`, `exact`, `reason` を持つ。
- `exact=True` は1指摘単位の除外。空欄がワイルドカードにならない。
- `exact=False` は範囲除外。管理者用。
- `rule_switches` でrule単位ON/OFF。

halunasuで使うなら:

- 既存の「算定設定」に `receiptCheckPolicy` を追加。
- 最初は `severity: off/warning/error` の表示制御だけ。
- `exact` の思想は採用する。
- 除外理由と変更者を監査ログに残す。

## 3. mediaclAI_recept から具体的に活かすもの

### 3.1 Golden cases

確認ファイル:

- `/Users/hiradekeishi/medical-ai/mediaclAI_recept/data/golden/README.md`
- `/Users/hiradekeishi/medical-ai/mediaclAI_recept/data/golden/cases/gr-001.json` 〜 `gr-020.json`
- `/Users/hiradekeishi/medical-ai/mediaclAI_recept/eval/golden_runner.py`

20症例の主なカバレッジ:

| case | 内容 | halunasuでの価値 |
|---|---|---|
| gr-001 | 初診+院内検体検査、判断料、外来迅速不可 | 検査/判断料/予定扱いの回帰 |
| gr-002 | 再診+外来管理加算可 | 外来管理加算の候補判定 |
| gr-003 | 処置実施日の外来管理加算不可 | 禁止候補テスト |
| gr-004 | 生活習慣病管理料と包括 | 管理料/包括 |
| gr-005 | 特定疾患処方管理加算+一般名処方加算 | 院外処方箋/加算排他 |
| gr-006 | 静岡こども83公費 | 公費/負担区分 |
| gr-007 | 休日/時間外加算 | 時間帯加算の相互排他 |
| gr-008 | 往診 | 往診/訪問診療/外来管理加算 |
| gr-009 | 予定・拒否トラップ | LLM status安全性 |
| gr-010 | 他院実施トラップ | 他院実施の算定禁止 |
| gr-011 | 病名不足 | コメント/病名不足警告 |
| gr-012 | 在総管+訪問診療 | 在宅/月間レセ |
| gr-013 | 高額療養費区ウ | 特記事項/限度額 |
| gr-014 | 難病54+静岡83 | 公費多重 |
| gr-015 | 2026-04二段階施行 | 版固定 |
| gr-016 | 静岡84自動償還 | 公費併用にしない判断 |
| gr-017 | 薬剤料実薬価/院内処方 | 薬剤料/処方料 |
| gr-018 | 廃止コード提示禁止 | deprecated code leak |
| gr-019 | 外来迅速検体検査加算可 | gr-001との対照 |
| gr-020 | 複数手術特例 | 手術/従50/100 |

halunasuへの具体導入:

- `python/data/golden/mediaclai_recept/` に変換後JSONを置く。
- 変換スクリプト:
  - `scripts/import_mediaclai_golden_cases.py`
  - または `python/medical_fee_calculation/golden_importer.py`
- テスト:
  - `python/tests/test_mediaclai_golden_cases.py`
  - `services/fee-api/test/server.test.js` には最小限のAPI smokeだけ。

変換方針:

- `input.karte_text` は LLMあり評価用。
- `expected_candidates` は deterministic expected lines。
- `forbidden_candidates` は「出たらP0失敗」。
- `expected_facts` の予定/他院/未実施は、LLM status regressionに使う。
- `provenance` はそのまま保存し、halunasu master sourceと突合できるものだけ有効化。

halunasu用の中間形式:

```json
{
  "caseId": "gr-005",
  "serviceMonth": "2026-06",
  "clinicalText": "...",
  "expectedLines": [
    { "code": "112007410", "name": "再診料", "points": 76, "count": 1 }
  ],
  "forbiddenLines": [
    { "code": "120003570", "reason": "一般名処方加算2は加算1と併算定不可" }
  ],
  "expectedReviewIssues": [
    { "topic": "monthly_history", "messageIncludes": "月2回上限" }
  ],
  "sourceProvenance": [...]
}
```

### 3.2 golden_runner の採点思想

確認ファイル:

- `eval/golden_runner.py`

使うべき採点:

- line F1
- points score
- required warning recall
- fact recall
- forbidden adopted penalty
- HazardStatus penalty
- forbidden採用でCI gate BLOCK

halunasuでの対応:

- `python/medical_fee_calculation/claim_batch.py` に既に gold difference classification がある。
- そこへ `forbiddenLines` と `expectedReviewIssues` の評価を追加するのが自然。
- LLMを使う評価と使わない評価は分ける。

最低限のCIゲート:

- forbidden codeが `confirmed` または自動採用相当で出たら失敗。
- `予定/他院/未実施` を実施としてbilling input化したら失敗。
- expected line欠落は最初はwarningでもよい。

### 3.3 RuleTrace / evidence trace

確認ファイル:

- `docs/04-dsl-spec.md`
- `db/schema.sql`

取り込むべき概念:

- `RuleTrace`
  - `rule_id`
  - `verdict`
  - `action`
  - `target_code`
  - `matched_predicates`
  - `unresolved_predicates`
  - `source_refs`
  - `table_lookups`
- `evidence_trace`
  - カルテspan
  - RAG/マスター引用
  - source verification

halunasuでの具体実装:

- Pythonの各算定結果lineに `traces` を追加する。
- `reviewIssues` に `ruleTraceIds` または `trace` を付ける。
- まずDBの新テーブルは作らず、`calculationResult.trace` に同梱する。

例:

```json
{
  "lineId": "line_120002910",
  "code": "120002910",
  "name": "処方箋料（リフィル以外・その他）",
  "points": 60,
  "traces": [
    {
      "ruleId": "prescription_outpatient_f400",
      "verdict": "pass",
      "source": "python.medical_fee_calculation.medication_fees",
      "matchedPredicates": ["external_prescription=true", "refill=false"],
      "unresolvedPredicates": [],
      "sourceRefs": ["medical_procedure_master:120002910@R08"]
    }
  ]
}
```

### 3.4 source verification

確認ファイル:

- `db/schema.sql`
- `docs/09-gaps-sources-provenance.md`
- `tools/watch_sources.py`

halunasuには既に `MasterSourceContext` がある。

確認ファイル:

- `python/medical_fee_calculation/claim_models.py`
  - `medical_procedure_source_id`
  - `drug_source_id`
  - `material_source_id`
  - `electronic_fee_source_id`
  - `comment_source_id`
  - `facility_source_id`

具体改善:

- `source_id` だけでなく `source_version`, `source_uri`, `source_hash`, `verified_at`, `verification_status` をAPIのdebug/管理画面に出す。
- `admin?section=master` で「最新/旧版」だけでなく「どのsource_idを見ているか」を出す。
- 改定時は source manifest diff を出す。

## 4. 具体的な実装順

### Step 1: ParsedReceipt/UKE parser を作る

作る:

- `python/medical_fee_calculation/receipt_uke.py`
- `python/tests/test_receipt_uke.py`

変更:

- `python/medical_fee_calculation/baseline_adapter.py`
- `python/medical_fee_calculation/baseline_api.py`

完了条件:

- UKEから `ParsedClaimFile` を作れる。
- `ParsedClaimFile` から既存の `BaselineClaim` を作れる。
- unknown recordをwarningsに出せる。
- `CO/SJ/SY` が保持される。
- 剤の継続行が崩れない。

### Step 2: receipt check finding を作る

作る:

- `python/medical_fee_calculation/receipt_checks.py`
- `python/tests/test_receipt_checks.py`

最初のルール:

- unknown code
- total points mismatch
- fixed points mismatch
- missing base visit fee
- missing prescription fee
- missing comment
- empty symptom detail

完了条件:

- `ParsedReceipt` から `ReceiptCheckFinding` を返す。
- `baseline_api.py` で `receiptCheckFindings` を返せる。

### Step 3: fee-api に接続する

変更:

- `services/fee-api/src/python-calculator.js`
  - `parseBaseline()` の戻りに `parseWarnings`, `receiptCheckFindings` を通す。
  - もしくは `runReceiptChecks()` を追加。
- `services/fee-api/src/server.js`
  - `baselineClaimsFromDiagnosisBody()` で詳細情報を保持。
  - `recalculationDiffIngestionSummary()` に warning/check count を出す。
  - `recalculation-diff-diagnosis` の結果に `receiptCheckFindings` を添える。

完了条件:

- 再算定差分診断の結果に parser/check の件数が出る。
- 差分行の理由に「コメント不足」「病名不足」「UKE合計不一致」などが紐づく。

### Step 4: UIは最小変更

変更:

- `apps/fee-web/components/fee-admin-console.js`
  - baseline diff画面の診断結果に「取込警告」「点検Finding」を折りたたみで出す。
  - テーブル列は増やしすぎない。
- `apps/fee-web/components/fee-workspace.js`
  - セッションのレセプト案に receipt checkを既存review itemsとして出す。

出す情報:

- 上部チップ: `取込: レセN件 / 未対応レコードN件 / 点検N件`
- テーブル: 現在の分類、コード、名称、点数、理由
- 詳細: parser warning / check finding

出さない情報:

- UKE全レコードの生表示
- 内部rule idだけの表示
- 収益煽り文言

### Step 5: golden case evaluation

作る:

- `scripts/import_mediaclai_golden_cases.py`
- `python/tests/test_mediaclai_golden_cases.py`

完了条件:

- 20症例をhalunasu用JSONに変換できる。
- forbidden候補が出たらテスト失敗。
- まずは全20症例をpassさせる必要はない。未対応は `expected_review_or_unsupported` として明示する。

### Step 6: 返戻・査定取込

作る:

- `python/medical_fee_calculation/assessment_feedback.py`
- `python/tests/test_assessment_feedback.py`

後続API:

- `POST /v1/fee/assessment-feedback/import`

完了条件:

- HEN/SAH/増減点CSVから `AssessmentEntry` 相当を抽出できる。
- 月次画面または管理画面で件数集計できる。
- 再審査支援の入力データとして使える。

## 5. 反映すべき設計判断

### 5.1 直接コピーしない

外部2リポジトリはローカル確認範囲で `LICENSE` が見当たらない。コードを直接コピーせず、設計とデータ契約を参考にhalunasu側で実装する。

### 5.2 halunasuのmaster DBを正とする

`recept-checker` は `masters.db` を前提にするが、このcloneにはREADME記載の実データが見当たらない。halunasuでは既存の `python/medical_fee_calculation` のマスター基盤に寄せる。

### 5.3 LLMには点数を決めさせない

`mediaclAI_recept` と同じく、LLMは抽出・説明・追記候補まで。コード/点数/併算定/回数/施設基準は決定論層で判定する。

### 5.4 差分はすべて要確認から始める

再算定差分診断では、`engine_only` を即「算定もれ」と言い切らない。表示上は以下が良い。

- 当社のみ: 算定もれ候補
- 既存のみ: 要確認
- 両方差分あり: 要確認
- 一致: 一致
- 再現失敗: 当社エンジン/入力変換の確認
- unknown: 取込/マッピング確認

### 5.5 カルテ赤字とレセ点検を分ける

receipt check findingには `chartInsertionText` と `receiptCommentDraft` を別フィールドで持たせる。

- カルテ赤字に出すのは、カルテにそのまま追記できる文だけ。
- レセプトコメントや症状詳記は、レセプト案/詳細に出す。
- 内部警告や英語メッセージは表示しない。

## 6. 最初のPRでやるなら

最初のPRは大きくしすぎない。以下が最もROIが高い。

1. `receipt_uke.py` で `SY/CO/SJ` まで保持するUKE parserを作る。
2. `baseline_adapter.parse_uke()` を新parser経由にする。
3. `baseline_api` の返却に `parseWarnings` と `parsedReceiptStats` を足す。
4. `receipt_checks.py` で `total_points_mismatch`, `unknown_code`, `missing_comment` だけ実装する。
5. `recalculation-diff-diagnosis` の結果に取込/点検件数を出す。

この範囲なら、既存UIの大改修なしで「アップロードした既存レセがどれだけ正しく読めたか」「差分の理由が何か」を具体化できる。

