# HOMIS Sidecar 管理料区分 13/13 exact 化ワークオーダー

- 作成日: 2026-08-03
- status: local core verification complete / STG selector verification and full browser-to-Fee API E2E pending
- 対象: `clients/homis-sidecar`、`services/fee-api`、mock HOMIS 評価ハーネス
- 目的: 現行の令和8年度 `sidecar-selection-axes` artifactを変えず、正当なHOMIS入力を補完して、mock 13患者の在医総管・施医総管を `13/13` で正しい1コードへ絞る。

## 1. 確定事項

1. HOMISの「行為」欄は正解データであり、runtimeの算定入力には使わない。
2. 行為欄を読んでコードを転記する実装、患者ID別ルール、mock専用分岐は禁止する。
3. 行為欄は算定終了後のoffline評価でのみ読む。
4. 詳細区分の成功は「正解コードが候補集合に含まれる」ではなく、`selectionResolution=exact`、`remainingOptionCount=1`、かつ残ったコードが正解であることとする。
5. `exact` は区分の一意化であり、算定可否の確定ではない。既存の `candidateOnly`、`review_required`、点数合計への非算入を維持する。
6. artifactは現行の `services/fee-api/src/fee-rule-data/sidecar-selection-axes-2026.generated.json` をそのまま実行する。修正対象はruntime contextの取得、完全性判定、集約と配線である。

## 2. 現状

修正前のChrome拡張DOM経路では、対象13患者の詳細区分は `0/13 exact` だった。v6の可視受診履歴・病名面・出典付きselection contextを実装した後は、fixture-drivenテストで同じartifactから以下の `13/13 exact` に一意化できる。したがって主因はマスター不足ではなく、context生成の不足だった。

| 患者ID | 期待コード | 点数 | 区分 |
| --- | --- | ---: | --- |
| 1001 / 1008 / 1009 / 1012 | `114031010` | 4,485 | 在医総管・機能強化型在支診等・病床有・月2回以上・1人・通常 |
| 1003 / 1005 | `114031310` | 2,745 | 在医総管・機能強化型在支診等・病床有・月1回・1人・通常 |
| 1006 / 1007 / 1013 | `114030710` | 5,385 | 在医総管・機能強化型在支診等・病床有・難病等・月2回以上・1人 |
| 1002 / 1004 / 1010 / 1011 | `114035610` | 3,225 | 施医総管・機能強化型在支診等・病床有・難病等・月2回以上・2～9人 |

この表は評価用goldであり、runtimeコードやrequest fixtureへ埋め込まない。

### 2.1 gold訂正(2026-08-03)

当初表では1010を一般区分 `114035910` としていたが、令和8年度「特掲診療料の施設基準等」別表第八の二は、在宅成分栄養経管栄養法を行っている状態、およびドレーンチューブ又は留置カテーテルを使用している状態をC002/C002-2の対象状態としている。1010は構造化機器面とSOAPの双方に経鼻経管栄養・膀胱留置カテーテルの継続使用があるため、正解を難病等区分 `114035610` へ訂正した。

- 一次資料: https://www.mhlw.go.jp/web/t_doc?dataId=84aa9733&dataType=0 (別表第八の二)
- 訂正はoffline goldのみで、runtimeが行為欄を参照しない原則は変えない。

### 2.2 修正前に確認した不足

| 軸 | 現状 | 問題 |
| --- | --- | --- |
| 施設類型・病床 | 施設設定キー `3055` / `3057` から取得済み | 現行mock施設では利用可能 |
| 単一建物診療患者数 | 正の明示値だけを採用 | 個人宅画面では0が非表示のため `null` になり、1人へ絞れない |
| 当月訪問回数 | 当月の過去fee sessionを種類に関係なく加算 | 電話再診、外来、往診まで定期訪問回数へ混入し得る。1003は電話再診を除くと月1回 |
| 情報通信機器 | 現在受診の `setting` だけで判定 | 月内の対面・情報通信機器の構成を表せない |
| 厚生労働大臣が定める疾病等 | 常に `unknown` | HOMISの構造化病名面を読んでおらず、通常/難病等の2候補が残る |
| 減算・注8/注14 | context未配線 | 今回13患者では他軸で一意化できるが、将来の候補集合では未確定を維持する必要がある |

`calendarVisitDates` は取得済みだが日付しか持たず、定期訪問、電話再診、外来、往診を区別できない。日付数をそのまま管理料の訪問回数として使ってはならない。

## 3. 入力境界

### 3.1 許可する入力

- 表示中カルテの患者ID、record ID、診療日、受診区分、居住区分、単一建物人数
- HOMISの病名画面にある構造化病名、状態、有効期間
- HOMISの診療予定・受診履歴にある日付、受診種別、状態
- 施設の有効な届出・施設基準設定
- 現在および過去のSidecar draft/sessionに保存済みの、出典付き構造化事実
- 令和8年度一次資料から生成し、版・checksumを固定した疾病等判定artifact

### 3.2 禁止する入力

- `#action_list`、`.koui-area`、`.koui-item` とその子孫
- 行為欄のテキスト、コード、点数、DOM有無、件数、hash
- offline evaluatorが作る `expectedCode`、`actionList`、goldラベル
- 患者ID、氏名、特定SOAP文言に対応した答えのハードコード
- LLMの推測だけで作った `not_eligible`、人数1、月1回などの否定的事実

## 4. 実装チケット

### MS0: gold firewallと正確性指標

- runtime extraction、API request、source proofのdenylistテストに行為欄selectorを固定する。
- 行為欄の内容を別の正解コード、空文字、ランダム文字列へ変えても、算定request hash、source revision、算定結果が変わらないmutation testを追加する。
- evaluatorは算定responseを保存した後で初めて行為欄を読み、照合する。
- 指標を追加する。
  - `selectionExactMatchRate`
  - `wrongExactCount`
  - `ambiguousCount`
  - `contextIncompleteCount`
  - `methodology.actionListUsedAsCalculationInput=false`
- 候補集合内に正解があるだけの状態をexactへ数えない。

### MS1: 出典付きselection context契約

contextの各値を裸のscalarで渡さず、値、状態、出典、観測時刻、source revisionを持たせる。

```json
{
  "singleBuildingPatientCount": {
    "value": 1,
    "status": "known",
    "source": "screen.privateResidence+screen.sameBuilding",
    "observedAt": "2026-08-03T00:00:00Z"
  },
  "qualifyingMonthlyVisits": {
    "value": 1,
    "status": "complete",
    "source": "homis.encounterHistory",
    "sourceRevision": "sha256:..."
  }
}
```

- 状態は最低でも `known|unknown|unavailable|conflict`、集合は `complete|incomplete|unavailable` を区別する。
- 値が同じでも出典や完全性が変わればsource revisionを更新し、過去の確認済み状態を失効させる。
- `unknown` を `false` や0へ正規化しない。

### MS2: 個人宅の1人判定

優先順位を次のように固定する。

1. 画面に正の `singleBuildingPatientCount` が明示されていれば採用する。
2. 明示値がなく、構造化DOMで `privateResidence=true` かつ `sameBuilding=false` が同一source revisionから確認できる場合だけ1人を導出する。
3. `sameBuilding=true` だが人数不明、居住区分不明、値が矛盾する場合は `unknown` とする。

raw値は上書きせず、導出値と根拠を別フィールドに残す。患者IDや「個人宅なら常に1」の無条件defaultは禁止する。

### MS3: 種別付き月内受診集約

- 日付だけの `calendarVisitDates` を `currentMonthEncounterCount` の正本にしない。
- HOMISの診療予定・受診履歴面、または保存済みSidecar履歴から、少なくとも `serviceDate`、`setting/visitKind`、`status`、`sourceRecordId` を持つ受診行を取得する。
- 同一患者、施設、対象月、同一recordをdedupして集約する。
- C002/C002-2の回数に含める受診種別は一次資料に基づく版管理ルールにする。電話再診、外来、臨時往診を単純に定期訪問回数へ加算しない。
- カレンダーに存在する全日付の種別を確認できない場合は `incomplete` とし、回数軸を適用しない。
- 1003では電話再診を除外し、管理料対象の定期訪問を1回として扱う回帰テストを置く。

単発カルテしか取得できず当月履歴の完全性を証明できない場合、月1回へ推測してexactにしてはならない。

実装では `homis-mock-v6` の診療予定画面に表示される「当月受診履歴」を正本とする。画面の可視4列（診療日、受診種別、状態、カルテID）だけを読み、hidden `data-*` や行為欄は使わない。可視の「全件表示」マーカーが完全一致し、全行が完了済みでrecord IDを持ち、追加ページがなく、当月カレンダーの実カルテ日集合と履歴日集合が一致した場合だけ `complete` とする。予約日のchipは `schedule_only/incomplete` であり、exactの根拠にしない。電話再診、外来、往診を除いた `home_visit` のみを、表示カルテの診療日以前について集計する。同じ日に異なるrecord IDが複数ある場合は日付へ縮約せず、現行ルールでは回数を確定できないため `incomplete` としてfail closedにする。

### MS4: 病名面とC002/C002-2疾病等artifact

- authenticated same-origin fetchでHOMIS病名画面を取得し、`problems` source surfaceを追加する。
- 患者ID一致、selector contract、timeout、unavailable reason、proof sealを既存の書類面と同じ契約で実装する。
- 病名は名称だけでなく、状態、有効期間、疑い、転帰が画面にあれば構造化して保持する。
- `homis-mock-v6` を追加し、旧v5では疾病等を `unknown` のままfail closedにする。
- C002/C002-2専用の疾病等artifactを一次資料から生成する。別制度向け疾病表を流用しない。
- resolverは `eligible|not_eligible|unknown` と、該当根拠、artifact revisionを返す。
- `eligible` は有効な陽性根拠がある場合だけ確定する。
- `not_eligible` は病名面が完全で、対象病名・状態・治療/機器条件のいずれにも該当しないことを決定論で確認できる場合だけ確定する。SOAPに記載がないことやLLM出力だけでは確定しない。
- 病名一覧と疾病等・状態管理一覧の双方に可視の「全件表示」マーカーが完全一致し、追加ページがない場合だけnegative proofへ使える `complete` とする。実HOMISに同等の表示根拠がなければ `unknown` のままにする。
- 1つの適用条件が病名面と状態管理面に分かれる複合条件は、両surfaceの陽性語をまとめて照合する。単一行・単一面だけで全条件が揃うことを要求しない。
- 疾病等区分が点数表上適用される月2回以上の分岐でだけselection filterへ使用する。月1回の1003は疾病等に該当していても月1回コードを選び、artifactとのcontext conflictにしない。

### MS5: narrowingへの配線

- `countCurrentMonthEncounters` を管理料選択には使わず、MS3の `qualifyingMonthlyVisits` を使う。
- MS2の導出人数、MS4の疾病等status、施設設定、診療方法を `sidecarSelectionContext` へ配線する。
- `appliedFilters` にvalueだけでなくsource、completeness、artifact revisionを返す。
- クライアント申告のsurface hashはFee APIで正規化rawから再計算し、一致しないrequestを保存前に拒否する。source revisionは検証済みhashだけから構成する。
- contextと候補集合が矛盾した場合は既存どおり `selection_context_conflict` でfail closedにする。
- 減算、注8/注14、月内の情報通信機器併用も、信頼できる構造化根拠が得られた場合だけ同じ3値契約でfilterできるようにする。今回の13件を通すために一律 `false` は設定しない。
- exactになっても `billingEligibility=review_required`、`candidateOnly=true` を維持する。

### MS6: リリース受入用13患者E2E

- mockを患者ごと・時系列順に実行し、対象月の履歴を構築した後に管理料区分を再計算する。
- direct evaluator payloadだけでなく、mock DOM、content script、Side Panel、Fee APIを通るChrome拡張経路を必須にする。
- 同じ入力を2回以上実行し、コード、applied filters、source revisionが決定的であることを確認する。
- 13患者すべてで上表と一致し、`wrongExactCount=0`、`ambiguousCount=0`、`contextIncompleteCount=0` とする。
- 病名面・履歴面を意図的に取得不能にしたfixtureではexactにならないことを確認する。

### MS7: rollout

1. contract unit testsとartifact `--check`。
2. extension contract/integration tests。
3. Fee API selection、candidate-only、revision invalidation tests。
4. mock 13患者E2Eをrepeat 2以上で実行。
5. STGの実HOMIS selectorで病名・履歴面の完全性を確認。
6. STG 13/13のartifact revision、request/source hash、applied filtersを保存。
7. wrong exactが0であることを確認してからprodへ進む。

### 実装結果（2026-08-03）

- selector contractを `homis-mock-v6` へ更新した。v6では `problems` と `visitPlan` source surfaceを必須とし、旧v5から同名surfaceを送ってもvalidator/normalizerは選択根拠として採用しない。
- 個人宅1人の導出根拠revisionには、居住区分・同一建物区分を含むrequest全体の `sourceRevisionHash` を使う。selector contract versionもrevision hashへ含める。
- C002/C002-2疾病等artifactは、令和8年別表第八の二の直接疾病・状態と指定難病348件を版・checksum付きで固定した。未来開始病名、疑い、時点を証明できない病名はfail closedにする。
- `clients/homis-sidecar/test/management-selection-fixture.test.mjs` は13名のfixtureからカルテ・病名・書類・可視受診履歴HTMLをrenderし、実content script、contract、proof seal、fee-contract validator、structured facts、現行selection artifactのnarrowingまでを通す。テスト側に人数・訪問回数・病名・機器を転記せず、goldは最後のコード比較だけに使う。このテスト単体はSide PanelとFee API routeを通る単一E2Eではない。
- mockの病名一覧、当月受診履歴、疾病等・状態管理一覧は、それぞれが全件表示であることを可視マーカーで明示する。抽出側は対応するマーカーの完全一致と追加ページなしを確認できた面だけ `complete` とする。実HOMISに同等の表示根拠がなければ `incomplete` / `unknown` とし、非該当や月1回を断定しない。
- Fee APIは各v6 surfaceの正規化rawをcanonical JSONへ変換してhashを再計算し、クライアント申告hashとの不一致を400で拒否する。確認済み状態の失効に使うsource revisionへ、未検証hashを採用しない。
- C002/C002-2の複合条件は病名面と状態管理面を横断して照合する。同日異recordは1回へ縮約せず `incomplete` とする。両方に回帰テストを置いた。
- 再現コマンドは `npm run test:homis-sidecar-management-exactness`。事前に `clients/homis-sidecar` の依存とPlaywright Chromiumが導入済みであることを前提とする。
- ローカル結果は `exactMatchCount=13`、`wrongExactCount=0`、`ambiguousCount=0`、`contextIncompleteCount=0`、`selectionExactMatchRate=1`、`methodology.actionListUsedAsCalculationInput=false`。各患者の行為欄を別コード、空文字、無関係なランダム文字列へmutationしてもpreview fingerprint、request相当payload/hash、source revision、選択結果が変わらないことを確認した。
- 別のFee API route integration testで手書きのv6 surface 1症例が保存後の `sidecarSelectionContext` まで到達し、候補がexactになってもcandidate-onlyとreview-requiredを維持することを確認した。Side PanelからFee APIまで13症例を連続実行するMS6の単一E2Eは未実施であり、prod受入条件として残す。
- 残作業はMS6のSide Panel-to-Fee API 13症例E2Eと、STGの実HOMISで可視受診履歴4列、病名一覧、疾病等・状態管理一覧のselector・完全性・ページングを確認することである。実画面に同等の完全な面がなければ、その軸は `incomplete` / `unknown` のままにし、別の正規API/画面を追加するまでexactへ昇格しない。

### デプロイと移行順

1. C002 artifactの `--check`、extension/Fee APIテスト、13名fixture検証を実行する。
2. v6 selector contractを許可するFee APIをSTGへ先にデプロイする。
3. `npm run audit:homis-sidecar-v6-migration` を実行し、STGでv5入力の残存状況とv6受入状態を確認する。
4. v6 Sidecar extensionをSTGへ配布し、実HOMISの各一覧面と完全性判定を確認する。
5. 実HOMISで表示される別表第八の二の全状態表現をartifactへmappingできることを陽性fixtureで確認する。未収載の表現がある面を `complete` として扱わない。
6. MS6の単一E2EとSTG 13/13を満たすまでprodへ進めない。prodもFee APIを先、extensionを後にする。

## 5. 受入条件

以下はprodリリース条件である。ローカルでは13名のDOM-to-narrowing検証と分割したFee API統合テストまで完了しており、MS6の単一E2EとSTG実画面確認は未完了である。

- 現行selection artifactのpayload checksumが変更されていない。
- mock 13患者が上表のコードへ `13/13 exact` で一致する。
- 行為欄mutationでruntime request/responseが変わらない。
- 1003の電話再診が管理料の月内訪問回数へ混入しない。
- 不完全な病名一覧や月内履歴から `not_eligible`、月1回を推測しない。
- surface rawと申告hashが一致しないrequestを受理せず、同日異recordから回数を推測しない。
- 患者ID別・期待コード別のruntime分岐が0件である。mockの全件表示マーカーは患者別goldではなく、一覧完全性を証明するfixture契約としてのみ使う。
- exact候補が自動採用されず、保険点数合計へ入らない。
- 旧selector contractは壊さず、不足軸をunknownとして処理する。

## 6. 非目標

- 行為欄とのruntime同期
- 正解コードの自動採用・請求確定
- SOAP自由記載だけによる疾病等の否定判定
- 全患者への人数1、月1回、非該当のdefault
- 現行selection artifactをmock正解へ合わせて改変すること

## 7. 根拠

- selection source: `data/fee-rules/source/sidecar-selection-axes-2026.json`
- narrowing: `services/fee-api/src/sidecar-selection-narrowing.js`
- current context: `services/fee-api/src/server.js` の `countCurrentMonthEncounters` / `applySidecarSelectionContextToPreparation`
- screen contract: `clients/homis-sidecar/extension/lib/contract.js`
- supplemental fetch: `clients/homis-sidecar/extension/content.js`
- mock gold boundary: `tmp/mock_homis/data/patients.py`
- official R8 source index: https://www.mhlw.go.jp/stf/newpage_67729.html
- current C002/C002-2 table: https://www.mhlw.go.jp/web/t_doc?dataId=84aa9729&dataType=0&pageNo=7
