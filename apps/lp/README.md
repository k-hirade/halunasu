# @halunasu/lp

ハルナスのランディングページです。

## 構成

- `index.html`: LP 本体
- `signup.html`: Platform API へ申込、メール確認、管理者ログイン用パスワード設定を送る登録ページ
- `assets/`: LP で使用する画像
- `privacy.html` / `terms.html` / `security.html` / `tokushoho.html`: 法務・セキュリティ関連ページ
- `netlify.toml`: Netlify 配信用設定

## ローカル確認

静的 HTML なので、`index.html` をブラウザで直接開いて確認できます。

```sh
open index.html
```

ローカルサーバーで確認する場合:

```sh
python3 -m http.server 8080
```

Platform API を別オリジンで動かす場合は、`signup.html?api=http://localhost:8081` のように `api` クエリでAPIベースURLを指定できます。

## 検証

```sh
npm test --workspace @halunasu/lp
```

## Netlify

Netlify 側では `apps/lp` を base directory として、publish directory は `.` を指定します。
ビルドコマンドは `npm test --workspace @halunasu/lp` です。
