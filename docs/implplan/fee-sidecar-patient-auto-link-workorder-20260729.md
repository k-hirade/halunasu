# sidecar患者 platform統合(find-or-create) ワークオーダー(J0〜J6 + J8分離)

- 作成日: 2026-07-29
- status: local implementation complete / J0・J6 STG verification pending
- 第2改訂(2026-07-29): 外部レビューP1×5・P2×5を全件検証し反映。**初版の中心前提(未連携でstanding lane不発火)が誤りだったため、目的自体を再定義した。** 初版の記述は本改訂で全面的に置き換える
- 対象: services/fee-api(sidecar calculate経路)、services/platform-api(patient store)、STG受入
- 前提フラグ: 新設のfee settingsフラグ `sidecarPatientAutoProvision`(既定off、PRODはoffのまま)

## 実装状況(2026-07-29)

- **J1完了**: memory / Firestore storeに `provisionPatientFromIdentifier` を追加し、患者識別子マッピングdocを使うトランザクションで通常患者作成・更新との一意性を統合した。patientIdは既存の `sidecarPatientKey` を再利用する。
- **J2完了**: fee settingsに厳密なbooleanの `sidecarPatientAutoProvision` を追加した。既定値はfalseで、文字列 `"true"` 等は拒否する。
- **J3完了**: sidecar calculateのcanonical患者解決直後に、`not_linked`・完全なlookup・施設設定trueの3条件を満たす場合だけ自動作成する。`ambiguous` / `unavailable` はfail-closedを維持する。作成者だけが外部患者番号を含まない監査イベントを1件記録する。
- **J4完了(ローカル)**: フラグoff時の仮ID、既存standing profile、自動作成後の請求履歴API、再calculateがすべて同じcanonical patient IDを使う統合テストを追加した。
- **J5完了**: 冪等性、並行作成、通常createとの競合、施設スコープ、識別子なし患者との共存、マッピング不整合をmemory / Firestoreテストで固定した。
- **J6設定のみ完了**: `samples/yamamoto-demo-stg/fee-settings.json` ではフラグをtrueにした。seed・deploy・mock患者1004での実機受入(a)〜(f)は未実施。
- **J0未実施**: mock患者1004のW1b不発火原因はSTG上で別途計測する。患者自動作成の実装結果から原因を推測して完了扱いにはしない。
- ローカル検証: firestore-schema 4件、platform-contracts 18件、fee-contracts 23件、platform-api 76件、fee-api 364件がpass。STG受入、gold gate、抽出安定性ゲートは未実施。

## 0. 用語整理(混同しやすい2つの「seed」)

- **患者リンクのseed**: mock患者に対応する内部患者を事前スクリプトで登録しておく案。本ワークオーダーの find-or-create により**不要になる**(初回読み取り時にその場で生える)。
- **請求履歴のseed**: W1(履歴駆動の恒常算定)は「前月に確定した実績」を参照するため、履歴のない患者では発火しない。過去実績の投入は既存の請求履歴取込API(`POST /v1/fee/patients/:id/billing-history`、`server.js:676-712`。baseline_import一括経路は `server.js:630-673`)で行う。**このAPIは管理者権限必須**であり、sidecar端末トークンから履歴を確定投入する経路は作らない(8節)。

seedは「過去の情報を取得する」機構ではなく「運用の中で自然に溜まるデータをスクリプトで事前投入する」こと。

## 1. 背景と実測事実(第2改訂で訂正)

### 1.1 現状の挙動(2026-07-29 コード再検証済み)

- サイドカーは読み取りごとに `(sourceSystem: "homis", facilityId, externalPatientId)` を送信する(`sidepanel.js:139`、`lib/contract.js:63`)。
- fee-apiは `resolveCanonicalSidecarPatientIdentity`(`longitudinal-context.js:14-74`)で、platform患者の `patientIdentifiers[]` と三つ組の完全一致がちょうど1件のときだけ `resolved` を返す。
- **【初版の誤り訂正】** 未連携(`not_linked` / `ambiguous` / `unavailable`)でも `canonicalPatientId` は空にならない。`unresolvedCanonicalIdentity` がフォールバックとして `sidecarPatientKey`(`sidecar_patient_<sha256先頭26hex>`、`server.js:1850-1866`)を `canonicalPatientId` に設定し、`canonicalPatientIdSource: "sidecar_patient_key"` を付ける(`longitudinal-context.js:356-368`)。この挙動は既存テストで固定されている(`services/fee-api/test/server.test.js:9481-9482`)。
- したがってstanding laneの前提条件(`server.js:7775-7779` は「IDが空か」だけを見る)は**未連携患者でも通過し、W1/W1bは仮ID空間で実行される**。`disabled("canonical_patient_unresolved")` がsidecar経路で発火することはない。
- standing profileの検索は `listStandingBillingProfilesForPatient(orgId, facilityId, canonicalPatientId)` の**canonical ID単独キー**(`server.js:7792-7796`)。aliasでの横断検索はしない。
- yamamoto-demo-stgにはHOMIS識別子を持つ内部患者が存在しない(seed `p15_seed_core_account.mjs:504-539` は `patientIdentifiers: []` のDemo Patient 1名のみ)。よって現状のsidecar計測はすべて `sidecar_patient_*` 仮ID空間で動いている。

### 1.2 本ワークオーダーの正しい目的

> **sidecarの仮患者ID(`sidecar_patient_*`)をplatform患者へ永続化し、通常のfeeセッション・請求履歴・standing profileと患者単位で統合する。**

未連携のままでも算定・W1b評価自体は動く。しかし仮ID空間に閉じるため、(a) 管理者APIで投入した請求履歴(platform患者ID宛)とsidecar実行(仮ID宛)が別人格になる、(b) 通常feeセッション経路と患者単位で突合できない、(c) 将来の名寄せ・患者管理に乗らない。この分断を閉じるのが目的。

**「W1bをSTGで初めて有効化する」は目的ではない**(初版の誤り)。mock患者1004でW1b候補が出ていない事象は、患者連携とは別の原因(standing_mentions抽出、profile不在、真理値表条件など)の可能性があり、J0で再実測して切り分ける。

### 1.3 設計不変条件

- **自動作成してよいのは `not_linked`(一致0件)かつ `lookupCompleteness === "complete"` のときだけ**。
  - `ambiguous`(複数一致)での作成は患者取り違え。fail-closed維持。
  - `unavailable`(store未達・例外)での作成は、障害中に重複患者を量産する。fail-closed維持。
- **既存仮ID空間との連続性**: platform患者のIDには**既存の `sidecarPatientKey` をそのまま使う**(J1)。別IDを発行すると、canonical ID単独キーで検索されるstanding profile・sidecar draft・履歴が取り残される(外部レビューP1-2)。同キー再利用なら移行は不要。
- **PHIの正確な整理**(外部レビューP2-4): 「PHIを保存しない」ではなく「**氏名・カルテ本文は保存せず、患者識別子(HOMIS患者番号等)は必要最小限のPHIとして保存する**」。患者識別子はplatform患者docと監査store(safePayload許可リスト経由)にのみ置き、Cloud Loggingには出さない。**短い患者番号の単純SHA-256は総当たりで復元可能なため、ログ・監査に生値由来hashも置かない**(P2-3)。監査には内部patientIdのみ記録する。
- candidateOnly原則は不変。確定は人。

## 2. チケット

### J0: 再実測 — mock患者1004でW1bが候補を出さない真因の特定

- **意図**: 初版は「未連携だからW1b不発火」と誤断定した。実際はstanding laneが仮IDで走っているため、候補が出ない原因は別にある。実装より先に事実を確定する。
- **具体実装**: STGでmock 1004を読み取り、draftとログ(PHI非出力の範囲)から以下を切り分ける:
  1. standing laneが実行されたか(`disabled(...)` 理由の有無。feature offなら `feature_disabled` のはず)
  2. `prepared.standingMentions` が空でないか(「気管切開・人工鼻管理と定期吸引を継続」がstanding_mentionsに抽出されているか)
  3. W1b初月検出まで到達して、ファミリ照合・ガード条件のどこで落ちたか
- **受入条件**: 「未連携で不発火」ではない実際の原因を計測docsに記録(`docs/2026MMDD-sidecar-w1b-diagnosis-stg/`)。原因がW1b側の欠陥なら別チケット化。

### J1: platform store に `provisionPatientFromIdentifier` を追加

- **意図**: 三つ組から冪等に患者を作成する専用メソッド。既存 `createPatient`(`firestore-store.js:633-650`)は `idFactory("pat")` でランダムIDのため流用しない。
- **具体実装**:
  - `firestore-store.js` / `memory-store.js` 両方に実装。シグネチャ: `provisionPatientFromIdentifier(orgId, {sourceSystem, facilityId, patientNumber, sidecarPatientKey})`。
  - **patientIdには呼び出し側から渡された `sidecarPatientKey`(`sidecar_patient_<26hex>`)をそのまま使う**。fee側の既存レコード(draft・standing profile・履歴イベント)がこのキーを `canonicalPatientId` として持つため、同キー採用で過去データの移行が不要になる(1.3)。
  - **一意性はdocID決定論だけでは保証されない**(外部レビューP1-3): 並行して通常の `createPatient` が同じHOMIS識別子をランダムIDで作れば2患者になる。対策として**患者識別子マッピングdoc**(`patient_identifier_index/<identifierKey由来ID>` → patientId)を新設し、Firestoreトランザクションで (a) マッピング取得/作成 (b) 患者doc取得/作成 (c) 既存患者との整合確認 を原子的に行う。`createPatient` / `updatePatient` 側も、識別子付き入力時は同マッピングを同一トランザクションで検査・登録するよう拡張する(既存識別子と衝突したら reject)。
  - `patientIdentifierKey` は現在storeごとの非公開関数(`firestore-store.js:1290-1299`)。共通モジュール(platform-contracts または store共有util)へ移して両store・マッピングdoc生成で単一実装を使う。
  - **戻り値は `{patient, created}`**(外部レビューP2-5)。競合した2リクエストのうち作成者だけが `created: true` を受け取り、監査イベントは作成者のみが記録する。
  - フィールドは最小: `displayName`(合成値 `HOMIS患者 <番号>`)、`primaryPatientNumber = patientNumber`、`patientIdentifiers: [{sourceSystem, facilityId, patientNumber}]`、`status: "active"`、`provenance: {source: "sidecar_auto_provision", firstSeenAt}`、`duplicateCandidateIds: []`。氏名・生年月日・保険情報は入れない。
  - `validateCreatePatientInput` が三つ組形式を受理し `buildPatientSearchFields` が `patientIdentifierKeys` を生成すること(`firestore-store.js:677` の索引が効くこと)を確認、不足なら拡張。
- **受入条件**:
  - 同一三つ組で2回呼んで同一 `patientId`・2回目は `created: false`(memory/firestore両方)。
  - 並行2呼び出しで患者docとマッピングdocが各1件、`created: true` は片方のみ。
  - **`provisionPatientFromIdentifier` と通常 `createPatient`(同識別子・ランダムID)の並行実行で2患者にならない**(トランザクション整合のテスト)。
  - 作成後に `findPatientsByIdentifier` が当該患者をちょうど1件返す。

### J2: fee settingsフラグ `sidecarPatientAutoProvision`(既定off・fail-closed)

- **意図**: 自動作成は重複患者リスクを伴うため組織/施設単位のopt-inにする。既存患者台帳と混在運用する組織はoffのまま運用できる。
- **根拠**: フラグ置き場は施設スコープのfee settings(`feeStore.getFeeSettings(orgId, facilityId)`、`server.js:772-773`。`autoBillingRules` と同居)。連携識別子が施設単位なので施設スコープが整合する。
- **具体実装**: fee settingsスキーマに `sidecarPatientAutoProvision: boolean`(既定 `false`)。読み出しは `=== true` 判定のみ。runtime featureプロファイルには追加しない(施設設定でありデプロイ形態ではない)。
- **受入条件**: フラグ未設定の既存settingsで挙動が現行と完全一致(回帰テスト)。設定バリデータテストに不正値ケース追加。

### J3: sidecar calculate経路に find-or-create を組み込む

- **意図**: `not_linked` の初見患者を読み取りリクエスト内でplatform患者化し、以後の履歴・セッションを患者単位で統合可能にする。
- **具体実装**:
  - フック位置は `server.js:252-259`(`resolveCanonicalSidecarPatientIdentity` 呼び出し直後)。
  - 分岐条件(全部AND): `resolutionStatus === "not_linked"` / `lookupCompleteness === "complete"` / 施設のfee settingsで `sidecarPatientAutoProvision === true`。
  - 条件成立時: J1を `sidecarPatientKey` 付きで呼ぶ。patientId=sidecarPatientKeyのため**draftの `canonicalPatientId` は値として変化しない**(仮ID時代と同一文字列)。変わるのは `canonicalPatientIdSource`(`sidecar_patient_key` → 新設 `sidecar_auto_provision`)と `resolutionStatus`(`resolved`)。以後の読み取りは `patient_identifier` で解決される。
  - `ambiguous` / `unavailable` / フラグoffは現行どおり(1.3)。
  - **監査**: J1が `created: true` を返したときのみ `createAuditEvent`。`eventType: "fee.sidecar_patient_auto_provisioned"`、safePayloadは `{patientId, facilityId}` のみ(内部IDのみ。**外部患者番号の生値もhashも入れない**、1.3)。safePayload許可リスト(`packages/platform-contracts/src/index.js:745-` の `sanitizeSafePayload`)は許可制で未登録キーは黙って落ちるため、使用キーが許可リストに含まれることをテストで固定する(外部レビューP2-2)。
- **受入条件**:
  - フラグonで未連携患者のcalculate → **storeのdraft**が `canonicalPatientResolutionStatus: "resolved"` / source `sidecar_auto_provision`、platform患者が1件生成。※現行のsidecarレスポンス(`sidecarDraftSummaryView` / `sidecarCalculationResponse`)はcanonical解決状態を返さないため(外部レビューP2-1)、**受入確認はstore読み取りで行う**。レスポンスへ `canonicalPatientResolutionStatus` を追加するかは別途判断(追加する場合はsidecar UIの表示方針と合わせて決める)。
  - 同一患者の2回目calculate → 自動作成が走らず(`patient_identifier` 解決)、`canonicalPatientId` の値が1回目と同一。
  - `ambiguous` fixtureで作成なし。platformStore例外注入(`unavailable`)で作成なし。フラグoffで挙動変化なし。
  - 監査イベントが競合時も1件のみ。

### J4: 患者統合のe2e(仮ID時代の履歴・profileが連続すること)

- **意図**: 本ワークオーダーの価値は統合の連続性。ID再利用により過去データが取り残されないことをe2eで固定する。
- **具体実装**:
  1. フラグoffでcalculate(仮ID空間にdraft・standing profileを作る)→ フラグonにして再calculate → platform患者が生え、**既存のstanding profile / draftが同一 `canonicalPatientId` で引き続き参照される**こと。
  2. 自動作成後、管理者APIで請求履歴を投入(`POST /v1/fee/patients/:id/billing-history`)→ `recordStandingProfilesFromConfirmedLines` が同一患者キーでprofileを作り、次回calculateのW1が参照すること。
  3. candidateOnly 3層防御の回帰(W1/W1b出力がreviewRequired候補のままであること)。
- **受入条件**: 上記がCIで緑。既存gold gate(seed-300 / v2 exact 138)と安定性ゲート(`eval:fee-extraction-stability`)に回帰なし。

### J5: 重複・境界テスト(memory-store)

- **意図**: 1.3の不変条件とP1-3対策をユニットレベルで固定する。
- **具体実装**: J1受入の常設テスト化に加え、(a) HOMIS識別子なしで先に内部登録済みの患者がいる場合に2人目ができること自体は仕様(氏名照合不能のため)と、`provenance.source` で自動作成分を列挙できること (b) 別施設の同番号患者(facilityId違い)が別患者になること (c) 識別子マッピングdocと患者docの不整合(手動削除等)を検出したとき作成せずエラーになること。
- **受入条件**: 上記テスト緑。

### J6: STG受入(yamamoto-demo-stg × mock患者1004)

- **意図**: find-or-createの実機動作と統合の連続性を確認する。※「W1b初発火の観測」は目的から除外(J0で切り分け)。
- **具体実装**:
  1. yamamoto-demo-stgのfee settingsに `sidecarPatientAutoProvision: true` を設定(PRODは触らない)。
  2. mock 1004を読み取り→算定。確認: (a) platform患者が `sidecar_patient_*` IDで1件生成、provenance付き (b) storeのdraftが `resolved` / `sidecar_auto_provision` (c) 2回目読み取りで作成が走らず同一ID (d) 監査イベント1件、safePayloadが許可リスト内キーのみ (e) Cloud Loggingに患者番号生値・生値由来hash・本文が出ていない (f) 管理者APIで前月履歴を投入→再calculateでW1が同一患者キーのprofileを参照する。
  3. 計測記録は `docs/2026MMDD-sidecar-auto-link-stg/` に、本文・患者名を保存しない既存規約で残す。
- **受入条件**: (a)〜(f) すべて確認。

## 3. 非対象(out of scope)

- 自動作成患者と既存患者の名寄せ・統合UI(将来。`duplicateCandidateIds` と `provenance` が入口)。
- サイドカーUIへの連携状態表示・連携操作の追加(操作を足さない方針)。
- 在宅医療機器管理状況パネルのcontract読取追加(別件)。
- **過去月行為のsidecar読取(旧J8)**: 別ワークオーダーに分離(5節)。
- PRODでのフラグ有効化。

## 4. リスクと緩和(要約)

| リスク | 緩和 |
| --- | --- |
| 既存内部患者との重複作成 | 施設opt-in(J2)+provenance明記(J1)+氏名を取り込まない設計の明文化(1.3) |
| 通常createPatientとの識別子競合 | 識別子マッピングdoc+トランザクション。createPatient側も同マッピングを検査(J1) |
| 仮ID時代のデータ分断 | platform患者IDに `sidecarPatientKey` を再利用し移行不要化(J1、e2eはJ4-1) |
| store障害中の重複量産 | `lookupCompleteness === "complete"` 必須(J3) |
| 複数一致時の取り違え | ambiguousでは作らない(J3受入で固定) |
| 患者識別子の露出 | 識別子は患者doc+監査storeのみ。ログには内部patientIdのみ、生値由来hash禁止(1.3) |
| 監査の二重記録 | `{patient, created}` 戻り値で作成者のみ記録(J1/J3) |
| candidateOnly破り | W1/W1b出力はreviewRequired候補のみ。J4-3で回帰固定 |

## 5. 過去月行為のその場取得(旧J8)— 原則は確定、実装は別ワークオーダーへ分離

### 5.1 原則の線引き(2026-07-29 ユーザー確認済み・確定)

「行為欄は評価専用」原則の本質は**「当月の答えを入力にすると、カルテから独立に算定を導く検証価値が消える」**こと。この本質に照らし、以下のとおり原則を精緻化する(緩和ではなく適用範囲の明確化):

- **当月の行為欄**: 引き続き入力禁止(なぞり防止。不変)
- **過去月の確定行為**: 入力に使ってよい。「答え」ではなく「前提条件(前月確定実績)」であり、baseline_importやW1の内部請求履歴参照と論理的に等価
- **機器管理欄**: 行為ではなく臨床状態。もともと正当な入力候補(別ワークオーダー対象)

この線引きは2026-07-29にユーザーが確認し確定した。以後の実装・レビューはこの精緻化を前提とする。

### 5.2 なぜ実装を分離するか(外部レビューP1-4・P1-5)

**現在のDOM contractでは実装できない。** contractが読むのは表示中カルテのSOAPのみ(`lib/contract.js:29` 以降、`#pdetail_karte .note-soap p`)。過去月行為の取得には以下の仕様が丸ごと不足している:

- 過去カルテをどう開くか(画面遷移の手順と、遷移中の読み取り競合防止)
- 何件・何か月分を取得するか
- 行為名(名称文字列のみ。疑似HOMISの `#action_list` はコードを持たない — `tmp/mock_homis/render.py:192`)を診療行為コードへどう解決するか
- コメント行と点数明細の分類、未解決行の保持方法

**セキュリティモデルも本体と異なる。** 既存の請求履歴APIは管理者権限必須(`server.js:676-677`)だが、sidecar calculateは端末トークンで実行でき、DOM改変・クライアント改変をサーバーは検証できない。よってsidecar由来の過去行為を直接 confirmed_claim にしてはならない。

### 5.3 分離後ワークオーダーに引き継ぐ設計要件

1. 読取行の4分類: `billable_line` / `claim_comment` / `claim_attribute` / `unknown`
2. **診療行為コードへ完全一致で解決できた行だけを履歴化候補にする**(部分一致・推測解決は不可)
3. 取り込みステータス: `source: "external_observed"`、`verificationStatus: "unverified"` で保存し、元画面・請求月・contractバージョン・hashをprovenanceに保持。**管理者確認後にのみstanding profileへ昇格**
4. STGの疑似HOMISに限り、明示的なテストモードフラグで自動確定を許可(PROD経路とはコードレベルで分離)
5. 前提: 本ワークオーダー(J1〜J6)完了。履歴の紐付け先となるplatform患者が先に必要

## 6. 改訂履歴

- 初版(2026-07-29): find-or-create設計、J1〜J8
- 第2改訂(2026-07-29): 外部レビュー反映。(P1-1)「未連携でstanding lane不発火」の前提誤りを訂正し目的を「仮患者IDのplatform永続統合」に再定義、J0(再実測)新設 (P1-2)platform患者IDに `sidecarPatientKey` を再利用し履歴分断を回避 (P1-3)識別子マッピングdoc+トランザクション、`patientIdentifierKey` 共通化 (P1-4/P1-5)旧J8を別ワークオーダーへ分離し、external_observed/unverified/管理者昇格のセキュリティモデルを要件化 (P2)レスポンス未返却項目の受入方法修正、safePayload許可リスト対応、生値由来hash禁止、PHI文言の精緻化、`{patient, created}` 戻り値
