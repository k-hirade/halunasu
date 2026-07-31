# W1c系サイレント不発の診断と修正 ワークオーダー(SF0〜SF6)

- 作成日: 2026-07-30
- status: implemented_stg_verified_with_mock_fixture_residual
- 起点計測: `docs/20260730-sidecar-wrapper-stg/20260730_231441`(00212-bf7、6月単月16ケース、recall 67.53%、危険FP 0、決定論・点数一致OK)
- 残欠落25件の内訳: 在医総管/施医総管本体×10・在宅医療充実体制加算×10・従属加算×5(情報連携2・移行早期2・包括的支援1)。**すべてstanding_family系(W1c)とその従属**。device_management系(気管切開・人工呼吸・酸素・人工鼻等)は同じレーンから発火している(FP側に出現=トリガ動作の証拠)。

## 0. SF0: 確定している事実と、否定された仮説(誤解防止のため明記)

**2026-07-30に実物で検証済みの事実**:

| # | 事実 | 検証方法 |
| --- | --- | --- |
| 1 | STG(00212)の6月計測で、W1c系候補は**全16ケースでゼロ**。device系トリガは発火 | result.jsonのcandidateInventory全数 |
| 2 | 実カタログ(ローカル `python/data/master/standard-master.sqlite`、228 families)の family名は**「在医総管」「施医総管」そのもの**(hierarchy: C/002/branch 00・02、variants各175) | `standing_fee_families({'service_date':'2026-06-15'})` を直接実行しダンプ |
| 3 | よってトリガselector(name=在医総管/施医総管+hierarchy)は**ローカルカタログとは一致し得る** | 同上+`standingFamilyMatchesSelector` の実装読解 |
| 4 | 在宅医療充実体制加算はfrequency由来カタログに**家族として存在しない**が、`additional_family_selectors` で解決する設計で、**配線は存在する**(`server.js:8284`→`checks_api.py:318-`) | ダンプ+コード読解 |
| 5 | 抽出イベントのフィールド名(type/actionStatus/temporalRelation/providerOwnership)は、`normalizeClinicalEventsForResult`(`clinical-calculation-input.js:7728-`)の出力と読取側(`standing-structured-triggers.js:205-`)で**一致** | 両実装の突合 |
| 6 | `management`/`counseling` は正規のイベントtype値 | `clinical-calculation-input.js:599,1547,3503` |

**否定された仮説(前回分析の訂正)**: 「カタログfamily名が正式名称(在宅時医学総合管理料)でselector名(在医総管)と不一致」説は**誤り**(事実2で否定)。したがって**matcherへのalias照合追加は本ワークオーダーでは行わない**(不要な変更)。

**残る仮説(どれかをSF1の観測で確定する)**:

- (a) 事実値の不成立: `clinical.currentManagementOrCounselingCount` が実抽出イベントの**値**(temporalRelationやproviderOwnershipの実際の値分布)で0になる
- (a') `encounter.residenceType` が実リクエスト経路でstructuredFactsに届いていない
- (b) STGのマスタ(runtime-master-current)がローカルDBと異なり、frequency表由来の在医総管familyが**STGでは**存在しない
- (c) `loadStandingFeeFamilyCatalog` またはstanding laneの例外が握りつぶされ、空カタログ/空結果で静かに継続している

## SF1: 可観測性の追加(最優先・これ無しで修正に進まない)

- **意図**: 今回の不発は3層(catalog/family/facts)のどこで死んでも**外から区別できない**。silent失敗を数値化しない限り、仮説を潰す度に計測1周が必要になる(既に2仮説を消費)。
- **具体実装**:
  1. standing lane結果の診断を `draft.calculationResult.metrics.standingLane` に保存: `{ disabledReason|null, familyCount, additionalSelectorResolvedCount, structuredTriggers: { reasonCounts, perTrigger: [{triggerId, reason, missingFacts[] }] }, factsSummary: { residenceType, plannedHomeVisit, activeDiagnosisCount, currentManagementOrCounselingCount, deviceFactCount } }`
  2. 同じ内容を `fee.calculate.performance` ログへ追加
  3. 計測ハーネスがこれをrunごとに収集し、result.jsonへ含める(README集計にreason上位を出す)
  - **PHI規約**: fact名・件数・enum値のみ。本文・患者識別子・evidence文字列は入れない。
- **受入条件**: STG再計測のresult.jsonで、全ケースのW1c不発理由(`family_not_in_current_master` / `required_positive_fact_missing`+missingFacts / disabledReason)が機械的に読める。

## SF2: 実カタログ再現ゲート(ローカルで診断を先取りする)

- **意図**: 既存のW1c unit/e2eは**合成family fixture**(name等を自作)だったため、実カタログとの乖離を一度も検証していなかった——これが今回の見逃しの構造原因。実カタログを使う統合テストを常設し、同時にローカル診断として使う。
- **具体実装**:
  1. 統合テスト(要ローカルマスタDB、CIではmaster無し時skip): `standing_fee_families`(additional_family_selectors込み=`standingStructuredTriggerFamilySelectors()` の実物を渡す)で実カタログを取得し、1001相当の入力(setting=home_visit、encounterDetails.residenceType="private"、diagnoses 1件以上、type="counseling"・actionStatus="instruction_only"・temporalRelation="current_visit"・providerOwnership="own_clinic" のイベント1件)で `buildStandingStructuredFacts`→`evaluateStandingStructuredTriggers` を実行し、**c002トリガがmatchedに入る**ことをassert
  2. カタログsnapshot fixture: 実カタログから standing系トリガが参照するfamily(在医総管・施医総管・充実体制・指導管理料群)の `{name, hierarchy, aliases}` だけを抜いた小さなJSONを `data/tests/` に固定し、「selectorがsnapshotに一致すること」をCIで常時検証(実カタログとfixtureの乖離検出。マスタ更新時はsnapshot再生成)
- **このテスト自体が診断になる**: ローカルで(1)が**通れば**原因はSTG側=(b)or(c)、**通らなければ**(a)/(a')で、SF1を待たずに一段絞れる。
- **受入条件**: (1)(2)がローカル緑。既存の合成fixatureテストはsnapshot由来の値に置き換え。

## SF3: 本修正(SF1/SF2の確定結果に対応する分岐表——確定前に着手しない)

| 確定した原因 | 修正先 | 内容 |
| --- | --- | --- |
| (a) missingFacts=currentManagementOrCounselingCount | `standing-structured-triggers.js` の事実構築 | 実抽出イベントの値分布(SF1のfactsSummary/診断ログ)を根拠に受理集合を実契約(v15の値定義)へ合わせる。**推測で受理を広げない**——契約定義との突合を出典として記録 |
| (a') missingFacts=residenceType | `server.js`(encounterDetails)→`buildStandingStructuredFacts` | 伝播欠落箇所を特定して修正+その経路のe2e |
| (b) family_not_in_current_master(STGのみ) | runtime-master-current artifact | STG相当DBで `standing_fee_families` をダンプしローカルとdiff。frequency表の欠落なら master artifactの再取込/更新(版・sha管理はマスタ更新の既存規約) |
| (c) disabledReason/例外 | `loadStandingFeeFamilyCatalog`・lane呼出し | catchの握りつぶしを「診断付きdisabled」へ(空カタログで静かに続行しない)。SF1の`disabledReason`がそのまま検知器になる |

- **受入条件**: 該当分岐の修正後、SF2の統合テストが緑のまま、STG 6月単月再計測で在医総管/施医総管本体+従属加算+充実体制が候補化される。

## SF4: テスト規約の恒久化

- standing系のfixtureは**実カタログsnapshot(SF2-2)から生成**し、名前・hierarchy・aliasesを手書きしない(合成fixtureが実物と乖離して「テスト緑のまま実機だけ死ぬ」を再発させない)。汎用性ゲートのテスト版としてG系ワークオーダー4節に追記。

## SF5: デプロイ→再計測

1. SF1〜SF3をデプロイ→readyzでリビジョン確認
2. 6月単月を再計測: **期待 actCoverageRecall 77/77=100%・危険FP 0維持・repeat 2以上で決定論確認**(前回はrepeat 1のため決定論主張が弱い)
3. 達成後、2026-06+07の2か月計測へ移行

## SF6: 2か月計測で残る既知根因への接続(本書のスコープ外・着手順のみ)

7月側には既知の未修正が残っている: ①物価対応料1(再診時等)の改称override+イ/ロ区分の一次資料確認(危険FP 1件の根) ②電話再診セットの体制加算候補化 ③K2材料の実機挙動(memo汚染排除後に判定) ④同一患家コメント検知(7月側)。それぞれ前回分析(2026-07-30)の根因2〜4の修正として実施する。

## 非対象

- matcherへのalias照合追加(SF0のとおり不要と確定)
- トリガselector名の変更(実カタログと一致しているため変更しない)

## 実装進捗(2026-07-31)

- SF1: standing laneのreason/missingFacts/factsSummaryを計算結果メトリクスへ保存し、G0 result/README集計まで配線済み
- SF2: 実マスタ由来snapshotとruntime masterを使う統合テストを追加済み
- SF3: 観測結果に基づき、当日自院の管理・指導イベント、v15 standing mention、明示的な当日指導記載、縦断的な管理計画を別々の正根拠として扱う汎用修正を実装。薬剤継続だけ、予定、過去、他院、否定・中止は引き続き除外
- wrapper経路: sidecar計算でもstanding profile・同日sibling draft検索がcanonical patient ID付きでdelegateされることをAPI統合テストで固定
- ローカル検証:
  - `services/fee-api`: 447/447 pass
  - `packages/fee-core`: 75/75 pass
  - sidecar計算経由のW1c候補、同一患家sibling比較、実マスタC002 triggerを含む回帰がgreen

## SF5 STG再計測結果(2026-07-31)

- revision: `fee-api-stg-00215-mxv`
- 証跡: `docs/20260731-w1c-notice-redesign-stg/20260731_073837/`
- 対象: 13患者・2026-06の16訪問・repeat 2(計32計算)
- 完走: 2/2
- 決定論: 2周の`outputSha256`が一致
- standing lane:
  - 16/16訪問で診断取得
  - `disabledReason`なし
  - trigger `matched`は各周60件
- 精度:
  - 行為欄raw: 75/77 = 97.40%
  - per-visit: 35/35 = 100%
  - 危険な偽確定: 0
  - billable-ready点数: 11,025点 / 11,025点、差分0

### 残る2件の確定診断

1004・1006の`114016070 在宅移行早期加算`だけが両周で欠落した。両ケースともtrigger診断は
`required_positive_fact_missing: encounter.withinThreeMonthsOfPatientStart`で一致している。

これはアプリのW1c不発ではなく、mock正解データの時系列不整合である。

- 1004: 診療開始日`2024-11-22`、評価診療日`2026-06-28`
- 1006: 診療開始日`2024-11-10`、評価診療日`2026-06-27`
- 行為欄には在宅移行早期加算と古い初回算定年月日が残り、コメントには「3か月以内」とある

したがって、これらを候補化するよう実装を緩めると、未知患者でも3か月外を提案する回帰になる。現行のfail-closed判定を維持する。機械集計上は75/77だが、日付整合する有効goldに限定した診断値は75/75である。raw値を改変せず、fixtureの期間シフト時に診療開始日も意味を保って移行するか、行為欄から対象外加算を除外することを別データ修正として扱う。
