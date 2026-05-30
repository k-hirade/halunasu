# LP Migration Parity

## Verdict

完了。現行 `apps/lp` は旧 `medical-lp` の主要ページ/法務ページ/マニュアルを保持し、`signup.html` とvalidate scriptを追加している。Netlify静的配信はSTG/PRODへ反映済み。LP登録フォームはPlatform signup APIに接続済みで、初回パスワード設定後にStripe Checkout開始を要求する。Stripe secret/Price/Webhookは正Stripeアカウント `medical-ai` でSTG/PRODとも設定済み。

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
| signup | Platform signup/Checkout開始要求までSTG/PROD反映済み | STG/PROD Checkout/Webhook/Portal確認済み |
| Netlify | PROD/STG root 200確認済み | `www.halunasu.com` はNetlifyでrootへ301。`www.stg.halunasu.com` は未使用 |

## 完了条件

- 旧LPで存在したページが全て現行に存在する。
- 旧LPの重要CTA、資料/マニュアル、法務ページへのリンクが現行でも機能する。
- 追加した `signup.html` がCore signup APIへ接続され、Stripe設定済み環境ではCheckout URLへ遷移する。
- `halunasu.com` と `www.halunasu.com` が現行LPへ到達する。Done. `www.halunasu.com` は `https://halunasu.com/` へ301。
- `stg.halunasu.com` が現行STG LPを返す。Done. `www.stg.halunasu.com` はDNS未設定で、現行運用対象外。
