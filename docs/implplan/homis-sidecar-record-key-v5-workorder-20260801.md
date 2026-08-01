# data-record-id依存の廃止(契約v5) ワークオーダー(RK0〜RK9)

- 作成日: 2026-08-01
- status: local implementation complete / STG rollout pending(RK1実HOMIS調査・RK9施設監査・認証付きE2E/G0は未完)
- 目的: サイドカーが**未改変の本番準拠HOMIS DOM**だけで、現行と同じ精度・同じ安全性で動くこと。`data-record-id` / `data-single-building-patient-count` はモック側に後付けした独自属性であり、「モックを実装に合わせる」依存の逆転を解消する(2026-08-01 ユーザー決定)。
- 前提の実測(2026-08-01確認):
  - 依存箇所は3つ: `contract.js:27`(sourceRecordId) / `contract.js:175`(単一建物人数) / `content.js:151`(MutationObserverのattributeFilter)
  - **受付時刻は既に可視テキストから取得済み**(`contract.js:76`、「13:30〜」)
  - **単一建物人数は可視テキスト「単一建物：{n}」がヘッダーに存在**(`render.py:184`)
  - サーバは `sourceRecordId` を不透明文字列として扱う(識別ハッシュの材料)——**フィールド定義を変えずに複合キーを渡せる=サーバAPI変更ゼロ**

## 0. 設計判断(ユーザー案+本計画での補強3点)

**採用するユーザー案**: 正規fixture保存 / 独自属性依存の廃止 / 可視情報のみからの識別子構成 / 本文hashは更新検知(sourceRevisionHash)専用 / 契約v5として追加しサーバ受入互換でv4と段階移行 / 同日重複はfail-closed / 実HOMISの内部ID調査を先行。

**補強1 — 受付時刻をキーに含める**:

```
sourceRecordKey = sourceSystem + patientId + serviceDate + displayedChartId + receptionTime
```

同一患者・同一日の複数カルテ(定期+臨時往診など、**実HOMISでは現実的なケース**)の大半は受付時刻で区別できる。fail-closed停止が発動するのは「同日・同表示ID・同時刻」の稀なケースのみに狭まる。receptionTimeは取得済みの可視情報であり追加コストなし。

**補強2 — 外部APIフィールド定義は維持(※「サーバ無変更」ではない——RK5参照)**: 複合キーを既存 `sourceRecordId` フィールドにそのまま渡す。draftの識別(`sidecarDraftId` = org+facility+system+patientId+sourceRecordIdのhash)は自動的に新キー由来になる。サーバ実装には契約v5対応(surfaces必須化)とRK9ガードの変更が必要(RK5に列挙)。
**訂正(2026-08-01 外部レビュー反映)**: 初版の「draft連続性の切れは実害軽微」は**誤り**——採用API(`server.js:441-` `isSidecarDraftAdoptionRoute`)が存在するため、**採用済みのv4 draftがある状態でv5が同じカルテの新draftを作ると、二重採用=二重請求経路が成立し得る**。移行は「軽微な既知事象」ではなく**RK9の移行ゲート**として管理する(下記)。`calculationRevision` の初期化は表示上の既知事象として従来どおり記録。

**補強3 — 構造的な再発防止**: dependency-guardテストに「拡張ソースが `data-record-id` / `data-single-building-patient-count` を参照しない」を追加する(行為欄 `#action_list` 禁止と同じ方式)。属性依存が再導入されるとCIで落ちる。

**識別子の扱いの原則**: displayedChartIdは**不透明文字列としてのみ**扱い、「患者ID+月日」等の内部構造を推測・分解しない(表記が変わっても壊れない)。年またぎはserviceDate(カレンダー年+表示日付から構成済み——`parseServiceDate`)が解消する。

## チケット

### RK0: 正規fixtureの確立

- 未改変の `mock_partner` 一式を正規fixtureとして保存(sha256付き・改変禁止)。以後のcontractテスト・E2Eはこのfixtureを読む。
- 新規 `prepare_homis_mock_v5.py` は期間・開始日・関連履歴日だけをシフトし、DOM属性を注入しない。再現性のためv2/v3生成器は過去評価用として凍結し、現行経路からは呼ばない。README更新。
- **受入**: 正規fixtureのshaが記録され、prepareを通しても属性が付かない。

### RK1: 実HOMISの不変内部IDの調査 [**実HOMIS展開の必須ゲート**(2026-08-01 外部レビュー反映で昇格)]

- 実HOMIS(または最も本番準拠の情報)で、hidden input / URLパラメータ / ページ内JS状態 / XHRレスポンスに**カルテの不変内部ID**が無いかを確認する。
- **あれば**: DOMへ追加せずそれを直接読む設計に変更(本ワークオーダーの複合キーは不要になり、RK2の中身を差し替え)。**なければ**: 同日複数カルテ運用の実態(頻度・区別手段)を確認し、対策を確定するまで**実HOMISへはv5を展開しない**。
- **mockはこのゲートの対象外として先行可**: 外部レビューが未改変mockの52訪問を実測し、**同一患者・同日・同時刻の重複は0件**——複合キーはmock demoに対して衝突なしで成立する(2026-08-01実測)。
- **受入**: 調査結果(確認した4経路と結論)が本書へ追記される。実HOMIS展開判断はこの結果に紐づく。

### RK2: 契約v5(sourceRecordKeyの複合構成)

- `contract.js` に homis-mock-v5 を追加。**新しい拡張は `SUPPORTED_VERSIONS = [homis-mock-v5]` としてv5だけを送信する**。ここでいうv4/v3との混在は、移行期間中にサーバ許可リストがv5/v4/v3/v2を受け入れる互換性を指し、単一拡張が複数versionを送る意味ではない。同一施設での新旧拡張の並行利用はRK9-4で禁止する:
  - `sourceRecordId` ← `sourceRecordKey`(補強1の5要素連結。区切りは既存identity hashと同じ ``)
  - 構成要素はすべて可視情報: URL/画面の患者ID・カレンダー年+表示日付由来のserviceDate・画面表示のカルテID・受付時刻
  - **訂正(2026-08-01 外部レビュー反映)**: 初版の「同一キーで本文が異なれば別カルテとして停止」は**観測上実現不可能なため削除**——「同じカルテの本文編集」と「同日・同ID・同時刻の別カルテへの切替」は画面からはまったく同じ事象であり、MutationObserverでは判別できない(次項の本文編集扱いと矛盾もしていた)。
  - **確定仕様**: 同一キー+本文差分は**常に「本文編集」として扱う**(同一draftの再計算・revision更新)。同キー別カルテのサイレント統合という残余リスクは実行時検知では防げないため、**展開ゲートで管理する**: mockは重複0件の実測(RK1)により安全、実HOMISはRK1必須ゲートで内部ID確認まで展開しない。
- 本文hashは従来どおり `sourceRevisionHash` / `previewFingerprint`(更新検知)専用。**本文編集ではsourceRecordKeyは不変、revisionだけ変わる**(同一draftの再計算として扱う=現行のdedupe目的を維持)。
- **受入**: 未改変fixtureで読取・算定が成立。カルテ切替でキーが変わる。本文編集でキー不変・revision変化。年違い同月日を区別。

### RK3: 単一建物人数の可視テキスト読取

- `data-single-building-patient-count` を廃止し、ヘッダーの「単一建物：{n}」表示テキストから読む。表示が無い場合は現行どおり「未確認」(fail-safe、ユーザー選択に委ねる——既存UIの同一建物区分コントロールは不変)。
- **受入**: 属性なしfixtureで人数が読める。表示なしfixtureで未確認になる。

### RK4: 変化検知(MutationObserver)の可視情報化

- `content.js:151` のattributeFilter依存を廃止し、識別子の構成要素(患者ID・カルテID・日付・受付時刻の各表示ノード)と本文のテキスト変化を監視する方式へ。
- 画面切替中の別患者・別カルテ混入防止(identityBefore/After比較)は、複合キー同士の比較に置き換え(`proof.sameIdentity` の材料変更)。
- **受入**: カルテ切替・患者切替で自動再読取が現行同様に発火。抽出中のカルテ変更ガード(`chart_changed_during_extraction`)が引き続き機能。

### RK5: サーバ側の変更(「差分ゼロ」の訂正——2026-08-01 外部レビュー反映)

- **訂正**: 初版の「サーバ差分ゼロ」は**不成立**。正確には「**外部APIのフィールド定義とdraftスキーマは維持するが、サーバ実装は変更する**」。必要な変更:
  1. **契約v5のサーバ側追加**: 許可contract一覧への `homis-mock-v5` 追加に加え、`validateSidecarSourceSurfaces` の必須化条件が現在 `homis-mock-v4` 限定(`fee-contracts/src/index.js:348`)のため、**v5でもsourceSurfacesを必須にするコード+テスト変更**が必要
  2. **RK9の受診fingerprint重複採用ガード**: 採用APIルート+memory store+Firestore store(トランザクション)+両storeのテスト
- 変更しないもの: `sourceRecordId` のopaque扱い(フォーマット検証を追加しないことをテストで固定)・draftスキーマ・既存フィールド定義。
- draft識別・idempotency・M6同日sibling検索・G0が新キーで従来どおり動くことを回帰確認。切替時のdraft分断はRK9で管理。
- **受入**: 上記1・2の変更を含めて全既存スイート緑。opaque扱いの固定テスト。v5でsurfaces欠落が拒否されるテスト。

### RK6: ガードとテスト(ユーザー案のテスト方針+補強3)

1. 未改変の元モックから読み取れる(RK0 fixture)
2. カルテ切替で識別子が変わる
3. 本文編集では識別子維持・revisionのみ変化
4. 年違いの同月日を区別できる
5. 同一受診fingerprintのv4/v5二重採用は409。同日でも表示カルテID・受付時刻・受診区分が異なる別受診は採用可能
6. **独自data-*属性が無くても動く**(属性を剥がしたfixture)
7. **行為欄 `#action_list` を読まない制約の維持**(既存denylist継続)
8. **dependency-guardに `data-record-id` / `data-single-building-patient-count` 参照禁止を追加**(補強3)
9. **訂正(2026-08-01 外部レビュー反映)**: 初版の「時刻欠落時は4要素キーでfail-soft」は**危険なため撤回**——描画途中で時刻が一時欠落すると「4要素キーでdraft作成→時刻描画後に5要素キーへ変化→同一カルテに別draft」という分裂が起きる。**homis-mock-v5では受付時刻を必須**とし、安定読取リトライ後も欠ける場合は `selector_contract_mismatch` で停止(fail-closed)。実HOMISで時刻表示が保証されない場合は、RK1の内部ID確認まで展開しない方針とそのまま整合する。テスト: 時刻欠落fixtureで停止すること・一時欠落→再描画で単一draftに収束すること

### RK7: 展開(検証は2系統に分離——2026-08-01 外部レビュー反映)

**G0は拡張を経由しない**(pythonからケースを合成しAPIへ直接POST——`evaluate_fee_mock_act_coverage.mjs:55` 前後)ため、G0だけでは「未改変DOMから読める」ことを検証できない。受入を2系統に分ける:

1. **Chrome拡張E2E**(未改変DOMの実読取): 属性なしfixtureに対して、読取・患者/カルテの自動切替検知・算定案作成までを実ブラウザE2E(既存 `e2e/smoke.test.mjs` の拡張)で確認
2. **G0**(算定精度の非劣化): export/ハーネスのsourceRecordId合成をv5導出に揃えたうえで再計測し、actCoverageRecall・dangerous FP・点数一致が現行値と同一であることを確認

- 展開順: v5拡張ビルド→**RK9の移行ゲート通過**→STGデプロイ(許可contractにv5追加、v4/v3併記——K1と同方式)→E2E→G0。
- **受入**: E2E 1/1 pass(未改変DOM)+G0同値。両方が揃って初めて「同精度で動く」と主張する。

### RK9: v4→v5移行ゲート(draft分断の安全管理)[2026-08-01 外部レビュー反映・新設]

- **背景**: キー定義変更で同一カルテに別 `sidecarDraftId` が生まれる。採用APIがある以上、**採用済み旧draft+新draftの二重採用**が可能になってしまう。
- **展開前ゲート(施設ごと)**:
  1. v3/v4 draftの全件監査(件数・lifecycleStatus・採用済みの有無を記録)
  2. **未採用draft**: 監査記録を保存したうえで期限切れを待つか明示削除
  3. **採用済みdraftが1件でもあれば、移行方式(採用済みカルテの新キーへの対応付け等)を確定するまでその施設へのv5展開を停止**
  4. **同一施設で旧拡張とv5拡張を並行利用しない**(配布・バージョン管理で担保)
- **旧draftの採用順序**: 受付時刻等が欠けて受診fingerprintを構成できない旧draftは安全側に409で採用を拒否する。利用者には「新しい拡張機能でHOMIS画面を再読み取りし、算定案を再作成」と案内する。したがってv5配布前に監査・未採用旧draftの掃除・必要な採用済みguardのbackfillを完了する。
- **恒久強化(P2・v5と独立に価値あり)——ガード範囲の訂正(2026-08-01 外部レビュー反映)**: 初版の「同一患者・同一診療日で409」は**広すぎる**——同日の定期訪問+臨時往診のような正当な複数受診(本書22行目の前提そのもの)まで拒否してしまう。ガードは**「同一の受診」**に限定する:
  - **受診fingerprint** = 施設ID+患者(canonicalエイリアス含む)+診療日+**表示カルテID(`sourceRecordDisplayId`)+受付時刻+受診区分**——いずれもv4/v5双方のdraftに保存済みのフィールドから構成でき、**キー方式(v4属性/v5複合)に依存しない対応付け**になる
  - 採用APIは**採用トランザクション内で**この受診fingerprintの一意性を検査し、同一fingerprintの採用済みセッションが存在する場合のみ409+確認要求。別受診(fingerprintが異なる同日)は通す
- **受入**: STG/PROD各施設の監査記録がdocsに残る。採用済みdraftが存在する施設でv5が配布されていないこと。二重採用ガードのテスト: (a) 同一fingerprintの二重採用が409 (b) **同日の別受診(定期+往診)は両方採用できる** (c) v4 draft採用済み→同一受診のv5 draft採用が409(トランザクション競合含む)。

## 非対象

- 外部APIの**フィールド定義**・draftスキーマの変更(維持。ただしサーバ**実装**はRK5のとおり変更する——「サーバ差分ゼロ」ではない)
- displayedChartIdの内部構造の解釈(不透明文字列として扱う)
- 実HOMISのXHR/内部状態への依存追加(RK1で見つかった場合のみ、別途設計してから)

## リスクと限界(明示)

| リスク | 扱い(2026-08-01 外部レビュー反映で更新) |
| --- | --- |
| 同日・同表示ID・同時刻の複数カルテ | **実行時検知は原理的に不可能**(本文編集と同一の観測)。mockは重複0件を実測済みで安全。実HOMISは**RK1必須ゲート**(内部ID確認まで展開しない)で管理 |
| 切替時のdraft分断 | **二重採用=二重請求経路のリスクあり**(採用API実在)。**RK9移行ゲート**(監査・未採用の掃除・採用済みありは展開停止・新旧並行利用禁止)+同日重複採用ガード(P2)で管理 |
| 表示フォーマット変更(カルテID・時刻表記) | キーが変わる=別カルテ扱いになるだけで誤統合はしない(安全方向)。契約バージョンで管理 |

## 追記(2026-08-01): RK0の2層構成の明確化・RK8・mockのGit管理化

### RK0の明確化(2層構成)

「正規fixture」は2層で管理する:

1. **原本fixture**: 未改変のmock_partner(2025年1月期間・DOM属性なし)。**実HOMISのDOM構造の参照点**であり、一切改変しない(sha256固定)
2. **実行用mock**: 原本にprepareの**期間シフトのみ**を適用したもの(現行: 対象2026-07/前月2026-06・DOM属性なし)。**令和8年度マスタ(施行2026-06-01)と診療日を整合させる計測環境**

旧日付(2025-01)のままでは施行前日付となり計測が成立しない(2026-05期間で確定0/77を実測済み——fee-mock-100-generalization-workorder C2a)ため、期間シフトは恒久に維持する。廃止するのはDOM属性注入のみ。

### RK8: 期間シフトの時系列整合(開始日・初回算定年月日) [mockデータ残修正]

- **背景(実測済み)**: 現行の期間シフトは診療日(+18か月)だけを動かし、**診療開始日を動かさなかった**。その結果、1004(開始2024-11-22)・1006(開始2024-11-10)の在宅移行早期加算(「在宅療養開始から3か月以内」)が時系列不整合となり、SF5計測の残2件(75/77)としてfail-closedになっている(エンジンの判定は正しい——`required_positive_fact_missing: encounter.withinThreeMonthsOfPatientStart`)。
- **具体実装**: prepareの期間シフトで、対象月のオフセット(原本2025-01→現行2026-07=+18か月)と**同一のオフセット**を以下にも適用する:
  1. 患者の `start_date`(診療開始日——基本情報1号紙の表示・K1のpatientStartDate読取元)
  2. `ikou_souki_comment(...)` / 「初回算定年月日(在宅移行早期加算)」コメントの日付(和暦変換は既存 `wareki()` がISOから導出するため自動追従)
  3. `docs`(訪看指示書等)の期間・記入日(既存のシフト対象——維持)
  4. `problems[].since`(病名開始日。算定には中立だが、時系列の意味を一貫させるため同オフセット)
- **整合の検算**: 1004は開始2026-05-22相当となり、移行早期を算定する訪問(2026-06-28・2026-07-25)がいずれも3か月以内に収まる(原本の「開始2か月後」という意味が保存される)。1006も同様。
- **受入条件**: `test_homis_mock_period_shift` に「開始日・初回算定コメントが同オフセットで移動し、移行早期の3か月条件が原本と同じ真偽になる」ケースを追加。再生成後のG0計測で1004/1006の在宅移行早期加算が一致し、**時系列不整合による既知残ゼロ**になる。mock再生成に伴うexport・action mapのsha再計算を忘れない。

### mock_dataのGit管理化(RK0に統合)

- **現状**: mock本体は `tmp/mock_homis`(gitignore対象)にのみ存在し、**GitHubに無い**。リポジトリにはprepareスクリプトとREADMEだけで、環境再現が個人環境依存になっている。
- **方針**: 原本fixtureをリポジトリへ取り込む。合成データのみでPHIゼロ、実体は約350KB(venv・`__pycache__` 除外)なのでサイズ問題なし。
  - 配置: `clients/homis-sidecar/mock/fixture/`(app.py・render.py・data/・static/・requirements.txt・README)
  - venv/`__pycache__` は除外(gitignore)。起動手順(venv構築)はREADMEに記載
  - 原本shaを記録し、RK0の「改変禁止」をCIで検証(fixture変更はPRレビュー必須の通常フローに乗る)
  - 実行用(期間シフト済み)は従来どおり `tmp/` に生成(生成物はGit外のまま)
- **受入条件**: クリーンcheckoutから「fixture+prepare実行→mock起動→G0計測」まで再現できる。

## 実装・検証状況(2026-08-01)

### ローカル実装済み

- RK0/RK8: `clients/homis-sidecar/mock/fixture/` に未改変原本と `SHA256SUMS` を保存。`prepare_homis_mock_v5.py` はDOMを変更せず、診療月・開始日・病名開始日・関連コメントを同一月差でシフトする。実行用`tmp/mock_homis`もv5で再生成済みで、1004の診療開始日は`2026-05-22`へシフト済み。
- RK2〜RK4: 拡張`0.3.0`は`homis-mock-v5`のみを生成し、患者ID・診療日・表示カルテID・受付時刻から可視レコードキーを構成する。時刻欠落はリトライ後も欠ければfail-closed。単一建物人数は可視テキストだけから取得する。
- RK5/RK6: v5の`sourceSurfaces`必須化、不透明な`sourceRecordId`の保持、独自data属性のdependency guard、本文編集・年跨ぎ・自動切替・一時欠落の回帰テストを追加した。
- RK7: G0 exporter/ハーネスをv5キーと7要素proofへ統一。STG/PROD用拡張を同一extension IDでビルドできる。
- RK9: memory/Firestoreの採用処理に受診fingerprintの一意ガードを追加。Firestoreではdraft採用・fee session作成・guard作成を同一transactionで行う。既存採用済みv2〜v4を監査・バックフィルする`npm run audit:homis-sidecar-v5-migration`も追加した。fingerprint不完全な旧draftは409で拒否し、v5による再読取・再計算を案内する。

### ローカル検証済み

- fixture checksum: 全9ファイル一致。生成後の`data-record-id` / `data-single-building-patient-count`は0件。再生成後の`gold_actions.csv` sha256は`d2bbf1409459293b5a1c1566941a7cb078cf56e52d382ebb06a49073a74432b4`、action map sha256は`15f6a935dc9505ca59a83324377b7f2a19d41f3c1ea8c9e1bf0d09f8ed95ec14`。
- HOMIS sidecar全体29/29(Chrome契約・自動読取・結果UI・レスポンシブ表示を含む)。
- fee-api全体457/457、fee-core 78/78、migration audit 4/4、Python対象テスト10/10。旧draftのfingerprint不完全時はfee-coreと実store採用経路の両方で409・復旧案内を固定した。
- G0 dry-run: 2026-06/07の13患者52訪問、billable 236・comment 1・attribute 59・patient charge 26・unknown 0。
- build: `dist/homis-sidecar/homis-sidecar-stg.zip` / `homis-sidecar-prod.zip`、extension IDは従来と同じ`nhbmaniknlcaaelpaoogepmkhphmmjof`。

### 展開前の未完了ゲート

1. RK1: 実HOMISのhidden input・URL・ページJS状態・XHRを確認し、不変内部IDの有無を記録する。完了までは実HOMISへv5を配布しない。
2. RK9: STG/PRODの各施設で監査CLIをread-only実行する。activeな旧draftを0件にした後、採用済み旧draftがあれば`--apply-backfill`し、再監査で`migrationReady=true`を確認する。
3. fee-apiをv5許可リスト付きでデプロイした後、未改変mockを使う認証付きChrome E2EとG0 live再計測を同一revisionで実行する。現時点ではdry-runまでであり、STG精度同値は未主張。
