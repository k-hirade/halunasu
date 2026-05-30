# 2026-05-30 Complete Migration Report

## Summary

カルテ作成、診療報酬算定、LP、Core Admin、紹介状作成を `halunasu` monorepo と現行STG/PROD環境へ再集約した。共通プラットフォームはCore GCP project、アプリ固有データは各product GCP projectに分離する構成を維持している。

## Runtime Responsibility

| Area | STG project | PROD project | Responsibility |
| --- | --- | --- | --- |
| Core Platform | `medical-core-stg` | `medical-core-497610` | org/member/login/facility/department/patient/entitlement/audit/signup/billing |
| Charting | `halunasu-charting-stg` | `halunasu-charting-prod` | encounter/session/transcript/SOAP/pairing/recorder |
| Fee | `halunasu-fee-stg` | `halunasu-fee-prod` | fee session/calculation result/review/receipt/master runtime |
| Referral | `halunasu-referral-stg` | `halunasu-referral-prod` | referral draft/generated document |
| Netlify | existing Halunasu sites | existing Halunasu sites | LP/Core Admin/Charting/Fee/Referral browser apps |

Cloud Runは全runtime serviceで `min=0`、`maxScale=1`、CPU throttling enabledを維持する。Fee APIだけ公式master展開のため `memory=2Gi`、`timeout=180s` とするが、idle時は0インスタンスなので常時課金は発生しない。

## Deployed Domains

| App | STG | PROD |
| --- | --- | --- |
| LP | `https://stg.halunasu.com` | `https://halunasu.com` |
| Core Admin | `https://admin.stg.halunasu.com` | `https://admin.halunasu.com` |
| Charting | `https://charting.stg.halunasu.com` | `https://charting.halunasu.com` |
| Fee | `https://fee.stg.halunasu.com` | `https://fee.halunasu.com` |
| Referral | `https://referral.stg.halunasu.com` | `https://referral.halunasu.com` |

## Implemented Changes

- Charting: 旧Next.js UIを復元し、`/sessions`、`/sessions/[sessionId]`、`/admin`、`/mobile/*` をNetlify Next.js配信へ戻した。
- Charting Gateway: Core Platform login/member/product entitlement bridgeに加え、Core患者/施設/診療科の参照APIとsession metadata snapshot保存を実装した。
- Fee API: 公式master SQLite gzipをCloud Run imageへ同梱し、起動後 `/tmp` へ展開してPython算定エンジンから読む構成にした。
- Fee Core: Python算定結果をFirestore保存できるよう、undefinedを再帰的に除去する正規化を追加した。
- Platform API/Core Admin: MFA QR表示、TOTP登録、MFAリセット、Stripe Checkout/Portal/WebhookをCoreへ統合した。
- LP: 登録、メール確認相当、初回パスワード設定、Stripe Checkout開始をCore Platformへ接続した。
- Referral: Core共有患者/施設/診療科を使った下書き作成、HTML文書生成、プレビュー、印刷導線を追加した。
- Deploy script: Fee API専用 `.gcloudignore.fee-api`、低コストFee runtime設定、任意のCharting `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` secret接続を追加した。

## Official Fee Master

- Build config: `configs/official-master/2026-05-01/standard-master-build.json`
- Runtime gzip: `python/data/master/standard-master.sqlite.gz` (git ignored, Cloud Build contextにだけ含める)
- Build report: `docs/migration-parity/fee-master-build-2026-05-01.md`
- STG readyz: `masterDbPathExists=true`, `masterDbBytes=1287618560`, `masterDbGzipBytes=141582636`
- PROD readyz: `masterDbPathExists=true`, `masterDbBytes=1287618560`, `masterDbGzipBytes=141582636`

実環境検証ではSTG/PRODとも `standardCode=160000410` を含む診療報酬sessionを作成し、`medical_fee_calculation` providerで `totalPoints=41`、`lineItems=2` の算定結果を保存できた。

## Post-Deploy Verification

内部確認用 `prod-test/migration-check` でSTG/PRODを通した。パスワードは `/private/tmp/halunasu-migration-check-password` にだけ保持し、Docs/Gitには残さない。

| Env | Charting | Fee | Referral |
| --- | --- | --- | --- |
| STG | login true, Core patients/facilities/departments各1件, session作成成功 | Platform login true, session作成成功, 算定 `medical_fee_calculation` completed, 41点/2明細 | Platform login true, referral作成成功, HTML document 702 bytes |
| PROD | login true, Core patients/facilities/departments各1件, session作成成功 | Platform login true, session作成成功, 算定 `medical_fee_calculation` completed, 41点/2明細 | Platform login true, referral作成成功, HTML document 702 bytes |

Ready checks:

- STG/PROD Platform API `readyz`: 200
- STG/PROD Fee API `readyz`: 200, official master gzip and expanded SQLite present
- STG/PROD Referral API `readyz`: 200
- STG/PROD Charting: authenticated login, Core master list, session creation passed through Netlify same-origin proxy

## Test Results

2026-05-30に以下を通過した。

- `npm test --workspace @halunasu/platform-api` (44 tests)
- `npm test --workspace @halunasu/platform-contracts` (13 tests)
- `npm test --workspace @halunasu/fee-core` (3 tests)
- `npm test --workspace @halunasu/fee-api` (9 tests)
- `npm test --workspace @halunasu/referral-api` (8 tests)
- `npm test --workspace @medical/core` (66 tests)
- `npm test --workspace @medical/contracts` (11 tests)
- `WEB_E2E_PORT=3199 npm test --workspace @halunasu/charting-web` (11 E2E tests)
- `npm run test:python` (1 test)
- `npm run test:python:legacy-fee` (126 legacy tests)
- `npm run test:migration-parity`

## Remaining Operational Notes

- ChartingのSTG/PROD projectには現時点で `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` secretが存在しない。旧アプリ相当の実AI STT/SOAPを使う場合はsecret追加後に `TARGET_SERVICE=charting-gateway ./scripts/p10_deploy_runtime_services_low_cost.sh --apply` を再実行する。secret未設定でもlocal preview SOAPは動くが、旧PRODの実AI出力とは同一ではない。
- STT/SOAP実プロバイダの短時間smokeは、費用を発生させるため今回の自動検証から外した。
- Fee masterのgzipは大きいためGit管理しない。再deploy前に `python/data/master/standard-master.sqlite.gz` が存在することを確認する。
