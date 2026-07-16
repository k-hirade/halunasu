# マスタDB成果物の再生成・鮮度ゲートと月次クエリ改善 チケット (2026-07-16)

T6デプロイ後STG再計測
`docs/20260716_fee_candidate_stability_t6_postdeploy_stg_20260716_025709/README.md` のレビュー結果と、
そこから確定した追加作業。

## レポートのレビュー結果

計測・切り分けの方法論は妥当(gzip SHA一致確認、病名本文を保存しない診断Run、候補点数KPIの
仕様変更注記)。結論も全て独立検証で再現した:

- デプロイ済みgzを展開して確認: **`diseases` / `disease_modifiers` / `cc_act_indications` を含む
  7テーブルがgzに存在しない**(レポートは「0件」だが、正確には**テーブル自体が無い**。
  Cloud Run側で `initialize_schema` が空テーブルを作るため0件に見える。したがって修正後の
  検証は「テーブル存在」ではなく**行数**で行う必要がある)。
- gzのタイムスタンプは6/15、ローカル完全DBは7/16。**gzはチェックマスタ・病名データ取込より
  前の成果物で、デプロイフローに再生成ステップが存在しない**(deployはリポジトリの
  `python/data/master/standard-master.sqlite.gz` をそのまま同梱)。
- `listSessionsForClaimMonth`(firestore-store.js 111行)に患者絞り込みが無いことを確認。
  組織×請求月の全セッション(計測時339〜361件、フルドキュメント)を毎回取得している。

### レポートの結論への追加(影響範囲の拡大)

gzに欠けているのは病名レーンの3テーブルだけではない。完全DBとの差分は次の**7テーブル**:

```
cc_act_indications / cc_drug_contra_disease / cc_drug_dose_groups /
cc_drug_indications / cc_drug_interactions / diseases / disease_modifiers
```

つまりSTGでは病名駆動候補(T4)に加えて、**IY-002薬剤用量チェック、薬剤適応・禁忌・相互作用
点検、病名コード化(resolve_diseases)が、リリース以来ずっと静かに無効化されていた**。
これはSTG設定PATCHが黙って落ちていたstore delegate欠落と同じ「静かな縮退」クラスの障害で、
再発防止ゲート(G1の内容検証)まで含めて修正する。

---

## G1. [P0] マスタDB成果物の再生成スクリプトと内容検証ゲート

### 1) 生成スクリプト `scripts/build_fee_master_artifact.sh`(新規)

手作業のgzip生成をやめ、検証つきの生成スクリプトに一本化する。

処理手順:

1. 入力: `python/data/master/standard-master.sqlite`(完全DB)
2. `sqlite3 <src> "VACUUM INTO '<tmp>'"` で空きページを除いたコピーを作る
   (import増分で肥大した実ファイルより小さくなる)
3. **必須テーブルの行数検証**(1つでも失敗したら非0終了・gzを作らない):

   | テーブル | 下限 | 根拠(2026-06-15世代の実数) |
   | --- | ---: | --- |
   | medical_procedures | 10,000 | 11,746 |
   | electronic_exclusions | 70,000 | 77,342 |
   | electronic_bundles | 200,000 | 248,264 |
   | electronic_frequency_limits | 5,000 | 5,928 |
   | comment_links | 15,000 | 18,201 |
   | diseases | 25,000 | 27,684 |
   | disease_modifiers | 2,000 | 2,390 |
   | cc_act_indications | 200,000 | 218,375 |
   | cc_drug_indications / cc_drug_contra_disease / cc_drug_interactions / cc_drug_dose_groups | 各 > 0 | チェックマスタ取込済みであること |
   | drugs / comments / specific_materials / hospital_facility_standards | 各 > 0 | ランタイム参照あり |

4. `gzip -9` で `standard-master.sqlite.gz` を生成し、隣に
   `standard-master.manifest.json` を書く:
   ```json
   {
     "generatedAt": "...",
     "sha256": "<gzのsha256>",
     "sourceVersions": [{"sourceType": "...", "sourceVersion": "..."}],
     "tables": {"medical_procedures": 11746, "...": 0}
   }
   ```
   sourceVersions は `master_sources` から全行を転記する。
5. 標準出力に新旧gzのサイズ・sha・テーブル行数の差分を出す。

### 2) ランタイム内容検証(再発防止の本体)

`services/fee-api/src/python-calculator.js` の `ensureMasterDbReady`(gz展開後)に追加:

- 展開したDBに対し、manifest(`FEE_MASTER_DB_MANIFEST_PATH`、既定はgzと同じディレクトリの
  `standard-master.manifest.json`)の `tables` を読み、**各テーブルの実行数が manifest の
  50%以上**であることを検証する(`SELECT COUNT(*)`。初回のみ、結果はプロセス内キャッシュ)。
- manifest が無い場合は後方互換のため警告ログのみ(移行期間)。
- 検証失敗時の挙動は `FEE_MASTER_CONTENT_CHECK`(既定 `strict`)で制御:
  - `strict`: readiness を落とす(/readyz が `masterContent: { ok: false, failedTables: [...] }` を
    返し、非readyになる)。請求系の静かな縮退は許容しない。
  - `warn`: エラーログ+readyz応答への記載のみ(緊急時の逃げ道)。
- 重要: `initialize_schema` が空テーブルを自動作成するため、**テーブル存在チェックでは
  今回の障害を検出できない。必ず行数で検証する**こと。

### 3) Cloud Run メモリの増強(必須の前提作業)

`scripts/p10_deploy_runtime_services_low_cost.sh` 82行: `FEE_MEMORY:-2Gi`。
Cloud Runの `/tmp` はメモリファイルシステムであり、完全DBの展開サイズは
旧1.59GB→**新1.71GB**。2Giのままでは展開だけでメモリをほぼ使い切り、OOMの恐れが高い。

- `FEE_MEMORY` の既定を `4Gi` へ変更する(またはfee-apiのみ4Gi指定)。
- 成果物の間引きで回避する案は**不可**と判断済み: 1.71GBのうち約1.26GBは
  `hospital_facility_standards`+索引だが、これは算定ランタイムが医療機関コードから
  施設基準を解決する経路(`lab_calculator._resolve_hospital_profile`)で参照しており、
  除外すると別の静かな縮退を作る。
- 展開時間が伸びるため、startup probe / min-instances の設定が現状で足りるか確認する。

### 4) テスト

- `services/fee-api/test/python-calculator.test.js`: manifest検証のユニットテスト
  (行数不足のfixture DB → strict で readiness 失敗、warn で警告のみ)。
- `scripts/build_fee_master_artifact.sh` はローカル完全DBがある環境で手動実行し、
  manifest の全テーブルが下限を満たすことを確認(CIでは実DBが無いためスキップ)。

### 5) 再デプロイ後の検証チェックリスト(レポートの次アクション3-4に追加)

1. `/readyz` の `masterContent.ok === true` と新sha256を確認
2. 1006を1回実行: `resolvedDiagnosisCount > 0` かつ `diseaseIndicationCandidateCount > 0`
3. **復旧確認(今回黙って死んでいた機能)**:
   - IY-002 薬剤用量チェックのスモーク(用量超過ケースで指摘が返る)
   - `checkLookup` の薬剤適応/禁忌/相互作用が非空で返るスモーク
4. 1006/1007を各3回再実行し、特定疾患療養管理料候補の反復安定(3/3)を確認
5. メモリ実測(Cloud Run metrics)が上限の80%未満であること

### 受け入れ条件

- 生成スクリプトなしで作られたgzがデプロイされても、readyzが `strict` で検出して落とす。
- STGで病名レーン・薬剤チェック群が実データで動作し、1006/1007の管理料候補が3反復安定する。

---

## G2. [P1] 月次セッション取得の患者絞り込み(T5で特定した4.6秒の主因)

### 現状(検証済み)

- 月次レセプトAPI(患者指定あり)でも `listSessionsForClaimMonth` は
  組織×請求月の**全セッションをフルドキュメントで**取得(claimMonth equality と
  serviceDate range の2クエリ、上限5,000件)し、その後メモリ上で患者に絞っている。
- 計測では月次集計の98.6%(中央値4,637ms)・差分診断の99.0%がこの取得で消費されている。

### 変更仕様

1. **store層**: `listSessionsForClaimMonth(orgId, claimMonth, options)` に
   `options.patientId`(単一)と `options.patientIds`(配列)を追加する。
   - firestore-store: `patientId` 指定時は両クエリに `.where("patientId", "==", patientId)` を追加。
     `patientIds` 指定時は**25件ずつのchunkで `where("patientId", "in", chunk)`** を並列実行し
     マージする(Firestoreの `in` 上限30に余裕を持たせる)。chunk数が多い場合
     (>4 chunk ≒ 100患者超)は従来どおり全件取得へフォールバックする。
   - memory-store(テスト用)にも同じフィルタを実装する。
   - `LazyFirestoreFeeStore` は汎用 `call` 委譲のため変更不要だが、**store delegate完全性テストが
     新シグネチャを検証対象に含むことを確認**する。
2. **server層**:
   - `listSessionsForMonthlyView` に `patientId` / `patientIds` をパススルーする引数を追加。
   - `GET /v1/fee/monthly-receipt`: クエリの `patientId` があれば渡す。
   - 既存レセ差分診断: `baseline.baselineClaims` から患者ID集合を作り `patientIds` として渡す
     (externalPatientId→patientId のマッピングが取れないbaselineでは従来どおり全件)。
   - 月次サマリ(claim summary)・一括候補は全患者対象のため従来どおり。
3. **インデックス**: `firestore.indexes.json` に複合インデックスを追加:
   - `feeSessions: (patientId ASC, serviceDate ASC)` — serviceDate範囲×patientId等価に必須
   - claimMonth等価×patientId等価は単一フィールド索引のマージで動くため追加不要だが、
     デプロイ後に実クエリでFAILED_PRECONDITIONが出ないことを確認し、出る場合は
     `(patientId ASC, claimMonth ASC)` も追加する。
   - インデックスのデプロイ手順(`gcloud firestore indexes` / terraform)を実行ログつきで記録する。
4. **計測**: T5の区間メトリクスはそのまま使う。変更後に
   `listSessionsForMonthlyView` の中央値が患者指定ありで大幅減(目標: 500ms未満)することを
   STGで確認する。

### テスト

- server.test.js: 患者指定ありの月次レセプトで store が `patientId` を受け取ること
  (スパイstore)。差分診断で baseline 患者集合が `patientIds` として渡ること。
- store側: memory-store実装に対するフィルタ動作テスト。
- 回帰: 患者指定なしの月次サマリが全患者分を返し続けること。

### 受け入れ条件

- STGで患者別月次レセプトの `listSessionsForMonthlyView` 区間が中央値500ms未満。
- 差分診断のセッション取得区間が baseline 患者数に比例したサイズに縮む。

---

## 残る候補揺れについて(チケット化しない判断の記録)

1006/1007で残った出没は次の2つで、いずれも既存の追跡項目に帰着する:

- `113001810 特定疾患療養管理料`: **G1完了後にT4病名レーンが決定論提示するため解消見込み**。
  G1の受け入れ条件で確認する。
- `140005610 酸素吸入`: LLMイベントレーン由来(処置の実施記載の抽出揺れ)。本文が
  「酸素吸入」をそのまま含むなら辞書スキャンが安定して拾うはずで、揺れているということは
  本文表現が別表記(酸素投与/O2等)の可能性が高い。これは改革2第2段(本文側の文字重なり/
  埋め込み照合)の担当領域(`fee-candidate-stability-followup-20260716.md` F4参照)。
  G1再計測のrawで該当受診の候補basisを確認してから判断する。

## 次のアクション順序

1. **G1**(生成スクリプト→メモリ増強→再デプロイ→復旧確認チェックリスト)
2. G1の再計測で T4/T6 をクローズ判定(特定疾患療養管理料の3反復安定)
3. **G2**(月次クエリ絞り込み)→ T5メトリクスで効果確認
