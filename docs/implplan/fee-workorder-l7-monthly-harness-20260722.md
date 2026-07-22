# 作業依頼: L7月次計測ハーネスの修正(M1〜M8) (2026-07-22)

対象Run: `docs/20260722-longitudinal-l7-mock-20260722_185226/`(L7未合格)。
親チケット: `fee-longitudinal-phase1-closeout-20260722.md` L7。

## 背景と結論

L7再測定は確定0点・UKE一致0で未合格だったが、主因は製品ではなく**評価ハーネスが
受診区分と同一建物区分を入力できないこと**にある。調査の結果:

- `POST /v1/fee/sessions` は既に `setting`(outpatient/inpatient/home_visit/house_call:
  `packages/fee-contracts/src/index.js:3`)と `encounterDetails {sameBuilding,
  sameBuildingSource, singleBuildingPatientCount}`(同`:126`付近、正規化は`:479-530`)を
  受け付ける。**API・エンジンの変更は不要**。
- データセット側にも必要情報は既にある: `charts.jsonl` の `visit_type/status`
  (定期/電話再診/往診)、`patients.csv` の `is_facility` / `facility_count`
  (1002=4, 1004=6, 1010=5, 1011=6, 他はFalse/1)。
- 空抽出ガードのmetricsはサーバが calculate 応答の
  `metrics.clinicalStructuring.extractionMode` / `.emptyExtractionGuard` として返している
  (`services/fee-api/src/clinical-calculation-input.js:1962-1966`)。
  月次ハーネスは `extractionMemo` しか写しておらず
  (`scripts/evaluate_fee_monthly_chart_e2e.mjs:557-580`)、ガード挙動が結果に残らない。

つまり修正はすべて `scripts/evaluate_fee_monthly_chart_e2e.mjs` とfixture解釈、
および再走プロトコルに閉じる。

---

## M1. [P1] 受診ごとの区分・同一建物入力(ハーネスのみ)

### 仕様

`scripts/evaluate_fee_monthly_chart_e2e.mjs` のセッション作成payload
(現状 `setting: encounterSetting` を全カルテ一律で送っている箇所、`:274-283`付近)を
受診単位の導出に変える。

1. **区分マッピング**(charts.jsonlの`visit_type`/`status`から決定論導出):
   - `定期` → `home_visit`
   - `往診` / `臨時` → `house_call`
   - `電話` / `電話再診` → `outpatient`(電話等再診料の判定は現行どおりエンジンが
     本文から行う。visitKindの本体対応はH3の別課題であり、ここでは区分だけ正す)
   - 未知の値 → **エラーで停止**(黙ってoutpatientに落とさない)。
2. **encounterDetails**(patients.csvから患者単位で導出し、home_visit/house_callの
   全受診に付与):
   - `is_facility=True` かつ `facility_count>=2` →
     `{sameBuilding: true, sameBuildingSource: "user", singleBuildingPatientCount: facility_count}`
   - `is_facility=False` → `{sameBuilding: false, sameBuildingSource: "user"}`
   - 契約上の注意: sameBuildingが既知なら`sameBuildingSource`必須。`"dom"`は
     件数整合の追加検証があるため使わず、データセット由来の入力は`"user"`とする
     (`packages/fee-contracts/src/index.js:490-530`)。
   - `outpatient`受診(電話再診)にはencounterDetailsを付けない。
3. CLIオプション: `--encounter-setting` は**明示上書き**として残す(指定時は従来どおり
   一律適用+警告表示)。未指定時はcharts.jsonlから導出する新挙動をデフォルトにする。
4. `result.json` の `inputAudit` に受診ごとの `{serviceDate, visitType, setting,
   sameBuilding, singleBuildingPatientCount}` を記録する(本文は含めない)。

### テスト

- `--dry-run` で1002の4受診が `home_visit×3 + outpatient×1`、
  `sameBuilding=true/count=4` になることを確認するユニット(導出関数を純関数に切り出す)。
- 未知visit_typeで例外。
- 個人宅患者(1006等)で `sameBuilding=false` が付くこと。

### 受入基準

- 再走時、訪問診療料とベースアップ評価料の同一建物コード選択が**保留0件**になり、
  確定明細に乗ること(前回は`services/fee-api/src/server.js:7424-7435`の保留分岐に
  全件落ちていた)。

## M2. [P1] ガード・抽出モードのper-visit記録(ハーネスのみ)

`scripts/evaluate_fee_monthly_chart_e2e.mjs:557-580` の per-visit 記録に追加:

1. `extractionMode`(`metrics.clinicalStructuring.extractionMode`:
   memo_only / line_subset / full / full_with_retry / line_subset_with_full_retry)
2. `emptyExtractionGuard`(同`.emptyExtractionGuard`:
   enabled / triggered / reasonCodes / retryAttempted / recovered /
   initialEventCount / finalEventCount)
3. summary集計に `emptyExtractionGuard: {triggeredVisitCount, recoveredVisitCount,
   unrecoveredVisitCount}` と `extractionModeCounts` を追加。
4. L7用summary.json(`fee-longitudinal-l7-summary.v1`)にも同項目を追加し、
   schemaVersionを`v2`へ上げる。

## M3. [P1] 1011カルテ3(0→3→0イベント)のガード検証

前回Runでは1011の3カルテ目が反復間で0/3/0イベントだった。反復2で3イベント取れている
以上、抽出可能な内容があるのに2回空振りしており、ガードが発火したかどうかは
記録がなく不明(M2の理由)。

1. M2実装後、1011のみ `--repeat 3` で再走し、当該受診の
   `emptyExtractionGuard.triggered` を確認する。
2. **発火していない場合**: トリガー3条件(`detectEmptyExtractionContradiction`:
   辞書ヒット / オーダー言及 / 病名言及)のどれも満たさなかった理由を特定する。
   喀痰吸引(140003810)は手技マスタ収載であり、本文に記載があるなら
   `dictionaryScanCandidateProposals` がヒットするはず。ヒットしないなら
   辞書スキャン側の正規化・語彙の問題として修正する。
3. **発火して未回復の場合**: 「AI抽出が空でした」確認事項が出ていることを確認し、
   リトライ1回の限界事例として記録する(仕様どおり。追加リトライはしない)。
4. トリガー条件の拡張は、この検証で根拠が出た場合のみ行う(推測で広げない)。

## M4. [P1] 1002の電話再診の土俵復帰

M1のマッピングにより1002の電話カルテは `outpatient` で送られる。

- 受入基準: 電話等再診料 `112007950`(既存UKEの1行)が候補または確定として
  検知対象に乗ること。乗らない場合は理由を記録する(H3対応が必要なら
  H3チケットへ根拠として追記し、このRunでは既知差分として扱う)。

## M5. [P2] メモ無効対照の要否判定

全行置換データではメモは構造的に不使用(前回60/60でmemoUsed=0)であり、
memoUsed=0のRunでは「メモ有効化の悪化」は定義上起こらない。よって:

1. M6再走で `memoUsedVisitCount=0` を確認できたら、メモ無効対照Runは**不要**とし、
   その論理をREADMEに明記する(メモ非関与の証明がそのまま無害性の証明になる)。
2. 万一 `memoUsed>0` の受診があれば(seed履歴と本文の偶然一致等)、同一イメージで
   `FEE_EXTRACTION_MEMO=false` の対照Runを追加する。env変更でrevisionは変わるため、
   同一性はCloud Runの**コンテナイメージdigest一致**で担保し、READMEに記録する。

## M6. [P1] 再走プロトコルと受入基準

M1〜M2実装後、5患者×3反復を再走する(組織・施設・revision固定、readyz前後記録は
前回同様)。判定は次の3群に**分離**する:

1. **ハーネス修正の効果**(このチケットの合否):
   - 同一建物コード選択の保留0件、確定明細が非0点
   - 電話再診カルテがoutpatientで処理される
   - per-visit inputAuditとガードmetricsが記録される
2. **L7本来の受入**(親チケットの合否):
   - `memoUsedVisitCount=0` が正常(全行置換データ)
   - `completeness=unavailable` 0件
   - UKE検知・確定一致が旧正条件Run
     (`docs/20260714_mockpartner_remaining_patients_e2e_20260714_205524/`、
     `docs/20260716-yamamoto-demo-stg-additional-3patients-20260716_211245/`)比で
     非悪化。ただし組織・施設設定が異なる点は差分要因として明記する
3. **LLM揺れ**(M7へ分離、L7の合否に含めない):
   - 月次候補点数・確認事項数・イベント数の反復間変動

## M7. [P2] 抽出揺れの別課題化

前回Runで定量化された全文抽出の揺れ(イベント数安定 0/20受診、確認事項安定 0/5患者、
1002の人工呼吸検出1/2/3回=302/604/906点、1011の喀痰吸引出没)は、縦断メモとは独立の
既知課題である。`fee-candidate-stability-tickets-20260715.md` 系の安定性課題に
本Runの数値を実測根拠として追記し、L7の合否からは切り離す。
(実運用ではcopy-forwardカルテの継続行がメモで固定されるため、この揺れの実効影響は
新規行に限定される——という見立てもそこに記載する。)

## M8. [P3・任意] copy-forward版mockタイムラインの作成

現mockデータは全行置換のため、**月次経路でのメモの実効性(削減率・揺れ抑制)は
このデータでは永遠に測れない**。Do記載(前回カルテの継続行+当日差分)を模した
時系列fixtureを合成し、M6と同じハーネスで memoHitLineRatio>0 の月次計測を
可能にする。着手は任意だが、PROD有効化判断の「実データcopy-forward率」計測の
リハーサルとして価値がある。

## 実施順

M1+M2(ハーネス修正、同一PR可) → M3(1011検証) → M6(本再走) → M4はM6に内包 →
M5(要否判定) → M7(別課題転記) → M8(任意)。

M6の1群・2群がともに合格した時点で、親チケットL7を合格とし、Phase 1をクローズする。
