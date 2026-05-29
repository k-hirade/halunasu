# Migration Test Plan

## Policy

旧アプリのテストがある場合は移植する。ない場合は、旧画面/旧API/新共通プラットフォームの完了条件を検出するテストを追加する。

## Existing Legacy Tests

### Charting

旧E2E:

- `apps/web/test/e2e/encounter-ui-regression.test.js`
- `apps/web/test/e2e/global-menu.test.js`
- `apps/web/test/e2e/admin-member-actions.test.js`
- `apps/web/test/e2e/admin-prompt-title.test.js`
- `apps/web/test/e2e/admin-audio-test.test.js`
- `apps/web/test/e2e/horizontal-scroll-source-guard.test.js`

移植方針:

1. `apps/charting-web` をNext.jsへ戻す。
2. 旧E2Eを `apps/charting-web/test/e2e` へ移す。
3. `@medical/web` 参照を現行workspace名へ更新する。
4. gateway mockを現行の互換APIに合わせる。

2026-05-30時点の状態:

- `apps/charting-web/test/e2e` に移植済み。
- `WEB_E2E_PORT=3100 npm run test --workspace @halunasu/charting-web` で11件すべて通過。
- Next dev serverとPlaywright Chromiumが必要なため、ローカルではsandbox外実行が必要。

### Fee Calculation

旧126テストを移植済み。

```bash
PYTHONPATH=python python3 -m unittest discover -s python/tests/legacy_medical_fee_calculation
```

### LP

旧テストなし。追加する。

- HTML link check
- required page existence
- CTA/form action existence
- asset existence

### Core Admin

旧Charting admin E2Eから共通管理機能を抽出し、Core Admin用に追加する。

対象:

- member create/update/status/password/MFA
- facility/department/patient CRUD
- entitlement CRUD
- audit event表示

### Referral

新規のため追加する。

- API draft create/update。Done.
- shared patient/facility/department/member snapshot。Done.
- UI draft create/edit。Static validation done / browser smoke pending.
- printable document artifact generation。Done.
- print/export browser check。Pending.

## Root Scripts

追加/利用するコマンド:

```bash
npm run test:python
npm run test:python:legacy-fee
npm run audit:migration-parity
npm run test:migration-parity
```

`test:migration-parity` はローカルコード上の移行パリティ監査として通す。デプロイパリティは別途Netlify/GCP確認が必要。

## 2026-05-30 Verification

通過済み:

- `npm run test`
- `npm run build`
- `npm run test:python`
- `npm run test:python:legacy-fee`
- `npm run test:migration-parity`
- `npm run audit:migration-parity`
- `WEB_E2E_PORT=3100 npm run test --workspace @halunasu/charting-web`
- STG `https://charting.stg.halunasu.com/sessions`
- PROD `https://charting.halunasu.com/sessions`
- STG/PROD Charting Core seeded login
- STG/PROD Charting `/api/v1/operator/me`
- STG/PROD Charting `/api/v1/sessions`
- PROD LP/Core Admin/Fee/Referral custom-domain 200 checks

注意:

- `npm run test` にはCharting Next.js + Playwright E2E 11件が含まれる。
- `npm run test:python:legacy-fee` には旧 `medical-fee-calculation` 由来の126件が含まれる。
- sandbox内の通常実行ではNext dev serverがlistenできず `EPERM` になるため、E2Eを含む実行はsandbox外で確認した。
- Netlify/GCPのSTG/PROD反映確認はChartingのログイン/API/セッション一覧まで完了。録音、SOAP生成、Billing/signup、Fee公式master、Referral印刷は別途深掘り確認が必要。
