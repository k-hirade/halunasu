# Charting / Fee / LP Complete Migration Tasks

最終更新: 2026-05-30

## 結論

カルテ作成、診療報酬算定、LPの完全移行は「画面が出る」だけでは完了にしない。旧3アプリを再確認した結果、完全移行の残タスクは以下に集約する。

1. Charting: 旧Next.js UIと旧Gatewayは復元/デプロイ済みだが、録音からSOAP生成/再生成/承認までの実環境操作確認、Core shared patient/facility/department bridge、Billing画面のCore Billing接続が残る。
2. Fee: Python算定エンジンと旧126テストは移植済みだが、STG/PRODの公式マスターSQLite配置、`FEE_MASTER_DB_PATH` 設定、代表ケース実算定が残る。
3. LP: 旧LPの静的ページはほぼ移植済みだが、旧 `medical` 側にあった登録/課金/MFA導線をCore Platformに寄せ切る必要がある。

今回、完全移行に向けて以下を実装した。

- Platform API: `/v1/auth/mfa/enroll` がGoogle Authenticator等で読める `qrCodeDataUrl` を返す。
- Core Admin: MFA QR発行、6桁コード確認、次回ログイン時のMFAコード入力を追加。
- Platform API: `/v1/billing/status`、`/v1/billing/checkout-session`、`/v1/billing/portal-session` を追加。
- Platform API: `/v1/stripe/webhook` を追加し、Stripe署名検証、event receipt冪等化、Core billing/access/product entitlement反映を実装。
- LP: 初回パスワード設定後に `startCheckout: true` を送り、Stripe Checkout URLが返った場合は支払い画面へ遷移する。
- Cloud Run deploy script: `platform-api-*` にStripe設定と任意の `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` secretを渡せるようにした。
- Fee API: `/readyz` で公式master DBの設定有無とファイル存在を確認できるようにした。

## 旧アプリから確認した事実

### LP / 登録 / Stripe

旧 `medical-lp` は静的サイトで、登録処理そのものは旧 `medical` の `apps/web` と `services/billing` が担当していた。

旧設計Docsでは、当時の本線は以下だった。

```mermaid
flowchart LR
  LP[medical-lp] --> Contact[/contact-signup]
  Contact --> Verify[メール確認]
  Verify --> Provision[病院/管理者作成]
  Provision --> Setup[/setup-password/:tokenId]
  Setup --> Trial[trial開始]
  Trial --> Billing[/admin?section=account]
  Billing --> Checkout[Stripe Checkout]
  Billing --> Portal[Stripe Customer Portal]
  Stripe[Stripe Webhook] --> BillingService[services/billing]
```

ユーザー要件としては、現行移行後に `LP -> 登録 -> Stripe支払い` まで進める必要がある。そのため、旧 `services/billing` をそのまま別サービスとして復活させるより、Core Platformにsignup、MFA、billing status、Checkout/Portal発行を寄せる方針にする。

2026-05-30にStripe CLIとGCP Secretを再調査した結果:

- 旧 `$HOME/bin/medical-stripe` は旧 `medical/keys/stripe_key.txt` を読むラッパーだったが、旧repo整理後は参照先ファイルが存在しない。
- Stripeの正アカウントは `medical-ai` (`acct_1TPAYOADFhjr3GQS`)。
- 正アカウントのPROD/live Productは `ハルナス` (`prod_UOMtOPqM6ZMlSI`)。Price v2は `medical_ai_monthly_jpy_v2` (`price_1TTss7ADFhjr3GQSZkTEOBcF`)、月額22,000円。
- 正アカウントのSTG/test Productは `ハルナス` (`prod_UNxntCvcqendyQ`)。2026-05-30にSTG parity用Price v2 `medical_ai_monthly_jpy_v2` (`price_1Tcd88ADFhjr3GQSkOQfgEpB`)、月額22,000円を追加した。
- 旧Core STGの `medical-core-stg` Secret `STRIPE_SECRET_KEY` は誤接続アカウント `acct_1TPAYbA2mWuSL3Xa` のrestricted test keyを参照していたため、正アカウント `acct_1TPAYOADFhjr3GQS` のtest keyへ差し替え済み。
- 正アカウントのCore STG webhookは `we_1Tcd8EADFhjr3GQSH2U7lcxM`。URLは `https://stg.halunasu.com/api/platform/v1/stripe/webhook`。
- 正アカウントの旧test webhook `we_1TRM5WADFhjr3GQS96BvzjJM` と、誤接続アカウント側のCore STG webhook `we_1TcbBPA2mWuSL3XaHhp431E3` はdisabledへ変更済み。
- 旧GCPログ上、旧PROD/STG `medical-billing` は2026-05-06時点で `STRIPE_PRICE_LOOKUP_KEY=medical_ai_monthly_jpy_v2` を参照していた。
- Core PROD `medical-core-497610` にはまだ `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` がない。旧PROD `medical-492407` は `DELETE_REQUESTED` で、旧Secret値は現状取得できない。
- 正アカウントの現在のlive restricted keyはProduct/Priceのreadはできるが、Webhook Endpoint作成権限がない。PROD完了にはDashboardで恒久的なlive restricted keyとCore live webhook secretの発行が必要。

### MFA / Google Authenticator

旧 `medical/services/gateway` は、管理者系ロールにMFAを要求し、TOTP URIを発行していた。UI側は認証アプリ登録を前提にしており、管理画面にはMFAリセットもあった。

現行CoreにはTOTP検証はあったが、QRコード表示とCore Admin上の登録UIが不足していた。これは今回実装済み。

### Charting

旧 `medical` は以下を持っていた。

- `/sessions`: セッション一覧/作成
- `/sessions/[sessionId]`: 録音、書き起こし、SOAP、レビュー、承認
- `/admin`: member、prompt、audio test、MFA reset、billing account section
- `/mobile/*`: スマホ録音
- `services/gateway`: realtime STT、pairing、SOAP生成、権限、MFA、session管理
- `services/finalize`: final transcript/SOAP生成
- `services/billing`: signup、Stripe、portal、webhook

現行はNext.js UIとGatewayを復元済み。残りは実操作E2EとCore shared master bridge。

### Fee

旧 `medical-fee-calculation` はWebアプリではなく、診療報酬算定エンジン、公式/地方厚生局master、契約、テスト資産だった。現行はPython engineと旧126テストを取り込み済み。完全移行には公式master SQLiteを実環境で読める状態にする必要がある。

## 完全移行ステップ

### C1 Charting 実操作確認

Status: pending

1. STGで `prod-test/goshi` または管理者ユーザーにMFAを登録。
2. `/sessions` で新規セッションを作成。
3. `/sessions/{id}` でPC録音開始/停止、スマホ録音pairing、音声テストを確認。
4. OpenAI/Deepgramの費用上限を確認し、短い音声でSTTを確認。
5. SOAP生成、再生成、レビュー、承認、監査ログを確認。
6. 上記をPlaywright deploy E2Eへ追加。

### C2 Charting Core shared master bridge

Status: partial

1. GatewayがCore login/member/product entitlementを読む部分はDone。
2. 患者、施設、診療科はCoreをsource of truthにする。
3. 旧Gateway内のsession metadataにCore IDとsnapshotを保存する。
4. 旧Gatewayが旧schemaへ患者/施設/診療科を直接作る経路を塞ぐ。
5. Charting Adminの共通管理機能はCore Adminへ寄せ、Charting固有設定だけ残す。

### C3 Charting Billing画面

Status: pending

1. `/billing` は旧billing proxyではなくCore Billing APIへ向ける。
2. Charting operator sessionとCore Platform sessionの扱いを統一する。
3. `GET /v1/billing/status`、`POST /v1/billing/checkout-session`、`POST /v1/billing/portal-session` を画面から使う。
4. Stripe Checkout/Portalの成功/キャンセル戻りを `/billing?checkout=...` で表示する。

### F1 Fee master配置

Status: runtime deployed / master data pending

1. 公式master raw CSV/ZIPからSQLiteを生成する。
2. `FEE_MASTER_DB_PATH` をCloud Run image内または低費用GCS同期先へ設定する。
3. `/readyz` の `feeCalculator.masterDbConfigured=true` かつ `masterDbPathExists=true` をSTG/PRODで確認する。2026-05-30時点ではSTG/PRODともAPI deploy済みで、`masterDbConfigured=false`、`masterDbPathExists=false` を明示している。
4. 代表外来検体検査、投薬、注射、処置、画像、入院/DPC代表ケースを実算定する。
5. `fee-web` から患者選択、施設選択、算定、レビュー、保存まで確認する。

### L1 LP signup and Stripe

Status: STG complete on canonical Stripe account / PROD restricted key pending

1. `signup.html` はPlatform signup APIへ申込を送る。Done.
2. メール確認相当のtoken flowで病院/管理者を作る。Done.
3. 初回パスワード設定後にCheckout開始を要求する。Done.
4. Stripe設定済み環境ではCheckout URLへ遷移する。Implemented and deployed.
5. Stripe未設定環境では登録を止めず、管理画面で支払いを続行する。Implemented and deployed.
6. STGのStripe test Price lookup keyと `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` secretを正アカウントへ設定する。Done.
7. STGで `LP -> signup -> password setup -> Checkout URL -> signed webhook -> billing/access/entitlement active -> Portal URL` を確認する。Done.
8. PRODのStripe live `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` を正アカウントで発行し、`medical-core-497610` に保存する。Pending.
9. PROD Core live webhook `https://halunasu.com/api/platform/v1/stripe/webhook` を作成する。Pending: current live key lacks Webhook Endpoint write.
10. PROD Platform APIを再deployし、Checkout URL/Portal URL生成とWebhook署名検証を確認する。Pending.

### L2 MFA

Status: implemented and deployed / admin reset pending

1. Platform APIがTOTP secret、otpauth URL、QR data URLを返す。Done.
2. Core AdminでQRを表示する。Done.
3. Google Authenticator等の6桁コードで登録を完了する。Done.
4. 次回ログイン時にMFA codeを入力できる。Done and deployed.
5. 管理者によるMFA resetをCore Adminに追加する。Pending.

## デプロイ前チェック

```bash
npm run test --workspace @halunasu/platform-api
npm run test --workspace @halunasu/core-admin
npm run test --workspace @halunasu/lp
npm run test --workspace @halunasu/fee-api
npm run test:migration-parity
```

## 2026-05-30反映結果

- Platform API STG/PROD: signup billing API、MFA QR Data URLをdeploy済み。`/readyz` 200確認済み。
- Platform API STG: 正Stripeアカウント `medical-ai` (`acct_1TPAYOADFhjr3GQS`) のtest keyへ差し替え、Core webhook endpoint `we_1Tcd8EADFhjr3GQSH2U7lcxM` を設定済み。
- Platform API STG: 申込からStripe Checkout URL発行、署名済みwebhookによるCore billing/access/entitlement更新、Customer Portal URL生成まで確認済み。Checkout session `cs_test_a1PTqQ6FrmmkZAlkhR7H46yuEBRthrJi3RUFFlXTgnW8z9z1mL3eZXrDi6` はPrice `price_1Tcd88ADFhjr3GQSkOQfgEpB` を使用。
- Stripe test mode: 正アカウントの旧 `medical-billing` webhook endpoint `we_1TRM5WADFhjr3GQS96BvzjJM` と、誤接続アカウント側のCore STG webhook `we_1TcbBPA2mWuSL3XaHhp431E3` はdisabledへ変更済み。
- Stripe live mode: 正アカウントに既存Product `prod_UOMtOPqM6ZMlSI` / Price `price_1TTss7ADFhjr3GQSZkTEOBcF` は存在する。Core live webhook作成は現live keyの権限不足で未完了。旧live webhook `we_1TPXYiADFhjr3GQSR83I19Fq` はまだ旧 `medical-billing-...run.app` を向いているため、Core PROD webhook確認後にdisabledにする。
- Platform API local: Stripe webhook署名検証、receipt冪等化、Core billing/access/entitlement反映を実装し、unit test通過。
- LP STG/PROD: 初回パスワード設定後にCheckout開始を要求するHTMLをNetlify production deploy済み。
- Core Admin STG/PROD: MFA QR発行/確認UIをNetlify production deploy済み。
- Fee API STG/PROD: master readiness付き `/readyz` をdeploy済み。現状は公式master未配置のため `masterDbConfigured=false`、`masterDbPathExists=false`。
- Netlify same-origin proxy: `halunasu.com` / `stg.halunasu.com` のPlatform API readyz、`fee.halunasu.com` / `fee.stg.halunasu.com` のFee API readyzで200確認済み。
- 追加GCPリソースは作らず、Cloud Runは既存の低費用設定 `min=0`、`max=1` を維持。

## STG/PROD反映手順

Stripe設定を先に作る。

```bash
gcloud secrets create STRIPE_SECRET_KEY --project medical-core-stg --replication-policy automatic
gcloud secrets versions add STRIPE_SECRET_KEY --project medical-core-stg --data-file /path/to/stg-stripe-secret.txt
gcloud secrets create STRIPE_WEBHOOK_SECRET --project medical-core-stg --replication-policy automatic
gcloud secrets versions add STRIPE_WEBHOOK_SECRET --project medical-core-stg --data-file /path/to/stg-stripe-webhook-secret.txt
gcloud secrets create STRIPE_SECRET_KEY --project medical-core-497610 --replication-policy automatic
gcloud secrets versions add STRIPE_SECRET_KEY --project medical-core-497610 --data-file /path/to/prod-stripe-secret.txt
gcloud secrets create STRIPE_WEBHOOK_SECRET --project medical-core-497610 --replication-policy automatic
gcloud secrets versions add STRIPE_WEBHOOK_SECRET --project medical-core-497610 --data-file /path/to/prod-stripe-webhook-secret.txt
```

2026-05-30時点ではSTGは正Stripeアカウントで設定済み。PRODは以下をStripe Dashboardで先に準備する。

- live restricted key: runtime用にProducts/Prices read、Customers read/write、Checkout Sessions read/write、Billing Portal Sessions writeを許可する。setup時に同じkeyでWebhook Endpointを作成する場合はWebhook Endpoints writeも一時的に許可する。
- live webhook endpoint: `https://halunasu.com/api/platform/v1/stripe/webhook`
- live webhook events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`
- live webhook signing secret: `medical-core-497610` の `STRIPE_WEBHOOK_SECRET` に保存する。

Stripe CLI loginで得られるlive keyは2026-08-28に失効するため、PROD Cloud Runの永続Secretには使わない。

低費用設定のままPlatform APIだけ再deployする。

```bash
TARGET_ENV=stg TARGET_SERVICE=platform-api ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
TARGET_ENV=prod TARGET_SERVICE=platform-api ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

静的アプリを再build/deployする。

```bash
npm run build:runtime-apps
npm run deploy:netlify-static -- --env stg --app lp --apply
npm run deploy:netlify-static -- --env stg --app core-admin --apply
npm run deploy:netlify-static -- --env prod --app lp --apply
npm run deploy:netlify-static -- --env prod --app core-admin --apply
```

Fee master DBを配置した後、Fee APIだけ再deployする。

```bash
TARGET_ENV=stg TARGET_SERVICE=fee-api ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
TARGET_ENV=prod TARGET_SERVICE=fee-api ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```
