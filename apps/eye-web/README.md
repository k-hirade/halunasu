# Eye Web

ハルナス眼科カルテの Web アプリです。患者検索・受付一覧、患者ごとの経過、左右眼の構造化カルテ、シェーマ、点眼処方、版管理を `eye-api` 経由で提供します。

```bash
npm run dev --workspace @halunasu/eye-web
```

必要な環境変数:

- `PLATFORM_PROXY_TARGET`
- `EYE_PROXY_TARGET`
- `NEXT_PUBLIC_PLATFORM_BASE_URL=/api/platform`
- `NEXT_PUBLIC_EYE_BASE_URL=/api/eye`
- `HALUNASU_ENV=local|stg|prod`
