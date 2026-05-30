# Charting / SOAP Migration Parity

## Verdict

部分完了。監査開始時点の `apps/charting-web` は旧 `medical/apps/web` の完全移植ではなく、簡易静的HTMLアプリだった。PRODの `https://charting.halunasu.com/sessions` は旧セッション一覧ではなく、`/` と同じ `index.html` がNetlify fallbackで返っているだけだった。

2026-05-29から2026-05-30の復元作業で旧Next.js資産を `apps/charting-web` に取り込み、旧E2Eはローカルで通過した。STG/PRODのNetlifyはNext.js配信へ切り替え済みで、`/sessions`、Core seeded operator login、`/api/v1/operator/me`、Core患者/施設/診療科取得、session作成まで独自ドメイン上で確認済み。

旧 `services/gateway` は `services/charting-gateway` として取り込み済み。旧 `services/finalize` と旧 `services/billing` も、それぞれ `services/charting-finalize-legacy`、`services/billing-api-legacy` として保存した。`services/charting-gateway` にはCore Platformのlogin identity/member/entitlement bridgeと、患者/施設/診療科のshared master bridgeを追加済み。

重要: 旧GatewayをそのままCore Firestoreへ向けるのは不可。旧 `@medical/core` は `organizations`, `login_identities`, `members` などを旧schemaで直接読み書きするため、現行Platform schemaと衝突する。短期互換で旧Gatewayを使う場合も、Product project側に隔離するか、Core Platform storeへ明示的にbridgeする必要がある。

旧Charting E2Eは `apps/charting-web` で11件すべて通過した。

## 旧実装の責務

旧 `medical/apps/web` はNext.jsアプリで、以下のルートを持っていた。

| 旧ルート | 旧コンポーネント | 必須機能 |
| --- | --- | --- |
| `/` | home | 診療アプリ入口、ログイン導線 |
| `/sessions` | `SessionLauncher` | セッション一覧、検索、状態フィルタ、ページング、新規セッション作成 |
| `/sessions/[sessionId]` | `EncounterWorkspace` | 診療ワークスペース、録音、書き起こし、SOAP、レビュー、承認 |
| `/admin` | `AdminConsole` | 権限管理、プロンプト設定、音声テスト、監査ログ |
| `/billing` | `BillingConsole` | Stripe契約状態、Checkout、Customer Portal |
| `/contact-signup` | onboarding | 問い合わせ申込 |
| `/contact-signup/submitted` | onboarding | 申込完了 |
| `/contact-signup/verify` | onboarding | メール確認 |
| `/setup-password/[tokenId]` | setup | 初回パスワード設定 |
| `/signup` | signup | サインアップ |
| `/signup/success` | signup | サインアップ成功 |
| `/signup/cancel` | signup | サインアップキャンセル |
| `/mobile/join` | mobile | QR/リンクからスマホ録音参加 |
| `/mobile/recorder` | mobile | スマホ録音端末UI |
| `/mobile/audio-test` | mobile | モバイル音声テスト |

旧主要ファイル:

- `apps/web/components/session-launcher.js`
- `apps/web/components/encounter-workspace.js`
- `apps/web/components/admin-console.js`
- `apps/web/components/audio-test-panel.js`
- `apps/web/components/mobile-join-client.js`
- `apps/web/components/mobile-audio-test-client.js`
- `apps/web/components/billing-console.js`
- `apps/web/components/operator-login-panel.js`

## 旧API

旧 `services/gateway` は以下の機能を持っていた。

- operator login / mfa / csrf / logout / me
- organizations / role definitions / members
- member password reset / roles / status / revoke sessions / MFA reset
- trusted recorders
- audio tests
- SOAP formats / draft / publish / archive / infer / preview / stream preview / assignment
- audit events
- sessions list / create / read / delete
- session prompt options / prompt profile
- session metadata
- mobile pairings / trusted recorder assignment
- recording source / start / stop / discard
- mobile recording start / stop
- generate SOAP / regenerate SOAP / review note / approve note
- pairings claim
- websocket live transcript / audio activity
- OpenAI Realtime STT, Deepgram fallback, final transcript, SOAP generation
- raw audio / artifact storage hooks

旧 `services/finalize` は `/internal/finalize` で実際のfinal transcriptとSOAP生成を担当していた。

旧 `services/billing` は contact signup、password setup、billing portal、Stripe webhook、internal billing tasks を担当していた。

## 現行実装

監査開始時点の `apps/charting-web/index.html` は単一静的HTMLで、主に以下だけを持っていた。この静的HTMLは旧Next.jsアプリ復元後に削除済みで、Netlifyの配信対象はNext.js buildへ切り替える。

- 病院コード、個人ID、パスワードのログイン
- 患者作成/選択
- encounter作成
- 録音開始/停止の状態変更
- 簡易SOAP生成
- SOAP保存/承認

現行 `apps/charting-web` は旧Next.jsアプリへ復元済みで、`/sessions`、`/sessions/[sessionId]`、`/admin`、`/mobile/*` などの旧ルートを持つ。

現行 `services/charting-api` はCore Platform連携用の `/v1/charting/...` の小さなAPIで、旧gateway互換APIではない。ただし `mock-soap` という本番導線名は削除し、`/soap-drafts/generate` へ変更済み。

旧gateway/finalize/billingは以下へ保存済み。

- `services/charting-gateway`
- `services/charting-finalize-legacy`
- `services/billing-api-legacy`

## 差分

| 領域 | 状態 | 修正方針 |
| --- | --- | --- |
| Next.jsルート | STG/PROD配信済み | 深い操作単位のE2Eを追加 |
| `/sessions` | STG/PROD確認済み | 操作回帰を継続 |
| `/sessions/[sessionId]` | ルート復元済み | ローカルE2E通過、STG/PRODではsession作成まで確認 |
| スマホ録音 | 旧UI/API保存済み | Gateway deployとCore bridgeが必要 |
| live STT | 旧実装保存済み | 新Charting projectにOpenAI/Deepgram secretsが未設定。費用発生を避けるため自動smoke対象外 |
| final transcript | 旧実装保存済み | `charting-finalize-legacy` を本番workerへ昇格するか統合 |
| SOAP生成 | 旧実装保存済み | secret未設定時はlocal preview。実AI出力確認はsecret追加後に手動smoke |
| admin SOAP format | 旧UI/API保存済み | Core Adminとの権限/導線整理 |
| audio test | 旧UI/API保存済み | PC/モバイル音声テストをSTGで確認 |
| billing | Core billing/Stripe entitlementへ接続済み | Charting内のbilling表示はCore APIを利用する方針 |
| E2E | ローカル移植済み | deploy後の録音/SOAP操作確認を追加 |
| 旧静的Charting | 削除済み | 誤配信防止のため復活させない |
| Gateway認証 | Core Platform認証bridge追加済み | STG/PRODでCore seed userによるlogin確認済み |
| Core shared master | Core患者/施設/診療科bridge追加済み | STG/PRODでlist/create session確認済み |

## TO-BE

共通プラットフォームは維持する。

- Core Platform: org, member, facility, department, patient, entitlement, audit, shared auth
- Charting product: encounter/session, raw audio, transcript turns, mobile pairing, recorder trust, SOAP versions, prompt profiles, STT/SOAP provider integration
- Billing: product entitlementとStripeの連携はCoreで管理。ただし旧billing UI/APIの互換導線は復元する。

旧gatewayを丸ごとCoreに戻すのではなく、以下のどちらかで互換性を確保する。

1. 短期: 旧gateway/finalize/billingを `services/charting-gateway`, `services/charting-finalize`, `services/billing-api` として復元し、Coreのorg/member/patientへbridgeする。
2. 中期: 旧UIが呼ぶ `/api/v1/...` 互換APIを新 `platform-api` / `charting-api` の薄いadapterで提供する。

短期は旧UI/旧テスト再利用に強い。中期は理想設計に近い。完全移行は短期復元を先に行い、その後adapterを減らす。

## 完了条件

- `/sessions` と `/sessions/[sessionId]` が旧UIとして表示される。ローカルE2E Done、STG/PRODはsession作成までDone。
- `/sessions` と `/` が同一HTMLではない。STG/PROD Done.
- 旧E2Eの以下が現行repoで実行できる。
  - `encounter-ui-regression.test.js`
  - `global-menu.test.js`
  - `admin-member-actions.test.js`
  - `admin-prompt-title.test.js`
  - `admin-audio-test.test.js`
  - `horizontal-scroll-source-guard.test.js`
- 上記旧E2Eはローカルで11件通過。Done.
- `services/charting-gateway` はローカル `healthz` 起動確認済み。Done.
- STG/PRODでログイン、一覧、API proxy、Core共有データ取得、新規セッション作成は確認済み。
- STG/PRODで録音導線、実AI STT/SOAP生成/再生成/承認まで確認する。OpenAI/Deepgram secret未設定かつ費用発生を避けるためmanual pending.
