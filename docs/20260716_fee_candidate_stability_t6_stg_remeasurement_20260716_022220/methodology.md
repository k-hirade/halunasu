# 測定方法

## 目的

候補安定化T1〜T5を前提に、同一カルテを3回処理したときの確定点数、月次候補、確認事項、
抽出イベント、既存UKE検知率、応答時間を患者単位で評価する。

## 対象データ

`tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/`
配下の1001、1004、1006、1007、1012を使用した。データはモックHOMIS由来の合成データである。

## 実行条件

- STGのplatform-apiとfee-apiへ直接接続
- 組織: `nishiyama-demo-stg`
- 各患者3反復
- 全受診を`home_visit`として送信
- `patients.csv.start_date`を既知受診歴として各反復の前にseed
- 月次候補は採用せず、そのまま既存UKEと比較
- 5患者は負荷干渉を避けるため直列実行

実行コマンドの形式:

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir <patient_sources>/<patient-id> \
  --repeat 3 \
  --seed-known-prior-history \
  --encounter-setting home_visit \
  --output-dir <report-dir>/<patient-id>/raw
```

認証情報は`.secrets/nishiyama-demo-password.txt`から読み、結果JSONには保存していない。
患者氏名、カルテ本文、ログインID、パスワードもraw結果には保存していない。

## 指標定義

- **確定一致**: 既存UKEと当社の確定月次明細で、コード・回数・点数が一致したコード数。
- **候補込み検知**: 確定明細に月次候補の`code`と`codeCandidates`を加えた場合に検知できた既存コード数。
- **候補安定**: `candidateLines`のコード候補集合、名称、数量、点数が3反復で同一。
- **確認事項安定**: セッションの確認事項集合が3反復で同一。
- **イベント最大差**: 同じ受診で抽出された臨床イベント数の最大値と最小値の差。
- **応答時間**: 評価クライアントから見たHTTPリクエスト時間。

CLIが出す`candidateResultStable`はセッション側の確定明細署名を基準にしており、月次候補の安定性を
表していない。今回の判定では`monthly.candidateLines`と`monthlyCandidateTotalPoints`を使用した。

## 実行前確認

`fee-api /readyz`はHTTP 200を返し、次を確認した。

- environment: `stg`
- master version: `2026-06-15`
- master DB configured: `true`
- worker mode: `persistent`

STGの有効施設に`facilityStandardKeys`は登録されていなかった。元データも空であるため、推測値は投入していない。

## 妥当性制約

計測完了後、T1/T2/T4/T5の未反映を示す応答が見つかった。このため本測定は現行STGの基準値であり、
T1〜T5デプロイ後の受け入れ測定ではない。T1〜T5反映後も同じ条件・同じ指標で再実行する。
