# Care Fee Web

緊急時治療管理の独立Webアプリです。CSV一括点検、月次点検、施設設定を `care-fee-api` 経由で提供します。

```bash
npm run dev --workspace @halunasu/care-fee-web
```

必要な環境変数:

- `PLATFORM_PROXY_TARGET`
- `CARE_FEE_PROXY_TARGET`
- `NEXT_PUBLIC_PLATFORM_BASE_URL=/api/platform`
- `NEXT_PUBLIC_CARE_FEE_BASE_URL=/api/care-fee`
- `HALUNASU_ENV=local|stg|prod`
