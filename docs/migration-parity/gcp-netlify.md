# GCP / Netlify Migration Parity

## Current Finding

Netlifyの独自ドメイン設定とCloud Run proxyは構成済みだが、監査開始時点でデプロイされている中身は旧アプリ相当ではなかった。特に `charting.halunasu.com/sessions` はNetlify fallbackで `index.html` を返していたため、ルート存在確認だけでは移行完了を判断できなかった。

2026-05-30時点で `apps/charting-web` はNext.jsへ戻し、旧静的 `index.html` は削除済み。STG/PRODともNetlify Next.js配信へ切り替え、Cloud Run Gatewayへの同一オリジンproxy、独自ドメイン上のログイン、Core共有患者/施設/診療科取得、session作成を確認済み。

最終移行結果は `docs/migration-parity/2026-05-30-complete-migration-report.md` を正とする。

## Target Responsibility Split

共通プラットフォームは必須で維持する。

| 領域 | GCP project責務 | データ |
| --- | --- | --- |
| Core PROD/STG | platform-api, shared Firestore, shared secrets, auth/session, core-admin backend | org, member, facility, department, patient, entitlement, audit |
| Charting PROD/STG | charting gateway, finalize, live STT, SOAP, audio storage | encounter/session, transcript, SOAP, raw audio, pairing, recorder |
| Fee PROD/STG | fee-api, calculation worker/artifacts | fee session, calculation result, review item, receipt draft, master metadata |
| Referral PROD/STG | referral-api, PDF generation/artifacts | referral draft, generated document metadata |
| Netlify | browser apps | LP, core-admin, charting, fee, referral |

注意: Chartingの旧互換GatewayをそのままCore projectへ接続してはいけない。旧schemaがCore Platform schemaと衝突するため、Charting product projectに置くか、Core Platform storeへのbridgeを実装する。

## Project Creation Guidance

必要ならアプリごとにGCP projectを分ける。ただし作るだけでは移行ではない。以下が揃う場合に作成/再作成する。

- product-specific Firestore/GCS/Cloud RunをCoreから分離する必要がある。
- Core shared dataを複製せず、ID/snapshot参照にできる。
- Cloud Runは `min-instances=0`、低traffic、max instances制限で費用を抑えられる。
- STG/PRODのbilling accountは環境ごとに使い分ける。

## Netlify Completion Criteria

- Git連携または再現可能なdeploy scriptがある。
- 各appのbuild command/base/publishが現行実装に合っている。
- Next.js appは`@netlify/plugin-nextjs`を使う。
- `charting-web` は `apps/charting-web` をbase directoryにし、`npm run build` + `.next` + `@netlify/plugin-nextjs` でdeployする。
- `charting-web` のHTTP APIはNext.js route handlerで `/api/v1/*` から `charting-gateway-*` Cloud Runへ同一オリジンproxyする。
- `charting-web` のWebSocketは `GATEWAY_WS_URL` で `wss://charting-gateway-*/ws` へ直接向ける。
- 静的SPA fallbackで未実装ルートを隠さない。
- PROD/STG custom domainが意図したsiteに設定されている。

## Required Deploy Checks

各デプロイ後に最低限確認する。

```bash
curl -sS -I https://charting.halunasu.com/sessions
curl -sS https://charting.halunasu.com/sessions | shasum
curl -sS https://charting.halunasu.com/ | shasum
```

`/sessions` と `/` が同一HTMLならCharting migrationは未完了。

Charting Next.js deploy:

```bash
npm run deploy:netlify-charting-next -- --env stg --apply
npm run deploy:netlify-charting-next -- --env prod --apply
```

このscriptはCloud Runの `charting-gateway-{env}` URLを解決し、`GATEWAY_PROXY_TARGET` と `GATEWAY_WS_URL` をbuild時に渡す。

## 2026-05-30 Deploy Result

実施済み:

- GCP provisioning再適用。
- `charting-gateway-stg` 用Service Account/Secret/IAM追加。
- `platform-api-stg` Cloud Run再deploy成功。
- `charting-gateway-stg` Cloud Run新規deploy成功。
- `charting-gateway-prod` Cloud Run deploy成功。
- `fee-api-stg` / `fee-api-prod` Cloud Run deploy成功。公式master gzip同梱、runtime展開、代表算定まで確認済み。
- `referral-api-stg` / `referral-api-prod` Cloud Run deploy成功。紹介状draft/document artifact生成まで確認済み。
- `apps/charting-web` をSTG/PRODのNetlify Next.js siteへdeploy。
- LP/Core Admin/Fee/Referralの静的Netlify siteをSTG/PRODへdeploy。

確認結果:

- `charting-gateway-stg` / `charting-gateway-prod` はCloud Run上でReady。
- STG `https://charting-gateway-stg-3rl7ei3i4a-an.a.run.app/readyz` は200。
- PROD `https://charting-gateway-prod-6dyw4sykta-an.a.run.app/readyz` は200。
- STG `https://charting.stg.halunasu.com/sessions` は200で旧Next.jsのセッション一覧を返す。
- PROD `https://charting.halunasu.com/sessions` は200で旧Next.jsのセッション一覧を返す。
- STG/PROD `GET /api/v1/operator/csrf` はNetlify proxy経由でGatewayへ到達し、未認証時401を返す。
- PROD `prod-test/goshi` は `https://charting.halunasu.com` でlogin、`/api/v1/operator/me`、`/api/v1/sessions` まで成功。
- STG/PROD `prod-test/migration-check` はCharting login、Core患者/施設/診療科取得、session作成まで成功。
- STG/PROD FeeはNetlify proxy経由でPlatform login、Core患者/施設/診療科取得、fee session作成、公式master実算定まで成功。
- STG/PROD ReferralはNetlify proxy経由でPlatform login、Core患者/施設/診療科取得、referral draft作成、HTML document artifact生成まで成功。
- PROD `https://halunasu.com`、`https://admin.halunasu.com`、`https://fee.halunasu.com`、`https://referral.halunasu.com` は200。

対応済み修正:

- `.gcloudignore` に `python/medical_fee_calculation` を追加し、Fee API Docker build contextへPython bridgeを含めた。
- `services/charting-gateway` がCloud Runの `PORT` を優先するよう修正。
- `services/charting-gateway` に `/readyz` を追加。
- `p10_deploy_runtime_services_low_cost.sh` に `TARGET_ENV` / `TARGET_SERVICE` を追加し、再deploy範囲を絞れるようにした。
- Netlify Next Runtimeの生成物が `apps/charting-web/apps/charting-web/.netlify` 側へ出る問題を、`scripts/p16_deploy_charting_next_netlify.mjs` のsync/patch/deploy処理で再現可能にした。
- `.gcloudignore.fee-api` を追加し、Fee APIだけ公式master gzipをCloud Build contextへ含めるようにした。
- `p10_deploy_runtime_services_low_cost.sh` はFee APIを `memory=2Gi` / `timeout=180s` にしつつ、`min=0` / `maxScale=1` を維持する。
- Fee APIのOpenAIカルテ構造化は `OPENAI_FEE_CLINICAL_TIMEOUT_MS=0` を既定とする。これはSOAP生成と同じくアプリ側で短時間abortしない設定で、OpenAIが遅い時も構造化結果を待ち、算定精度を優先する。Cloud Run全体のtimeoutは別途 `180s` のまま。

運用メモ:

- Chartingの `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` secretは新projectに未設定。secret追加後の再deployに備え、deploy scriptは任意secretを自動接続する。
- 実AI STT/SOAP smokeは費用が発生するため今回の自動post-deploy検証から外した。
