# ローカル構造監査アプリ（halunasu Architecture Inspector）

## 目的

`charting-web`（カルテ自動作成）と`fee-web`（診療報酬算定）の構造を、  
ローカルで独立して可視化するための検証アプリです。

- フロント側ルート（Page / API Route）
- サービス側ルート（services/\* の`server.js`）
- フロント→バックエンドの推定呼び出しフロー
- 未解決API呼び出し（どのサービスにも結び付かない呼び出し）
- ソース参照（ボタンクリックで対象ファイルを即表示）

を一画面で確認できます。

## 構成

- `tools/local-architecture-inspector/server.js`
  - コードスキャン（静的解析）
  - `/api/*` を返すローカルAPI
  - Mermaid図とJSONスナップショットの生成
  - `public/`配下のローカルUI配信

- `tools/local-architecture-inspector/public/index.html`
  - UI本体。外部から見てもすぐ理解できるシンプルなダッシュボード

- `tools/local-architecture-inspector/public/app.js`
  - ダッシュボード描画ロジック
  - 再スキャン、Mermaidコピーボタン、ソースファイルビューア

- `tools/local-architecture-inspector/public/styles.css`
  - 視認性重視のシンプルレイアウト（カード/テーブル/検索/サービス別バーチャート）

### 起動仕様

- 既定では `127.0.0.1:4173` で起動します。
- `--host` / `--port` を指定してバインド先を変更できます。

## 実行コマンド

```bash
cd halunasu/tools/local-architecture-inspector
npm run start
```

- 既定ポート: `4173`
- `--scan-once`を使うと標準出力へJSONを吐いて終了:

```bash
node server.js --scan-once
```

必要ならポート指定:

```bash
node server.js --port=4173
node server.js --host=127.0.0.1 --port=4173
```

※ `npm run dev` はファイル監視で高速反映しますが、監視上限（`EMFILE`）で起動に失敗しやすい環境があるため、確認時は `start` 系を優先します。

## 画面項目

- **Summary cards**
  - 対象アプリ数 / 対象サービス数 / 検出APIフロー / 未解決数
- **Mermaidフロー図**
  - `charting-web` / `fee-web` から主要サービス（gateway, fee-api, platform-api...）へのAPI流を表示
- **アプリ/サービスのルート一覧**
  - Page数、API Route数、主要プレフィックスを確認
- **API呼び出しマッピング**
  - `呼び出し元ファイル → メソッド+パス → 遷移先サービス`
- **検索・フィルタ**
  - サービス名 / 信頼度 / `path` / ファイル名で絞り込み
- **サービス別件数**
  - 遷移先サービスごとの件数を視覚化
- **未解決API**
  - 未分類/外部扱いの呼び出しを強調表示
- **ソースビューア**
  - テーブル行をクリックするとソース全文が表示

## 確認フロー（あなたの要求に対応）

> 「スクリプトだけでなく、実際にアプリを見に行って確認する」

1. `npm run start:local-architecture-inspector` を実行（`npm run dev` は監視版）
2. ブラウザで `http://localhost:4173` を開く
3. 画面更新（再スキャン）で最新スナップショットを取得
4. 未解決/不自然な遷移がないかを確認
5. 必要なら対象ファイルをクリックしてソースを即時確認

## 補足

- このアプリは「補助観測ツール」です。既存アプリの実装を直接変更しません。
- 解析精度はヒューリスティック依存なので、完全に100%ではありません。
  ただし本番に近い構造差分の見落とし検知や、運用初動の確認には十分実用的です。
