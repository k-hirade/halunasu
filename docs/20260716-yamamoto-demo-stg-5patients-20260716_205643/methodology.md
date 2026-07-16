# 測定方法

## 対象

- 実行日時: 2026-07-16 20:57-21:01 JST
- Platform API: STG
- Fee API: STG
- 組織コード: `yamamoto-demo-stg`
- 対象患者: `1001 / 1004 / 1006 / 1007 / 1012`
- 請求月: 2026-06
- 反復: 各患者1回
- 合計受診: 15件

## 入力

各患者の`charts.jsonl`、`patients.csv`、`diagnoses.csv`を再算定入力に使用した。既存UKEは算定後の
比較にだけ使い、正解コード、構造化オーダー、`claimContext`、`calculationOptions`は算定入力へ渡していない。

既往歴不足による初再診判定の混入を避けるため`--seed-known-prior-history`を使い、今回の在宅中心データに
合わせて`--encounter-setting home_visit`を指定した。ただしこの値は全受診共通であり、同一建物区分や
定期訪問・臨時往診の違いは表現できない。

## 施設設定

実行時にFee Firestoreの施設設定を読み取り、各`result.json`へ次を記録した。

- persisted: `true`
- effectiveFrom: `2026-06-01`
- 施設基準: `zaitaku_data_teishutsu_kasan`、`base_up_hyoka_1`
- 自動算定ルール: `home_visit_fee`、`home_visit_baseup`、`zaitaku_data_addon`

## 実行コマンド

患者ID部分と出力先を変えて、次を5回直列実行した。

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/1001 \
  --repeat 1 \
  --seed-known-prior-history \
  --encounter-setting home_visit \
  --output-dir docs/20260716-yamamoto-demo-stg-5patients-20260716_205643/1001/raw
```

## 指標

- 確定一致: 月次の確定明細でコード、回数、合計点数が既存UKEと一致したコード。
- 候補込み検知: 確定明細に加え、要確認候補または曖昧コード候補で同じコードに到達したもの。
- 既存のみ: 既存UKEにはあるが、確定明細に存在しないコード。
- 確認事項数: 各受診で生成されたレビュー事項の合計。重複・関連事項を含み、固有問題数ではない。

## 制約

- 1反復なので、`stable=true`は実質的な安定性証明ではない。
- 全受診に同じ`home_visit`条件を与えており、患者別・受診別の請求条件を完全には再現していない。
- 人による候補採用を行っていないため、最終レセプト作成精度ではない。
- 既存UKEは比較基準であり、診療録と算定要件に照らした正解監査は行っていない。
- STGのCloud Run起動状態、OpenAI負荷、Firestore負荷は統制していない。

## 保存データ

各患者の`raw/result.json`は、カルテ本文、患者名、認証情報を含まない。結果内の`security`で
`chartTextIncluded=false`、`patientNameIncluded=false`、`credentialsIncluded=false`、
`expectedReceiptWithheldUntilComparison=true`を5患者すべて確認した。
