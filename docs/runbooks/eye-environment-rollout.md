# Eye EMR environment rollout

Last updated: 2026-10-27

ハルナス眼科カルテ（`eye-api` / `eye-web`）を STG・PROD に出す手順。care-fee と同じ低コスト構成（Cloud Run min=0 / max=1、Firestore、Netlify）で、眼科のデータは専用プロジェクトに置く。患者マスタ・ログイン・権限は Core（platform）を共有する。

| Environment | GCP project | Cloud Run | Netlify site | Domain |
| --- | --- | --- | --- | --- |
| STG | `halunasu-eye-stg` | `eye-api-stg` | `halunasu-eye-stg` | `eye.stg.halunasu.com`（IP 制限あり） |
| PROD | `halunasu-eye-prod` | `eye-api-prod` | `halunasu-eye-prod` | `eye.halunasu.com` |

## 0. Local release gate

```bash
npm test --workspace @halunasu/eye-contracts
npm test --workspace @halunasu/eye-core
npm test --workspace @halunasu/eye-api
npm test --workspace @halunasu/eye-web          # 実 API（メモリ）＋ブラウザの通しテストとビルド
node --test packages/product-boundaries/test/index.test.js packages/security-boundaries/test/index.test.js
```

ローカルで触る場合:

```bash
node scripts/dev_eye_stack.mjs   # platform-api :8086 / eye-api :8087（メモリ、デモ組織 eye-local）
PLATFORM_PROXY_TARGET=http://127.0.0.1:8086 EYE_PROXY_TARGET=http://127.0.0.1:8087 \
  npm run dev --workspace @halunasu/eye-web
```

## 1. Create and activate the STG project

```bash
gcloud projects create halunasu-eye-stg --name="Halunasu Eye STG" --organization=634072823240

scripts/p10_activate_product_project_guarded.sh eye stg            # dry-run
P10_ALLOW_BILLING=yes BILLING_ACCOUNT_ID=017363-055589-E21116 \
  scripts/p10_activate_product_project_guarded.sh eye stg --apply
```

## 2. Provision

Firestore（asia-northeast1）、Artifact Registry、Cloud Build 用バケット、実行用サービスアカウント `halunasu-eye-api`、セッション署名シークレットを作る。サービスアカウントには Core Firestore への `roles/datastore.user` を付ける（患者の登録・更新と Core 監査記録のため）。

```bash
TARGET_PRODUCT=eye TARGET_ENV=stg scripts/p10_provision_runtime_projects_low_cost.sh            # dry-run
P10_ALLOW_BILLING=yes TARGET_PRODUCT=eye TARGET_ENV=stg \
  scripts/p10_provision_runtime_projects_low_cost.sh --apply

FIRESTORE_INDEXES_FILE=firestore.eye.indexes.json \
  scripts/p17_deploy_firestore_security_and_indexes.sh --apply halunasu-eye-stg
```

## 3. Deploy

platform-api は `eye` 製品 ID と「眼科ロールは二段階認証必須」の判定を含む版に更新する。

```bash
MIN_INSTANCES=0 CPU=1 TARGET_ENV=stg TARGET_SERVICE=platform-api ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
MIN_INSTANCES=0 CPU=1 TARGET_ENV=stg TARGET_SERVICE=eye-api      ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

`config/runtime-proxy-targets.json` の `stg.eye` に `eye-api-stg` の URL を入れる。

## 4. Netlify

```bash
netlify sites:create --name halunasu-eye-stg
```

`config/netlify-sites.json` の `stg.eye-web` に site ID を入れ、`provisioningStatus` を `registered` にしてから:

```bash
npm run deploy:netlify-admin-fee-next -- --env stg --app eye-web            # dry-run
STG_GATE_ALLOWED_IPS=<許可するIP> npm run deploy:netlify-admin-fee-next -- --env stg --app eye-web --apply
```

STG は `stg-gate` エッジ関数で IP を制限する。`STG_GATE_ALLOWED_IPS` が空だと 503 を返す。

## 5. Tenant

既存の組織に `eye` 製品を足す。`--products` は既存の製品も含めて全部列挙する（列挙しない製品の権限は外れる）。パスワードと MFA の登録状態は変わらない。

```bash
node scripts/p15_seed_core_account.mjs --env stg --organization-code halunasu-internal-stg \
  --organization-name "Halunasu Internal STG" --login-id <id> \
  --products fee,homis_sidecar,eye --facility-name halunasu-internal-stg --department-name 医事課 \
  --member-role-profile admin --member-display-prefix "Halunasu Internal STG" \
  --fee-project-id halunasu-fee-stg --fee-settings-file samples/yamamoto-demo-stg/fee-settings.json \
  --skip-demo-patient --password-file <既存のパスワードファイル> --apply
```

デモ用の架空患者を入れる場合は `docs/eye-demo/README.md` の手順で `scripts/seed_eye_demo.mjs` を使う（本番には `EYE_DEMO_ALLOW_PROD=yes` なしでは入らない）。

## 6. STG acceptance

- `/readyz` が `status=ok`。
- ログイン → 二段階認証 → 受診一覧。
- 患者登録、初診作成、確定、再診（前回引き継ぎ・差分・本数計算）、経過グラフ、印刷、設定。
- 受付: 予約、当日受付（受付番号）、進捗ボードの遷移、未登録患者の登録、次回予約。
- 視能訓練士・医療事務ロールでは確定できない。
- Cloud Logging に患者名やカルテ本文が出ていない。
- Cloud Run が minScale=0 / maxScale=1。

## 7. PROD

STG 受け入れ後、`halunasu-eye-prod`、課金アカウント `01AF66-9333E9-4574D9`、`P10_ALLOW_PROD=yes` で 1〜5 を繰り返す。本番で実患者のデータを扱う前に、バックアップ（隔離した別プロジェクトへの定期エクスポート）と復元訓練を済ませる。

## DNS

Cloudflare の CNAME（DNS only）を `scripts/cloudflare_upsert_dns_records.mjs --names eye.stg,eye` で登録する。トークンは `.secrets/cloudflare-dns-token.txt`（halunasu.com の DNS 編集のみ）。Netlify 側は各サイトの custom domain を設定済みで、DNS が通ると証明書は自動で発行される。
