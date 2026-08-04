# HOMIS Sidecar 管理料区分 13/13 exact 化ワークオーダー

- 作成日: 2026-08-03
- status: homis-mock-v7 implemented / verification and 13-patient remeasurement pending
- 対象: `clients/homis-sidecar`、`services/fee-api`、mock HOMIS 評価ハーネス
- 目的: 現行の令和8年度 `sidecar-selection-axes` artifactを変えず、正当なHOMIS入力を補完して、mock 13患者の在医総管・施医総管を `13/13` で正しい1コードへ絞る。

> **2026-08-04 訂正:** 新旧mockで変更してよいのは合成日付・患者データだけであり、
> DOM、画面項目、CSS、クライアント挙動は旧mockに合わせる。2026-08-03に追加した
> 完全性マーカーと当月受診履歴テーブル、およびそれらを使った `13/13 exact` の結果は
> この制約に違反するため受入証跡から取り消した。13患者の再測定結果は本書では未確定とする。

## 1. 確定事項

1. HOMISの「行為」欄は正解データであり、runtimeの算定入力には使わない。
2. 行為欄を読んでコードを転記する実装、患者ID別ルール、mock専用分岐は禁止する。
3. 行為欄は算定終了後のoffline評価でのみ読む。
4. 詳細区分の成功は「正解コードが候補集合に含まれる」ではなく、`selectionResolution=exact`、`remainingOptionCount=1`、かつ残ったコードが正解であることとする。
5. `exact` は区分の一意化であり、算定可否の確定ではない。既存の `candidateOnly`、`review_required`、点数合計への非算入を維持する。
6. artifactは現行の `services/fee-api/src/fee-rule-data/sidecar-selection-axes-2026.generated.json` をそのまま実行する。修正対象はruntime contextの取得、完全性判定、集約と配線である。

## 2. 現状

2026-08-03にはmockへ可視受診履歴と完全性マーカーを追加したfixture-drivenテストで
`13/13 exact` を得たが、mock DOMを変更していたため結果を無効化した。2026-08-04に
新mockのDOM生成コードとCSSを旧mockへ戻した。以下はoffline評価用goldであり、現行の
旧DOM互換mockに対する達成結果を表すものではない。

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

### 2.3 旧DOM調査で確認した不足（2026-08-04）

旧mockのDOMには、今回追加していた完全性マーカーと当月受診履歴テーブルが存在しない。
この構造が正本であり、新mockにも同じ制約を適用する。

- カレンダーには診療日があるが、一覧上では定期訪問、電話再診、外来、往診を区別できない。日付数を定期訪問回数へ直接変換してはならない。
- 病名一覧と在宅医療機器欄に「全件表示」を示す専用マーカーはない。マーカーをmockだけへ追加してnegative proofを作ってはならない。
- 旧mockは2025年1月、新mockは同じ患者データを令和8年度へ日付shiftしたものなので、制度artifactの適用可否は診療日によって変わる。

新データと旧DOMを組み合わせた13患者の判定結果は、評価担当者が別途測定する。本書では
件数や達成率を先取りして記録しない。行為欄は引き続きruntime入力に使用しない。

### 2.4 AS-IS / TO-BE（2026-08-04合意）

#### AS-IS（v7導入前）

v7導入前のSidecarがカルテ本文としてruntime抽出していたのは、HOMISで表示中の1カルテである。
病名、書類、診療予定は補助画面から取得するが、HOMISの「前のカルテ／次のカルテ」を
巡回して対象月の実績カルテを収集してはいない。

Fee APIは過去のfee sessionとSidecar draftを参照する。しかし、既存の
`countCurrentMonthEncounters` は同月sessionを受診種別に関係なく数えるため、電話再診、
外来、往診をC002/C002-2の定期訪問回数へ混入させ得る。この件数は管理料区分の
`qualifyingMonthlyVisits` の正本にしない。現行の管理料narrowingが使うのは
`structuredSourceFacts.selection.qualifyingMonthlyVisits` であり、診療予定面だけから作った
`basis=schedule_only` は完全な実績履歴ではないため `incomplete` になる。

疾病等判定は、有効な病名・状態・機器の陽性根拠があれば、一覧の完全性が不明でも
`eligible` にできる。一方、該当語が見つからないことだけでは非該当を証明できず、病名面と
状態管理面の両方がcompleteでない限り `not_eligible` にできない。旧DOMにはその全件性を
直接示す専用マーカーがない。

#### TO-BE（v7で実装）

1. 表示中カルテの患者ID、record ID、診療日、受診種別とsource fingerprintを固定する。
2. Fee APIは、v7の現在カルテにある完全なカレンダーと日付集合が一致する場合だけ、現在および
   過去のSidecar sessionを当月履歴として再利用する。同一患者・施設・対象月、record ID、
   DOM由来受診種別を満たさない行や、保存件数だけから完全性を推測した値は使わない。
3. Sidecarは算定準備時にHOMISカレンダーの対象月について既存の「前のカルテ／次のカルテ」を
   巡回する。開始位置が月途中でも取りこぼさないよう、新しい方向の境界を確認してから古い方向へ
   対象月を通過するまで走査する。Fee APIのDB履歴fallbackはこのDOM巡回とは独立して照合する。
4. 各カルテから許可された患者ID、record ID、診療日、受診種別だけを収集し、record IDで
   dedupする。電話再診、外来、臨時往診は定期訪問回数へ含めない。
5. カレンダーと巡回結果を照合し、対象月の履歴が完全と証明できた場合だけ
   `basis=encounter_history`、`listCompleteness=complete` として
   `qualifyingMonthlyVisits` を生成する。
6. 巡回後は元のrecordへ戻し、患者ID、record ID、診療日、fingerprintが開始時と一致することを
   再確認する。復元後の表示中カルテから通常の算定snapshotを改めて作る。
7. 月1回なら疾病等軸を適用せず月1回区分へ絞る。月2回以上では、陽性根拠を自動採用し、
   安全なnegative proofがある場合だけ通常区分へ絞る。それ以外は `unknown` とし、将来の
   手動補完対象にする。

カルテ巡回では、mock専用の `window.KARTE_HTML`、`window.KARTE_DATES`、患者fixtureへ
アクセスしない。実HOMISにも存在する日めくり操作と可視DOMだけを使う。また、現在・過去を
問わず `#action_list`、`.koui-area`、`.koui-item` とその子孫は抽出、完全性判定、hash、
停止条件のすべてから除外する。

### 2.5 exactの停止条件

次のいずれかが発生した場合は当月履歴を `incomplete` または `conflict` とし、区分を
一意化しない。

- 巡回中に患者IDが変わる、record IDまたは診療日を取得できない、並び順が逆転する
- 画面遷移のtimeout、同一recordでの予期しない停止、巡回上限超過
- カレンダーにある日付を履歴で説明できない、または履歴のrecordをカレンダーと照合できない
- 同一record IDに異なる内容がある、同一日複数recordの全件性を証明できない
- 表示中カルテを開始時のrecordへ復元できない、または復元後fingerprintが一致しない
- DB履歴と新規DOM抽出で受診種別、状態、患者、施設、対象月が矛盾する
- 実HOMISの画面契約で「カルテが存在すること=実施済み」を保証できない
- selector contractが未対応、または対象年度の制度artifactが存在しない

巡回開始後に利用者がカルテを操作した場合も競合として中断する。巡回のためのDOM mutationと
通常の自動再読取を分離し、途中カルテを別の算定requestとして送らない。件数が1件に見える、
病名が見つからない、またはtimeoutしたことを理由に月1回・非該当へdefaultしない。

### 2.6 疾病等のnegative proofと手動補完

自動判定の優先順位を次のように固定する。

1. 診療日時点で有効な対象疾病・状態・機器の陽性根拠がある場合は `eligible`。
2. 実HOMISの版管理された画面/API契約により病名面と状態管理面の全件性が証明され、対象根拠が
   ない場合は `not_eligible`。
3. 全件性を証明できない場合は `unknown` とする。将来の手動補完では、Sidecarで人が「対象／対象外／未確認」を選ぶ。

v7で実装済みなのは上記1と2、およびcompleteでなければ `unknown` に戻す境界である。疾病等軸の
手動確認保存は未実装で、将来実装する場合は患者・施設・対象月、判断値、actor、判断日時、
根拠artifact revision、確認時の病名面・状態管理面source revisionをFee APIへ保存する。
病名、機器、対象月、selector contract、artifact revisionのいずれかが変わった場合はstaleにし、
新しい陽性根拠と手動の `対象外` が衝突した場合は陽性根拠を優先する。手動確認を追加しても
既存のcandidate-only/review-required境界は維持する。

### 2.7 旧2025年mockのartifact要件

旧mockの診療日は2025年1月であり、令和8年度C002/C002-2疾病等artifactの適用開始前である。
現行2026 artifactを過去日へ遡及適用してexactにしてはならない。旧mockも制度日時点で判定する
場合は、2025年1月に適用可能なC002/C002-2疾病等artifactとselection artifactを別versionで
用意し、`serviceDate` により選択する。対応artifactがなければ `artifact_not_effective` として
fail closedにする。offlineの行為欄goldへ合わせるために現行artifactの有効期間を広げない。

## 3. 入力境界

### 3.1 許可する入力

- 表示中カルテの患者ID、record ID、診療日、受診区分、居住区分、単一建物人数
- HOMISの病名画面にある構造化病名、状態、有効期間
- HOMISの既存画面から確認できる診療予定と各カルテの診療日・受診種別・状態
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
- v7 Sidecarは可視カルテを日めくりし、少なくとも `serviceDate`、`setting/visitKind`、`status`、`sourceRecordId` を持つ受診行を作る。Fee APIは別経路として、カレンダーと完全一致する保存済みSidecar履歴だけをfallbackに使う。
- 同一患者、施設、対象月、同一recordをdedupして集約する。
- C002/C002-2の回数に含める受診種別は一次資料に基づく版管理ルールにする。電話再診、外来、臨時往診を単純に定期訪問回数へ加算しない。
- カレンダーに存在する全日付の種別を確認できない場合は `incomplete` とし、回数軸を適用しない。
- 1003では電話再診を除外し、管理料対象の定期訪問を1回として扱う回帰テストを置く。

単発カルテしか取得できず当月履歴の完全性を証明できない場合、月1回へ推測してexactにしてはならない。

mockへ新しい履歴表やhidden metadataを追加してはならない。旧DOMにあるカレンダーと
日めくり可能な各カルテから受診種別を取得するか、保存済みSidecar履歴など本番にも存在する
正規の情報源を使う。全件性を証明できない場合は `incomplete` としてfail closedにする。

### MS4: 病名面とC002/C002-2疾病等artifact

- authenticated same-origin fetchでHOMIS病名画面を取得し、`problems` source surfaceを追加する。
- 患者ID一致、selector contract、timeout、unavailable reason、proof sealを既存の書類面と同じ契約で実装する。
- 病名は名称だけでなく、状態、有効期間、疑い、転帰が画面にあれば構造化して保持する。
- 現行selector contractを `homis-mock-v7` とする。v7では `problems` と `visitPlan` を必須surfaceにし、旧v5では疾病等を `unknown` のままfail closedにする。v6はrollout互換として受理する。
- C002/C002-2専用の疾病等artifactを一次資料から生成する。別制度向け疾病表を流用しない。
- resolverは `eligible|not_eligible|unknown` と、該当根拠、artifact revisionを返す。
- `eligible` は有効な陽性根拠がある場合だけ確定する。
- `not_eligible` は病名面が完全で、対象病名・状態・治療/機器条件のいずれにも該当しないことを決定論で確認できる場合だけ確定する。SOAPに記載がないことやLLM出力だけでは確定しない。
- mock専用の「全件表示」マーカーは追加しない。既存画面仕様または正規APIから全件性を証明できる場合だけnegative proofへ使い、証明できなければ `unknown` のままにする。
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

### 実装結果（2026-08-04、`homis-mock-v7`）

- extensionの既定selector contractを `homis-mock-v7` へ更新した。v7は `currentChart`、`documents`、`problems`、`visitPlan` surfaceを送り、v6はrollout互換として受理する。旧v5の同名surfaceは疾病等・月内回数の選択根拠にしない。
- 算定準備時にSidecarが可視の「次のカルテ／前のカルテ」を新しい側から古い側へ最大100遷移まで巡回する。患者、record、診療日、時刻、受診種別を安定読取し、対象月と巡回方向から1月/12月の年境界を補正する。並び順、未知種別、同日複数record、timeout、境界不整合ではcompleteにしない。
- 巡回中は通常のカルテ変更通知を抑止する。終了時に元recordへ戻してidentityとpreview fingerprintを再検証し、復元できなければ算定を停止する。
- 巡回行がカレンダー日付集合と完全一致した場合だけ、既存の `visitPlan` surfaceを `basis=encounter_history`、`collectionMethod=chart_navigation`、`traversalComplete=true`、`calendarReconciled=true` で置き換える。巡回不能時は補助画面由来の `schedule_only/incomplete` を維持する。
- Fee contractsとFee APIは、v7のchart-navigation integrity fields、開始・復元record一致、surface hashを検証する。v7 requestでは復元・照合済みhistoryだけを `qualifyingMonthlyVisits` に採用し、`home_visit` だけを診療日以前の回数へ数える。v6は移行互換として従来契約を維持する。
- Fee APIの履歴fallbackは、v7の完全な現在カレンダーに対し、現在および過去のSidecar sessionから同一患者・施設・対象月、record IDあり、`encounterTypeSource=dom` の行だけを集約する。record競合、同日複数record、日付集合不一致では再利用せず、保存件数だけを回数へ変換しない。
- v7の病名面は、表が存在し全行を解析でき、追加ページがない場合にcompleteとする。状態管理面は明示的な「登録なし」、または空・読込中・エラーでない表示をcompleteとする。この全件性契約はmock provider向けであり、実HOMISへの適用はSTG確認を残す。
- 個人宅1人の導出根拠revisionには、居住区分・同一建物区分を含むrequest全体の `sourceRevisionHash` を使う。selector contract versionもrevision hashへ含める。
- C002/C002-2疾病等artifactは、令和8年別表第八の二の直接疾病・状態と指定難病348件を版・checksum付きで固定した。未来開始病名、疑い、時点を証明できない病名はfail closedにする。複合条件は病名面と状態管理面を横断して照合する。
- `prepare_homis_mock_v6.py` は日付shift用コマンド名として残るが、生成後のDOM、CSS、JavaScriptへ完全性マーカー、履歴表、hidden metadataを追加しない。v7 runtimeも `window.KARTE_HTML`、`window.KARTE_DATES`、行為欄を入力にしない。
- chart crawl・復元・未知種別・同日複数record、v7 integrity、DB履歴照合、行為欄mutation、candidate-only/review-required境界の回帰テストを追加した。
- 旧DOMを変更して得た `exactMatchCount=13` は無効のままである。Side PanelからFee APIまで13症例を連続実行するMS6とSTG再測定は未実施で、prod受入条件として残す。

### デプロイと移行順

1. C002 artifactの `--check`、extension/Fee APIテスト、mock DOM parity検証を実行する。
2. v7 selector contractを許可するFee APIをSTGへ先にデプロイする。
3. `npm run audit:homis-sidecar-v7-migration` を実行し、STGでv6以前のactive draft/sessionとv7受入状態を確認する。
4. v7 Sidecar extensionをSTGへ配布し、実HOMISの日めくり順序、完了状態、カレンダー、病名・状態管理面の全件性判定を確認する。
5. 実HOMISで表示される別表第八の二の全状態表現をartifactへmappingできることを陽性fixtureで確認する。未収載の表現がある面を `complete` として扱わない。
6. MS6の単一E2EとSTG 13/13を満たすまでprodへ進めない。prodもFee APIを先、extensionを後にする。

## 5. 受入条件

以下はprodリリース条件である。13名のDOM-to-narrowing再測定は未完了である。

- 現行selection artifactのpayload checksumが変更されていない。
- mock 13患者が上表のコードへ `13/13 exact` で一致する。
- 行為欄mutationでruntime request/responseが変わらない。
- 1003の電話再診が管理料の月内訪問回数へ混入しない。
- 不完全な病名一覧や月内履歴から `not_eligible`、月1回を推測しない。
- surface rawと申告hashが一致しないrequestを受理せず、同日異recordから回数を推測しない。
- 患者ID別・期待コード別のruntime分岐が0件であり、mock専用DOM・完全性マーカーを追加していない。
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

## 8. アーキテクチャレビューとリスク

| 重要度 | リスク | 対応 |
| --- | --- | --- |
| Critical | 実HOMISで「カルテが存在すること」が実施済みを意味する保証がない場合、予定・中止を実績として数え得る | STGで画面/APIの状態意味を確認し、版管理selector contractへ固定する。保証できない環境では月内回数を `incomplete` にする |
| Critical | カレンダーが予定日と実績日を混在させる場合、日付集合は完全性の正本にならない | 日めくり履歴の境界到達を全件性の主証拠にし、カレンダーは意味が確認済みの場合だけreconciliationへ使う |
| High | 同一日に電話再診と定期訪問など複数recordがあると、日付集合だけではrecord件数を証明できない | v7はカレンダー一致で巡回を早期終了せず月境界まで走査し、同日複数recordを `incomplete` にする。算入規則を確定するまで縮約しない |
| High | 巡回中のDOM mutationが自動読取や利用者操作と競合し、途中カルテを算定する可能性がある | v7は巡回中の変更通知を抑止し、安定読取と元record復元後のidentity/fingerprint再検証を必須にする。復元失敗時は算定を停止する |
| High | DBの過去session/draftが古いDOM、別selector version、誤った受診種別から作られている可能性がある | 現行fallbackは現在requestがv7で、同一患者・施設・月、record ID、DOM由来受診種別、カレンダー日付集合の完全一致を満たす場合だけ再利用する。rollout前にv7 migration auditも実行する |
| High | `#pdetail_karte` 全体のinnerText/innerHTML/hashを使うと、禁止対象の行為欄が間接的にsource proofへ混入する | allowlistした構造化rawだけをhashし、行為欄の文言・要素数・有無を変更するmutation testでrequest/source revision/responseの不変を検証する |
| High | 一覧に対象疾病がないことを、全件性なしで非該当と誤判定する | 陽性は自動、陰性はcompleteな2 surfaceだけに限定する。手動補完は未実装で、追加時はrevision付きにする |
| Medium | 手動の `対象外` が病名・機器更新後も残り続ける | source/artifact/selector revision変更時にstale化し、陽性根拠との競合は陽性優先で監査する |
| Medium | 2025年データを2026 artifactで判定すると制度時点が壊れる | `serviceDate` でartifactを選び、過去版がなければexactにしない |
| Medium | 全履歴巡回は画面のちらつき、処理時間、HOMIS負荷を増やす | v7は対象月と境界確認、最大100遷移、遷移timeout、必須の元record復元に制限する。crawl省略cacheは将来最適化とする |

この方式で完全自動exactが成立する条件は、実HOMISについて、日めくりが対象患者のカルテを
単調順序で漏れなく列挙すること、各recordの実施状態を判別できること、病名・状態一覧の全件性を
証明できることの3点である。いずれかを証明できない症例では、ロジックで欠落情報を推測せず、
回数軸は `incomplete`、疾病等軸は `unknown` に戻す。手動補完は将来範囲とする。
