# 測定方法

## 条件

- 実行日: 2026-07-16
- API: Platform STG / Fee STG
- 組織: `yamamoto-demo-stg`
- 対象: `1002 / 1003 / 1005`
- 請求月: 2026-06
- 反復: 各患者1回
- 既知受診歴: seedあり
- CLI受診区分: 全受診`home_visit`

患者ごとに次を実行した。

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/1002 \
  --repeat 1 \
  --seed-known-prior-history \
  --encounter-setting home_visit \
  --output-dir docs/20260716-yamamoto-demo-stg-additional-3patients-20260716_211245/1002/raw
```

## 入力分離

算定入力にはカルテ、患者属性、病名、明示した既往歴と受診区分だけを使用した。`orders.csv`、既存UKEコード、
期待`claimContext`は算定入力へ渡さず、既存UKEは算定完了後の比較にのみ使用した。

各結果で以下を確認した。

- `environment.organizationCode = yamamoto-demo-stg`
- `environment.feeSettings.persisted = true`
- `summary.allCalculationsUsedOpenAi = true`
- カルテ本文、患者名、認証情報は保存結果に含まれない
- 正解レセは算定完了まで非公開

## 制約

- 1002は訪問3件と電話再診1件、1003は電話再診1件と訪問1件が混在する。
- 現行CLIは受診単位の区分を持たないため、すべて`home_visit`として算定した。
- 1002の同一建物区分も入力していない。
- 1反復なので抽出安定性は評価していない。
- 確認候補を人が採用していないため、最終レセプト精度ではない。
