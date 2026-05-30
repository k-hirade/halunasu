# Charting / Fee / LP Complete Migration Tasks

最終更新: 2026-05-30

## 結論

2026-05-30の最終移行パスで、カルテ作成、診療報酬算定、LP、Core Admin、紹介状作成は現行 `halunasu` monorepo とSTG/PROD環境へ反映済み。詳細な最終結果は `docs/migration-parity/2026-05-30-complete-migration-report.md` を正とする。

1. Charting: 旧Next.js UI、Gateway、Core患者/施設/診療科bridge、Netlify独自ドメイン配信、STG/PROD login/session作成はDone。実AI STT/SOAPは `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` secret未設定のためlocal preview運用。
2. Fee: Python算定エンジン、旧126テスト、公式master SQLite gzip同梱、STG/PROD `readyz`、代表コード実算定はDone。
3. LP: 登録、Resend確認メール、初回パスワード設定、Stripe Checkout/Portal/Webhook、Core entitlement連携はコード移行済み。STG/PRODへResend反映済みで、STG実送信は成功。
4. Referral: Core共有データを使った下書き作成、HTML文書生成、プレビュー/印刷導線、STG/PROD post-deploy確認はDone。

今回、完全移行に向けて以下を実装した。

- Platform API: `/v1/auth/mfa/enroll` がGoogle Authenticator等で読める `qrCodeDataUrl` を返す。
- Core Admin: MFA QR発行、6桁コード確認、次回ログイン時のMFAコード入力を追加。
- Platform API: `/v1/billing/status`、`/v1/billing/checkout-session`、`/v1/billing/portal-session` を追加。
- Platform API: `/v1/stripe/webhook` を追加し、Stripe署名検証、event receipt冪等化、Core billing/access/product entitlement反映を実装。
- LP: 初回パスワード設定後に `startCheckout: true` を送り、Stripe Checkout URLが返った場合は支払い画面へ遷移する。
- Platform API: LP登録の確認メール/初回設定メール送信を旧 `services/billing` 相当のResend方式で実装。
- LP: 送信後にフォームを隠し、「確認メールを送信しました」ブロックのみ表示。メールリンク `/signup?token=...` と初回設定リンク `/signup?setup=...` を処理する。
- Charting Web: 旧 `/contact-signup`、`/contact-signup/verify`、`/setup-password/:tokenId`、`/signup/*` を現行LP `/signup` へredirectし、旧billing API前提の登録画面を表に出さない。
- Cloud Run deploy script: `platform-api-*` にStripe設定と任意の `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` secretを渡せるようにした。
- Cloud Run deploy script: `platform-api-*` に任意の `RESEND_API_KEY` secretを渡し、Secret未設定時はPlatform API deployをskipしてLP登録メールの半端な反映を防ぐ。
- Fee API: `/readyz` で公式master DBの設定有無とファイル存在を確認できるようにした。
- Fee API: 公式master gzipをCloud Run imageに同梱し、runtimeで `/tmp` に展開してPython算定へ渡すようにした。
- Charting Gateway: Core患者/施設/診療科を読み、session metadataへCore ID/snapshotを保存するbridgeを追加した。
- Referral Web: 生成HTMLのプレビューiframeと印刷ボタンを追加した。
- Core Admin: 管理者によるMFA resetを追加した。

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
- Core PROD `medical-core-497610` には正アカウントのlive restricted keyとCore live webhook secretを設定済み。
- 正アカウントのCore PROD webhookは `we_1TcdVxADFhjr3GQSUv5L4qLt`。URLは `https://halunasu.com/api/platform/v1/stripe/webhook`。
- 正アカウントの旧live webhook `we_1TPXYiADFhjr3GQSR83I19Fq` はdisabledへ変更済み。

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

Status: deployed and post-deploy verified for login/Core master/session creation. Cost-bearing live STT/SOAP provider smoke remains manual because `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` secrets are not present in the new Charting projects.

1. STGで `prod-test/goshi` または管理者ユーザーにMFAを登録。
2. `/sessions` で新規セッションを作成。
3. `/sessions/{id}` でPC録音開始/停止、スマホ録音pairing、音声テストを確認。
4. OpenAI/Deepgramの費用上限を確認し、短い音声でSTTを確認。
5. SOAP生成、再生成、レビュー、承認、監査ログを確認。
6. 上記をPlaywright deploy E2Eへ追加。

### C2 Charting Core shared master bridge

Status: done

1. GatewayがCore login/member/product entitlementを読む部分はDone。
2. 患者、施設、診療科はCoreをsource of truthにする。Done.
3. 旧Gateway内のsession metadataにCore IDとsnapshotを保存する。Done.
4. 旧Gatewayが旧schemaへ患者/施設/診療科を直接作る経路を塞ぐ。
5. Charting Adminの共通管理機能はCore Adminへ寄せ、Charting固有設定だけ残す。

### C3 Charting Billing画面

Status: pending

1. `/billing` は旧billing proxyではなくCore Billing APIへ向ける。
2. Charting operator sessionとCore Platform sessionの扱いを統一する。
3. `GET /v1/billing/status`、`POST /v1/billing/checkout-session`、`POST /v1/billing/portal-session` を画面から使う。
4. Stripe Checkout/Portalの成功/キャンセル戻りを `/billing?checkout=...` で表示する。

### F1 Fee master配置

Status: done

1. 公式master raw CSV/ZIPからSQLiteを生成する。
2. `FEE_MASTER_DB_PATH` をCloud Run runtime `/tmp/halunasu-fee-master/standard-master.sqlite` に設定し、`FEE_MASTER_DB_GZIP_PATH=/app/python/data/master/standard-master.sqlite.gz` から展開する。Done.
3. `/readyz` の `feeCalculator.masterDbConfigured=true` かつ `masterDbPathExists=true` をSTG/PRODで確認する。Done.
4. 代表外来検体検査コード `160000410` をSTG/PRODで実算定する。Done.
5. `fee-web` から患者選択、施設選択、算定、保存までpost-deploy scriptで確認する。Done.

### L1 LP signup, Resend, and Stripe

Status: deployed. STG Resend delivery smoke completed. Email-link click through remains a manual inbox check because production-like API responses no longer expose raw verification tokens.

1. `signup.html` はPlatform signup APIへ申込を送る。Done.
2. Resendで確認メールを送り、`/signup?token=...` から病院/管理者を作る。Code Done / Secret pending.
3. 初回パスワード設定後にCheckout開始を要求する。Done.
4. Stripe設定済み環境ではCheckout URLへ遷移する。Implemented and deployed.
5. Stripe未設定環境では登録を止めず、管理画面で支払いを続行する。Implemented and deployed.
6. STGのStripe test Price lookup keyと `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` secretを正アカウントへ設定する。Done.
7. STGで `LP -> signup -> password setup -> Checkout URL -> signed webhook -> billing/access/entitlement active -> Portal URL` を確認する。Done.
8. PRODのStripe live `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` を正アカウントで発行し、`medical-core-497610` に保存する。Done.
9. PROD Core live webhook `https://halunasu.com/api/platform/v1/stripe/webhook` を作成する。Done.
10. PROD Platform APIを再deployし、Checkout URL/Portal URL生成とWebhook署名検証を確認する。Done.
11. STG/PRODに `RESEND_API_KEY` Secretを追加し、Platform APIを再deployする。Done.
12. STGで実メール送信がResend `delivered=true` になることを確認する。Done.
13. メール受信、確認リンク、初回設定メール受信、パスワード設定、Checkout遷移を受信メールから確認する。Manual pending.
14. Chartingの旧登録/初回設定URLはLP signupへredirectする。Done.

### L2 MFA

Status: implemented and deployed

1. Platform APIがTOTP secret、otpauth URL、QR data URLを返す。Done.
2. Core AdminでQRを表示する。Done.
3. Google Authenticator等の6桁コードで登録を完了する。Done.
4. 次回ログイン時にMFA codeを入力できる。Done and deployed.
5. 管理者によるMFA resetをCore Adminに追加する。Done.

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
- Platform API PROD: 正Stripeアカウント `medical-ai` (`acct_1TPAYOADFhjr3GQS`) のlive keyとCore live webhook endpoint `we_1TcdVxADFhjr3GQSUv5L4qLt` を設定済み。
- Platform API PROD: 申込からStripe Checkout URL発行、署名済みwebhookによるCore billing/access/entitlement更新、Customer Portal URL生成まで確認済み。Checkout session `cs_live_a1Z1FHojYlLyotIluQKeGhwBbVQjnXyNhLTden1qAm6jA16TO51Ga6noui` はPrice `price_1TTss7ADFhjr3GQSZkTEOBcF` を使用し、未払いのまま `expired` に変更済み。
- Stripe live mode: 旧 `medical-billing` webhook endpoint `we_1TPXYiADFhjr3GQSR83I19Fq` はdisabledへ変更済み。
- Platform API local: Stripe webhook署名検証、receipt冪等化、Core billing/access/entitlement反映を実装し、unit test通過。
- LP STG/PROD: 初回パスワード設定後にCheckout開始を要求するHTMLをNetlify production deploy済み。
- LP/Platform API: 旧Resend方式の確認メール/初回設定メールをPlatform APIに移植し、unit/static test通過。STG/PRODへdeploy済み。
- Charting Web: 旧contact signup/password setup URLを現行LP signupへredirectするコードをSTG/PRODへdeploy済み。
- Platform API STG Resend smoke: `resend-smoke-20260530-1754` / `info@halunasu.com` で `emailDelivery.mode=resend`、`delivered=true`、provider message id `e82b3fb1-131e-489a-bffb-481480bf6b7c` を確認。
- Core Admin STG/PROD: MFA QR発行/確認UIをNetlify production deploy済み。
- Fee API STG/PROD: 公式master gzip同梱版をdeploy済み。`/readyz` は `masterDbConfigured=true`、`masterDbPathExists=true`、`masterDbGzipPathExists=true` を返す。
- Fee API STG/PROD: `standardCode=160000410` の代表算定で `medical_fee_calculation` provider、`totalPoints=41`、`lineItems=2` を確認済み。
- Charting Gateway STG/PROD: Core患者/施設/診療科参照とsession作成を独自ドメイン経由で確認済み。
- Referral STG/PROD: Core共有データで紹介状下書き作成、HTML文書artifact生成を確認済み。
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

2026-05-30時点ではSTG/PRODとも正Stripeアカウントで設定済み。今後Stripe secretを再発行する場合は以下を準備する。

- live restricted key: runtime用にProducts/Prices read、Customers read/write、Checkout Sessions read/write、Billing Portal Sessions writeを許可する。setup時に同じkeyでWebhook Endpointを作成する場合はWebhook Endpoints writeも一時的に許可する。
- live webhook endpoint: `https://halunasu.com/api/platform/v1/stripe/webhook`
- live webhook events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`
- live webhook signing secret: `medical-core-497610` の `STRIPE_WEBHOOK_SECRET` に保存する。

Stripe CLI loginで得られるlive keyは2026-08-28に失効するため、PROD Cloud Runの永続Secretには使わない。

LP登録メール送信用のResend secretを追加する。

```bash
gcloud secrets create RESEND_API_KEY --project medical-core-stg --replication-policy automatic
gcloud secrets versions add RESEND_API_KEY --project medical-core-stg --data-file /path/to/stg-resend-api-key.txt
gcloud secrets add-iam-policy-binding RESEND_API_KEY \
  --project medical-core-stg \
  --member serviceAccount:halunasu-platform-api@medical-core-stg.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor

gcloud secrets create RESEND_API_KEY --project medical-core-497610 --replication-policy automatic
gcloud secrets versions add RESEND_API_KEY --project medical-core-497610 --data-file /path/to/prod-resend-api-key.txt
gcloud secrets add-iam-policy-binding RESEND_API_KEY \
  --project medical-core-497610 \
  --member serviceAccount:halunasu-platform-api@medical-core-497610.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor
```

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

Fee master DBを再生成した後、Fee APIだけ再deployする。

```bash
TARGET_ENV=stg TARGET_SERVICE=fee-api ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
TARGET_ENV=prod TARGET_SERVICE=fee-api ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

Chartingで実AI STT/SOAPを使う場合は、Charting projectへ `OPENAI_API_KEY` と必要に応じて `DEEPGRAM_API_KEY` を追加し、Gatewayを再deployする。secret未設定時はlocal preview SOAPにfallbackするため、費用は発生しない。

```bash
TARGET_SERVICE=charting-gateway ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```
