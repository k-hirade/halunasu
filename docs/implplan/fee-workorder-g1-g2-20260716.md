# 作業依頼: G1 マスタDB成果物の再生成と内容検証ゲート / G2 月次セッション取得の患者絞り込み (2026-07-16)

背景・調査根拠は `docs/implplan/fee-master-artifact-and-monthly-query-tickets-20260716.md`
(T6再計測レビュー)を参照。本ファイルは実装者向けの作業指示書で、これ単体で着手できるよう仕様を書く。

前提となる確定事実(検証済み):

- デプロイ中の `python/data/master/standard-master.sqlite.gz`(6/15生成、sha `0451c6ec…`)には
  `diseases` / `disease_modifiers` / `cc_act_indications` / `cc_drug_indications` /
  `cc_drug_contra_disease` / `cc_drug_interactions` / `cc_drug_dose_groups` の**7テーブルが存在しない**。
  Cloud Run上では `initialize_schema` が空テーブルを自動作成するため「0件」に見える。
  → **検証はテーブル存在ではなく行数で行うこと**。
- 影響: T4病名レーンに加え、IY-002薬剤用量チェック・薬剤適応/禁忌/相互作用点検・病名コード化が
  STGで静かに無効化されている。
- ローカル完全DBは1.71GB(うち約1.26GBは `hospital_facility_standards`+索引)。
  この表は算定ランタイム(`lab_calculator._resolve_hospital_profile`)が参照するため**間引き不可**。
- fee-apiのCloud Runメモリは `FEE_MEMORY:-2Gi`
  (`scripts/p10_deploy_runtime_services_low_cost.sh:82`)。`/tmp` はメモリFSであり、
  1.71GB展開+Node+Pythonで2Giは不足の恐れが高い。

---

## G1. [P0] マスタDB成果物の再生成スクリプトと内容検証ゲート

### G1-1. 生成スクリプト `scripts/build_fee_master_artifact.sh`(新規)

役割: 手作業gzipを廃止し、「検証に通った完全DBからしか成果物を作れない」一本道にする。

```
使い方: scripts/build_fee_master_artifact.sh [SRC_DB] [OUT_DIR]
  SRC_DB  既定 python/data/master/standard-master.sqlite
  OUT_DIR 既定 python/data/master
```

処理手順(順序どおり):

1. `sqlite3 "$SRC_DB" "VACUUM INTO '$TMP_DB'"` — importで肥大した空きページを除去したコピーを作る。
   `$TMP_DB` は `mktemp` 配下(成果物ディレクトリに中間物を残さない)。
2. **必須テーブルの行数検証**。1つでも下限未満なら明確なエラーメッセージで非0終了し、
   gzip/manifestを一切書かない:

   | テーブル | 下限 |
   | --- | ---: |
   | medical_procedures | 10000 |
   | electronic_exclusions | 70000 |
   | electronic_bundles | 200000 |
   | electronic_frequency_limits | 5000 |
   | comment_links | 15000 |
   | diseases | 25000 |
   | disease_modifiers | 2000 |
   | cc_act_indications | 200000 |
   | cc_drug_indications | 1 |
   | cc_drug_contra_disease | 1 |
   | cc_drug_interactions | 1 |
   | cc_drug_dose_groups | 1 |
   | drugs | 1 |
   | comments | 1 |
   | specific_materials | 1 |
   | hospital_facility_standards | 1 |

   下限はハードコードでよい(2026-06-15世代の実数の5〜9割。世代更新で実数が下回る場合は
   このスクリプトの表を意図的に更新する運用)。
3. `gzip -9 -c "$TMP_DB" > "$OUT_DIR/standard-master.sqlite.gz.tmp"` → 完了後 `mv` で原子的に差し替え。
4. manifest `$OUT_DIR/standard-master.manifest.json` を書く:

   ```json
   {
     "schemaVersion": 1,
     "generatedAt": "2026-07-16T…Z",
     "sha256": "<gzのsha256>",
     "sourceVersions": [
       { "sourceType": "medical_procedure_master", "sourceVersion": "2026-06-15", "importedAt": "…" }
     ],
     "tables": { "medical_procedures": 11746, "diseases": 27684, "…": 0 }
   }
   ```

   - `sourceVersions` は `SELECT source_type, source_version, imported_at FROM master_sources` 全行。
   - `tables` は上の必須テーブル全部の実カウント(VACUUM後DBで計測)。
5. 標準出力に「旧gz→新gzのサイズ差・sha・行数表」を出す。

### G1-2. ランタイム内容検証(再発防止の本体)

対象: `services/fee-api/src/python-calculator.js`

1. コンストラクタ/環境変数に `FEE_MASTER_DB_MANIFEST_PATH` を追加。既定は
   `masterDbGzipPath` と同ディレクトリの `standard-master.manifest.json`
   (gzipPath未設定なら無効)。`createFeeCalculatorFromEnv`(23行付近)で配線する。
2. `ensureMasterDbReady()`(306行)の展開完了後に**1回だけ**内容検証を実行し、結果を
   プロセス内にキャッシュする(`this.masterContentCheck = { ok, failedTables, checkedAt, manifestSha }`):
   - manifestを読み、`tables` の各エントリについて展開済みDBへ `SELECT COUNT(*)` を実行。
   - **実行数 < manifest値の50%** のテーブルを `failedTables` に列挙(名称と 実数/期待値)。
   - manifestファイルが無い場合: `ok: true, manifestMissing: true` とし、警告ログを1回出す
     (移行期間の後方互換)。
   - COUNT列挙のコストは起動時1回・16テーブルのみ。行数キャッシュ等の最適化は不要。
3. 失敗時挙動は `FEE_MASTER_CONTENT_CHECK`(既定 `strict`)で分岐:
   - `strict`: `ensureMasterDbReady()` が `ConfigurationError`(statusCode 503、
     `failedTables` をメッセージに含める)をthrowする。既存のgzip欠如時(322行)と同じ扱いで、
     算定リクエストと readyz が両方落ちる。
   - `warn`: エラーログのみで続行。
4. `readinessDetailed()`(235行付近)の返り値に追加:

   ```js
   masterContent: this.masterContentCheck || null  // { ok, failedTables, manifestMissing?, manifestSha }
   ```

   readyz は既存の `feeCalculatorReadiness`(server.js:7123)経由でそのまま露出される。
   ※ readyzを見るだけで内容検証結果が分かることがT6検証手順の前提。
5. 注意: 検証は `initialize_schema` 実行**後**のDBに対して行われるため、
   「テーブルが無い」ケースも行数0として検出される(存在チェックにしないこと)。

### G1-3. デプロイ設定

1. `scripts/p10_deploy_runtime_services_low_cost.sh:82` — `FEE_MEMORY` の既定を `2Gi` → `4Gi`。
2. 同スクリプトのfee-api環境変数に `FEE_MASTER_DB_MANIFEST_PATH=/app/python/data/master/standard-master.manifest.json`
   を追加(322-323行の `FEE_MASTER_DB_*` の並び)。
3. startup probe / タイムアウトの現行値を確認し、1.71GB展開(数十秒想定)で不足するなら延長。

### G1-4. テスト

1. `services/fee-api/test/python-calculator.test.js` に追加:
   - fixture: 小さなsqlite(medical_proceduresのみ数行)をgzip化 + manifest
     `{ tables: { medical_procedures: 4, diseases: 100 } }` を一時ディレクトリに用意。
   - `strict`: `ensureMasterDbReady()` が reject し、メッセージに `diseases` を含む。
   - `warn`: resolveし、`readinessDetailed().masterContent.ok === false` かつ
     `failedTables` に diseases(実数0/期待100)が入る。
   - manifest無し: resolveし、`masterContent.manifestMissing === true`。
   - 全テーブル充足: `masterContent.ok === true`。
2. 生成スクリプトはCI外(実DB必須)。ローカルで実行し、出力manifestの
   全テーブルが下限以上であることを目視+スクリプト出力で確認する。

### G1-5. 実施手順と受け入れ条件

実施順:

1. `scripts/build_fee_master_artifact.sh` をローカル完全DBに対して実行し、新gz+manifestを生成
2. G1-2/G1-3 のコード変更とともにSTGへデプロイ(memory 4Gi)
3. 検証チェックリスト:
   - [ ] `/readyz` → `feeCalculator.masterContent.ok === true`、gz sha が新manifestと一致
   - [ ] 患者1006を1回実行 → `resolvedDiagnosisCount > 0` かつ `diseaseIndicationCandidateCount > 0`
   - [ ] **復旧確認**: IY-002薬剤用量チェックのスモーク(用量超過ケースで指摘が返る)、
         `checkLookup` の薬剤適応/禁忌/相互作用が非空で返る
   - [ ] 1006/1007を各3回再実行 → 特定疾患療養管理料候補が3反復とも提示(候補集合の安定判定)
   - [ ] Cloud Run メモリ実測がピークで上限の80%未満
4. 意図的な逆テスト(任意だが推奨): 旧gz(manifestなし or 不整合manifest)を指すよう環境変数を
   変えたRunで readyz が落ちることを1度確認してから戻す。

受け入れ条件:

- 内容の欠けたgzがデプロイされた場合、strictのreadyzが `failedTables` つきで非readyになる。
- STGで病名レーン・薬剤チェック群が実データで動作する。

---

## G2. [P1] 月次セッション取得の患者絞り込み(月次4.6秒の主因解消)

### G2-1. store層

対象: `services/fee-api/src/store/firestore-store.js:111` `listSessionsForClaimMonth(orgId, claimMonth, options)`

1. `options.patientId`(string)と `options.patientIds`(string[])を追加する。両方指定時は
   `patientId` を優先。正規化(trim・空除去)して空なら従来どおり全件。
2. `patientId` 指定時: 既存2クエリ(claimMonth equality / serviceDate range)の両方に
   `.where("patientId", "==", patientId)` を追加。
3. `patientIds` 指定時: **25件ずつのchunk**に分け、chunkごとに両クエリへ
   `.where("patientId", "in", chunk)` を付けて並列実行し、スナップショットを全部
   `mergeMonthlySessionSnapshots` へ渡す(重複はmergeが排除することを確認。していなければ
   feeSessionIdでdedupeを追加)。**chunk数が4を超える(=100患者超)場合は絞り込みを諦めて
   従来の全件取得にフォールバック**する(inクエリの多重発行がかえって遅くなるため)。
4. `services/fee-api/src/store/memory-store.js:56` の同名メソッドにも同じフィルタ仕様を実装する
   (単純な `filter`)。
5. `LazyFirestoreFeeStore`(create-store.js)は汎用 `call` 委譲のため変更不要。
   **store delegate完全性テスト(store.test.js)が本メソッドを対象に含んでいることを確認**し、
   含まれていなければ追加する。

### G2-2. server層

対象: `services/fee-api/src/server.js`

1. `listSessionsForMonthlyView(feeStore, orgId, claimMonth, options)` に
   `options.patientId` / `options.patientIds` のパススルーを追加。
2. `GET /v1/fee/monthly-receipt`(695行付近): クエリパラメータ `patientId` が非空なら
   `listSessionsForMonthlyView` へ渡す。後段の `buildMonthlyReceiptDraft` の patientId
   フィルタは**そのまま残す**(防御の二重化。store絞りが効かない旧storeでも正しさを保つ)。
3. 既存レセ差分診断(baseline_diagnosis, 570行付近): `baseline.baselineClaims` から
   `patientId` 集合(当社patientIdが取れる形式のもの)を作り `patientIds` として
   `listSessionsForBaselineDiagnosis` 経由で渡す。baselineが externalPatientId しか持たず
   マッピングできない場合は従来どおり全件(挙動変更なし)。
4. 月次サマリ(claim summary, 436行)・一括候補プランは全患者対象のため変更しない。
5. T5計測(`stageDurationsMs.listSessionsForMonthlyView`)は既存のまま。効果測定に使う。

### G2-3. Firestoreインデックス

対象: `firestore.indexes.json`(現状 `fee_sessions` のエントリは0件)

1. 追加(collectionGroup は `fee_sessions`。orgサブコレクション配下のため COLLECTION scope):

   ```json
   {
     "collectionGroup": "fee_sessions",
     "queryScope": "COLLECTION",
     "fields": [
       { "fieldPath": "patientId", "order": "ASCENDING" },
       { "fieldPath": "serviceDate", "order": "ASCENDING" }
     ]
   }
   ```

   (serviceDate range × patientId equality に必須)
2. claimMonth equality × patientId equality は単一フィールド索引のマージで動く想定のため
   追加しない。**デプロイ後にSTG実クエリで `FAILED_PRECONDITION` が出た場合のみ**
   `(patientId ASC, claimMonth ASC)` を追加する(エラーメッセージに必要インデックスの
   作成リンクが出るのでそれに従ってよい)。
3. インデックスのデプロイコマンドと完了確認(`gcloud firestore indexes composite list` 等)を
   作業ログに残す。**インデックス構築完了前にコードをデプロイしない**(rangeクエリが
   FAILED_PRECONDITIONで落ちるため。コードはインデックスREADY後にデプロイ)。

### G2-4. テスト

1. `services/fee-api/test/server.test.js`:
   - スパイstoreで `GET /v1/fee/monthly-receipt?patientId=…` 時に store が
     `options.patientId` を受け取ることを検証。
   - 差分診断で baselineの患者集合が `options.patientIds` として渡ること
     (マッピング不能なbaselineでは渡らないこと)。
   - patientId指定なしの月次サマリが従来どおり全患者分を返すこと(回帰)。
2. memory-store のフィルタ動作(単一patientId / patientIds chunk / 未指定)のユニットテスト。
3. store delegate完全性テストのカバレッジ確認(G2-1の5)。

### G2-5. 受け入れ条件

- STGの患者別月次レセプトで `stageDurationsMs.listSessionsForMonthlyView` 中央値が
  500ms未満(現状中央値4,637ms)。
- 差分診断のセッション取得件数がbaseline患者数に比例して縮む(T5メトリクスで確認)。
- 患者指定なしの月次系エンドポイントの応答内容が変わらない。

---

## 共通の完了ゲート

1. `services/fee-api` / `packages/fee-core` / `packages/fee-contracts` / `packages/medical-core` の
   node --test 全パス、`PYTHONPATH=python python3 -m unittest discover -s python/tests` 全パス。
2. goldゲート2系統:
   - `npm run test:fee-gold:engine`(seed-300 exact 150件)
   - `node scripts/evaluate_fee_soap_e2e_dataset.mjs --dataset data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json --use-expected-claim-context --assertion exact`(v2 exact 138件)
   - G1/G2は成果物・クエリ層のみの変更なので、確定点数(エンジン純度)は不変のはず。
3. 反例コーパス(`services/fee-api/test/counterexamples.test.js`)パス。
4. 実施順: **G1 → STG再計測(G1-5チェックリスト=T4/T6のクローズ判定を兼ねる)→ G2 → T5メトリクスで効果確認**。
5. コミット粒度: G1-1+G1-2+G1-4 / G1-3(デプロイ設定) / G2-1+G2-2+G2-4 / G2-3(インデックス) を推奨。
