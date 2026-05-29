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

Status: deployed / Core shared master bridge partial

理由: ユーザー影響が最も大きく、旧UI/旧テスト/旧APIの差分が最大。

Steps:

1. `apps/charting-web` をNext.jsアプリとして復元する。Done.
2. 旧 `apps/web/app`, `components`, `lib`, `test/e2e` を取り込む。Done.
3. 旧 `packages/core` / `packages/contracts` を互換層として取り込む。Done.
4. 旧 `services/gateway` を `services/charting-gateway` として復元する。Done.
5. 旧 `services/finalize` と旧 `services/billing` をlegacy serviceとして保存する。Done.
6. 旧Charting E2Eを現行appで通す。Done.
7. 旧静的 `apps/charting-web/index.html` を削除し、Next.js buildのみを配信対象にする。Done.
8. 旧 `services/finalize` を本実装として `services/charting-finalize` に統合する。Pending.
9. Core shared org/member/patient/facility/departmentへbridgeする。Partial.
   - Gateway login identity/member/product entitlement bridge: Done.
   - Patient/facility/department shared master bridge: Pending.
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
    - STG/PROD seeded operator login and `/api/v1/sessions`: Done.

## P3: Restore Billing / Signup Flow

Status: pending

Steps:

1. 旧 `services/billing` をCore billingへ統合するか、`services/billing-api` として復元する。
2. contact signup, verify, password setupをLP/Core signupと統合する。
3. Stripe Checkout/Portal/WebhookをCore entitlementへ接続する。
4. 旧billing testsを移植する。

## P4: Connect Fee Web/API to Real Engine

Status: local done / deploy master data pending

Steps:

1. `mock-calculate` と `mock算定` を本番導線から外す。Done.
2. `/v1/fee/sessions/{id}/calculate` を追加。Done.
3. Python engine呼び出し方式を決める。Done.
   - short term: child process / Python module call in Cloud Run
   - later: Python service or worker
4. `python/medical_fee_calculation/api.py` を追加し、Fee sessionをClaimContext payloadへ変換する。Done.
5. Node service imageへ `python3` と `python/` を同梱する。Done.
6. representative calculation API testsを追加。Done.
7. 旧config/contractsを正式配置へ移す。Pending.
8. STG/PRODへ公式マスターSQLiteを配置し、`FEE_MASTER_DB_PATH` を設定する。Pending.
9. STG/PRODで代表オーダーを検証。Pending.

## P5: LP Parity and Signup

Status: static deployed / signup parity pending

Steps:

1. 旧LPとの差分をHTML単位で確認。
2. 旧optimized assetsを必要なら復元。
3. `signup.html` をCore signup/contact signup flowに接続。
4. LP link/form validationを追加。
5. `halunasu.com` / `www.halunasu.com` で確認。PROD root 200 Done / signup end-to-end Pending.

## P6: Referral Production Foundation

Status: static deployed / print UX pending

Steps:

1. placeholder UI/APIを削除。Done.
2. referral draft modelを確定。Done.
3. 低費用のinline printable document生成を実装。Done.
4. UI/API/Core testsを追加。Done.
5. ブラウザ印刷/PDF化のUIプレビューを追加。Pending.
6. STG/PROD deploy確認。Static deploy Done / browser print smoke Pending.

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

Status: baseline deploy verification done / product-deep verification remains

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

Remaining:

- Fee公式マスターSQLiteをSTG/PRODへ配置し、代表診療行為で実計算する。
- Billing/contact signup/Stripe portal/webhookをCore entitlementへ接続する。
- Charting patient/facility/department bridgeをCore shared masterへ寄せる。
- Referralの印刷/PDF導線をブラウザで確認する。
- LP signup/contact導線の旧仕様との差分を消す。
