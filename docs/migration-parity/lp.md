# LP Migration Parity

## Verdict

部分完了。現行 `apps/lp` は旧 `medical-lp` のファイルを多く含むが、`index.html` と `README.md` に差分があり、現行側には `signup.html` とvalidate scriptが追加されている。Netlify静的配信はSTG/PRODへ反映済みで、PROD `halunasu.com` は200を確認済み。LP登録フォームはPlatform signup APIに接続済みで、初回パスワード設定後にStripe Checkout開始を要求する実装もSTG/PRODへdeploy済み。Stripe secret/Price設定とWebhook反映は残る。

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
| signup | Platform signup/Checkout開始要求までSTG/PROD反映済み | Stripe secret/Price設定後にCheckout/WebhookをSTG/PROD実確認 |
| Netlify | PROD root 200確認済み | `www.halunasu.com` とsignup/contact導線の実行確認 |

## 完了条件

- 旧LPで存在したページが全て現行に存在する。
- 旧LPの重要CTA、資料/マニュアル、法務ページへのリンクが現行でも機能する。
- 追加した `signup.html` がCore signup APIへ接続され、Stripe設定済み環境ではCheckout URLへ遷移する。
- `halunasu.com` と `www.halunasu.com` が現行LPを返す。`halunasu.com` Done / `www` final check Pending.
