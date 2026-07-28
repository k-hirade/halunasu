# 作業依頼: OpenAI主経路 + 補助Span漏れ再確認 (2026-07-28)

関連:

- [白箱抽出STG計測分析](./fee-whitebox-shadow-measurement-analysis-20260728.md)
- [白箱ゲート再設計](./fee-whitebox-gate-redesign-workorder-20260727.md)
- [分類器入力契約](./fee-whitebox-context-input-contract-workorder-20260728.md)
- [白箱抽出全体計画](./fee-whitebox-extraction-plan-20260724.md)

## 0. 決定

期限内に採用する構成を次で固定する。

1. **OpenAIを臨床事実抽出の主経路として維持する。**
2. コード・点数・算定可否は、従来どおり決定論エンジンが判定する。
3. 最終確定は人間の承認を必要とする。
4. 現在のGLiNER方式MiniLM Span検出器は、OpenAIの抽出漏れを見つける
   **補助センサー**としてのみ使う。
5. 補助センサーが抽出漏れ候補を見つけた場合だけ、OpenAIへ最大1回の
   限定再確認を行う。
6. Span検出器、Linker、WX3分類器からコード・点数を直接追加・削除しない。
7. Whiteboxの自律ルーティング昇格は、本リリースのクリティカルパスから外す。

ここでいう「GLiNER方式」は、ゼロショットGLiNER本体ではない。
ゼロショット評価は1.16%で不採用であり、実行対象は現在の学習済み
MiniLM Span検出器である。

### 0.1 実装・リリース状態 (2026-07-28)

- OpenAI主経路、Span漏れ照合、最大1回の限定再確認、安全な候補専用変換を実装済み。
- STG専用profile
  `stg-openai-primary-span-recheck` は
  `FEE_EXTRACTION_COVERAGE_MODE_STG=verify` とし、
  `fac_9fe275b29feebb03bfeb9410f7` だけを許可する。
- Linker / WX3 / Whitebox自律ルーティングは同profileで無効。
- `FEE_SPAN_DETECTOR_MODE_STG=shadow` は既存runtime上でSpan推論を
  読み取り専用起動するための内部スイッチである。機能全体は観測専用ではなく、
  `FEE_EXTRACTION_COVERAGE_MODE_STG=verify` により限定再確認まで実行する。
- ローカル検証とgold回帰は完了。STGへの実デプロイとSTG固定ケース計測は未実施。

## 1. 判断根拠

32セル x 3回のSTG計測で、実行基盤自体は安定している。

- 96/96実行完了
- degraded 0
- 単一Cloud Run revision
- ルータ決定論一致 100%
- 当日自院Span検出 84/88 (95.5%)

一方、自律ルーティングに必要な結合ゲートは未成熟である。

- strict billable inclusion: 0
- shadow billable inclusion: 3/68 (4.4%)
- strict safe exclusion: 0
- shadow safe exclusion: 1/25 (4.0%)
- 主なブロッカー:
  - `context_abstain_or_low_confidence`: 52
  - `context_unresolved`: 49

したがって、Span検出能力は漏れ監視に利用できるが、WX2/WX3を含む白箱出力を
OpenAIの代わりに算定入力へ昇格させる根拠はない。

## 2. 目的

### 2.1 達成すること

- 新規・変更カルテは、OpenAIが従来どおり全文または既存memo差分を抽出する。
- Span検出器が、OpenAI結果に現れない診療行為候補を行・節単位で検出する。
- 漏れ候補だけを、元カルテの該当行とともにOpenAIへ1回再確認する。
- 再確認で支持された臨床事実だけを、通常の決定論変換・マスタ照合へ流す。
- 再確認後も解消しない候補は、算定へ入れず既存の「やること」に表示する。
- 補助機能停止・失敗時は、現在のOpenAI主経路と同じ結果を返す。

### 2.2 達成しないこと

- LLMに点数計算や請求コードの最終選択をさせない。
- Span検出器の出力を直接 `clinical_events` に変換しない。
- Linkerのtop-1を自動採用しない。
- WX3で実施・過去・予定・他院を最終確定しない。
- Span検出結果でOpenAIの抽出済み事実を削除しない。
- 補助機能をOpenAI利用料削減策として扱わない。
- 期限内にWhitebox自律ルーティングの昇格を目指さない。

## 3. 不変条件

以下はコードとテストで固定し、設定だけでは破れないようにする。

### 3.1 主経路

```text
カルテ
  -> OpenAI臨床事実抽出
  -> 決定論変換・マスタ照合
  -> 算定候補 / 確認事項
  -> 人間承認
```

同一本文をmemoから再利用する場合も、再利用元はOpenAI抽出済みsnapshotで
なければならない。memoはOpenAI主経路のキャッシュであり、Whiteboxによる
置換とは扱わない。

### 3.2 補助経路の権限

補助Span検出器に許可する操作は次の2つだけとする。

1. OpenAI再確認対象の行・節を選ぶ。
2. 解消しなかった漏れ候補を確認事項として残す。

次は明示的に禁止する。

- `procedure_codes`、候補コード、点数の追加
- OpenAI事実の削除・降格
- safe exclusionの自動確定
- `performed`、`prescribed`、`administered` の直接確定
- 本文にない名称・区分・数量の補完

### 3.3 単調な統合

再確認結果は初回OpenAI結果への**追加**に限定する。

- 同一事実は重複排除する。
- 再確認が初回事実と矛盾した場合、初回事実を上書きしない。
- 矛盾は `auxiliary_extraction_conflict` として人間確認へ送る。
- 再確認だけが支持した事実には
  `extraction.source=openai_auxiliary_recheck` を付与する。
- 再確認由来の候補は `candidateOnly=true`、
  `reviewRequired=true` とし、人間承認前の確定点数へ入れない。
- 補助Spanそのものには算定根拠のprovenanceを与えない。
- **`visit_facts` は初回OpenAI結果を保持し、再確認結果では一切変更しない。**

  根拠(2026-07-28レビュー): `mergeClinicalFactsSamples` は
  `mergeClinicalVisitFacts` 経由で `visit_facts` もマージする
  (`services/fee-api/src/clinical-calculation-input.js:4134`)。
  現状は `.filter(isPlainObject)` により visit_facts を持たないサンプルを
  除外するため今日時点では安全だが、再確認応答が visit_facts を含むと
  `mergeDecision` が不一致を `"unknown"` へ落とし、**初回の確信ある判定を
  格下げする**。ここは過去に院外処方箋の判定で stale visit_facts が
  院内調剤+32点の実害を出した経路であり、A4で同じ関数を改修するため、
  不変条件として明文化し反例テストで固定する
  (再確認応答に visit_facts が混入しても初回値が保たれること)。

## 4. 目標データフロー

```text
                        +-------------------------+
                        | MiniLM Span detector    |
                        | 補助候補のみ            |
                        +------------+------------+
                                     |
カルテ -> 共通前処理 ----------------+-------------------+
          |                                               |
          +-> OpenAI初回抽出 -----------------------------+
                         |                                 |
                         +-> SpanとOpenAI根拠を照合        |
                                      |                    |
                          漏れなし ----+--> 決定論算定      |
                                      |                    |
                          漏れ候補あり                       |
                                      v                    |
                         OpenAI限定再確認 (最大1回)          |
                                      |                    |
                         単調merge / 矛盾は要確認            |
                                      v                    |
                                  決定論算定                |
```

Span検出とOpenAI初回抽出は、共通前処理の完了後に並列開始する。
補助推論をOpenAI呼び出しの前に直列実行しない。

## 5. 漏れ候補の判定契約

### 5.1 補助信号

`services/fee-api/src/whitebox-extraction.js` から、Linker/WX3の成否に依存しない
読み取り専用の信号を返す。

```js
{
  lineId,
  clauseId,
  spanId,
  category,
  charStart,
  charEnd,
  normalizedTextHash,
  confidence,
  artifactThreshold,
  artifactVersion
}
```

実カルテ本文とSpan文字列はCloud Runログへ出さない。
アプリ内部の再確認入力では元の前処理済み行を使用する。

対象は現在のartifactに定義された算定行為カテゴリとする。

- `counseling`
- `exam`
- `imaging`
- `injection`
- `lab`
- `management`
- `material`
- `medication`
- `other`
- `outpatient_basic`
- `pathology`
- `procedure`
- `treatment`

Span信号は、カテゴリ別artifact閾値を満たすものだけを対象にする。
Linker score、linker margin、WX3 context confidenceは再確認の必須条件にしない。
これらを条件にすると、今回観測したWX2/WX3の弱点が再び漏れ検知を止めるためである。

### 5.2 OpenAI側のカバレッジ索引

初回OpenAI結果から次を行ID単位で索引化する。

- `clinical_events[].evidence_line_ids`
- `clinical_events[].name`
- `clinical_events[].search_queries`
- `excluded_events[].evidence_line_ids`
- `excluded_events[].name`
- `standing_mentions[].line_id`
- `standing_mentions[].target`
- `line_review[].line_id / line_role`

`line_review=performed` だけでは個別行為のカバー済み判定にしない。
1行に複数行為がある場合の一部漏れを隠すためである。

### 5.3 gap判定

次を全て満たすSpanを再確認候補とする。

1. artifact閾値以上である。
2. 対応する行・節が空行や管理用メタ行ではない。
3. 同じ行のOpenAI事実に、正規化した名称または検索語が対応していない。
4. 同じSpanが既に再確認済みではない。

名称照合はNFKC、空白・記号・算定語尾の正規化を使う。
意味類似度だけで「カバー済み」にしない。曖昧な場合は再確認側へ倒す。
誤検知の影響は追加OpenAI呼び出しに限定し、算定事実にはしない。

### 5.4 上限

1セッションにつき次で固定する。

- 追加OpenAI呼び出し: 最大1回
- 再確認行: 最大8行
- 再確認Span: 最大16件
- 同一行のSpanは1回の `line_subset` へまとめる

限定再確認は `FEE_CLINICAL_EXTRACTION_SAMPLES` の値にかかわらず
常に1 sampleとする。通常抽出を複数sampleにしている環境でも、
再確認だけが2〜3呼び出しへ増えないようにする。

上限超過分は黙って捨てず、件数だけを
`auxiliary_extraction_unresolved` の確認事項と監査traceへ残す。

## 6. OpenAI限定再確認契約

既存の `line_subset` schemaを再利用し、別の自由形式レスポンスは追加しない。

`packages/medical-core/src/fee/openai-fee-clinical-facts.js` へ
`coverageReviewTargets` を追加する。

```js
[
  {
    line_id: "L0004",
    category: "lab",
    detected_phrase: "CRP検査"
  }
]
```

プロンプトでは次を固定する。

- 対象は未確認の機械検出であり、事実ではない。
- 必ず元行を読み、実施・予定・過去・他院・否定を独立に判定する。
- 本文に支持されなければイベントを作らない。
- 点数・コード・算定可否を決めない。
- 該当行以外を推測しない。
- 全対象行の `line_review` を返す。

通常全文抽出の意味契約は変えず、限定再確認入力がある場合だけ補助指示を追加する。

**prompt versionの扱い(2026-07-28レビューで変更)**: 通常全文抽出は
`fee-clinical-events-v15` のまま据え置き、**再確認呼び出しにだけ別タグを付ける**。

`promptVersion` は抽出snapshotの有効性キーである
(`services/fee-api/src/longitudinal-context.js:176`)。v16へ一律に上げると
**全患者のmemoが失効し、デプロイ直後は全件full抽出へ戻る**
(memoの約0.93秒・OpenAI呼び出し0が一時的に消える)。
本chartは通常抽出の出力を変えないと明言しているため、同一入力は同一出力であり
memoは有効なままでよい。バージョンを上げる合理的理由がない。

どうしても一律にv16へ上げる場合は、リリース手順(§11)へ
「初回計算はmemo無効化により全件full抽出になる」コスト・レイテンシ影響を
明記すること。

## 7. 再確認コーディネータ

現状は次の再試行契機がある。

- 空抽出検証
- `line_review` 欠落
- 新規のSpan漏れ検証

個別実装のまま追加すると、1セッションで複数回OpenAIを呼ぶ可能性がある。
`services/fee-api/src/clinical-calculation-input.js` に共通の
`extractionRecoveryBudget` を導入し、追加呼び出しを合計1回に制限する。

優先順位は次とする。

1. `line_review` 契約欠落
2. 空抽出かつ算定行為Spanあり
3. 一部Spanの未カバー

同じ再確認で対象行を安全にまとめられる場合は、優先順位の異なる対象も
1回の `line_subset` にまとめる。

Span検出器が利用不能、timeout、invalid responseの場合:

- 初回OpenAI結果をそのまま使用する。
- 算定結果を失敗させない。
- 追加OpenAI呼び出しを行わない。
- degraded理由をメトリクスへ記録する。
- 生のエラーや本文をユーザー画面へ出さない。

OpenAI再確認が失敗した場合:

- 初回OpenAI結果をそのまま使用する。
- 対象が存在した事実だけを確認事項として残す。
- 計算全体をrules fallbackへ落とさない。

## 8. 実装対象

### A1. Span補助信号の分離

対象:

- `services/fee-api/src/whitebox-extraction.js`
- `services/fee-api/test/whitebox-extraction.test.js`

作業:

- raw Span検出結果から `coverageSignals` を生成する純関数を追加する。
- 全三レーン計画を作る `prepareWhiteboxExtraction` とは別に、
  Span-onlyの `prepareAuxiliaryCoverageSignals` を設ける。
- `coverageSignals` はLinker/WX3がoffまたはunavailableでも返せるようにする。
- `encoderFacts` / `encoderShadowFacts` と完全に分離する。
- route用の `passed`、`jointEligible` を補助漏れ検知で参照しない。
- Span detectorがoffの場合は空配列を返す。

### A2. OpenAI主経路の構造保証

対象:

- `services/fee-api/src/clinical-calculation-input.js`
- `services/fee-api/src/server.js`
- `scripts/p10_deploy_runtime_services_low_cost.sh`
- `scripts/runtime_feature_profile.py`

作業:

- `FEE_CLINICAL_EXTRACTION_STRATEGY=openai_primary` を既定かつ
  STG/PRODの通常profileで唯一許可する値として追加する。
- `openai_primary` では `whiteboxPlan.status=route_ready` でも
  `whiteboxPlan.llmLines` / `encoderFacts` へ切り替えない。
- 既存の自律ルーティング実験は
  `FEE_CLINICAL_EXTRACTION_STRATEGY=whitebox_experiment` に隔離し、
  local/STGの専用profile以外では拒否する。
- STG/PRODの補助再確認profileで
  `FEE_SPAN_DETECTOR_MODE=route` を禁止する。
- `FEE_LINKER_MODE=propose` と
  `FEE_CONTEXT_CLASSIFIER_MODE=assist` も同profileでは禁止する。
- 既存の三レーンshadow profileは研究・比較用として残す。
- `readyz` にstrategy、coverage mode、Span availability、artifact versionを
  出し、デプロイ直後に主経路を機械確認できるようにする。

### A3. カバレッジ照合と限定再確認

対象:

- `services/fee-api/src/clinical-calculation-input.js`
- 必要なら新規
  `services/fee-api/src/extraction-coverage-recheck.js`

作業:

- `buildClinicalFactCoverageIndex`
- `findUncoveredAuxiliarySpans`
- `planExtractionRecovery`
- `stampAuxiliaryRecheckProvenance`
- `detectAuxiliaryExtractionConflicts`

を副作用のない関数として分離する。

- OpenAI初回抽出とSpan detectorを並列開始する。
- 既存の空抽出・line review retryと再確認budgetを統合する。
- 再確認後に1回だけfactsを正規化し、決定論変換を実行する。
- 同じfactsを変換前後で二重に算定しない。
- 再確認由来のsource factから生成された候補に
  `candidateOnly / reviewRequired` を伝播する。

### A4. facts mergeの補強

対象:

- `services/fee-api/src/clinical-calculation-input.js`

現行 `mergeClinicalFactsSamples` は主に `clinical_events`、`diagnoses`、
`line_review`、`standing_mentions` を統合している。
限定再確認を安全に統合するため、少なくとも次を明示的に扱う。

- `excluded_events`
- `missing_information`
- `review_flags`
- event provenance
- 初回と再確認の矛盾
- `diagnoses` と `standing_mentions` は初回OpenAI結果を保持する。
  補助Spanは行為漏れセンサーであり、再確認応答から病名駆動・恒常算定レーンへ
  出所不明の候補を波及させない。

performed側を優先して黙って上書きするのではなく、矛盾は確認事項へ送る。

### A5. OpenAI入力契約

対象:

- `packages/medical-core/src/fee/openai-fee-clinical-facts.js`
- `packages/medical-core/test/openai-fee-clinical-facts.test.js`

作業:

- `coverageReviewTargets` の安全な正規化を追加する。
- line subsetに存在しないline IDを除外する。
- phrase長、件数、カテゴリを制限する。
- 通常全文抽出のprompt versionはv15のまま据え置く(§6の理由)。
  再確認呼び出しにだけ別タグを付け、memoを失効させない。
- 通常全文抽出に補助Spanを混ぜない。
- テスト用extractorにも同じ入力契約を渡す。

### A6. 設定とruntime profile

新規設定:

```text
FEE_CLINICAL_EXTRACTION_STRATEGY=openai_primary|whitebox_experiment
FEE_EXTRACTION_COVERAGE_MODE=off|observe|verify
FEE_EXTRACTION_COVERAGE_MAX_LINES=8
FEE_EXTRACTION_COVERAGE_MAX_SPANS=16
FEE_EXTRACTION_COVERAGE_TIMEOUT_MS=2000
FEE_EXTRACTION_COVERAGE_FACILITY_ALLOWLIST=
```

- `off`: 補助照合なし。
- `observe`: SpanとOpenAIの差を計測するが再確認しない。
- `verify`: 未カバーSpanがあると最大1回限定再確認する。
- `whitebox_experiment`: 既存の自律ルーティング研究専用。PRODでは拒否する。
- facility allowlistが空のPRODではverifyを拒否する。
  STGは専用profileでのみ許可する。

新規profile:

```text
configs/runtime-feature-profiles/stg-openai-primary-span-recheck.env
```

profile方針:

- `FEE_CLINICAL_EXTRACTION_STRATEGY_STG=openai_primary`
- `FEE_EXTRACTION_COVERAGE_MODE_STG=verify`
- `FEE_EXTRACTION_COVERAGE_FACILITY_ALLOWLIST_STG=fac_9fe275b29feebb03bfeb9410f7`
- Span detectorのみ有効
- Linker/WX3はoff
- Whitebox routeはoff
- PRODは未指定時off
- `MIN_INSTANCES=0` を維持

三モデルを常駐させずSpan artifactだけを使うため、現在の三レーンshadowより
メモリ・artifact転送・cold startを小さくできる見込みである。ただしCPU・メモリは
推測で下げず、Cloud Run実測後に決める。デプロイ時のCPU指定は `CPU=2` を使う。

### A7. 監査・計測

`fee.calculation.performance` に次を追加する。

```js
auxiliaryCoverage: {
  mode,
  detectorAvailable,
  detectorDurationMs,
  detectedSpanCount,
  coveredSpanCount,
  gapSpanCount,
  gapLineCount,
  recheckPlanned,
  recheckAttempted,
  recheckSucceeded,
  recheckSuppressedReason,
  recoveredClinicalEventCount,
  unresolvedGapCount,
  conflictCount,
  additionalOpenAiCallCount,
  additionalOpenAiInputTokens,
  additionalOpenAiOutputTokens,
  additionalOpenAiDurationMs,
  spanArtifactVersion
}
```

Cloud Loggingには本文、氏名、Span文字列、OpenAI出力を記録しない。
記録するIDが必要な場合は、run内限定のHMAC/hashにする。

clinical trace:

- `auxiliary_coverage_check`
- `auxiliary_extraction_recheck`
- `auxiliary_extraction_conflict`

### A8. UI

新しい画面は作らない。既存の「やること」を使う。

再確認後も解消しない場合のみ:

- title: `カルテ抽出候補の確認`
- issueCode: `auxiliary_extraction_unresolved`
- severity: `warning`
- requiredInput: `当日実施、予定、過去・他院情報の区別`

ユーザー向け表示に「GLiNER」「WX1」など内部モデル名は出さない。
再確認で復元した候補は、既存候補と同じ承認フローへ送る。

## 9. テスト

### 9.1 単体テスト

1. OpenAIが全Spanを抽出済み:
   - gap 0
   - 追加OpenAI呼び出し0
   - 算定結果が補助機能off時と完全一致
2. 同じ行の1行為だけ欠落:
   - 欠落Spanだけ再確認対象
   - 追加呼び出し1
   - 支持された事実だけ追加
3. 1行に複数行為:
   - 一部だけ抽出済みでも、残りをgapとして検出
4. 過去の行為:
   - Spanがあっても再確認結果から当日算定へ自動追加しない
5. 他院・持参結果:
   - own clinic current eventへ昇格しない
6. 未実施・否定:
   - performedへ昇格しない
7. 予定・次回:
   - current performedへ昇格しない
8. detector timeout/unavailable:
   - 初回OpenAI結果と完全一致
   - 計算全体は成功
9. recheck timeout/error:
   - 初回OpenAI結果と完全一致
   - unresolved issueのみ追加
10. gapが上限超過:
    - 追加呼び出しは1回
    - 超過件数を監査可能
11. 初回と再確認が矛盾:
    - 上書きせず `auxiliary_extraction_conflict`
12. memo only:
    - snapshot由来factsと現在Spanを照合
    - gapがなければOpenAI呼び出し0
13. line review欠落 + Span gap:
    - 合計追加呼び出し1
14. empty extraction + Spanあり:
    - 合計追加呼び出し1
15. Linker/WX3がoff:
    - Span補助再確認が動作
16. 再確認由来候補:
    - `candidateOnly=true`
    - `reviewRequired=true`
    - 承認前の確定点数に入らない

### 9.2 回帰

- fee-api全テスト
- medical-core全テスト
- engine purity gold 300/300
- v2 exact engine gold 138/138
- fee-web build
- **抽出安定性ゲート** `npm run eval:fee-extraction-stability`
  (2026-07-28レビューで追加)

  確定点数については再確認由来候補が `candidateOnly + reviewRequired` であり
  三層防御で守られるが、**安定性ゲートは候補集合のJaccardも判定する**
  (基線100%)。gapの有無自体が1回目のLLM出力に依存するため、
  同一入力でrecheckが発火したりしなかったりし、**候補集合が揺れうる**。
  基線が崩れる場合は「recheck由来候補をJaccard評価対象から除く」等の規約を
  先に決めること。閾値を後から緩めない。

本方式はWhitebox自律昇格ではないため、32セル x 3回のpromotion測定を
実装受入の必須条件にしない。高額な再測定を繰り返さず、次のSTG比較を行う。

### 9.3 STG比較

同じ固定ケースで次を比較する。

1. `off`: OpenAI主経路のみ
2. `observe`: 差分計測のみ
3. `verify`: 限定再確認あり

最低ケース:

- 既知の抽出漏れ
- 複数行為を含む1行
- 過去言及
- 他院言及
- 否定・未実施
- 予定
- 通常ケース
- 長めの在宅カルテ

新規ハーネス:

```text
npm run eval:fee-extraction-coverage-recheck-stg
```

ハーネスは次を出力する。

- 初回OpenAI結果
- 再確認追加分
- 最終臨床事実差分
- 最終候補・点数差分
- 追加OpenAI呼び出し回数
- token / latency
- unresolved / conflict
- Cloud Run revision / Span artifact version

## 10. 受入条件

### 10.1 必須

- 通常ケースで補助offとverifyの候補・点数が完全一致する。
- detector利用不能時に補助offと完全一致する。
- 既知漏れfixtureを1回の再確認で復元できる。
- 過去・他院・否定・予定fixtureから確定点数を増やさない。
- 1セッションの追加OpenAI呼び出しが1回以下である。
- Span/Linker/WX3から直接生成された算定コードが0件である。
- 再確認由来候補がすべてcandidate-onlyであり、自動確定が0件である。
- engine gold 300/300、v2 exact 138/138を維持する。
- 生カルテ・Span文字列をCloud Loggingへ出さない。
- PRODの既定値がoffである。

### 10.2 計測して判断

- gap発生率
- 再確認成功率
- 未解消率
- 初回抽出に対するrecall増分
- dangerous false positive件数
- 追加token
- no-gap時のp50/p95増分
- recheck時のp50/p95増分
- Cloud Run cold start / memory peak

数値を見ずに閾値を緩めない。Span誤検知は再確認コストに閉じ込め、
算定精度を下げる方向へ使わない。

## 11. リリース手順

### Phase 1: ローカル

1. A1〜A5を実装する。
2. 単体・統合・gold回帰を通す。
3. OpenAI主経路不変テストを必須化する。

### Phase 2: STG verify

1. `stg-openai-primary-span-recheck` profileで限定施設へデプロイする。
2. `readyz` でOpenAI主経路、coverage verify、Linker/WX3 off、
   Span artifact利用可能を確認する。
3. 固定ケースを測定し、必須受入条件を確認する。
4. 実患者データは匿名化済みデータだけを使う。
5. 受入未達時は `FEE_EXTRACTION_COVERAGE_MODE=off` へ即時ロールバックする。

### Phase 3: PROD判断

初回PRODは次のどちらかだけとする。

- 安全条件を満たす: `verify` を限定施設allowlistで有効化
- 条件未達: OpenAI主経路のみをリリースし、補助機能はoff

期限を理由にroute/propose/assistへ切り替えない。

## 12. ロールバック

即時ロールバック単位は次の1変数とする。

```text
FEE_EXTRACTION_COVERAGE_MODE=off
```

off時は:

- Span detectorを呼ばない。
- coverage照合を行わない。
- 追加OpenAI呼び出しを行わない。
- 現行OpenAI主経路だけを使用する。

artifactや学習資産を削除する必要はない。既存の三レーンshadow計測資産も
研究用に残すが、STG/PRODの通常算定profileからは外す。

## 13. 明日期限の停止条件

次のどれかが未達なら、補助verifyを無理に有効化しない。

- OpenAI主経路不変テスト
- 追加呼び出し上限1回
- 過去・他院・否定・予定の反例
- detector/recheck障害時の無変更フォールバック
- gold 2系統
- PHI非出力

その場合も失敗ではなく、**OpenAI主経路のみをリリース可能な状態**を完了形とする。
Whitebox自律昇格やWX3再学習を明日の出荷条件に戻さない。
