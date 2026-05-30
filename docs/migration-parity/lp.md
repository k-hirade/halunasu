# LP Migration Parity

## Verdict

コード上は移行済み。現行 `apps/lp` は旧 `medical-lp` の主要ページ/法務ページ/マニュアルを保持し、`signup.html` とvalidate scriptを追加している。LP登録フォームはPlatform signup APIに接続済みで、初回パスワード設定後にStripe Checkout開始を要求する。Stripe secret/Price/Webhookは正Stripeアカウント `medical-ai` でSTG/PRODとも設定済み。

2026-05-30時点の追加修正で、旧 `services/billing` が使っていたResend確認メール送信を `platform-api` に移植した。STG/PRODともSecret Managerの `RESEND_API_KEY` を追加し、Platform API、LP、Charting旧登録URL redirectをdeploy済み。STGでは実Resend送信が `delivered=true` で成功した。

## 旧実装

旧 `medical-lp` は静的サイト。

主要ファイル:

- `index.html`
- `privacy.html`
- `security.html`
- `terms.html`
- `tokushoho.html`
- `manual/index.html`
- `manual/harunas-user-manual-v1.pdf`
- `assets/doctor-hero.png`
- `assets/doctor_long.png`
- `assets/doctor_pc.png`
- `assets/shakehands.png`
- `assets/optimized/*.webp`
- `assets/brand/harunas-mark.png`
- `netlify.toml`

## 現行実装

現行 `apps/lp` には以下がある。

- `index.html`
- `privacy.html`
- `security.html`
- `terms.html`
- `tokushoho.html`
- `signup.html`
- `manual/index.html`
- `manual/harunas-user-manual-v1.pdf`
- `assets/*.png`
- `netlify.toml`
- `scripts/validate-static-site.mjs`

## 差分

| 領域 | 状態 | 修正方針 |
| --- | --- | --- |
| `index.html` | 差分あり | 旧LPと現行LPのセクション/文言/CTA/フォーム導線をHTML単位で比較 |
| optimized assets | 未移植 | `assets/optimized/*.webp` を取り込むか、現行で不要な理由を明記 |
| signup UI | 旧お問い合わせフォーム寄せ済み | 送信後はフォームを隠し、「確認メールを送信しました」ブロックのみ表示 |
| signup email | Resend送信コードはPlatform APIへ移植済み | STG/PROD deploy済み。STG実送信確認済み |
| signup billing | Platform signup/Checkout開始要求まで実装済み | STG/PROD Checkout/Webhook/Portal確認済み |
| Netlify | PROD/STG root 200確認済み | `www.halunasu.com` はNetlifyでrootへ301。`www.stg.halunasu.com` は未使用 |

## 完了条件

- 旧LPで存在したページが全て現行に存在する。
- 旧LPの重要CTA、資料/マニュアル、法務ページへのリンクが現行でも機能する。
- 追加した `signup.html` がCore signup APIへ接続され、Stripe設定済み環境ではCheckout URLへ遷移する。
- 登録送信後にResendで確認メールを送り、メールリンク `/signup?token=...` から病院/管理者作成へ進む。
- メール確認後にResendで初回パスワード設定リンク `/signup?setup=...` を送る。
- `halunasu.com` と `www.halunasu.com` が現行LPへ到達する。Done. `www.halunasu.com` は `https://halunasu.com/` へ301。
- `stg.halunasu.com` が現行STG LPを返す。Done. `www.stg.halunasu.com` はDNS未設定で、現行運用対象外。

## Secret追加が必要な項目

Secret投入済み。再発行時は以下で更新する。

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

Resendの送信元はdeploy scriptで `EMAIL_FROM_ADDRESS="Halunasu <no-reply@mail.halunasu.com>"`、返信先は `EMAIL_REPLY_TO_ADDRESS="info@halunasu.com"` を既定値にする。Resend側で `mail.halunasu.com` ドメイン認証が未完了なら、認証済み送信元に合わせて `EMAIL_FROM_ADDRESS` を指定してdeployする。

## 2026-05-30 Deploy Result

- `platform-api-stg`: `platform-api-stg-00013-m4r`
- `platform-api-prod`: `platform-api-prod-00008-6sk`
- LP STG: `https://6a1aa45917acbbc20b228722--halunasu-lp-stg.netlify.app`
- LP PROD: `https://6a1aa4611b2c5f373ec4fb05--halunasu-lp-prod.netlify.app`
- Charting STG: `https://6a1aa4c7c8c2cb14b96f2a63--halunasu-charting-stg.netlify.app`
- Charting PROD: `https://6a1aa52b1b2c5f3874c4fd01--halunasu-charting-prod.netlify.app`
- STG signup smoke: `resend-smoke-20260530-1754` / `info@halunasu.com` でResend delivery success。provider message idは `e82b3fb1-131e-489a-bffb-481480bf6b7c`。
