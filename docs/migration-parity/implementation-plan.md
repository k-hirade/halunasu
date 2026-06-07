# Complete Migration Implementation Plan

## P0: Freeze Destructive Cleanup

Status: done

- 旧資産削除を停止する。
- `/private/tmp/halunasu-old-audit2` の旧cloneを監査元として保持する。
- 今後の削除は、パリティDocsとテストで不要が確認できたものだけ行う。

## P1: Document and Test Baseline

Status: done

- アプリ別Docsを作成。
- 旧fee testsをrepoへ移植。
- `test:migration-parity` を追加。
- 現行Deployが旧アプリ相当でないことをDocsに明記。

## P2: Restore Charting First

Status: deployed / Core shared master bridge done /実AI provider smoke manual

理由: ユーザー影響が最も大きく、旧UI/旧テスト/旧APIの差分が最大。

Steps:

1. `apps/charting-web` をNext.jsアプリとして復元する。Done.
2. 旧 `apps/web/app`, `components`, `lib`, `test/e2e` を取り込む。Done.
3. 旧 `packages/core` / `packages/contracts` を互換層として取り込む。Done.
4. 旧 `services/gateway` を `services/charting-gateway` として復元する。Done.
5. 旧 `services/finalize` と旧 `services/billing` をlegacy serviceとして保存する。Done.
6. 旧Charting E2Eを現行appで通す。Done.
7. 旧静的 `apps/charting-web/index.html` を削除し、Next.js buildのみを配信対象にする。Done.
8. 旧 `services/finalize` 相当はGateway inline finalizeで動かす。Separate worker化は費用/運用が必要なため後回し。
9. Core shared org/member/patient/facility/departmentへbridgeする。Done.
   - Gateway login identity/member/product entitlement bridge: Done.
   - Patient/facility/department shared master bridge: Done.
10. NetlifyをNext.js buildに切り替える。Done.
   - Same-origin HTTP proxy route: Done.
   - WebSocket direct URL config: Done.
   - `deploy:netlify-charting-next`: Done.
11. STG deploy、E2E、PROD deploy。Done for login/API/session-list baseline.
    - STG `platform-api-stg` deploy: Done.
    - STG `charting-gateway-stg` Cloud Run deploy: Done.
    - STG `charting-gateway-stg` external `readyz`: Done.
    - STG Netlify Charting Next.js deploy: Done.
    - PROD `charting-gateway-prod` Cloud Run deploy: Done.
    - PROD Netlify Charting Next.js deploy: Done.
    - STG/PROD seeded operator login, Core shared master list, and session create: Done.

## P3: Restore Billing / Signup Flow

Status: STG/PROD checkout, webhook, and portal verified

Steps:

1. 旧 `services/billing` をCore billingへ統合するか、`services/billing-api` として復元する。Core統合方針に決定.
2. contact signup, verify, password setupをLP/Core signupと統合する。Done.
3. LP初回パスワード設定後にStripe Checkoutへ進める。Done.
4. Platform APIにbilling status / checkout-session / portal-sessionを追加。Done.
5. Stripe Checkout/Portal/WebhookをCore entitlementへ接続する。STG/PROD Done on canonical Stripe account.
6. 旧billing testsをCore Platform側へ移植する。Partial.
7. Stripe調査結果:
   - 正Stripeアカウントは `medical-ai` (`acct_1TPAYOADFhjr3GQS`)。
   - 正アカウントのPROD/live Productは `ハルナス` (`prod_UOMtOPqM6ZMlSI`)。Price v2は `medical_ai_monthly_jpy_v2` (`price_1TTss7ADFhjr3GQSZkTEOBcF`)、月額22,000円。
   - 正アカウントのSTG/test Productは `ハルナス` (`prod_UNxntCvcqendyQ`)。STG parity用Price v2 `medical_ai_monthly_jpy_v2` (`price_1Tcd88ADFhjr3GQSkOQfgEpB`) を2026-05-30に追加。
   - 2026-06-06時点の現行商用価格は月額30,000円、税込33,000円。`medical_ai_monthly_jpy_v2` は旧価格の調査記録であり、現行Checkoutでは再利用しない。現行のPlatform Checkoutは `halunasu_charting_flat_monthly_jpy_v1` を使う。
   - 旧Core STGは誤接続アカウント `acct_1TPAYbA2mWuSL3Xa` を参照していたため、`medical-core-stg` の `STRIPE_SECRET_KEY` を正アカウントtest keyへ差し替え済み。
   - 正アカウントのCore STG webhook `we_1Tcd8EADFhjr3GQSH2U7lcxM` はenabled。正アカウント旧test webhook `we_1TRM5WADFhjr3GQS96BvzjJM` と誤接続アカウントのCore STG webhook `we_1TcbBPA2mWuSL3XaHhp431E3` はdisabled。
   - Core PRODには正アカウントのlive restricted keyとCore live webhook secretを設定済み。Core live webhook `we_1TcdVxADFhjr3GQSUv5L4qLt` はenabled。旧live webhook `we_1TPXYiADFhjr3GQSR83I19Fq` はdisabled。

## P4: Connect Fee Web/API to Real Engine

Status: done

Steps:

1. `mock-calculate` と `mock算定` を本番導線から外す。Done.
2. `/v1/fee/sessions/{id}/calculate` を追加。Done.
3. Python engine呼び出し方式を決める。Done.
   - short term: child process / Python module call in Cloud Run
   - later: Python service or worker
4. `python/medical_fee_calculation/api.py` を追加し、Fee sessionをClaimContext payloadへ変換する。Done.
5. Node service imageへ `python3` と `python/` を同梱する。Done.
6. representative calculation API testsを追加。Done.
7. 旧config/contractsを正式配置へ移す。Done for active official/regional master config. Legacy contracts remain under migration parity docs.
8. STG/PRODへ公式マスターSQLiteを配置し、`FEE_MASTER_DB_PATH` を設定する。Done.
   - `/readyz` master readiness reporting: Done and deployed.
9. STG/PRODで代表オーダーを検証。Done. `160000410` -> 41 points / 2 line items.

## P5: LP Parity and Signup

Status: done

Steps:

1. 旧LPとの差分をHTML単位で確認。
2. 旧optimized assetsを必要なら復元。
3. `signup.html` をCore signup/contact signup flowに接続。Done.
4. 初回パスワード設定後にStripe Checkoutへ進める。Done and deployed.
5. LP link/form validationを追加。Done.
6. `halunasu.com` / `www.halunasu.com` で確認。PROD root 200 Done / signup + Stripe Checkout/Webhook/Portal verified.

## P6: Referral Production Foundation

Status: done for low-cost HTML print foundation

Steps:

1. placeholder UI/APIを削除。Done.
2. referral draft modelを確定。Done.
3. 低費用のinline printable document生成を実装。Done.
4. UI/API/Core testsを追加。Done.
5. ブラウザ印刷/PDF化のUIプレビューを追加。Done.
6. STG/PROD deploy確認。Draft/document artifact Done.

## P7: GCP Project Split Finalization

Status: baseline done / app-specific data split remains

Steps:

1. Core / Charting / Fee / Referral の責務を最終確認。
2. 必要ならproduct projectを新規作成または再作成。
3. billing accountを環境ごとに紐付ける。
4. Cloud Run min instances 0、max instances制限、不要API無効化。
5. Firestore/GCS/secrets/IAMを最小権限で設定。
6. Deploy runbookを更新。

## P8: Completion Verification

Status: STG/PROD post-deploy verification done for Core shared data, session/draft creation, and Fee real calculation

Steps:

1. `npm run test`
2. `npm run test:python`
3. `npm run test:migration-parity`
4. Charting E2E
5. Fee calculation representative tests
6. LP link/form checks
7. Netlify domain checks
8. Cloud Run readyz checks
9. STG user login checks
10. PROD user login checks

Results on 2026-05-30:

- `npm run test` passed.
- `npm run build` passed.
- `npm run test:python` passed.
- `npm run test:python:legacy-fee` passed, 126 legacy tests.
- `npm run test:migration-parity` passed.
- `npm run audit:migration-parity` passed.
- `WEB_E2E_PORT=3100 npm run test --workspace @halunasu/charting-web` passed, 11 E2E tests.
- STG/PROD Charting Cloud Run `readyz` passed.
- STG/PROD Charting Netlify `/sessions` passed.
- STG/PROD Charting login and `/api/v1/sessions` passed with Core seeded users.
- PROD LP/Core Admin/Fee/Referral custom domains returned 200.
- STG/PROD Platform API `/readyz` passed after signup billing and MFA QR deploy.
- STG/PROD LP and Core Admin Netlify production deploy completed after signup checkout and MFA QR UI changes.
- STG/PROD Fee API `/readyz` passed with `masterDbConfigured=true`, `masterDbPathExists=true`, `masterDbGzipPathExists=true`.
- STG/PROD Fee real calculation passed with official master: `medical_fee_calculation`, `totalPoints=41`, `lineItems=2`.
- STG/PROD Referral draft/document artifact creation passed.
- STG/PROD Charting Core shared patient/facility/department list and session creation passed.
- Netlify same-origin proxies passed for PROD/STG Platform API and Fee API readyz.
- Platform API local tests passed for Stripe webhook signature verification, event receipt idempotency, Core billing/access update, and product entitlement update.
- STG signup -> password setup -> Stripe Checkout URL creation passed with existing test Price lookup key `medical_ai_monthly_jpy_v2`.
- STG signed Core Stripe webhook passed and updated Core billing/access/product entitlement.
- Stripe test mode old `medical-billing` webhook endpoint was disabled after Core endpoint creation.

Remaining operational note:

- Chartingの実AI STT/SOAP provider smokeは `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` secret未設定かつ費用発生を避けるため未実施。secret追加後に手動smokeする。
