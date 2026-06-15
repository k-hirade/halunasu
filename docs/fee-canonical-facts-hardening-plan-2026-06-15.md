# 診療報酬算定フロー強化計画: 検証済み臨床事実を主入力にする

作成日: 2026-06-15

## 目的

カルテ自由記載から算定候補を作る現行フローを、特定SOAPや特定文面への対応ではなく、より安全で再現可能な構造へ寄せる。

大方針は以下。

```text
LLMは「カルテに何が書かれているか」を抽出する。
算定するか、何点か、どのコードかは、検証済み臨床事実・マスター・施設情報・履歴・ルールエンジンで決める。
```

## 現状の問題

現状は、検証済み臨床事実である `canonicalClinicalFacts` を作っているが、計算時には一度 `clinicalEvents` へ戻して既存イベントループを通している。

```text
LLM抽出
→ checklist照合
→ 根拠検証
→ canonicalClinicalFacts作成
→ clinicalEventsへ戻す
→ 既存event loop
→ calculationOptions
→ Python算定エンジン
```

この構造では、次の負債が残る。

- 検証済みfactと実際の計算入力の意味がずれる可能性がある。
- verifierで落としたはずの情報が別経路で復活するリスクがある。
- `factId` 単位で「なぜ算定されたか」を追いにくい。
- LLMあり、LLMなしshadow、手入力オーダー、構造化オーダーを同じ入口で扱いにくい。
- `clinicalFactsToCalculationOptions()` に責務が集中し、今後の改善で肥大化する。

## TOBE

`canonicalClinicalFacts` を計算の主入力にする。

```text
raw clinical events
checklist findings
deterministic candidates
manual orders
structured orders
        ↓
ExtractionReconciler
        ↓
EvidenceVerifier
        ↓
canonicalClinicalFacts
        ↓
MasterLinker
        ↓
BillingIntentBuilder
        ↓
CalculationOptionsBuilder
        ↓
Python算定エンジン
```

`clinicalEvents` は保存・trace・デバッグ用途として残してよいが、自動算定の入口にはしない。

## 守るべき安全条件

この改善で、特定SOAP対応や単語反応による誤算定を増やさないために、次の条件を固定する。

```text
辞書一致 = 算定ではない
NLP前処理 = 算定ではない
checklist performed = 算定ではない
LLM event = 算定ではない

verified fact
+ master一意
+ facility/history/rule通過
= 自動算定候補
```

自動算定に進めてよいのは、原則として以下を満たすものだけ。

- `verificationStatus=verified`
- `status=eligible_for_master_search` または `eligible_for_billing`
- 当日性、自院性、実施性が否定されていない
- `future / planned / considered / other_provider / past / not_performed` ではない
- マスター候補が一意、または安全に一意化できる
- Python算定エンジンのルールを通過する

不明・曖昧・矛盾は、自動算定ではなく `needs_review` に落とす。

---

# P0: まず直す

## P0-1. `canonicalClinicalFacts` を計算の主入力にする

### やること

- `clinicalEventsFromCanonicalClinicalFacts()` 経由で既存event loopへ戻す経路を段階的に縮小する。
- `canonicalClinicalFacts` から直接、計算前の意図を作る。
- 既存の `calculationOptions` 形式は当面維持し、互換アダプタとして使う。

### 完了条件

- 自動算定に入った明細から、元の `factId` を追える。
- `excluded` / `review_required` のfactが `calculationOptions` に入らない。
- `canonicalClinicalFacts` と `calculationOptions` の対応関係がtraceに残る。

### 追加テスト

- `excluded fact` が自動算定されない。
- `review_required fact` が自動算定されない。
- `verified fact` のみがマスター照合へ進む。
- `factId` が candidateWorkbench の明細またはreview issueまで残る。

## P0-2. `clinicalFactsToCalculationOptions()` の責務を分割する

### やること

現状の大きな変換関数を、少なくとも以下に分ける。

```text
ExtractionReconciler
EvidenceVerifier
CanonicalFactBuilder
MasterLinker
BillingIntentBuilder
CalculationOptionsBuilder
```

### 完了条件

- checklist矛盾検出、根拠検証、マスター照合、計算入力生成が別責務として読める。
- 各段階のtraceが独立して出る。
- 既存E2Eの結果が大きく崩れない。

## P0-3. fact lineage を通す

### やること

以下の流れでIDを保持する。

```text
factId
→ masterCandidate.sourceFactId
→ billingIntent.sourceFactId
→ calculationOptions source
→ receiptDraft / candidateWorkbench
```

### 完了条件

- UIまたはレポートから「この候補はどのカルテ根拠・どのfact由来か」を追える。
- master lookup traceに `factId` が出る。

## P0-4. 自動算定禁止 invariant を追加する

### やること

以下は絶対に自動算定に進めない。

- future
- planned
- considered
- past
- external provider
- not performed
- negated service
- evidence missing
- evidence approximate only
- checklist contradiction

### 完了条件

- JS側で止める。
- Python側でも可能な範囲で防御する。
- 反例テストを追加する。

---

# P1: 精度と運用性を上げる

## P1-1. evidenceをlineId/span主体へ寄せる

### やること

- LLM出力に `evidence_line_ids` を要求する。
- quote一致は補助扱いにする。
- `lineId + charStart/charEnd + quote` をfactに保存する。

### 完了条件

- quoteが多少揺れても、lineId/spanで根拠を追える。
- lineIdが存在しない根拠はreviewに落ちる。

## P1-2. NLP前処理を候補生成・cue付与として強化する

### やること

まず以下に限定する。

- 検査値 parser
  - `CRP 0.8`
  - `HbA1c 7.2%`
  - `尿蛋白 ±`
  - `インフルA陽性`
- 画像結果 parser
  - `胸部X線: 異常なし`
  - `CT: 肺炎なし`
- 薬剤用量 parser
  - `500mg 1日3回 5日分`
  - 外用、頓用、院外、院内
- 時制・所有・否定cue
  - 前医、他院、先月、次回、予定、検討、施行せず

### 禁止事項

NLP前処理だけで算定を確定しない。

### 完了条件

- deterministic candidates がtraceに出る。
- 自動算定ではなく、LLM・verifier・master linkerへの補助入力として使われる。

## P1-3. 概念辞書を外部データ化する

### やること

現在コード管理している概念辞書を、JSONまたはYAMLへ移す。

```text
conceptId
label
eventType
billingDomain
matchTerms
queryHints
blockers
reviewPolicy
positiveExamples
negativeExamples
```

### 完了条件

- 概念追加がコード変更なし、または最小変更で可能になる。
- 辞書にversionが付く。
- positive / negative fixture test を持つ。

## P1-4. MasterLinkerを独立させる

### やること

マスター照合の優先順位を固定する。

```text
1. conceptIdに紐づくqueryHints
2. 構造化オーダー/検査結果の標準名
3. deterministic synonym
4. lexical master search
5. LLM search_queries は弱い補助
```

### 完了条件

- LLM `search_queries` だけでコードが確定しない。
- 曖昧候補は `ambiguous_master` に落ちる。
- スコアと除外理由がtraceに出る。

## P1-5. review issueを機械可読にする

### やること

review issueに以下を持たせる。

```text
reasonCode
topicCode
requiredInput
suggestedActions
sourceFactId
severity
```

### 完了条件

- UIが「何を確認すればよいか」をreasonCodeから出せる。
- 文言一致ではなくtopicCode/reasonCodeで評価できる。

## P1-6. 情報源の優先順位を明確化する

### やること

factにsource rankを持たせる。

```text
A: 構造化オーダー・検査結果・処方データ
B: 手入力オーダー
C: カルテ自由記載の明示的結果
D: カルテ自由記載の曖昧表現
E: 過去カルテ・前医・紹介状・患者申告
```

### 完了条件

- 矛盾時にどの情報源を優先するかtraceに出る。
- 自由記載が構造化データを黙って上書きしない。

---

# P2: 評価・安定性・将来拡張

## P2-1. 句単位scope resolver

### やること

行単位だけでなく、句単位でcueの適用先を解決する。

例:

```text
CRP 0.8。腹部CTは次回検討。
```

この場合、`次回検討` はCTにだけ適用する。

### 完了条件

- future / past / external / not_performed のcueが、無関係な別概念に誤適用されない。
- 反例fixtureを持つ。

## P2-2. LLMを2段に分けるか判断する

### やること

現状の一括LLM呼び出しを、必要なら以下に分ける。

```text
Pass A: checklistなし自由抽出
Pass B: checklist verification
Reconciler: 不一致はreview
```

### 判断条件

- case stability が90%未満
- checklist誘導による誤抽出が増える
- 同一入力で候補が揺れる

## P2-3. selective verifier

### やること

全件ではなく、高リスク・曖昧ケースだけ追加検証する。

対象:

- 高点数
- 施設基準絡み
- 同月履歴絡み
- checklistと自由抽出が矛盾
- master候補が複数
- evidenceが短い/曖昧

### 完了条件

- verifier呼び出し件数と効果がレポートに出る。
- 自動算定精度と処理時間のバランスを測れる。

## P2-4. shadow modeを評価基盤化する

### やること

現在のshadow保存を、人間の最終採否と接続する。

分類:

```text
LLM_ADDED_TRUE_POSITIVE
LLM_ADDED_FALSE_POSITIVE
RULES_ONLY_FOUND_TRUE_POSITIVE
BOTH_MISSED_HUMAN_ADDED
BOTH_ADDED_HUMAN_REMOVED
UNSTABLE_LLM_OUTPUT
```

### 完了条件

- LLMあり/なしの差分が改善判断に使える。
- shadow modeが「保存しているだけ」ではなくなる。

## P2-5. async jobの運用性を強化する

### やること

- phase表示
- idempotencyKey
- inputSnapshotHash
- retry理由の分類
- stale job detection
- cancel / supersede
- job history UI

### 完了条件

- 504や長時間処理がUI上で破綻しない。
- 古いジョブ結果が新しい入力に反映されない。

## P2-6. 共通算定モジュール・ORCA連携を見据えた境界整理

### やること

`calculationOptions` の前段に `billingIntents` を定義する。

```text
canonicalClinicalFacts
→ billingIntents
→ internal Python calculator
```

将来的には以下へ差し替え可能にする。

```text
internal_rule_engine
common_calculation_module_adapter
ORCA/WebORCA_adapter
simulation/test_adapter
```

---

# 実装順序

推奨順序は以下。

```text
1. P0-4 自動算定禁止invariant
2. P0-3 fact lineage
3. P0-1 canonicalClinicalFacts主入力化
4. P0-2 関数分割
5. P1-4 MasterLinker独立
6. P1-1 evidence lineId/span強化
7. P1-2 NLP前処理強化
8. P1-3 概念辞書外部データ化
9. P1-5 review issue機械可読化
10. P2の評価・運用強化
```

P0は安全性と監査性を上げるための修正。
P1は抽出漏れと曖昧マスターを減らすための修正。
P2は安定性、処理時間、長期運用のための修正。

---

# 期待される効果

## 短期

- 根拠なし自動算定が減る。
- reviewに落ちる理由が明確になる。
- 事故調査が `factId` 単位でできる。

## 中期

- 概念辞書とMasterLinker強化により、初見カルテの取り漏れが減る。
- NLP前処理により、LLMの揺れを減らせる。
- shadow評価により、LLMが本当に精度を上げているか判断できる。

## 注意点

P0直後は、点数一致率が一時的に下がる可能性がある。

理由は、これまでlegacy event loopが拾っていた曖昧候補を、検証済みfact基準で止めるため。
これは安全側の変化であり、精度悪化ではなく、要確認への適切な縮退として評価する。

