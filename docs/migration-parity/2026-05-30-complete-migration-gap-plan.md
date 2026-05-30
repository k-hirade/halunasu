# 2026-05-30 Complete Migration Gap Plan

## Purpose

旧3リポジトリ:

- `/tmp/repo/medical/medical`
- `/tmp/repo/medical/medical-fee-calculation`
- `/tmp/repo/medical/medical-lp`

から、現行monorepo `/Users/hiradekeishi/medical-ai/halunasu` への完全移行状況を突き合わせ、抜けている実装、設定、運用資産、テストゲートを明確化する。

今回の方針は、まずGCPリソース追加なしで復元できるものをrepo内に戻す。その後、STG/PRODで実際に使う経路の修正と検証へ進む。

ただし、Core Platform化によって不要になった旧実装は移行しない。旧資産の完全コピーではなく、現行アーキテクチャで必要な責務だけを残す。

## Summary Judgment

コード/UI本体は大きく移行済み。ただし、以下は完全移行の完了条件を満たしていない。

- Charting billing UIがCore Billing APIへ確実に接続されていない。
- Charting gatewayのPlatform auth bridgeでMFA要求が無効化されている。
- Firestore rules/indexes、GCS lifecycle、retention cleanup、MFA break-glass CLI、OpenAI smoke scriptなど運用資産が欠落している。
- `.env.example` が大幅に縮小され、旧gateway/finalize/STT/SOAP構成を再現しにくい。
- FeeのCSV契約/デモ注文データがactive pathから外れている。
- 旧package scriptの品質ゲート、manual生成、OpenAI smoke、retention ops導線が消えている。
- Docsに「完了」と「pending」が混在している。

したがって、現時点では「LPとFeeはかなり近いが、Chartingは完全移行未完」と判定する。

## Explicitly Not Migrated Because of Platform Architecture

以下は「旧repoに存在したが、Core Platform化後はactive migration対象にしない」と判断する。

| Old asset | Decision | Reason |
| --- | --- | --- |
| `services/billing` as active billing runtime | Do not reactivate | 課金、signup、Stripe webhook、entitlementはCore Platform APIへ集約する。旧billingは`services/billing-api-legacy`として参照保存のみ。 |
| Charting `/contact-signup` public flow as primary signup | Do not keep as active flow | 入口はLP `signup.html` -> Platform APIへ統一する。旧Charting routeはLPへredirectする互換導線で十分。 |
| `cloudbuild.billing.yaml`, `cloudbuild.gateway.yaml`, `cloudbuild.finalize.yaml` | Do not restore as active deploy config | `cloudbuild.node-service.yaml` とP10 deploy scriptに集約済み。旧per-service YAMLは運用分岐を増やすだけ。 |
| `bootstrap_gcp_serverless.sh`, `deploy_cloud_run_zero_fixed.sh` | Do not restore as active scripts | 旧GCP project前提のbootstrap/deployであり、現行のproject split/low-cost scriptと責務が重複する。 |
| `deploy_finalize_cloud_run.sh` | Do not restore now | 現行は費用抑制のためCharting gateway `FINALIZE_MODE=inline` を正とする。独立finalize workerを再開する時だけ新scriptとして設計する。 |
| `scripts/analyze_finalize_timings.mjs` as active script | Do not restore now | 旧scriptはFirestore Admin SDKを直接使う。現行PlatformではFirestore direct accessをstore adapterへ閉じるため、active scriptには戻さない。必要ならPlatform-safeなread-only reporting APIかstore methodとして再設計する。 |
| Deepgram required path | Do not require | ユーザー方針として`DEEPGRAM_API_KEY`は設定しない。OpenAI pathを主経路とし、Deepgramはenv documentation上の任意項目に留める。 |
| Old LP contact CTA to `https://app.halunasu.com/contact-signup` | Do not restore | LP -> `signup.html` -> Platform APIが現行の正規導線。 |
| Old app-specific organization/member master as source of truth | Do not restore | organization/member/facility/department/patientはCore Platformを正とする。product projectはproduct固有データだけを持つ。 |

以下はactive runtimeではないが、検証/運用/再現性のためrepoに戻す。

| Asset | Reason |
| --- | --- |
| `audio_treatment/` | OpenAI STT/SOAP smoke用のデモ音声台本と生成手順として必要。runtime dependencyではない。 |
| `firestore.rules`, `firestore.indexes.json` | サーバー経由アクセス前提とFirestore query要件をrepoで宣言するため必要。 |
| `infra/gcs-raw-audio-lifecycle.json` | GCS raw audioを再開する場合の7日削除policyとして必要。現行inline運用では未適用でよい。 |
| OpenAI smoke scripts | `OPENAI_API_KEY`投入後に低費用でSTT/SOAP経路を確認するため必要。 |
| retention cleanup script | PHI保管期限運用の入口として必要。 |
| MFA break-glass CLI | Core Adminに入れない時の緊急復旧手段として必要。 |

## App-by-App Findings

### 1. Charting: old `medical` -> `halunasu`

#### Migrated

| Old path | New path | Status |
| --- | --- | --- |
| `apps/web/` | `apps/charting-web/` | 全主要routeは移行済み。`/` と `/sessions` は旧同様 `SessionLauncher`。 |
| `services/gateway/` | `services/charting-gateway/` | 旧gatewayをベースにCore Platform auth/shared master bridgeを追加。 |
| `services/billing/` | `services/billing-api-legacy/` | 旧billing serviceはlegacyとして保存済み。 |
| `services/finalize/` | `services/charting-finalize-legacy/` | 旧finalize serviceはlegacyとして保存済み。 |
| `packages/contracts/` | `packages/medical-contracts/` | session metadataにCore master IDを追加。 |
| `packages/core/` | `packages/medical-core/` | store/auth/STT/SOAP/billing domain logicを移行。 |
| legacy docs | `docs/migration-parity/charting-legacy-docs/` | 旧docsは保存済み。 |

#### Gaps

| Priority | Gap | Impact | Fix |
| --- | --- | --- | --- |
| P0 | Charting `/billing` still calls old `/api/v1/billing/*` style API. | Netlify proxy configに`billingLegacy`がなく、Core `/v1/billing/*` とprefixも不一致。課金画面が壊れる可能性が高い。 | `apps/charting-web/lib/billing-api.js` と billing proxy routeをCore Platform APIへ接続する。 |
| P0 | Platform auth bridge sets `mfaRequired: false`. | Core AdminでMFA登録してもCharting login側で特権MFAが効かない。 | Platform identity/memberのMFA状態をCharting operator payloadへ反映する。 |
| P1 | `firestore.rules` missing. | 「ブラウザ直接Firestore禁止」の実装宣言がrepoにない。 | deny-by-default rulesを復元し、適用手順をdocs/scriptsへ追加する。 |
| P1 | `firestore.indexes.json` missing. | Charting gatewayのFirestore queryが本番でindex errorになる可能性。 | 旧indexと現行`encounters` query用indexを宣言する。 |
| P1 | `infra/gcs-raw-audio-lifecycle.json` missing. | raw audioをGCS保存する構成へ戻すと7日削除policyが再現できない。 | lifecycle JSONを復元する。 |
| P1 | `run_retention_cleanup.mjs` missing. | PHI retention cleanupの運用入口がない。 | scriptとnpm scriptを復元する。 |
| P1 | `reset_member_mfa.mjs` missing. | Core Adminに入れないbreak-glass時のCLIがない。 | Platform schema対応のMFA reset CLIを追加する。 |
| P2 | `check_openai_*` scripts missing. | OpenAI STT/SOAP pipelineの低費用smokeが手作業になる。 | 新pathへ合わせてscriptを復元する。 |
| P2 | `audio_treatment/` missing. | デモ音声台本/AivisSpeech生成が再現できない。 | old repoから復元する。 |
| P2 | `.env.example` missing legacy gateway/finalize/STT/SOAP vars. | 旧PROD相当構成を再現しにくい。 | Platform + Charting legacy envを併記する。 |
| P2 | top-level `test:web:e2e`, `test:coverage`, docs/manual, OpenAI smoke, ops scripts missing. | 品質ゲートと運用導線が弱い。 | npm scriptsを復元する。 |

### 2. Fee Calculation: old `medical-fee-calculation` -> `halunasu`

#### Migrated

| Old path | New path | Status |
| --- | --- | --- |
| `src/medical_fee_calculation/` | `python/medical_fee_calculation/` | 旧engine + 新API bridgeを移行。 |
| `tests/test_*.py` | `python/tests/legacy_medical_fee_calculation/` | 旧legacy testsを保存。 |
| `docs/core`, `docs/implementation` | `docs/migration-parity/fee-calculation-legacy-docs/` | 保存済み。 |
| master configs | `configs/...` and `config/migration-parity/...` | active configs + backupとして保存。 |

#### Gaps

| Priority | Gap | Impact | Fix |
| --- | --- | --- | --- |
| P1 | `contracts/order-csv/` only under migration backup. | CSV契約例をactive code/docsから参照しにくい。 | `contracts/order-csv/` をactive pathへ復元する。 |
| P1 | `data/work/example-orders/...` missing. | 実データ形式のデモ/回帰確認CSVがない。 | `data/work/example-orders/` を復元する。 |
| P2 | `configs/*/README.md` only under migration backup. | active configsの更新手順が見えない。 | `configs/official-master/README.md` と `configs/regional-master/README.md` を復元する。 |
| P2 | `regional_manifest.json` has content differences. | 再生成差分か手修正か追跡しにくい。 | 差分理由をdocsに記録し、active manifestを正とするか旧互換へ戻すか決める。 |

### 3. LP: old `medical-lp` -> `halunasu`

#### Migrated

| Old path | New path | Status |
| --- | --- | --- |
| `index.html` | `apps/lp/index.html` | CTAを`signup.html`へ変更。 |
| legal pages | `apps/lp/*.html` | byte-compatible。 |
| manual | `apps/lp/manual/` | byte-compatible。 |
| assets | `apps/lp/assets/` | optimized webp含め移行済み。 |
| `netlify.toml` | `apps/lp/netlify.toml` | byte-compatible。 |

#### Gaps

| Priority | Gap | Impact | Fix |
| --- | --- | --- | --- |
| P1 | Docs says optimized assets missing, but files exist. | 現状把握を誤る。 | Docsを更新する。 |
| P1 | Email link click-through remains manual pending. | 実受信メールからの登録完了が完全自動検証されていない。 | Secret値を使わないmock testと、STG手動確認手順を分けて記録する。 |

## Complete Migration Steps

### Step 1: Repo-level Parity Restoration

Status: implemented in this pass.

GCPリソース追加なしで復元できる旧資産を戻す。

- Done: `firestore.rules`
- Done: `firestore.indexes.json`
- Done: `infra/gcs-raw-audio-lifecycle.json`
- Done: `audio_treatment/`
- Done: `scripts/check_openai_*.mjs`
- Not migrated: `scripts/analyze_finalize_timings.mjs` はFirestore direct accessのためactive復元しない。
- Done: `scripts/run_retention_cleanup.mjs`
- Done: `scripts/reset_member_mfa.mjs`
- Done: active `contracts/order-csv/`
- Done: active `data/work/example-orders/`
- Done: active `configs/*/README.md`
- Done: top-level npm scripts
- Done: `.env.example`

### Step 2: Runtime Critical Fixes

Status: implemented locally; STG/PROD deploy verification pending.

- Done: Charting billing UIをPlatform API `/v1/billing/*` へ接続する。
- Done: Netlify billing proxyをPlatform API targetへ向ける。
- Done: Charting login成功時にPlatform sessionも張り、Charting内のbilling UIがCore Platform sessionで動くようにする。
- Done: Charting gateway Platform auth bridgeでMFA状態を維持する。
- Done: MFA未登録の特権userでは、旧gatewayと同様にMFA enrollment/verification flowへ進むようにする。
- Pending: STG/PRODへdeployして、Charting login -> billing status -> Checkout/Portal発行まで確認する。

### Step 3: Tests and Quality Gates

- Done: `test:web:e2e` を復元する。
- Done: `test:coverage` をmonorepo baseline gateとして復元する。
- Pending: 旧repo相当の高閾値 `90/90/85` は `test:coverage:target` として残す。現状は新規Platform/product packagesとprovider modulesのcoverage不足により未達。
- Done: Migration parity manifestに今回復元した必須ファイルを追加する。
- Pending: Billing client/proxy testを追加する。
- Pending: Charting Platform MFA bridge testを追加する。
- Pending: LP signup mocked flow testを追加する。

### Step 4: STG Verification

費用を増やさない範囲で以下を確認する。

- LP -> signup -> Resend delivery -> password setup -> Stripe Checkout URL
- Core Admin MFA enroll/reset
- Charting login -> session start
- Charting billing status/Checkout/Portal
- Fee API readyz + master DB configured
- OpenAI smokeはAPI key投入済み環境で明示実行する。Deepgramはユーザー方針により必須にしない。

### Step 5: PROD Verification

STGと同じ手順をPRODで実施する。live StripeはCheckout session発行までに留め、不要な課金が発生しないよう未払いsessionはexpireする。

### Step 6: Docs Reconciliation

- `complete-migration-tasks.md`
- `charting.md`
- `fee-calculation.md`
- `lp.md`
- `test-plan.md`

の「Done」「pending」を実装状態に合わせて更新する。

## Verification in This Pass

Local checks:

- `node --check services/charting-gateway/src/server.js`: passed
- `node --check scripts/check_openai_final_transcription.mjs`: passed
- `node --check scripts/check_openai_realtime_transcription.mjs`: passed
- `node --check scripts/check_openai_soap_pipeline.mjs`: passed
- `node --check scripts/reset_member_mfa.mjs`: passed
- `npm run test:migration-parity`: passed
- `npm run test:coverage`: passed with monorepo baseline `line 80 / function 80 / branch 68`
- `npm run test:python:legacy-fee`: 126 tests passed
- `npm test --workspace @medical/core`: 66 tests passed
- `npm test --workspace @halunasu/platform-api`: 46 tests passed
- `npm test --workspace @halunasu/fee-api`: 9 tests passed
- `npm run build --workspace @halunasu/charting-web`: passed

Not executed in this pass:

- STG/PROD deploy
- Live OpenAI smoke
- Resend inbox link click-through
- Stripe live paid subscription completion
- `npm run test:coverage:target` high threshold `line 90 / function 90 / branch 85`

These are intentionally left for the deployment/verification phase to avoid unintended external calls or cost.

## Current Implementation Start

このDoc作成後、Step 1から実装を始める。Step 2以降は、Step 1の検証が通った後に進める。
