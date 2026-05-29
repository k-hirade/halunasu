# 問い合わせ起点 trial 利用・後決済 実装タスク

最終更新: 2026-04-27
元設計: [11-contact-trial-and-later-payment.md](./11-contact-trial-and-later-payment.md)

## 1. 目的

本ドキュメントは、問い合わせ起点で trial 利用を開始し、その後に Stripe 決済で継続利用へ移行する仕組みを、実装順に落としたタスクリストである。

対象は次の流れ。

1. 問い合わせフォーム送信
2. メール確認
3. org / admin provisioning
4. 初回パスワード設定
5. 7 日 trial
6. trial 中の決済導線
7. trial 失効後の access 制御
8. Stripe Checkout / webhook による有効化

## 2. 前提

- 既存の `services/billing` を活かす
- 既存の `organizations.billing` / `organizations.access` を活かす
- 既存の `password_setup_tokens` を再利用する
- billing 用の最終決済は Stripe Checkout Session を使う
- static Payment Link は本線にしない

## 3. 実装フェーズ

## Phase 0: 仕様確定

### Task 0-1: 未決定事項を固定

決める項目:
- trial 日数を `7日` 固定にするか
- trial 失効後の一般ユーザー挙動
  - 完全ログイン不可
  - read-only なし
- 未払い org の保持期間
  - `30 / 60 / 90日`
- 問い合わせフォームの配置
  - `medical-lp`
  - `medical/apps/web/app/signup`
- `organizationCode` / `adminLoginId`
  - 自動採番
  - 入力制

完了条件:
- 本ドキュメントまたは `11` に最終決定が追記されている

---

## Phase 1: Firestore schema / store foundation

### Task 1-1: `signup_applications` を store に追加

追加対象:
- `packages/core/src/store/firestore-store.js`
- `packages/core/src/store/in-memory-store.js`

必要メソッド:
- `createSignupApplication`
- `getSignupApplication`
- `listSignupApplicationsByEmail`
- `updateSignupApplication`
- `reserveSignupIdentifiers`

フィールド:
- `status`
- `source`
- `organizationName`
- `organizationCode`
- `adminName`
- `adminEmail`
- `adminLoginId`
- `phoneNumber`
- `seatEstimate`
- `notes`
- `emailVerifiedAt`
- `verificationTokenHash`
- `provisionedOrgId`
- `provisionedMemberId`
- `trialDays`
- `createdAt`
- `updatedAt`
- `expiresAt`

完了条件:
- unit test で create / read / update / reservation が通る

### Task 1-2: `email_verification_tokens` を store に追加

必要メソッド:
- `createEmailVerificationToken`
- `getEmailVerificationToken`
- `consumeEmailVerificationToken`

要件:
- one-time consume
- expired token を拒否

完了条件:
- token が 1 回しか使えないことを test で確認

### Task 1-3: `organizations.billing` に trial 初期値を入れられるようにする

対象:
- 既存 provisioning path
- `normalizeOrganizationBilling`

追加要件:
- `status = trialing`
- `trialEndsAt`
- `stripeCustomerId = null`
- `stripeSubscriptionId = null`

完了条件:
- trial org を provision した時に billing 初期値が正しく入る

### Task 1-4: `organizations.access` の trial / unpaid 制御を整理

対象:
- `packages/core/src/billing/access-status.js`

要件:
- `trialing -> active`
- `past_due/grace_period -> billing_action_required`
- `suspended -> suspended`

完了条件:
- access helper test が追加されている

---

## Phase 2: contracts / validation

### Task 2-1: 問い合わせフォーム schema を追加

対象:
- `packages/contracts/src/index.js`

追加 schema:
- `contactSignupRequestSchema`
- `contactSignupResponseSchema`
- `verifyContactSignupResponseSchema`
- `contactSignupStatusResponseSchema`

要件:
- メール形式
- 電話番号最小 validation
- seatEstimate 数値 validation

### Task 2-2: Checkout Session request schema を追加

追加 schema:
- `createTrialCheckoutSessionRequestSchema`
- `createTrialCheckoutSessionResponseSchema`

要件:
- `successPath`
- `cancelPath`

---

## Phase 3: public signup / email verification API

### Task 3-1: 問い合わせ送信 API

endpoint:
- `POST /api/v1/contact-signups`

配置:
- `services/billing/src/routes/public-signup.js`
- `services/billing/src/handlers/create-contact-signup.js`

処理:
1. request validate
2. captcha verify
3. rate limit check
4. `signup_application` 作成
5. email verification token 発行
6. 確認メール送信

完了条件:
- 200 response
- Firestore に `signup_application` と token が作成される

### Task 3-2: メール確認 API

endpoint:
- `GET /api/v1/contact-signups/verify?token=...`

処理:
1. token validate
2. consume
3. `signup_application.status = verified`
4. provisioning task enqueue

完了条件:
- consume 後に再利用できない
- provisioning task が起動する

### Task 3-3: 問い合わせ状態確認 API

endpoint:
- `GET /api/v1/contact-signups/:signupId/status`

用途:
- frontend polling

返却:
- `submitted`
- `verified`
- `provisioning`
- `provisioned`

---

## Phase 4: メール送信基盤

### Task 4-1: verification mail sender

対象:
- `services/billing/src/lib/`

送る内容:
- 確認リンク
- 有効期限

### Task 4-2: password setup mail sender

送る内容:
- ログイン URL
- 医療機関コード
- ログイン ID
- 初回パスワード設定リンク

送らないもの:
- 平文パスワード

完了条件:
- local / test では mail stub
- production/stg では provider 差し替え可能

---

## Phase 5: provisioning worker

### Task 5-1: verified signup から org/admin を作成

配置:
- `services/billing/src/handlers/provision-contact-signup.js`

処理:
1. `signup_application` 取得
2. 重複確認
3. `createOrganizationWithAdminMember` 相当で作成
4. `billing.status = trialing`
5. `access.status = pending_setup` または `active`
6. password setup token 発行
7. setup mail 送信
8. `signup_application.status = provisioned`

完了条件:
- org / member / password token / billing / access が一通り作られる

### Task 5-2: 冪等化

要件:
- 同じ provisioning task が複数回走っても二重作成しない

完了条件:
- 同一 signupId で 2 回叩いても 1 org / 1 admin のまま

---

## Phase 6: trial 中の UI / access 制御

### Task 6-1: trial banner を app に追加

表示場所:
- 共通 layout
- または `operator/me` 取得後の global banner

表示条件:
- `billing.status = trialing`

表示内容:
- `無料利用期間はあと X 日`
- `継続利用には決済が必要です`
- `決済する`

### Task 6-2: `アカウント` 画面へ billing CTA を統合

対象:
- `apps/web/components/admin-console.js`

表示内容:
- trial 状態
- trial 終了日
- 決済ボタン

完了条件:
- 既存の独立 `/billing` に依存せず billing 導線が完結する

### Task 6-3: trial 失効 access 制御

対象:
- `services/gateway/src/server.js`
- access helper

要件:
- `org_admin`: login 可、billing 操作可、clinical use 不可
- 一般ユーザー: clinical use 不可

完了条件:
- 失効 org で録音開始 / SOAP 作成が止まる

---

## Phase 7: Stripe Checkout for post-trial payment

### Task 7-1: Checkout Session 作成 API

endpoint:
- `POST /api/v1/billing/checkout-session`

対象:
- `services/billing`

Stripe metadata:
- `orgId`
- `signupId`
- `planCode`

要件:
- `org_admin` 限定
- 既存 trial org からだけ作成

完了条件:
- 認証済み trial org admin が Checkout URL を受け取れる

### Task 7-2: frontend 決済導線

対象:
- `apps/web/components/admin-console.js`
- `apps/web/lib/billing-api.js`

要件:
- CTA 押下で loading
- Checkout URL へ遷移

---

## Phase 8: Stripe webhook integration

### Task 8-1: `checkout.session.completed`

処理:
- `stripeCustomerId`
- `stripeSubscriptionId`
- `stripePriceId`
- `billing.status = active`
- `access.status = active`

### Task 8-2: `customer.subscription.updated`

処理:
- `trialing -> active`
- `active -> past_due`
- `grace_period`

### Task 8-3: `invoice.payment_failed`

処理:
- `billing.status = past_due`
- `access.status = billing_action_required`

### Task 8-4: `invoice.paid`

処理:
- `billing.status = active`
- `access.status = active`

完了条件:
- Stripe event receipt に冪等記録が残る
- billing/access 状態が期待どおり更新される

---

## Phase 9: trial expiration / scheduler

### Task 9-1: trial expiration internal handler

endpoint:
- `POST /internal/billing/enforce-trial-expiration`

処理対象:
- `trialEndsAt <= now`
- `billing.status == trialing`
- 未決済 org

処理:
- `billing.status = checkout_pending` または `suspended`
- `access.status = billing_action_required`

### Task 9-2: Cloud Scheduler 設定

job:
- `medical-billing-enforce-trial-expiration`

schedule:
- hourly

完了条件:
- STG / PROD に job が存在
- 手動 POST で 200 を返す

---

## Phase 10: 問い合わせフォーム UI

### Task 10-1: 問い合わせ画面

候補:
- `medical-lp`
- `medical/apps/web/app/signup`

要件:
- 入力 validation
- loading
- 完了画面

### Task 10-2: メール確認後の中間画面

要件:
- provisioning 中 loading
- 完了時案内

---

## Phase 11: security / abuse protection

### Task 11-1: captcha

要件:
- public endpoint に必須

### Task 11-2: rate limit

対象:
- contact signup
- email verify retry

### Task 11-3: audit

追加 event:
- `contact_signup.submitted`
- `contact_signup.verified`
- `contact_signup.provisioned`
- `billing.trial.expired`

---

## Phase 12: test

### Task 12-1: unit test

対象:
- store
- token consume
- billing/access mapping

### Task 12-2: integration test

シナリオ:
1. contact signup
2. verify
3. provisioning
4. password setup
5. login
6. trial banner
7. checkout session create
8. webhook complete

### Task 12-3: regression test

既存 billing/onboarding を壊していないこと:
- password setup
- billing status API
- portal session
- access enforcement

---

## 4. 推奨実装順

最短で意味がある順序はこれ。

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 10
7. Phase 6
8. Phase 7
9. Phase 8
10. Phase 9
11. Phase 11
12. Phase 12

## 5. 実装開始時の最小スコープ

最初の着手単位としては次が最小。

### Slice A
- `signup_applications`
- `email_verification_tokens`
- `POST /api/v1/contact-signups`
- `GET /api/v1/contact-signups/verify`

### Slice B
- provisioning
- password setup mail
- trial billing/access 初期化

### Slice C
- trial banner
- `アカウント` 画面 CTA
- `POST /api/v1/billing/checkout-session`

### Slice D
- webhook
- trial expiration scheduler

## 6. 完了の定義

以下を満たしたら完了。

1. 問い合わせフォーム送信から trial 開始まで手動介入なし
2. パスワードはメール送信せず setup link だけで開始できる
3. trial 中にアプリ内から Checkout へ進める
4. trial 失効後に clinical use が止まる
5. 決済完了 webhook で自動復帰する
6. STG で end-to-end を再現できる
