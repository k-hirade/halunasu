# HOMIS Sidecar 患者別交通費・処理継続 意思決定メモ

- 作成日: 2026-08-03
- status: Sidecar患者別3択・履歴付き解除・B1を実装済み / 会計確定・fee-web管理・B2は未実装
- 対象: fee-domain、fee-web、HOMIS Sidecar

## 1. 結論

| 論点 | 2026-08-03実装済み | 未決・未実装 |
| --- | --- | --- |
| 患者別交通費 | `patient_charge`として保険算定から分離。Sidecarの `未設定 / 請求する / 請求しない` から患者別方針を選び、Fee API経由で `fee_patient_charge_contracts` へ保存する。未設定へ戻す操作も履歴付きclearとして保存する | 施設既定値、実費金額、同意、会計・領収証連携、fee-webの参照・管理UI |
| タブ切替中の算定 | 抽出完了後のFee API処理を継続し、別患者には表示せず、元カルテ復帰時だけ結果を復元するB1 | Side Panel閉鎖・再読込後まで復旧するB2 |

したがって、質問への回答は次のとおり。

1. **患者別交通費のSidecar保存フローを3択で実装した。** 現段階で同じ値を読むのはFee APIとSidecarであり、fee-web接続と施設既定値は未実装である。
2. **タブ切替継続B1を実装した。** 患者取り違え防止を維持しつつ、抽出完了後の成功結果を破棄しない。Panel閉鎖後の復旧B2は別判断とする。

## 1.1 今回の実装境界

今回の保存値は患者ごとの請求方針であり、請求確定値ではない。`請求する`を選んでも実費未入力なら `status=pending_actual`、`billingHandling=unknown` とし、自動請求しない。交通費は引き続き保険点数、`estimatedTotalPoints`、UKE/レセ電へ含めない。

実装したAPIは `PUT /v1/integrations/sidecar/drafts/:sidecarDraftId/patient-charge-setting` のみである。任意の患者IDは受け取らず、draftに解決済みのcanonical patientへだけ保存する。入力には患者契約の `expectedRevision` に加え、Sidecarが表示していたdraftの `expectedSourceRevision` と `expectedCalculationRevision` を必須とする。handlerで現在のdraftと照合し、契約更新transaction内でも同じrevisionを再照合したうえで、draftの組織・施設・患者・診療日・有効期限・未採用状態を再検証する。監査outboxも契約更新と同じtransactionで保存する。

施設既定値とfee-webの患者交通費GET/更新UIは実装されていない。このため新しいSidecarから `施設設定を継承` を削除した。`契約内に含む` は「交通費を別明細で患者請求しないが、その理由を契約内包として区別する」旧handlingだったが、契約文書・会計consumerが未実装で `請求しない` との差を運用できないため、新規選択肢から削除した。

既存DBの `inherit` と `included_in_contract` は破壊的に変換せず、APIとreaderの後方互換として残す。Sidecar表示では `inherit` を未設定、`included_in_contract` を請求しない相当へ投影し、旧設定であることを補足する。利用者が明示変更したときだけ新しいeventを追記する。

## 2. 交通費の現状

### 2.1 既決事項

- `fee-universal-act-coverage-workorder-20260729.md` G7で `patient_charge` として評価分離済み。
- `fee-mock-act-gap-analysis-and-features-20260730.md` の「個人宅全員」はmock fixtureの記述であり、契約仕様ではない。
- Fee APIは往診時に「患家負担のため自動計上しない」と警告するだけである。
- Sidecar response、点数候補、`totalPoints`、UKE/レセ電、保険自己負担計算に交通費は含まれない。
- runtimeは行為欄を読まない。mock行為欄に交通費があるかどうかは請求判断に使わない。

令和8年適用の診療報酬告示でも、C000往診料の注7は往診に要した交通費を患家負担としている。ただし、予定された訪問診療を含む請求可能範囲、徴収方法、金額、税務・領収証の扱いは、制度資料と施設運用を確認して別途確定する。mockの「定期訪問+往診交通費」をそのまま一般ルールにはしない。

一次資料:

- https://www.mhlw.go.jp/hourei/doc/hourei/H260319S0060.pdf
- https://www.mhlw.go.jp/web/t_doc?dataId=84aa9729&dataType=0&pageNo=6

### 2.2 未決事項

実装前に、少なくとも次を業務決定する。

1. 対象を往診だけにするか、計画的訪問診療にも適用するか。
2. 実費、固定額、距離別、都度手入力のどれにするか。
3. 公共交通・自動車等の対象費用と、徴収不可の移動手段・費目。
4. 患者ごとの請求、免除、契約内包、未確認をどう区別するか。
5. 同意・契約書が必要な運用、文書版、撤回、適用開始/終了日。
6. 金額確定の担当者とタイミング、訂正・返金方法。
7. 消費税、領収証、会計連携の表示方法。
8. 施設標準方針と患者overrideの優先順位。

単純なboolean `chargeTransportFee` では、未確認と免除、施設設定の継承、契約期間、同意失効を区別できないため採用しない。

## 3. 患者別交通費の仕様

2026-08-03に、Sidecarで患者別に選択し、Fee API経由で患者契約DBへ保存する基本フローを承認した。既存G7の「Sidecar UIには表示しない」は「点数候補とは分離した患者負担欄で表示・設定する」へ改訂する。

### T1: データ所有（Sidecar保存部分を実装済み）

- fee-domain配下に `fee_patient_charge_contracts` を新設した。
- platform患者docの自由形式 `consent` には埋め込まない。
- 施設標準方針を既存 `fee_settings` の `patientChargePolicies[]` に置く案は未実装である。
- 患者契約は `orgId + facilityId + canonicalPatientId + chargeType + serviceDate` で解決する。
- 行為欄、SOAP、同一建物/個人宅ラベルから請求有無を推論しない。

施設標準方針の最小モデル:

```json
{
  "policyId": "pcp_...",
  "chargeType": "home_medical_transport",
  "applicableSettings": ["house_call", "home_visit"],
  "defaultHandling": "require_patient_agreement",
  "amountMode": "actual",
  "effectiveFrom": "2026-08-01",
  "effectiveTo": null,
  "version": 1,
  "status": "active"
}
```

今回実装した患者契約の主要モデル:

```json
{
  "patientChargeContractId": "pcc_...",
  "orgId": "org_...",
  "facilityId": "fac_...",
  "canonicalPatientId": "pat_...",
  "chargeType": "home_medical_transport",
  "revision": 1,
  "settingEvents": [{
    "revision": 1,
    "handling": "charge",
    "amountMode": "actual",
    "amountYen": null,
    "effectiveFrom": "2026-08-01",
    "effectiveTo": null,
    "source": "homis_sidecar"
  }],
  "auditOutbox": {}
}
```

新しいSidecarが設定する `handling` は `charge|waive` とする。`未設定` へ戻す場合は `handling="unknown"` を保存せず、同じrevision列へ `{ "action": "clear", "handling": null }` を追記する。これにより履歴・CAS・監査を保ちながらactive settingだけを解除でき、将来施設既定値を導入しても旧 `inherit` の意味と混同しない。契約IDは組織・施設・患者・charge typeから決定的に生成する。既存の `inherit|included_in_contract` set eventは読み取り互換を維持する。

### T2: 解決規則（1-4の一部を実装済み）

1. canonical patientが未解決なら `patient_not_linked`、自動請求しない。
2. 診療日に有効な患者契約を取得する。
3. 患者契約が `waive` / legacy `included_in_contract` なら、患者への交通費の別請求対象外であるhandlingを返す。会計金額はまだ生成しないため `amountYen` は `null` のままとする。
4. `charge + amountMode=actual + 金額未入力` は `pending_actual` とし、自動請求しない。同意判定は未実装である。
5. 有効契約がないか最新有効eventがclearなら `setting_not_configured` とする。施設方針の解決は未実装であり、legacy `inherit` も `facility_default_not_configured` となる。
6. 将来: 算定時の契約/policy revisionをdraft/sessionへsnapshotし、後日の契約変更で過去会計を無言で変えない。
7. 将来: Sidecar draft adoptionでcanonical patientが確定した場合は再解決し、差分を明示してから採用する。

fail-closed時も保険算定やUKE出力は止めず、患者向け会計の交通費確定だけを保留する。

### T3: APIと権限

- 実装済み: `PUT /v1/integrations/sidecar/drafts/:sidecarDraftId/patient-charge-setting`
- 未実装: fee-web向け患者契約GET/更新API
- 未実装: `POST /v1/fee/sessions/:sessionId/patient-charges/:chargeId/finalize`

通常の契約管理・撤回はfee admin、訪問後の実費確定はfee write権限とする。Sidecarは任意の患者IDを指定させず、現在のdraftに解決済みのcanonical patientへだけ患者設定を保存する。Sidecar grantには患者負担設定専用write scopeを追加し、draftの施設・診療科scope、患者連携、患者契約の `expectedRevision`、表示draftの `expectedSourceRevision` / `expectedCalculationRevision`、idempotency、actor/device監査を必須にする。handlerとtransactionの両方でrevisionを照合し、患者未連携、scope外、または契約・draftのいずれかが古い場合は保存しない。

現行のSidecar role方針では、`admin`、`doctor`、`nurse`、`medical_clerk` の全roleに患者負担設定専用write scopeを発行し、grantされたfacility/department scope内に限ってhandling更新を許可する。契約文書、金額、適用期間は更新できない。handling更新もroleをさらに限定する必要がある場合は、施設運用と責任分界を確定した後に別途role policyを狭める。

Sidecarが更新できるのは `charge`、`waive`、または設定解除だけである。適用開始日はdraftの診療日に固定し、終了日は設定しない。`charge` は `amountMode=actual`・金額未確定に固定する。解除はAPIへ `clear=true` を送り、revision付きtombstone eventを追記する。直接APIを呼んでも固定金額、任意の開始日・終了日を指定できず、金額確定や過去履歴の訂正は将来のfee-web/APIへ分離する。

Sidecarの5分access tokenはextensionのメモリ内だけに保持し、失効30秒前までは算定・確認状態更新・患者負担設定で再利用する。期限近接時のrefreshは同一grantにつきsingle-flightとし、access tokenとproof verifierは `chrome.storage` へ保存しない。切断中に開始済みrefreshが完了しても、generation照合で認証状態を復活させない。

### T4: responseとUI（Sidecarのみ実装済み）

Sidecar responseへ点数候補とは別の `patientCharges[]` を追加する。

```json
{
  "chargeType": "home_medical_transport",
  "status": "pending_actual",
  "amountYen": null,
  "handling": "charge",
  "billingHandling": "unknown",
  "revision": 1,
  "includedInInsurancePoints": false,
  "includedInUke": false
}
```

- fee-web患者設定は未実装である。将来は適用期間、同意状態、文書参照、履歴、一括管理を担う。
- Sidecar: 点数候補とは別の「患者負担」1行にドロップダウンを置き、`未設定 / 請求する / 請求しない` だけを患者別に設定する。
- 有効な患者設定がない場合は `未設定` とし、選択・保存までは請求へ含めない。既存設定から未設定へ戻す場合は「設定解除」としてclear eventを保存する。`未設定` を0円や請求なしへ変換しない。
- legacy `inherit` は未設定へ、legacy `included_in_contract` は請求しないへ表示投影するが、DB値は自動変換しない。
- `請求する` で金額未確定なら `実費入力待ち`、患者未連携ならドロップダウンを無効化して `患者連携後に設定` と表示する。
- Sidecarで保存した値は契約DBのrevisionとなり、現在draftの `patientCharges[]` と次回以降のSidecar算定で参照する。fee-web参照は未実装である。
- `decisionCandidateCount`、要確認/区分確認、保険点数の候補へ混ぜない。
- Sidecarで許可するのは患者ごとのhandling設定までとし、契約文書管理・過去履歴の訂正・一括操作はfee-webに残す。実費金額をSidecarで確定するかは施設運用決定後の追加範囲とする。

### T5: 会計分離

- 実装済み: `patientCharges[]` を保険候補から分離し、`totalPoints`とUKE/レセ電を不変にする。
- 未実装: `patientChargeTotalYen`、`patientAmountDueYen`、会計・領収証の別明細。
- 将来も `charge + 必要な同意済み + 金額確定` の場合だけ患者請求へ加算する。

### T6: 監査とテスト

今回実装した監査event:

- `fee.patient_charge_contract_updated`

監査payloadには患者名や文書本文を含めず、ID、charge type、旧/新handling、有効期間、revision、金額mode/value、actor/deviceだけを記録する。契約保存とaudit outboxは同じtransactionで永続化し、決定的event IDによる送信成功後にoutboxから除去する。

確認状態または患者負担設定の業務DB transactionが成功した後に外部監査配送だけが失敗した場合、更新APIは更新済みの状態を200で返す。監査失敗は構造化warningへ記録し、未配送eventはoutboxへ残して次回の同一・関連PUTで冪等再送する。revision競合、事前検証失敗、業務DB transaction失敗は従来どおり成功扱いにしない。

ただし、独立したoutbox drainは未実装である。現在の再送は、同一のidempotent requestまたは関連する患者負担設定requestが後から到着した場合の再試行に依存するため、外部監査基盤への即時・保証配送までは成立していない。定期実行するCloud Schedulerは不要だが、保証配送を要件にする場合は、将来Cloud Tasks、Firestore trigger等のevent駆動dispatcher、または同等のqueue/workerを追加する。

今回実装した受入テスト:

- 患者別handlingの新規保存、revision競合、同一requestのidempotent retry
- 既存handlingから未設定へ戻すclear event、revision保持、同一clear再送、監査 `beforeHandling -> null`
- canonical patient未解決、施設・診療科scope、draft採用済み・期限切れの拒否
- home visit / house callの適用範囲
- 固定金額、任意の適用開始・終了日のSidecar経由更新拒否
- 保険点数と点数候補が不変で、UKE/レセ電へ含めない境界
- transaction内TOCTOU再検証、監査outboxとidempotent再送
- 業務DB更新後の監査一時障害で200を返し、outboxを残して次回drainすること
- 保存中のタブ切替、元カルテ復帰、二重送信防止
- 確認状態の保存中は同じdraftの再計算を止め、複数候補の保存完了後に再計算を再開すること
- 候補判断の `要確認/区分確認 -> 確認済み -> 対象外 -> 要確認/区分確認` サイクル、明示statusのDB保存、既存boolean API互換、source/fingerprint変更時のstale化

将来フェーズの受入条件:

- 施設方針、患者override、有効日境界、契約重複拒否
- 同意未確認・撤回、実費確定、請求、免除、契約内包
- canonical patient未解決からadopt後の再解決
- 自己負担会計、領収証の別明細と訂正
- action-list mutationで交通費解決結果が変わらないことの専用評価

## 4. B1実装前のタブ切替挙動

修正前の実装はSide Panelから同期POSTを行っていた。`sw.js` は現在もSide Panelを開く設定だけで、算定処理やjob管理をしていない。

修正前は、タブ切替時に `tabs.onActivated` が `scheduleAutoRead({ invalidate: true })` を呼び、`resetChartState()` がpreviewと表示結果を消していた。API request自体は停止していなかったが、response受信後の表示カルテ照合に失敗し、成功結果を捨てていた。このため利用者には「処理が止まった」ように見えていた。

B1では表示状態と実行中taskを分離した。実行中taskは1件だけを管理して並行算定を開始させず、完了taskは `tab + patient + record` をkeyにした最大20件のMapへ保持する。DOM再検証完了後のFee API requestはタブ切替後も継続する。算定開始時のpreview fingerprintと、受診区分・同一建物区分を含む入力snapshotもtaskへ固定する。別患者には完了結果や交通費保存エラーを表示せず、元カルテへ戻って再読取が一致した場合だけ、入力snapshot、完了結果、交通費保存エラーを復元する。

## 5. 処理継続の実装フェーズ

B1は2026-08-03に実装済みである。B2は未決のまま分離する。

### B1: タブ切替だけを継続する最小修正

最初はSide Panelが開いている間のタブ切替だけを対象にする。

1. 算定クリック時に `sourceTabId`、患者ID、record ID、preview fingerprint、受診区分・同一建物区分等の入力snapshotを固定する。
2. DOM再検証完了前のタブ/カルテ変更は従来どおりfail closedにする。
3. DOM検証完了後は、`tabs.onActivated` が実行中API taskを無効化しない。
4. 表示previewのgenerationと `inFlightCalculation` のgenerationを分離する。
5. 実行中taskは1件に限定する。完了taskは `tab + patient + record` keyのMapで最大20件を保持し、別カルテのtask開始で元カルテの完了結果を消さない。
6. Fee API responseの患者・診療日・record IDをtask identityと照合し、不一致ならfail closedにして表示しない。
7. 現在表示中の患者が異なる場合は完了結果本文や交通費保存エラーを表示しない。
8. 元カルテへ戻ったときだけ、そのtaskの入力snapshot、完了結果、または交通費保存エラーを再表示する。
9. 交通費handlingまたは確認状態の保存中は同じカルテの再算定を開始させず、算定中も交通費保存を開始させない。タブ切替中に交通費保存が失敗した場合も、エラーを元taskへ保持して復帰時に表示する。
10. このフェーズではService Worker、サーバAPI、PHIの永続化を増やさない。

受入テストは、算定中タブ切替、切替後成功、元タブ復帰、入力snapshot復元、response identity不一致のfail closed、抽出中切替のfail closed、複数カルテtaskの保持、交通費・確認状態保存との排他、別患者への誤表示0件を含める。

B1でカルテ別に復元するのは成功した算定結果と交通費保存エラーである。算定API自体が失敗したtaskの履歴復元、およびPanel閉鎖後の復旧は今回の対象に含めない。

### B2: Side Panel閉鎖・再読込後も復旧する

Panel閉鎖後まで継続・復旧するなら、B1とは別のサーバージョブ化が必要である。

- 通常fee-webの既存 `calculation-jobs` パターンをSidecar draftへ拡張する。
- POSTは `202 Accepted` と `sidecarDraftId` / `calculationJobId` を返し、Fee API/workerが処理状態の正本になる。
- Sidecar用のjob status/detail取得APIを追加し、Panel再表示時に復旧する。
- Service Workerまたは `chrome.storage.session` にはjob/draft ID、元tab ID、状態だけを置き、カルテ本文、病名、tokenは保存しない。
- 完了通知から詳細を開く場合も、現在カルテと元患者・record IDが一致するまでPHIを表示しない。

**Cloud Schedulerは不要である。** 必要なのはユーザー操作で作成された永続jobをqueue/workerで処理し、IDから復旧する仕組みであり、定期実行ではない。Service Workerを長時間処理の正本にも使わない。

## 6. 実装順

1. 完了: 患者契約storeとdraft-scoped API。
2. 完了: Sidecarの未設定ドロップダウン、保存、response再描画。
3. 完了: 点数・UKE分離、患者契約と表示draftのrevision競合、draft TOCTOU、監査outbox再送のテスト。
4. 完了: B1の単一実行taskと最大20件の完了task Map、入力snapshot復元、response identity照合、交通費保存との排他と元カルテでのエラー復元。
5. 未着手: 交通費の対象範囲・金額・同意運用を施設と確認し、fee-webと金額確定フローを追加する。
6. 未着手: Panel閉鎖後の復旧が必要と確認できた場合だけB2を実装する。

### 6.1 2026-08-03 22:16の保存障害

PROD request logでは、Platform API `POST /v1/auth/sidecar-token` が22:16:30、22:16:43、22:16:52 JSTに429を返していた。修正前のextensionは5分access tokenを持っていてもFee API操作ごとにtokenを再発行しており、同一deviceの既定上限10回/5分へ到達していた。Fee APIの確認状態・患者負担設定用rate limitが原因ではない。

429の直前には、確認状態PUTと患者負担設定PUTの409も記録されていた。同じdraftの再計算で `calculationRevision` が進んだ後、古い表示revisionから保存したためである。対策として、確認状態保存中のローカル再計算を無効化する。別端末・別Panel更新による本物の競合はblind retryせず、厳格なrevision/CAS照合と再計算案内を維持する。

この障害修正で変更するruntimeはFee APIとSidecar extensionであり、Platform APIのrate limitやtoken発行処理は変更しない。患者負担write scopeを発行するPlatform APIが既にデプロイ済みなら、この修正のためのPlatform API再デプロイは不要である。

デプロイ順は `platform-api` → `fee-api` → Sidecar extensionとする。Platform APIが専用scopeを発行するため、`fee-api`だけのデプロイでは不十分である。既存grantも次回API呼出時のrefreshで新scopeを含むtokenを取得するため、grantの一括再発行は不要である。

`fee_patient_charge_contracts` は最初の保存時にlazy作成され、既存docのschema migrationやbackfillは不要である。単一docの直接取得・transactionだけを使うためFirestore複合indexも不要で、Cloud Schedulerも追加しない。監査outboxの保証配送が必要になった場合は、Schedulerではなくevent駆動のCloud Tasks等を別途設計する。

## 7. 根拠

- `docs/implplan/fee-universal-act-coverage-workorder-20260729.md`
- `docs/implplan/fee-mock-act-gap-analysis-and-features-20260730.md`
- `docs/implplan/homis-sidecar-extension-build-workorder-20260718.md`
- `docs/20260718-homis-sidecar-extension-implementation.md`
- `docs/implplan/homis-sidecar-extension-plan-20260718.md`
- `docs/fee-calculation-current-flow-2026-06-15.md`
- `clients/homis-sidecar/extension/sidepanel.js`
- `clients/homis-sidecar/extension/lib/api.js`
- `clients/homis-sidecar/extension/sw.js`
- `services/fee-api/src/encounter-variants.js`
