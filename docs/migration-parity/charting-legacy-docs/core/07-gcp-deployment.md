# GCP Deployment Plan

## 環境前提

### 現在の整理

| 種別 | 値 |
|---|---|
| canonical STG project | `medical-stg-493105` |
| historical / dev project | `medical-492407` |
| primary region | `asia-northeast1` |
| frontend hosting | Netlify |
| app name | `ハルナス` |

この文書では、`medical-stg-493105` を現在の基準環境として扱う。

## Cloud サービス

| サービス | 用途 | 現在の扱い |
|---|---|---|
| Netlify | `apps/web` 配信 | 標準 |
| Cloud Run `medical-gateway` | 認証、API、WebSocket、録音、SOAP | 標準 |
| Cloud Run `medical-billing` | 申込、初回設定、Stripe | 実装あり |
| Cloud Run `medical-finalize` | 非同期 finalization worker | optional path |
| Firestore | durable app state | 標準 |
| Cloud Storage | raw audio / artifacts | async finalize 時に使用 |
| Cloud Tasks | finalize queue | async finalize 時に使用 |
| Secret Manager | API key / signing secret | 標準 |

## 現在の標準 runtime

### gateway

- service: `medical-gateway`
- region: `asia-northeast1`
- `STORE_BACKEND=firestore`
- `FINALIZE_MODE=inline`
- `LIVE_STT_PROVIDER=openai`
- `LIVE_STT_FALLBACK_PROVIDER=deepgram`
- `max-instances=1`

`max-instances=1` は暫定ではなく、現行 fanout が instance-local であることに対応した意図的な設定である。

### finalize worker

- code と deploy script はある
- ただし current standard path は inline finalize
- PHI を前提にした本番運用では async path を有効にする前提で考える

### billing service

- `services/billing` は独立 service boundary
- build 用に `cloudbuild.billing.yaml` がある
- gateway と同じ operator auth / CSRF model を共有する

## デプロイスクリプト

### gateway

- [scripts/bootstrap_gcp_serverless.sh](../../scripts/bootstrap_gcp_serverless.sh)
- [scripts/deploy_cloud_run_zero_fixed.sh](../../scripts/deploy_cloud_run_zero_fixed.sh)

### finalize

- [scripts/deploy_finalize_cloud_run.sh](../../scripts/deploy_finalize_cloud_run.sh)
- [cloudbuild.finalize.yaml](../../cloudbuild.finalize.yaml)

### billing

- [cloudbuild.billing.yaml](../../cloudbuild.billing.yaml)

billing だけ gateway / finalize のような専用 deploy script はまだない。

## Netlify

[netlify.toml](../../netlify.toml) が source of truth。

現状の重要点:

- `base = "apps/web"`
- `command = "npm run build"`
- `publish = ".next"`
- Node `20`
- CSP の `connect-src` は gateway / run.app を許可する

運用方針:

- API / WebSocket は Netlify proxy を使わず Cloud Run に直接接続する
- `APP_BASE_URL` と `ALLOWED_ORIGINS` は Netlify domain に合わせる

## 必須 secret

- `PAIRING_SIGNING_SECRET`
- `APP_SESSION_SIGNING_SECRET`
- `APP_ACCESS_PASSWORD`
- `APP_FIELD_ENCRYPTION_KEY` 本番の特権 MFA で必須

### provider secret

- `OPENAI_API_KEY`
- `DEEPGRAM_API_KEY`

### async finalize 追加 secret / env

- `FINALIZE_INTERNAL_SECRET`
- `RAW_AUDIO_GCS_BUCKET`
- `RAW_AUDIO_GCS_PREFIX`
- `FINALIZE_ENDPOINT`
- `FINALIZE_TASKS_QUEUE`
- `FINALIZE_TASKS_PROJECT_ID`
- `FINALIZE_TASKS_SERVICE_ACCOUNT_EMAIL`

## 推奨 env

### live STT

- `LIVE_STT_MODE=provider`
- `LIVE_STT_PROVIDER=openai`
- `LIVE_STT_FALLBACK_PROVIDER=deepgram`
- `OPENAI_REALTIME_WS_URL=wss://api.openai.com/v1/realtime`
- `OPENAI_REALTIME_CLIENT_SECRETS_URL=https://api.openai.com/v1/realtime/client_secrets`
- `OPENAI_REALTIME_MODEL=gpt-4o-mini-transcribe`

### finalize

- `FINALIZE_MODE=inline` を現在の既定とする
- `OPENAI_FINAL_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`
- `OPENAI_FINAL_TRANSCRIBE_LANGUAGE=ja`
- `OPENAI_SOAP_MODEL=gpt-5.4-nano`
- `OPENAI_SOAP_REASONING_EFFORT=low`

## デプロイ戦略

### 現在の推奨

1. Netlify に `apps/web` を配信
2. Cloud Run に `medical-gateway` を deploy
3. Firestore を durable store に使う
4. まず `FINALIZE_MODE=inline` で STG を回す
5. provider key を付与し、OpenAI primary / Deepgram fallback を確認する

### 本番前に切り替えるもの

1. `FINALIZE_MODE != inline`
2. `RAW_AUDIO_GCS_BUCKET` を設定
3. `medical-finalize` を private ingress で deploy
4. Cloud Tasks queue を設定
5. retention cleanup を schedule する

## 運用上の注意

### health check

- `medical-gateway`: `GET /healthz`
- `medical-billing`: `GET /healthz`
- `medical-finalize`: `GET /healthz`

### ログ / 指標

最低限追うもの:

- operator login failure rate
- live STT provider failure rate
- fallback 発動率
- finalize duration
- SOAP generation duration
- websocket disconnect rate
- billing webhook failure rate

### retention

- `npm run ops:retention:dry-run`
- `npm run ops:retention:apply`

raw audio retention は Cloud Storage lifecycle と cleanup job の両方を前提にする。

## ロールアウト順

1. STG で inline finalize を安定化
2. billing / onboarding の end-to-end を確認
3. provider key を本番相当にする
4. async finalize を有効化
5. その後に multi-region や standby を検討する
