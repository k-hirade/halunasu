# 診療報酬算定アーキテクチャ改善レビュー

作成日: 2026-06-09

## 目的

STGのSOAP E2Eで見えている失敗を、個別SOAPへのパッチではなく、診療科横断で通用する算定支援アーキテクチャへ改善する。

本ドキュメントは、次の方針の妥当性確認と実装ロードマップを整理する。

- LLMはカルテ読解器として使い、診療報酬コード・点数・算定可否を決めさせない。
- `clinical_event -> master_candidate -> billing_candidate -> billing_proposal / review_issue -> receipt_draft` の中間層を明確に分ける。
- マスター検索はカテゴリ制御し、加算・判断料・減算をカルテ本文から直接自由検索しない。
- 点数・加算・判断料・小児加算・施設基準・同月履歴は、版管理されたマスターとルールで評価する。
- E2Eは合計点だけではなく、コード構成、派生項目、禁止候補、バケット分類を検証する。

## 妥当性レビュー

### 妥当な点

1. **LLM責務の縮小は妥当**
   - OpenAI Structured OutputsはJSON Schemaへの準拠に使えるが、出力内容の医学的・算定的正しさまでは保証しない。
   - よってLLMは `clinical_event` 抽出に限定し、コード・点数・算定可否は後段で決める設計が安全。

2. **現在の主ボトルネックは後段変換にある**
   - 直近のSTGランダム実行では、OpenAI JSON Schemaエラーは解消済みで `clinicalStructuringSource=openai` になっている。
   - 失敗は、検体検査・迅速検査・判断料・小児加算・CT機器区分など、`clinical_event` 後段の検索空間制御、候補種別制御、カテゴリ別ルール展開に集中している。

3. **マスター/ルールの版管理は必須**
   - 厚労省は診療報酬改定ごとに算定方法、実施上の留意事項、基本診療料・特掲診療料の施設基準、疑義解釈等を分けて公表している。
   - 支払基金は診療行為、医薬品、特定器材、コメント、傷病名などの基本マスターを分けて提供している。
   - したがって、診療日ベースで `masterVersion` / `ruleVersion` / `facilityContext` を固定して評価する必要がある。

4. **1層LLM + deterministic後段 + 条件付きLLM2が妥当**
   - 常時2層LLMにするとコスト・レイテンシ・監査性が悪くなる。
   - まずはカテゴリゲート、ロール制御、辞書、ルール展開を固め、曖昧なtop-k候補だけLLM2で再ランキングする方が現実的。

5. **RAGは根拠検索・候補照合補助として使うべき**
   - `SOAP + 点数表PDF全文 -> LLM -> コード/点数生成` は危険。
   - RAGは、マスター表記ゆれ、ルール根拠、施設基準説明、UIの「なぜ？」表示に使い、最終算定判断は deterministic rule で行う。

### 修正して扱うべき点

1. **「LLM抽出ではなく後段が主因」は断定しすぎない**
   - 現在の5件では後段が主因だが、一般化するとLLM抽出、正規化、マスター検索、ルール、テストoracleの全層で失敗し得る。
   - 設計文書では「直近の失敗では後段が支配的」と表現する。

2. **固定検査名は個別パッチではなくontology seedとして扱う**
   - `CBC / CRP / COVID/Flu / A群β溶連菌 / HbA1c` などは、特定SOAPを解くためのif文にしてはいけない。
   - `lab ontology / alias dictionary` の初期seedとして扱い、検査種別、病原体、検査法、検体、迅速/同時などの属性へ正規化する。

3. **マスター上のitemRoleは取り込み時に付与する**
   - 公式マスターそのものに、アプリが必要とする `base / addon / judgment / reduction / comment` の全分類がそのまま存在するとは限らない。
   - 取り込み時に電子点数表、コメント関連、施設基準、ルールメタデータを合わせて `feeCategory` / `itemRole` を付与する。

4. **管理料は病名だけで提案しない**
   - 管理料は、対象疾患、指導/計画/説明記録、管理主体、施設種別/施設基準、同月履歴が必要。
   - 病名だけを根拠に `増点できる` へ出すと過剰算定リスクが高い。

5. **テストの期待値は本文前提とcontext前提を分離する**
   - SOAP本文に迅速検査がないのに迅速検査コードを期待する、再診期待なのに事前履歴がない、というテストはproduct failureではなくtest oracle failure。
   - `expectedExtraction`、`expectedMasterMapping`、`expectedRuleExpansion`、`expectedReceiptDraft` を分ける。

## TOBEアーキテクチャ

```text
SOAP / カルテ本文
  ↓
[LLM1] clinical_event抽出
  - 高再現率
  - code / point / billable判定は禁止
  - evidence span必須
  - action/result/temporal/ownershipを分離
  ↓
event normalizer
  - セクション補正
  - 陰性/正常結果と未実施の分離
  - planned / past / other_provider補正
  - category-specific payload補完
  ↓
category-gated master retrieval
  - event_typeで検索対象を制限
  - reduction / addon / judgment / management_fee の直接検索を原則禁止
  - exact / alias / FTS / optional embedding
  ↓
candidate scorer
  - deterministic score
  - top-k保持
  - margin判定
  ↓
[optional LLM2]
  - ambiguous top-kのみ再ランキング
  - 新規コード生成・点数判断は禁止
  ↓
rule engine
  - 基本料
  - 小児加算
  - 検査
  - 画像
  - 薬剤
  - 処置
  - 管理料
  - 施設基準
  - 同月履歴
  ↓
billing_candidate / billing_proposal / review_issue
  ↓
UI 3バケツ
  - 算定中
  - 増点できる
  - 確認・修正が必要
  - 除外/参考
  ↓
receipt_draft
```

## LLM責務

### LLM1: clinical_event extractor

出力してよいもの:

- `clinical_event`
- `actionStatus`
- `temporalRelation`
- `sourceOrigin`
- `providerOwnership`
- `resultAssertion`
- `evidenceSpans`
- `searchTerms`
- category-specific payload

出力してはいけないもの:

- 診療報酬コード
- 点数
- 算定可否
- 初診/再診の確定
- 施設基準判定
- 同月履歴判定
- 減算適用
- 管理料の自動判断

重要ルール:

- 検査・画像・処置は、結果が正常・陰性でも実施済みなら `performed` とする。
- `negated` 相当は「行為そのものを実施していない」場合だけに使う。
- `resultAssertion=negative/normal` と `actionStatus=not_performed` を混同しない。
- `P`欄の予定、予約、次回、検討は `planned` / `considered` であり `performed` ではない。
- 他院、持参、前医、過去結果は `sourceOrigin` / `providerOwnership` / `temporalRelation` で分ける。

### LLM2: selective master reranker

呼ぶ条件:

- top1 scoreが閾値未満。
- top1とtop2の差が小さい。
- CT/MRI、手術、管理料、材料、高点数処置など高リスク/高点数。
- event payloadとmaster属性に不一致がある。
- rule engineが `ambiguous_master` を返した。

LLM2に禁止すること:

- top-kにないコードの生成。
- 点数の生成。
- 算定可否の断定。
- 施設基準や同月履歴の推測。

## Data Model

### ClinicalEvent

```ts
type ClinicalEvent = {
  id: string
  sourceDocumentId: string
  encounterId: string
  eventType:
    | "lab"
    | "imaging"
    | "procedure"
    | "medication"
    | "injection"
    | "material"
    | "management"
    | "counseling"
    | "diagnosis"
    | "follow_up"
    | "other"
  originalText: string
  normalizedName: string
  actionStatus:
    | "performed"
    | "prescribed"
    | "administered"
    | "ordered"
    | "planned"
    | "considered"
    | "instruction_only"
    | "not_performed"
    | "unknown"
  temporalRelation: "current_visit" | "past" | "future" | "unknown"
  sourceOrigin:
    | "own_clinic_record"
    | "patient_reported"
    | "external_document"
    | "carried_in_result"
    | "other_provider_record"
    | "unknown"
  providerOwnership:
    | "own_clinic"
    | "same_institution_other_department"
    | "other_provider"
    | "unknown"
  resultAssertion:
    | "positive"
    | "negative"
    | "normal"
    | "abnormal"
    | "numeric"
    | "not_applicable"
    | "unknown"
  evidenceSpans: SourceSpan[]
  searchTerms: SearchTerms
  extractionConfidence: number
  payload:
    | LabPayload
    | ImagingPayload
    | MedicationPayload
    | ProcedurePayload
    | ManagementPayload
    | null
}
```

### Category Payloads

```ts
type LabPayload = {
  analytes?: string[]
  panelName?: string
  pathogenTargets?: string[]
  method?: string
  specimen?: string
  isRapidTest?: boolean
  isSimultaneousTest?: boolean
  resultValues?: ResultValue[]
  sampleCollectionInferred?: boolean
}

type ImagingPayload = {
  modality?: "xray" | "ct" | "mri" | "ultrasound" | "nuclear" | "other"
  bodySite?: string
  laterality?: "right" | "left" | "bilateral" | "unknown"
  contrastUsed?: boolean
  equipmentKind?: string
  acquisitionMethod?: string
  electronicImageManagement?: boolean
  filmUsed?: boolean
  findingsPresent?: boolean
}
```

### MasterCandidate

```ts
type MasterCandidate = {
  id: string
  clinicalEventId: string
  masterType: "medical_service" | "drug" | "material" | "disease" | "comment"
  code: string
  name: string
  masterVersion: string
  validFrom: string
  validTo: string | null
  points: number | null
  feeCategory:
    | "basic_fee"
    | "lab_test_basic"
    | "lab_judgment"
    | "lab_addon"
    | "imaging_basic"
    | "imaging_addon"
    | "procedure_basic"
    | "procedure_addon"
    | "management_fee"
    | "drug"
    | "material"
    | "comment"
    | "reduction"
    | "unknown"
  itemRole: "base" | "addon" | "judgment" | "comment" | "material" | "reduction" | "derived_only"
  canBeDirectlyRetrievedFromEvent: boolean
  requiresParentCode: boolean
  retrievalSource: "exact" | "alias" | "bm25" | "embedding" | "llm2_rerank"
  score: number
  rank: number
  mismatchReasons: string[]
}
```

### BillingCandidate / Proposal / ReviewIssue

```ts
type BillingCandidate = {
  id: string
  lineGroupId: string
  clinicalEventIds: string[]
  masterCandidateId: string
  status: "billable" | "proposal" | "needs_review" | "excluded"
  safetyLevel: "auto_safe" | "conditional_safe" | "review_required" | "blocked"
  lineRole: "base" | "addon" | "judgment" | "comment" | "material" | "reduction"
  parentBillingCandidateId?: string
  points: number | null
  pointDelta: number | null
  metConditions: RuleCondition[]
  unknownConditions: RuleCondition[]
  failedConditions: RuleCondition[]
  evidenceSpans: SourceSpan[]
  ruleEvaluationId: string
}

type BillingProposal = {
  id: string
  proposalType:
    | "addon_possible"
    | "facility_if_met"
    | "diagnosis_if_added"
    | "comment_required"
    | "quantity_required"
    | "performed_if_confirmed"
    | "master_selection_required"
  title: string
  pointDelta: number | null
  pointDeltaType: "fixed" | "range" | "unknown"
  anchorEventIds: string[]
  relatedCandidateIds: string[]
  conditions: Array<{
    label: string
    status: "met" | "unknown" | "failed"
    evidence?: string
    requiredInput?: string
  }>
  whyNotAutoAdded: string
  overbillingRisk: "low" | "medium" | "high"
}

type ReviewIssue = {
  id: string
  issueCode:
    | "ambiguous_master"
    | "missing_birth_date"
    | "missing_quantity"
    | "missing_body_site"
    | "missing_equipment_kind"
    | "planned_not_performed"
    | "other_provider"
    | "facility_unknown"
    | "same_month_unknown"
    | "unsupported_category"
    | "forbidden_candidate_filtered"
  severity: "blocking" | "warning" | "info"
  messageForStaff: string
  requiredInput?: string
  relatedEventIds: string[]
  relatedCandidateIds: string[]
  evidenceSpans: SourceSpan[]
}
```

### EncounterContextSnapshot

```ts
type EncounterContextSnapshot = {
  patientId: string
  serviceDate: string
  birthDate: string | null
  ageOnServiceDate: {
    years: number
    months: number
    days: number
  } | null
  sex: string | null
  encounterType: "initial" | "revisit" | "unknown"
  priorSessionCount: number
  departmentId: string
  facilityId: string
  providerId: string
  sameMonthBillingHistory: BillingHistory[]
  facilityStandards: FacilityStandard[]
  activeDiagnoses: Diagnosis[]
  insuranceContext: InsuranceContext
  masterVersion: string
  ruleVersion: string
}
```

## Master Search

### 方針

- `eventType` と payload で検索対象を制限する。
- `reduction`、`judgment`、`addon`、`derived_only` は、原則としてclinical eventから直接採用しない。
- 直接検索するのは、カルテ本文に現れる基本行為に対応するマスターだけにする。
- 派生項目はrule engineで生成する。

### Direct Retrieval Gate

| clinical event | 直接検索してよい候補 | 直接検索しない候補 |
| --- | --- | --- |
| `lab` | `lab_test_basic` | `lab_judgment`, `lab_addon`, `reduction` |
| `imaging` | `imaging_basic` | `imaging_addon`, `reduction` |
| `procedure` | `procedure_basic` | `procedure_addon`, `comment`, `reduction` |
| `medication` | `drug` | `medication_fee` 派生行 |
| `material` | `material` | comment / addon |
| `management` | なし（初期実装では直接検索しない） | `management_fee`, disease-only inferred fees |

管理料は `clinical_event` として抽出してよいが、病名や指導文言だけでコード・点数を直接検索して候補化しない。対象疾患、管理主体、同月履歴、施設/診療科条件、記録要件を確認する `review_issue` に落とし、管理料moduleが十分な条件を持てる段階で `proposal` または `billing_candidate` を生成する。

### Forbidden Candidate Filter

```text
if candidate.itemRole == "reduction":
  reject unless generatedByRuleEngine == true

if candidate.itemRole in ["judgment", "addon", "derived_only"]:
  reject unless parentBillingCandidateId exists or ruleEngineGenerated == true
```

### Derived Item Policy

派生項目は「生成元」と「リスクゲート」を分けて扱う。`derived` と呼ぶだけでは、判断料のように自動で足せるものと、検体採取料や管理料のように人の確認が必要なものが混ざるため。

| 項目カテゴリ | 生成元 | 充足時 | 欠落/曖昧時 | 意図 |
| --- | --- | --- | --- | --- |
| 検査判断料 | 親検査コードから派生 | auto | review | 検査分類から機械的に導出できるため |
| 採血料（B-V等） | 親検査 + 血液検体の明示 | auto | review | `採血` / `血液検査` など臨床事実が明示される場合のみ |
| 非血液の検体採取料 | 親検査 + specimen/collection_method | review | review | 検体と採取方法が明示されても、同日算定条件や親行為確認が必要なため自動合計へ入れない |
| 検体検査管理加算 | 親検査 + 判断料 + 施設基準 | auto（施設基準確認済みのみ） | 出さない/施設設定review | 施設基準不明のまま自動追加しない |
| 管理料 | 独立項目 | review_only | review_only | 病名だけで出さず、管理主体・記録・同月履歴・施設条件を人が確認するため |

この表はコード分岐ではなくポリシーテーブルとして実装し、新しい派生項目を追加する時も同じ軸で判断する。単語単位のパッチではなく、`clinical_event` の構造化属性と親候補から一貫して分類する。

## Rule Engine

### Common Eligibility

```text
pass:
  actionStatus in ["performed", "prescribed", "administered"]
  temporalRelation == "current_visit"
  providerOwnership == "own_clinic"

review:
  actionStatus == "unknown"
  temporalRelation == "unknown"
  providerOwnership == "unknown"

exclude:
  actionStatus in ["planned", "considered", "instruction_only", "not_performed"]
  temporalRelation in ["past", "future"]
  providerOwnership == "other_provider"
```

### Basic Fee

- LLMで初診/再診を決めない。
- 患者履歴、診療日、同一患者の過去Fee session、保険コンテキストから決める。
- 小児加算は `birthDate + serviceDate` で年齢を算出して派生させる。

### Lab Module

検査モジュールは最優先で強化する。

処理:

1. `lab` eventが `performed/current_visit/own_clinic` か確認。
2. `lab_test_basic` だけを直接マッチ。
3. `LabPayload` から検査分類を付与。
4. 検査分類から判断料を派生。
5. 採血は血液検体の明示がある場合のみ自動派生し、非血液の検体採取料は `specimen` / `collection_method` を根拠にreviewへ送る。
6. 迅速検査や施設基準が必要な加算はproposal/reviewへ。
7. 減算は施設/算定条件からのみ生成。

### Imaging Module

処理:

1. `modality` で候補を絞る。
2. CT/MRIは `equipmentKind` を必須属性として扱う。
3. `bodySite` / `contrastUsed` / `electronicImageManagement` を伝播する。
4. 機器区分不明時は安いコードへfallbackせず、点数未確定または確認・修正へ落とす。

### Medication Module

- 今回処方だけ候補化する。
- 持参薬、他院処方、内服中、既往薬は参考または除外。
- 日数/数量不足はreviewに落とす。
- 一般名/商品名の正規化は薬剤辞書で行う。

### Procedure Module

- `performed` のみ候補化する。
- 指導のみは処置にしない。
- 部位、左右、面積、数量不足はreviewに落とす。

### Management Module

- 病名だけでは出さない。
- 指導/説明/計画の記録、管理主体、施設種別、施設基準、同月履歴を評価する。
- 条件不足ならproposalまたはreviewにする。
- 他科/他院管理が明示される場合は、自動算定しない。

### Unsupported Module

- 手術、麻酔、在宅、リハビリ等の未実装高リスク領域は、clinical eventとして抽出する。
- billing candidateは作らず `review_issue: unsupported_category` とする。

## UI/UX

3バケツは維持するが、定義を厳密にする。

### 算定中

入れる条件:

- 実施/処方/投与が明確。
- 今回診療。
- 自院。
- マスター一意。
- 点数計算可能。
- blocking issueなし。

### 増点できる

入れる条件:

- カルテ内に明確な根拠がある。
- 条件を満たせば追加できる。
- 点数または点数範囲が計算できる。
- 自動追加しない理由が明確。

表示:

- `条件確認で +○点`
- 根拠カルテ
- 満たしている条件
- 未確認条件
- 自動追加しない理由
- 過剰算定リスク

### 確認・修正が必要

入れる条件:

- 点数未確定。
- 実施/予定/他院/自院が曖昧。
- 数量、部位、面積、機器区分、birthDate等が不足。
- マスター候補が曖昧。
- 未対応カテゴリ。

### 除外/参考

UI上は折りたたみで保持し、監査ログに残す。

例:

- `来週CT予定`: future plannedのため算定対象外。
- `前医で検査済み`: other_provider/pastのため自院算定対象外。
- `施設基準不適合減算`: clinical_eventからの直接候補ではないため除外。

## Testing

E2Eだけでは失敗原因が見えないため、4層に分ける。

1. LLM抽出テスト
   - event recall / precision
   - status accuracy
   - evidence span accuracy
   - normal/negative result handling
   - planned / past / other_provider識別

2. マスター照合テスト
   - gold clinical_eventを入力する。
   - required top-k候補とforbidden categoryを検証する。

3. ルール展開テスト
   - gold clinical_event + matched master + contextを入力する。
   - 派生する判断料、B-V、小児加算、画像加算等を検証する。

4. E2Eテスト
   - required codesがすべて含まれる。
   - forbidden codesが含まれない。
   - 親子構成が正しい。
   - バケット分類が正しい。
   - 合計点が一致する。

### 失敗分類

E2Eレポートには少なくとも以下を出す。

```text
EXTRACT_MISSING_EVENT
EXTRACT_STATUS_WRONG
EXTRACT_ATTRIBUTE_MISSING
MASTER_NO_CANDIDATE
MASTER_WRONG_TOP1
MASTER_FORBIDDEN_CANDIDATE_INCLUDED
RULE_MISSING_DERIVED_ITEM
RULE_SPURIOUS_ITEM
CONTEXT_MISSING
CONTEXT_TRANSFORM_ERROR
POINT_MISMATCH
BUCKET_MISMATCH
```

### Mutation Family

固定SOAP過学習を防ぐため、同じ医療行為について文脈だけを変えたテストを持つ。

例:

```text
胸部X線 異常なし -> performed/current_visit/normal
来週胸部X線予定 -> planned/future
前医で胸部X線異常なし -> other_provider/past
胸部X線未施行 -> not_performed
胸部X線検討 -> considered
```

## Roadmap

## 2026-06-11 P0 Implementation Notes

今回のP0修正では、個別SOAPへの分岐ではなく、評価と算定の共通前提を以下のように整理する。

- 施設基準はゴールド期待値からケースごとに注入しない。E2Eでは施設fixtureとして登録し、製品経路では施設プロファイルから `facility_standard_keys` を読む。
- 入院日数は期待値から直接コピーしない。原則として `admissionDate` と `serviceDate` から算出し、セッション入力として必要な場合はfixture由来であることをレポートに残す。
- 「当日確認した主な診療内容は...」「確認すべき論点は...」などの生成用メタ文は、臨床実施の根拠として扱わない。データセット検証はこれらを除外して、本文に根拠がない期待コードを検出する。
- 画像の請求影響属性（造影、電子保存、機器区分）は `present / absent / unknown` の3値で扱う。`unknown` は自動加算せず、確認topicへ落とす。
- B-Vなどの採血料は、同一イベント内に閉じず、同一診療内に「検体検査コード」と「当日自院の静脈採血根拠」がそろう場合に派生できる。
- 複数日記録、病理、リハビリ、在宅、精神科専門療法、麻酔、手術、透析、輸血、内視鏡、放射線治療などは、構造化された `billing_domain` を入力にしたreview-only判定へ寄せる。自由文正規表現でドメインを再分類しない。
- デバッグ性を上げるため、E2Eレポートには抽出された `clinicalEvents` の概要を含める。失敗がLLM抽出なのか、マスター照合なのか、ルール派生なのかを分けて見る。

### Structured Facts First

自由文正規表現は、候補生成、review topic生成、否定・時制・帰属のガードに限定する。算定確定に直結する事実は、原則として構造化フィールドと決定論ルールから決める。

- `visit_facts`、`clinical_event.action_status`、`temporal_relation`、`provider_ownership`、`billing_domain`、`specimen`、`collection_method` などに明示値がある場合、自由文fallbackより優先する。
- 構造化フィールドが `yes` / `no` / `present` / `absent` のように明示されている場合は、それを確定事実として扱う。自由文fallbackで上書きしない。
- 構造化フィールドが `unknown`、空、未出力の場合だけ自由文fallbackを使う。
- 自由文fallbackを使う場合も、否定、予定、過去、他院・持参、第三者文脈の共通ガードを通す。
- 自由文fallbackで迷う場合は、自動算定せず `review_issue` へ落とす。

例:

- `visit_facts.outside_prescription_issued = no` の場合、本文中に過去の「処方箋を交付」言及があっても、当日院外処方箋料へは進めない。
- `result_assertion = numeric` であっても、根拠が「前回CRP」「他院HbA1c」なら、今回自院実施検査には昇格しない。
- 造影、電子保存、機器区分は、明示値がなければ `unknown` として確認topicに落とし、安いコードや加算なしへ勝手に確定しない。

### P0

1. category gateを実装する。
2. `reduction` / `addon` / `judgment` のdirect retrievalを禁止する。
3. `master_candidate` に `feeCategory` / `itemRole` / `directRetrievalAllowed` / `validFrom` / `validTo` を付与する。
4. 検査payload normalizerを作る。
5. 検査判断料、B-V、検体検査管理加算等をrule expansionへ移す。
6. `birthDate + serviceDate` による小児加算contextを実装する。
7. CT/MRIの `equipmentKind` をpayload化して伝播する。
8. E2E oracleをコード構成重視へ修正する。
9. 各line/proposal/reviewに `generatedBy` / `anchorEvents` / `ruleVersion` / `masterVersion` を出す。

### P1

1. curated synonym / ontologyを作る。
2. selective LLM2 rerankerを導入する。
3. proposal engineを本格化する。
4. 管理料moduleをproposal/review中心で導入する。
5. rule source/version管理を実装する。

### P2

1. オーダー、検査結果、画像実施、処方、注射、処置、同月履歴を構造化連携する。
2. 施設基準マスターと自院設定を統合する。
3. 監査ビューを作る。
4. active learningで、ユーザー採否結果を辞書・ルール・テストへ反映する。

## やってはいけない設計

- LLMにコード・点数を直接出させる。
- 全マスターを自由検索する。
- 加算・判断料・減算をclinical_eventから直接検索する。
- 合計点一致だけでE2Eをpassにする。
- 病名だけで管理料を出す。
- CT/MRI機器区分不明時に安いコードへ自動fallbackする。
- 年齢を整数ageだけで扱う。
- PDF RAGで算定判断をLLMへ丸投げする。
- 個別SOAP名や特定症例名でパッチする。

## Source Notes

- 厚生労働省「令和８年度診療報酬改定について」では、算定方法、実施上の留意事項、基本診療料・特掲診療料の施設基準、施設基準チェックリスト、疑義解釈、訂正通知が分かれて掲載されている。
- 社会保険診療報酬支払基金「基本マスター」では、医科診療行為、医薬品、特定器材、コメント、傷病名、修飾語などの基本マスターが分けて提供されている。
- OpenAI Structured OutputsはJSON Schema準拠に有効だが、domain correctnessは保証しない。アプリ側のvalidation、ルール評価、テスト分解が必要。
