# 診療報酬算定の現状フロー

作成日: 2026-06-15

このドキュメントは、現時点の `fee-web` / `fee-api` / `fee-core` / Python算定エンジンの実装に基づく算定フローを整理したものです。

目的は、次の3点を明確にすることです。

- カルテ本文がどのように算定候補へ変換されるか
- LLM、NLP的前処理、概念辞書、根拠検証、ルールエンジンがそれぞれ何を担当しているか
- 現状できていることと、まだ理想形に届いていないこと

## 全体像

現在の算定フローは、以下の順序で進みます。

```text
fee-web
  1. ユーザーが患者・カルテ・病名・手入力オーダーを編集
  2. 「カルテから算定候補を作成」を押す
  3. fee-api に非同期算定ジョブを作成
  4. detail-lite をポーリングして完了を待つ
  5. 完了後に detail を再取得して画面表示

fee-api
  6. 入力スナップショットを作る
  7. 施設プロファイル・患者履歴・同月履歴・手入力オーダーを集める
  8. カルテ本文を正規化し、行ID・セクション・時制/否定/他院などのcueを作る
  9. 概念辞書からチェックリストメニューを作る
  10. LLMにカルテ本文とチェックリストを渡し、臨床イベントを抽出する
  11. LLM出力とチェックリスト結果を突き合わせる
  12. 根拠引用が本文に存在するか、過去/他院/予定/否定でないかを検証する
  13. 検証済み臨床事実の台帳を作る
  14. 検証済みイベントを calculationOptions に変換する
  15. 施設基準・画像施設属性・院内外処方などの決定論ルールを反映する
  16. Python算定エンジンへ渡す

Python算定エンジン
  17. マスター・ルール・施設基準・履歴・入力オプションから点数を計算する

fee-core
  18. 算定結果を、算定中 / 要確認 / 提案 / レセプト案 に整形する

fee-web
  19. candidateWorkbench を表示する
```

重要な設計方針は、以下です。

```text
LLM:
  カルテに何が書かれているかを構造化する

JS側の決定論:
  根拠、時制、否定、他院、予定、院内外処方、施設属性、マスター候補を検証する

Python算定エンジン:
  診療報酬コード、点数、派生項目、施設基準、併算定、加算を計算する
```

LLMは点数も診療報酬コードも最終算定可否も決めません。

## 1. fee-web から算定ジョブを開始する

ユーザーがセッション画面で「カルテから算定候補を作成」を押すと、`fee-web` はまず画面入力を保存し、その後 `fee-api` に算定ジョブを作成します。

主な実装:

- `apps/fee-web/components/fee-workspace.js`
  - `calculate()`
  - `refreshCalculationStatus()`
  - `loadAll()`

現在のUI側の流れは以下です。

```text
calculate()
  ↓
saveSessionDetails()
  ↓
POST /v1/fee/sessions/:id/calculation-jobs
  ↓
画面上の status を calculating にする
  ↓
GET /v1/fee/sessions/:id/detail-lite をポーリング
  ↓
完了したら GET /v1/fee/sessions/:id/detail を取得
```

`detail-lite` は軽量な状態確認用です。算定中に毎回フルの `candidateWorkbench` を取得しないようにしています。

## 2. fee-api がジョブを作成する

APIルーティングは `services/fee-api/src/server.js` の `routeFeeApiRequest()` が受けます。

主なエンドポイント:

```text
POST /v1/fee/sessions/:id/calculation-jobs
  非同期算定ジョブを作成

POST /v1/fee/internal/calculation-jobs/run
  Cloud Tasks / PubSub から呼ばれるworker

POST /v1/fee/sessions/:id/calculate
  同期算定の旧経路またはfallback

GET /v1/fee/sessions/:id/detail-lite
  ポーリング用の軽量状態取得

GET /v1/fee/sessions/:id/detail
  画面表示用の詳細取得
```

ジョブ作成では `createFeeCalculationJob()` が以下を行います。

```text
1. セッションを読む
2. 入力スナップショットを作る
3. calculationJob を queued として保存する
4. Cloud Tasks または PubSub に enqueue する
5. セッションの status を calculating にする
```

enqueue先は環境変数で切り替わります。

```text
FEE_CALCULATION_CLOUD_TASKS_QUEUE
FEE_CALCULATION_PUBSUB_TOPIC
```

Cloud Tasks / PubSub が未設定または失敗した場合は、ジョブ作成エラーになります。ジョブ実行は `runFeeCalculationJob()` から `calculateFeeSessionNow()` に入ります。

## 3. 入力スナップショットを作る

算定時点の入力は `buildFeeCalculationInputSnapshot()` で保存されます。

スナップショットに含まれる主な内容は以下です。

```text
clinicalText
patientSnapshot
facilitySnapshot
departmentSnapshot
serviceDate
claimMonth
setting
admissionDate / dischargeDate / inpatientBasicDays
manualOrders
diagnoses
claimContext
calculationOptions
facilityStandardKeys
facilityProfileVersion
masterVersion
ruleSetVersion
promptVersion
registryVersion
clinicalExtraction metadata
```

このスナップショットの目的は、後から以下を追えるようにすることです。

```text
どのカルテで
どの患者情報で
どの施設基準で
どのマスターで
どのルールで
どのプロンプトで
算定したか
```

## 4. 算定準備

ジョブが実行されると、`calculateFeeSessionNow()` が呼ばれます。

内部では大きく2段階です。

```text
prepareFeeSessionForCalculation()
  ↓
calculatePreparedFeeSessionNow()
```

`prepareSessionForCalculation()` は以下を行います。

```text
1. 手入力オーダーをマスターで補完
2. 施設プロファイルを読む
3. 患者の過去算定履歴を読む
4. カルテ本文から calculationOptions を作る
5. 施設基準・画像施設属性を calculationOptions に反映
6. shadow mode 用の決定論パイプラインも裏で走らせる
```

施設プロファイルからは、たとえば以下を取得・反映します。

```text
facilityStandardKeys
electronicImageManagement
ctEquipmentKind
mriEquipmentKind
```

## 5. カルテ本文の正規化

カルテ本文は最初に `normalizeClinicalText()` で軽く正規化されます。

現在やっている正規化は主に以下です。

```text
改行を統一
全角英数字を半角に寄せる
前後の空白を削る
```

これは MeCab / Sudachi / kuromoji のような形態素解析ではありません。現状のNLP的処理は、軽量な文字列正規化と行単位の前処理です。

## 6. 行IDつきのNLP的前処理

`buildClinicalTextPreprocessing()` で、カルテ本文を行単位に分解します。

各行には以下が付与されます。

```json
{
  "lineId": "O-003",
  "index": 8,
  "section": "O",
  "charStart": 120,
  "charEnd": 180,
  "text": "CRP 0.8、WBC 8500。",
  "normalizedText": "CRP 0.8、WBC 8500。",
  "cues": {
    "futureOrOrderOnly": false,
    "negatedService": false,
    "pastOrExternal": false,
    "currentVisit": true,
    "syntheticMeta": false
  }
}
```

現在の前処理で見ているものは、主に以下です。

```text
S/O/A/P セクション
行番号
文字位置
正規化済み文字列
未来・予定・検討
否定・未実施
過去・前医・他院・持参
合成データ用のメタ文
```

ただし、これはまだ理想形のNLP前処理ではありません。現状では、行ごとの構造化情報を作っていますが、それを十分にLLM入力へ明示的タグとして渡し切っているわけではありません。

## 7. 概念辞書からチェックリストメニューを作る

`buildClinicalChecklistMenu()` は、カルテ本文から「このカルテに関係しそうな候補メニュー」を作ります。

元になる概念辞書は `services/fee-api/src/clinical-concept-registry.js` にあります。

代表例:

```text
尿定性 / 尿一般 / 尿検査
  → lab:urine_general

尿蛋白 / 蛋白尿
  → lab:urine_protein

CRP / C反応性蛋白
  → lab:crp

血算 / CBC / 末梢血液一般
  → lab:cbc

熱傷 / 火傷 / やけど
  → procedure:burn_treatment

手術 / 麻酔 / 病理 / リハ / 在宅 / 精神科専門療法
  → review-only domain
```

このチェックリストは、請求を確定するためではありません。

目的は以下です。

```text
LLMの自由抽出で漏れやすい項目を、LLMに確認させる
```

単語に反応して点数を足すわけではありません。

現在はコード管理の辞書です。外部JSONや管理画面で更新できる形にはまだなっていません。

## 8. LLMに投げる入力

OpenAI抽出は `extractFeeClinicalFactsWithOpenAi()` で行います。

LLMに渡している主な入力は以下です。

```text
Session context
Checklist menu
Clinical text
```

LLMへの重要な指示は以下です。

```text
カルテ本文に根拠のある事実だけ返す
出力は clinical_events であり、billing candidates ではない
点数を計算しない
診療報酬コードを選ばない
算定可否を決めない
マスター検索とルール判定は後段が行う
```

LLM出力の主なフィールド:

```text
visit_type
visit_facts
diagnoses
clinical_events
checklist_findings
excluded_events
missing_information
review_flags
```

`clinical_events` の主なフィールド:

```text
type
name
billing_domain
action_status
temporal_relation
source_origin
provider_ownership
result_assertion
certainty
section
evidence
search_queries
specimen
collection_method
body_site
area_size_cm2
modality
days
quantity_per_day
total_quantity
```

`checklist_findings` は、チェックリストメニューの各項目について、LLMが以下のいずれかを返します。

```text
performed_today
planned
past_or_external
mentioned_not_performed
not_in_text
unclear
```

## 9. LLM出力をそのまま使わず、チェックリストと突き合わせる

LLMの自由抽出とチェックリスト結果は、`clinicalFactsToCalculationOptions()` で突き合わせます。

### 9.1 矛盾チェック

自由抽出が performed と言っていても、チェックリストが以下なら自動算定に進めません。

```text
not_in_text
mentioned_not_performed
planned
past_or_external
```

この場合はイベントをブロックし、レビューに落とします。

### 9.2 チェックリスト回収

逆に、自由抽出が漏れていても、チェックリストが `performed_today` で、根拠引用が安全ならイベントを回収します。

ただし、以下はガードされます。

```text
否定文
予定文
他院/過去文
not_performed
引用が本文に存在しない
```

つまり、チェックリストは漏れ補完に使いますが、単独で算定権限を持ちません。

## 10. 根拠検証

`verifyClinicalEventEvidence()` は、LLMイベントの根拠引用を検証します。

確認する内容:

```text
根拠引用が本文中に存在するか
完全一致しない場合でも、トークン重なりで近い行があるか
根拠行が否定/未実施文脈ではないか
根拠行が予定/検討/未来ではないか
根拠行が前医/他院/持参/過去ではないか
```

結果は以下になります。

```text
verified
  → 後段へ進める

review_required
  → 要確認へ

blocked
  → 自動算定しない
```

## 11. 検証済み臨床事実の台帳を作る

`canonicalClinicalFactsFromEvents()` で、イベントを検証済み臨床事実の台帳に変換します。

1件の台帳は概ね以下の形です。

```json
{
  "factId": "fact_xxx",
  "clinicalEventId": "evt_xxx",
  "conceptId": "lab:crp",
  "eventType": "lab",
  "billingDomain": "standard_lab",
  "clinicalName": "CRP",
  "status": "eligible_for_master_search",
  "actionStatus": "performed",
  "temporalRelation": "current_visit",
  "sourceOrigin": "own_clinic_record",
  "providerOwnership": "own_clinic",
  "resultAssertion": "numeric",
  "certainty": "explicit",
  "evidenceRefs": [
    {
      "lineId": "O-003",
      "section": "O",
      "quote": "CRP 0.8"
    }
  ],
  "verificationStatus": "verified",
  "verificationReasons": []
}
```

ただし、現状ではこの台帳が「唯一の計算入力」にはまだなっていません。

現在は以下のブリッジ構造です。

```text
clinical_events
  ↓
canonicalClinicalFacts を作る
  ↓
clinicalEventsFromCanonicalClinicalFacts() で既存イベント形に戻す
  ↓
既存の event loop で calculationOptions に変換
```

したがって、台帳は保存・検証・traceには使われていますが、算定変換ロジックはまだ既存のイベントループが中心です。

## 12. clinical event を calculationOptions に変換する

`clinicalFactsToCalculationOptions()` の後半で、検証済みイベントを種類別に処理します。

### 12.1 imaging

画像イベントは `imagingOrderFromClinicalEvent()` へ進みます。

処理内容:

```text
X線 / CT / MRI / 超音波などのmodality判定
body_site
造影状態
電子画像管理
CT/MRI機器区分
撮影方向
写真診断
撮影料
施設属性不足時のreview issue
```

出力:

```text
imaging_orders
procedure_codes
comment_inputs
reviewIssues
masterCandidates
billingCandidates
trace
```

### 12.2 lab

検体検査イベントは `procedureCodesFromPerformedClinicalEvent()` へ進みます。

処理内容:

```text
検査名からマスター検索
category gate
密輸クエリ除外
曖昧マスター判定
検査コード候補化
採血料判定
検体採取料判定
判断料の派生
検体検査管理加算
```

### 12.3 medication

薬剤イベントは、院外処方の場合は薬剤料を算定しません。

処理内容:

```text
visit_facts から院外処方を確認
院外処方が verified なら薬剤マスター検索をスキップ
院内処方なら薬剤マスター検索
日数・総量・用法不足なら要確認
```

これは、院外処方箋料と医療機関側の薬剤料が混ざる事故を防ぐための invariant です。

### 12.4 procedure / exam / treatment

処置・検査・手技イベントはマスター検索に進みます。

処理内容:

```text
診療行為マスター検索
category gate
スコアリング
曖昧候補なら要確認
review-only domain なら自動算定しない
```

### 12.5 management / counseling

管理料・指導料系は原則として自動算定しません。

処理内容:

```text
対象疾患確認
療養計画確認
同月算定履歴確認
施設基準確認
指導・説明記録確認
```

これらは `reviewIssues` に落とします。

## 13. facility profile の反映

施設プロファイルは `applyFacilityProfileToPreparation()` で `calculationOptions` に反映されます。

反映対象:

```text
facility_standard_keys
電子画像管理
CT機器区分
MRI機器区分
```

方針:

```text
カルテ本文から施設基準を推測しない
施設に登録されている設定を使う
施設情報が足りなければ要確認
```

## 14. Python算定エンジンに渡す

`calculatePreparedFeeSessionNow()` で `calculationOptions` をまとめ、Python算定エンジンに渡します。

Node側の呼び出しは `services/fee-api/src/python-calculator.js` の `calculate()` です。

Pythonへ渡る主な入力:

```text
session
input
calculationOptions
procedure_codes
imaging_orders
medication_orders
lab_options
facility_standard_keys
material_inputs
comment_inputs
```

Python側が決めること:

```text
診療報酬コードの点数
基本料
薬剤料
処方料
処方箋料
調剤料
画像診断
検体検査
判断料
採血料
加算
施設基準依存項目
併算定・派生項目
```

LLMはここには関与しません。

## 15. 結果を保存する

Pythonから返った結果は `calculatePreparedFeeSessionNow()` で保存されます。

保存対象:

```text
lineItems
candidateProposals
reviewIssues
clinicalEvents
canonicalClinicalFacts
masterCandidates
billingCandidates
clinicalExtraction
shadowCalculations
inputSnapshot
```

`clinicalExtraction` には以下のような観測情報が入ります。

```text
source
model
reasoningEffort
promptVersion
ruleSetVersion
registryVersion
masterVersion
openAiProviderDurationMs
masterLookupDurationMs
checklistMenuCount
extractedClinicalEventCount
convertedProcedureCodeCount
trace
```

## 16. fee-core で画面用に整形する

`packages/fee-core/src/index.js` が、算定結果をUI用の形に整えます。

主な出力:

```text
receiptDraft
reviewItems
candidateWorkbench
```

画面は主に `candidateWorkbench` を見ます。

分類:

```text
算定中
  lineItems に入っているもの

要確認
  reviewIssues / warnings / unresolved candidates

提案
  candidateProposals
```

## 17. fee-web で表示する

`fee-web` は以下を表示します。

```text
算定中
要確認
提案
レセプト案
詳細モーダル
根拠・確認項目
```

現在の画面は `candidateWorkbench.counts` を件数ソースにする方針です。

## 18. shadow mode

現在は `FEE_CALCULATION_SHADOW_MODE` が明示的に off でなければ有効です。

shadow mode では、メイン計算とは別に、LLMなしの決定論ルートを裏で走らせます。

```text
メイン:
  OpenAI + checklist + verifier + rules
  → ユーザーに表示する本番結果

shadow:
  OpenAIなしの rules-only preparation
  → shadowCalculations に保存
  → 表示結果には影響しない
```

目的:

```text
LLMあり/なしの差分を測る
決定論だけで拾えるものを確認する
LLMが増やした候補・減らした候補を確認する
将来の精度評価に使う
```

これはDBに記録するだけで、現時点の算定結果には影響しません。

## 現状のNLP利用状況

「NLPを使っているか」という問いに対する現状の正確な答えは以下です。

```text
軽量なNLP的前処理:
  使っている

本格的なNLPライブラリ:
  使っていない

意味検索・embedding:
  本流では使っていない

LLM前に十分な構造タグを渡す前処理:
  一部のみ

LLM後の根拠検証:
  使っている
```

使っているもの:

```text
全角/半角正規化
行分割
S/O/A/P推定
lineId / charStart / charEnd
未来/予定cue
否定cue
過去/他院cue
現在診療cue
合成データメタ文除外
概念辞書による候補メニュー生成
根拠引用検証
```

使っていないもの:

```text
MeCab
Sudachi
kuromoji
形態素解析
係り受け解析
医療NERモデル
BM25
embedding / vector search
RAG
```

## 具体例

カルテ:

```text
O:
インフルエンザ迅速検査 A陽性。
CRP 0.8。
胸部X線：異常なし。
前医で先月HbA1c 7.2%と言われた。
腹部CTは次回必要時に検討。
```

### 1. 前処理

行IDが付きます。

```text
O-001 インフルエンザ迅速検査 A陽性。
O-002 CRP 0.8。
O-003 胸部X線：異常なし。
O-004 前医で先月HbA1c 7.2%と言われた。
O-005 腹部CTは次回必要時に検討。
```

### 2. チェックリストメニュー

概念辞書から候補が作られます。

```text
lab:influenza_antigen
lab:crp
imaging:xray
lab:hba1c
imaging:ct
```

### 3. LLM抽出

LLMは以下のようなイベントを返します。

```text
インフルエンザ迅速検査
  action_status=performed
  temporal_relation=current_visit
  evidence=インフルエンザ迅速検査 A陽性

CRP
  action_status=performed
  temporal_relation=current_visit
  evidence=CRP 0.8

胸部X線
  action_status=performed
  result_assertion=normal
  evidence=胸部X線：異常なし

HbA1c
  action_status=performed または unknown の可能性がある
  source_origin=other_provider_record
  temporal_relation=past
  evidence=前医で先月HbA1c 7.2%

腹部CT
  action_status=considered
  temporal_relation=future
  evidence=腹部CTは次回必要時に検討
```

### 4. 根拠検証

検証結果:

```text
インフルエンザ迅速検査
  verified
  → 検査候補へ

CRP
  verified
  → 検査候補へ

胸部X線
  verified
  → 画像候補へ

HbA1c
  past_or_external_context
  → 自動算定しない

腹部CT
  future_or_planned_context
  → 自動算定しない
```

### 5. マスター照合と算定

```text
インフルエンザ迅速検査
  → マスター検索
  → 一意なら procedure_codes へ

CRP
  → マスター検索
  → 曖昧なら要確認、一意なら procedure_codes へ

胸部X線
  → imaging_orders
  → Python側で写真診断・撮影料・電子画像管理などを算定

HbA1c
  → 除外または要確認

腹部CT
  → 予定/検討として除外または要確認
```

## 現状の強い点

- LLMに点数やコードを決めさせていない
- チェックリストで自由抽出漏れを補える
- 根拠引用が本文にあるか検証している
- 過去/他院/予定/否定をブロックできる
- 院外処方時に医療機関側の薬剤料を抑制するルールがある
- 施設基準をカルテ本文から推測しない方針になっている
- shadow modeでLLMあり/なしの差分を残せる
- ruleSetVersion / promptVersion / registryVersion を残せる

## 現状の弱い点

### 1. NLP前処理はまだ弱い

行ID・セクション・cueはありますが、以下は未実装または弱いです。

```text
形態素解析
係り受け
医療NER
薬剤用量の強い構造化
検査値の体系的抽出
画像結果の体系的抽出
LLM入力への行タグ明示
```

### 2. 概念辞書はコード管理

現状は `clinical-concept-registry.js` に直書きです。

そのため、概念追加にはコード変更が必要です。

### 3. embedding / 意味検索は本流にない

現状は、概念辞書・正規表現・マスター検索が中心です。

```text
胸写
CXR
胸部XP
胸部レントゲン
```

のような表現揺れは辞書に入っていれば拾えますが、辞書外の初見表現は弱いです。

### 4. canonicalClinicalFacts は主入力へ完全移行していない

台帳は作っていますが、最終的には既存イベントループへ戻しています。

理想は以下です。

```text
canonicalClinicalFacts
  ↓
直接 master linking
  ↓
直接 calculationOptions
```

現状は以下です。

```text
canonicalClinicalFacts
  ↓
clinicalEvents に戻す
  ↓
既存event loop
  ↓
calculationOptions
```

### 5. selective verifier はまだ本格実装ではない

高リスク・高点数・矛盾・曖昧マスターだけを追加LLMで検証する仕組みは、まだ本流ではありません。

### 6. 非同期ジョブのUI/運用は改善余地あり

非同期ジョブはありますが、以下はまだ強化余地があります。

```text
詳細なphase表示
ジョブ失敗理由のUI表示
再実行UI
ジョブ履歴
長時間処理時の運用監視
```

## 現在の責任分担

```text
fee-web
  入力・保存・ジョブ開始・ポーリング・結果表示

fee-api
  入力固定
  施設/履歴/患者情報取得
  NLP的前処理
  概念辞書チェックリスト
  LLM抽出
  根拠検証
  マスター照合前処理
  calculationOptions生成
  Python算定呼び出し
  trace保存

medical-core
  OpenAI structured extraction schema
  prompt
  structured response parsing

Python calculator
  診療報酬点数計算
  派生項目
  加算
  施設基準
  薬剤/画像/検査/基本料計算

fee-core
  lineItemsをUI用に整理
  レセプト案
  reviewItems
  candidateWorkbench
```

## まとめ

現状は、以下の構成です。

```text
軽量NLP前処理
  ↓
概念辞書によるチェックリスト
  ↓
LLMによる臨床イベント抽出
  ↓
チェックリストとの矛盾/回収
  ↓
根拠検証
  ↓
検証済み臨床事実台帳
  ↓
既存イベントループで calculationOptions 化
  ↓
Python算定エンジン
  ↓
fee-coreでUI用整形
  ↓
fee-web表示
```

したがって、今のフローは「NLPなし」ではありません。

ただし、使っているのは本格的なNLPエンジンではなく、**正規化・行ID・セクション・cue・概念辞書・根拠検証**を中心にした軽量な前処理です。

次に精度を上げるなら、最も重要なのは以下です。

```text
1. LLM前のNLP前処理を強くする
2. 行ID・cueをLLM入力へ明示的に渡す
3. canonicalClinicalFactsを本当の主入力へ移行する
4. 概念辞書を外部データ化する
5. 意味検索は算定判断ではなく候補検索だけに使う
6. selective verifierを高リスク項目だけに入れる
```

