# 抽出カバレッジ限定再確認 STG fixture

`cases.json` は、OpenAI主経路とMiniLM Span補助再確認をSTGで確認するための
合成カルテです。実患者情報は含みません。

対象:

- 同一行の複数行為
- 文書交付
- 過去・他院・否定・予定の安全反例
- 通常の当日処置
- 長めの在宅カルテ

実行:

```bash
npm run eval:fee-extraction-coverage-recheck-stg -- \
  --expected-mode verify \
  --organization-code yamamoto-demo-stg \
  --login-id yamamoto-admin \
  --password-file .secrets/yamamoto-demo-stg-password.txt \
  --mfa-code "$FEE_E2E_MFA_CODE" \
  --facility-id fac_9fe275b29feebb03bfeb9410f7 \
  --department-id dep_0a9c99c2dedcf0b6247294ef6a
```

結果にはカルテ本文を保存せず、入力SHA-256、件数、候補・確定明細、
追加OpenAI呼び出し数、revision、Span artifact versionだけを残します。
