# Security Operations Runbook

作成日: 2026-04-19

## 本番前に必須の残作業

今回のコード修正でアプリ側の経路は入ったが、以下は本番前にGCP側で必ず作成/設定する。

- raw audio用Cloud Storage bucket
- raw audio bucket lifecycle
- private `medical-finalize` Cloud Run service
- Cloud Tasks queue
- gateway service accountのCloud Tasks enqueue権限
- Cloud Tasks OIDC用service accountのfinalize invoker権限
- Cloud Schedulerによるretention cleanup日次実行
- Cloud Armor rate limit/WAF
- Cloud Logging sinkと管理者操作アラート

## raw audio / async finalize

gateway:

- `RAW_AUDIO_GCS_BUCKET=<bucket>`
- `RAW_AUDIO_GCS_PREFIX=raw-audio`
- `FINALIZE_MODE=worker`
- `FINALIZE_ENDPOINT=https://<medical-finalize>.run.app/internal/finalize`
- `FINALIZE_TASKS_QUEUE=session-finalize`
- `FINALIZE_TASKS_LOCATION=asia-northeast1`
- `FINALIZE_TASKS_PROJECT_ID=<project-id>`
- `FINALIZE_TASKS_SERVICE_ACCOUNT_EMAIL=<cloud-tasks-invoker-sa>`
- `FINALIZE_INTERNAL_SECRET` Secret Manager injection

finalize:

- `STORE_BACKEND=firestore`
- `RAW_AUDIO_GCS_BUCKET=<bucket>`
- `FINALIZE_INTERNAL_SECRET` Secret Manager injection
- `OPENAI_API_KEY` Secret Manager injection

Deploy finalize:

```bash
PROJECT_ID=medical-stg-493105 \
RAW_AUDIO_GCS_BUCKET=<bucket> \
FINALIZE_INTERNAL_SECRET_NAME=FINALIZE_INTERNAL_SECRET \
OPENAI_SECRET_NAME=OPENAI_API_KEY \
./scripts/deploy_finalize_cloud_run.sh
```

Deploy gateway with Cloud Tasks:

```bash
PROJECT_ID=medical-stg-493105 \
FINALIZE_MODE=worker \
FINALIZE_ENDPOINT=https://<medical-finalize>.run.app/internal/finalize \
FINALIZE_TASKS_QUEUE=session-finalize \
FINALIZE_TASKS_SERVICE_ACCOUNT_EMAIL=<cloud-tasks-invoker-sa> \
RAW_AUDIO_GCS_BUCKET=<bucket> \
FINALIZE_INTERNAL_SECRET_NAME=FINALIZE_INTERNAL_SECRET \
./scripts/deploy_cloud_run_zero_fixed.sh
```

## retention cleanup

Dry run:

```bash
GOOGLE_CLOUD_PROJECT=medical-stg-493105 \
STORE_BACKEND=firestore \
npm run ops:retention:dry-run
```

Apply:

```bash
GOOGLE_CLOUD_PROJECT=medical-stg-493105 \
STORE_BACKEND=firestore \
npm run ops:retention:apply
```

運用ではCloud Schedulerから日次実行する。削除件数は月次で確認し、異常に多い場合は実行を止めて調査する。

## 録音端末の紛失/廃棄

1. Web管理画面で `設定 > 録音端末` を開く。
2. 対象端末の `失効` を押す。
3. 必要に応じて該当メンバーの `失効` でログインsessionも失効する。
4. `操作ログ` で `録音端末失効` が残ることを確認する。

## 監査で確認するイベント

- `auth.mfa_failed`
- `member.mfa_reset`
- `member.mfa_enabled`
- `member.status_updated`
- `member.password_reset`
- `trusted_recorder.registered`
- `trusted_recorder.revoked`
- `audio.raw_audio.stored`
- `soap.finalize.enqueued`
- `retention.cleanup.completed`
