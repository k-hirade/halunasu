# Stripe課金・病院オンボーディング実装設計

最終更新: 2026-05-07
対象: `services/billing`, `apps/web`, `packages/core`

## 1. 概要

現在の実装は、LP からいきなり Stripe Checkout に入る構成ではない。
先に `contact signup -> メール確認 -> 病院作成 -> 初回パスワード設定 -> trial 開始` を進め、trial 終了後または必要時に管理画面から Checkout を開く構成である。

## 2. 現在のフロー

```mermaid
flowchart LR
    LP[medical-lp] --> SIGNUP[/contact-signup]
    SIGNUP --> VERIFY[確認メール]
    VERIFY --> PROVISION[病院作成]
    PROVISION --> SETUP[/setup-password/:tokenId]
    SETUP --> LOGIN[operator login]
    LOGIN --> APP[/]
    APP --> ACCOUNT[/admin?section=account]
    ACCOUNT --> CHECKOUT[Stripe Checkout]
    ACCOUNT --> PORTAL[Stripe Customer Portal]
    STRIPE[Stripe Webhook] --> BILL[services/billing]
    BILL --> FS[(Firestore)]
```

## 3. 実装済み責務

### `services/billing`

- `POST /api/v1/contact-signups`
- `GET/POST /api/v1/contact-signups/verify`
- `POST /api/v1/contact-signups/:signupId/resend`
- `GET/POST /api/v1/password-setup/:tokenId`
- `GET /api/v1/billing/status`
- `POST /api/v1/billing/checkout-session`
- `POST /api/v1/billing/portal-session`
- `POST /api/v1/stripe/webhook`
- internal billing ops endpoint 群

### `apps/web`

- `contact-signup` の公開フォーム
- `contact-signup/submitted`
- `contact-signup/verify`
- `setup-password/[tokenId]`
- `/admin?section=account` の契約状態表示

### `packages/core`

- signup / password setup / access status の domain logic
- Firestore / in-memory store 実装
- operator auth helper

## 4. 現在の onboarding 詳細

### 4.1 問い合わせ申込

入力:

- 医療機関名
- 担当者名
- 担当者メール
- 電話番号
- 想定利用人数
- 備考
- 規約 / プライバシー同意

結果:

- `signup_applications/{signupId}` を作成
- `source=lp_contact_form`
- `status=submitted`
- `planCode=medical_ai_monthly`
- email verification token を発行

### 4.2 メール確認

- 確認リンクは `24h` 有効
- `GET /api/v1/contact-signups/verify` は inspection only
- `POST /api/v1/contact-signups/verify` が provisioning を明示的に実行する

### 4.3 provisioning

メール確認後、現在の実装は Stripe webhook を待たずに病院を作成する。

作成されるもの:

- `organizations/{orgId}`
- `members/{memberId}`
- `login_identities/{organizationCode:loginId}`
- `password_setup_tokens/{tokenHash}`

初期状態:

- `billing.status = trialing`
- `access.status = pending_setup`

### 4.4 初回パスワード設定

- 管理者が `setup-password` で password を設定する
- 完了後に通常の operator login に入る

### 4.5 利用開始

- ログイン後、`organization.access.status` が `active` なら診療機能を使える
- billing status は account section で確認する

## 5. trial と Checkout

### 現在の考え方

- trial は organization 作成時に始まる
- trial 中に Stripe subscription がまだ無い場合がある
- trial 期限超過時は internal job が状態を更新する

### trial 期限切れ

`POST /internal/billing/enforce-trial-expiration`

挙動:

- `trialing` かつ `stripeSubscriptionId` が無い組織を検出
- `billing.status -> pending_checkout`
- `access.status -> billing_action_required`

### Checkout 開始

`POST /api/v1/billing/checkout-session`

条件:

- 組織が checkout 開始可能な billing state
- 対応する signup_application が存在
- org admin / platform admin 相当の権限

Checkout は post-trial の subscription 開始を想定し、新しい trial は付けない。

## 6. webhook と継続課金

現在処理している主な event:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

反映先:

- `organizations/{orgId}.billing`
- `organizations/{orgId}.access`
- `signup_applications/{signupId}`
- `stripe_event_receipts/{eventId}`

## 7. access 状態への変換

Stripe status をそのまま UI 権限に使わず、内部 status に変換する。

| billing.status | access.status |
|---|---|
| `trialing` | `pending_setup` または `active` |
| `active` | `active` |
| `pending_checkout` | `billing_action_required` |
| `past_due` | `billing_action_required` |
| `grace_period` | `billing_action_required` |
| `unpaid` | `billing_action_required` |
| `canceled` | `canceled` |
| `suspended` | `suspended` |

## 8. Customer Portal

`POST /api/v1/billing/portal-session`

用途:

- 支払い方法更新
- subscription 管理
- Stripe 側の self-serve billing 操作

## 9. 現在の source of truth

### route

- 公開導線は `signup` ではなく `contact-signup`
- `/signup` は `contact-signup` へ redirect

### データ

- trial は signup 完了ではなく provisioning 時点で organization 側に付く
- billing status は organization に正として保存する

### 権限

- billing API は gateway と同じ operator session / CSRF ルールを共有する

## 10. 今後の余地

1. LP から直接 Checkout に入る完全 self-serve 化
2. billing service の deploy script 整備
3. 請求分析や usage-based seat 管理
4. 外部会計 / 請求書運用連携
