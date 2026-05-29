# 2026-04-28 Billing / Contact Signup Security & Refactor Audit

Scope:
- `services/billing`
- `apps/web` onboarding / billing UI
- `packages/core` signup / token / billing store paths

Out of scope for this memo:
- PROD Stripe Billing Portal configuration completion
- Resend sender domain onboarding
- trial length policy discussion (`14 days` is the current intended runtime behavior)

Status note:
- This memo captured the pre-fix state.
- `P0-01`, `P1-01`, `P1-02`, `P2-01`, `P2-02` have since been addressed on `stg`.
- The findings are retained here as a record of what was changed and why.

## Findings

### P0

#### P0-01 `GET /api/v1/contact-signups/verify` が副作用付きで、メールリンクスキャナや prefetch で自動実行されうる

Files:
- [services/billing/src/routes/contact-signup.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/routes/contact-signup.js)
- [apps/web/components/contact-signup-verify-panel.js](/Users/hiradekeishi/medical-ai/medical/apps/web/components/contact-signup-verify-panel.js:31)
- [services/billing/src/handlers/verify-contact-signup.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/handlers/verify-contact-signup.js)

Current behavior:
- メール内リンクを開くと `GET /api/v1/contact-signups/verify?token=...` がそのまま token 消費、signup 更新、org/admin provisioning、password setup mail 発行まで進める。
- verify page も mount 時に自動でこの `GET` を叩く。

Risk:
- メールセキュリティ製品や link preview/prefetch が `GET` を先に実行すると、本人が明示操作していないのにアカウント作成と token 消費が進む。
- contact signup フロー全体が「リンクを開いただけ」で state change するのは防御が弱い。

Recommended change:
- `GET` は token の存在確認と画面描画だけにする。
- token 消費と provisioning は `POST /api/v1/contact-signups/verify` に分離し、画面上の明示操作でのみ実行する。
- verify 完了後は one-time completion state を返す。

---

### P1

#### P1-01 public status endpoint が signup 全体を返しており、公開範囲が広すぎる

Files:
- [services/billing/src/routes/contact-signup.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/routes/contact-signup.js)
- [packages/contracts/src/index.js](/Users/hiradekeishi/medical-ai/medical/packages/contracts/src/index.js:903)
- [apps/web/components/contact-signup-submitted-panel.js](/Users/hiradekeishi/medical-ai/medical/apps/web/components/contact-signup-submitted-panel.js:93)

Current behavior:
- `GET /api/v1/contact-signups/:signupId/status` が `signupApplicationSchema` をそのまま返す。
- schema には `adminEmail`, `organizationCode`, `adminLoginId`, `orgId`, `memberId`, `stripeCustomerId`, `stripeSubscriptionId` まで含まれる。

Risk:
- `signupId` はランダムだが、submitted page の query param としてブラウザ URL に載る。
- URL 共有、ログ、解析タグ、スクリーンショットなどから漏れた場合、public endpoint で必要以上の状態が引ける。

Recommended change:
- public 用 schema を別に切り、返す値を `status`, `organizationName`, `createdAt` など最小限に絞る。
- `signupId` 直指定ではなく、status polling 用の別トークンを発行する方が安全。

#### P1-02 public contact signup に abuse 対策が無い

Files:
- [services/billing/src/server.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/server.js:29)
- [services/billing/src/routes/contact-signup.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/routes/contact-signup.js)
- [apps/web/components/contact-signup-onboarding.js](/Users/hiradekeishi/medical-ai/medical/apps/web/components/contact-signup-onboarding.js:24)

Current behavior:
- `POST /api/v1/contact-signups` は public で、CAPTCHA / Turnstile / reCAPTCHA / rate limiting / IP throttle が無い。
- 同一 email の再送分岐はあるが、bot/spam 抑止にはなっていない。

Risk:
- 問い合わせスパム
- verify mail の大量送信
- Firestore signup 蓄積
- 送信基盤コスト増

Recommended change:
- IP + email ベースの rate limiting
- CAPTCHA / Turnstile
- 同一 origin だけではなく request volume の抑制
- 監査イベントに IP hash / UA hash を足す

---

### P2

#### P2-01 provisioning 後の password setup mail 失敗が運用上サイレント

Files:
- [services/billing/src/handlers/provision-contact-signup.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/handlers/provision-contact-signup.js:165)
- [services/billing/src/handlers/resend-contact-signup-mail.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/handlers/resend-contact-signup-mail.js)

Current behavior:
- provisioning 完了後の `sendPasswordSetupMail` は `try/catch` で握っており、失敗しても signup は `provisioned` のまま残る。
- ログは出るが、再送 API / 管理UI / dead-letter queue は無い。

Risk:
- 実メール送信を有効化した後、配送失敗で利用開始できない signup が出ても、運用上の回収導線が弱い。

Recommended change:
- password setup mail 再送 endpoint
- admin からの再送導線
- 配送失敗イベントの監査記録と alert

#### P2-02 public signup router が複数フローを抱えており、修正時の影響範囲が広い

Files:
- [services/billing/src/routes/contact-signup.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/routes/contact-signup.js)
- [services/billing/src/routes/public-billing.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/routes/public-billing.js)
- [services/billing/src/handlers/create-checkout-session.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/handlers/create-checkout-session.js:54)
- [services/billing/src/handlers/create-contact-signup.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/handlers/create-contact-signup.js:8)

Current behavior:
- 1つの router に
  - legacy `/signup`
  - contact signup
  - verify / status
  - legacy checkout
を同居させている。
- `trialDays` のような shared config も両フローにまたがる。

Risk:
- onboarding フロー追加や trial policy 変更時に、別フローへ意図せず波及しやすい。
- test があっても設計上の結合は強い。

Recommended change:
- router を
  - `legacy-signup`
  - `contact-signup`
  - `public-billing`
へ分離
- flow ごとの config を明示

#### P2-03 docs と runtime behavior の drift がある

Files:
- [docs/core/11-contact-trial-and-later-payment.md](/Users/hiradekeishi/medical-ai/medical/docs/core/11-contact-trial-and-later-payment.md:62)
- [services/billing/src/config.js](/Users/hiradekeishi/medical-ai/medical/services/billing/src/config.js:60)

Current behavior:
- runtime は `BILLING_TRIAL_DAYS=7`
- docs の一部は `7日` 前提の記述が残っている

Risk:
- 実装判断そのものではなく、運用認識ズレの原因になる。

Recommended change:
- docs を runtime に合わせて 7 日へ更新
- あるいは policy 決定後に docs/runtime を一括で同期

## Recommended order

1. `P0-01` verify endpoint の副作用分離
2. `P1-01` public response schema の縮小
3. `P1-02` abuse controls
4. `P2-01` resend / recovery path
5. `P2-02` router / flow 分離
6. `P2-03` docs sync
