# 診療報酬算定・カルテ 総合分析レポート（2026-07-02）

診療報酬算定（fee: `apps/fee-web` + `services/fee-api` + `packages/fee-core` + `python/medical_fee_calculation`）と
カルテ（charting: `apps/charting-web` + `services/charting-gateway` + `services/charting-api` + `services/charting-finalize`）の
2アプリを、コードベース全体を読み込んで分析した結果をテーマ別にまとめる。

## レポート構成

| # | テーマ | ファイル |
|---|--------|---------|
| 1 | セキュリティ | [01-security.md](01-security.md) |
| 2 | UI/UX | [02-ui-ux.md](02-ui-ux.md) |
| 3 | パフォーマンス | [03-performance.md](03-performance.md) |
| 4 | ロジックの改善 | [04-logic.md](04-logic.md) |
| 5 | アーキテクチャ・コード健全性（追加テーマ） | [05-architecture.md](05-architecture.md) |
| 6 | テスト・品質保証（追加テーマ） | [06-testing-quality.md](06-testing-quality.md) |
| 7 | コンプライアンス・PHI・運用（追加テーマ） | [07-compliance-phi-ops.md](07-compliance-phi-ops.md) |
| 8 | 他SaaSベンチマーク（追加テーマ） | [08-saas-benchmark.md](08-saas-benchmark.md) |

## 対応状況（2026-07-02 更新 / branch: `fix/p1-p4-cross-theme`）

ハイプライオリティの P1〜P4 を実装・検証済み。詳細は各テーマ末尾の「対応履歴」を参照。

| ID | 内容 | 状態 | 検証 |
|----|------|------|------|
| P1 | 月次サマリ等のフルスキャン解消（claimMonthクエリへ） | ✅ 実装済 | fee-api 115テスト green |
| P2 | 5xxエラーの内部/PHI露出停止（固定文言化） | ✅ 実装済 | fee-api 115テスト green |
| P3 | 本番CORSの許可オリジン厳格化（preview/localhostを非本番限定） | ✅ 実装済 | 追加CORSテスト green |
| P4a | アクセストークンのlocalStorage永続化を廃止（same-origin構成） | ✅ 実装済 | web-ui/auth テスト green |
| P4b | CSP nonce化（`unsafe-inline`排除・middleware動的付与） | ✅ 実装済 | 本番ビルド＋実起動でnonce一致を確認 |

⚠️ **P4b は本番反映前に Netlify プレビューでの実機スモークが必須**（Netlifyエッジ＋Next 15の nonce 伝播は本レポジトリのローカル本番起動では確認済みだが、Netlifyランタイム固有の挙動は要現地確認）。

## 深刻度の定義

- **高**: 本番運用前に対応すべき。情報漏えい・請求誤り・サービス停止に直結しうる。
- **中**: 計画的に対応すべき。スケール時・攻撃時・監査時に問題化する。
- **低**: 改善が望ましい。技術的負債・体験の摩耗。

## 最重要ファインディング（Top 10）

| 深刻度 | テーマ | 概要 | 場所 |
|--------|--------|------|------|
| 高 | セキュリティ | プラットフォームのアクセストークンを `localStorage` に保存。CSP が `script-src 'unsafe-inline'` のため、XSS 1件でセッション奪取＋CSRF回避（Bearer時はCSRF検証スキップ）まで到達しうる | `packages/web-ui/src/platform-auth.js:13,437-446` / `apps/fee-web/netlify.toml` / `services/fee-api/src/server.js:5991-5996` |
| 高 | セキュリティ | fee-api は 500 以外のエラーで `error.message` をそのままクライアントに返す。Python 算定失敗(502)は stderr（トレースバック・パス・場合により入力値）が丸ごと露出 | `services/fee-api/src/server.js:3399-3405` / `src/python-calculator.js:398,513` |
| 高 | パフォーマンス | 月次サマリAPIが「組織の全セッションを全期間フルスキャン」して1ヶ月分に絞り込んでいる。`listSessionsForClaimMonth` が実装済みなのに未使用 | `services/fee-api/src/server.js:345` vs `src/store/firestore-store.js:111` |
| 高 | パフォーマンス | Python算定ワーカーが単一プロセス直列処理＋算定毎に SQLite 接続・スキーマ初期化。1件のタイムアウトでワーカーごと kill され、待機中の全リクエストが巻き添え | `python/medical_fee_calculation/worker.py` / `api.py:23-27` / `services/fee-api/src/python-calculator.js:273-286` |
| 高 | アーキテクチャ | 巨大単一ファイル群: gateway 7,977行 / clinical-calculation-input 8,889行 / fee-api server 6,291行 / fee-workspace 6,348行 / admin-console 3,507行。変更コスト・レビュー精度・バンドルサイズすべてに波及 | 各所 |
| 中 | コンプライアンス | 患者氏名＋カルテ全文＋診断名を OpenAI API へ送信（fee）。診療音声・逐語・SOAPも同様（charting）。技術的低減策はあるが、委託整理・本人周知・氏名の仮名化は未対応 | `packages/medical-core/src/fee/openai-fee-clinical-facts.js:373,441-452` / `services/charting-gateway/src/server.js:518-610` |
| 中 | セキュリティ | fee-api の CORS が `https://*--halunasu-*.netlify.app`（全デプロイプレビュー）を許可。プレビュー環境のXSS/依存汚染が本番APIへの足がかりになる | `services/fee-api/src/server.js:5941` |
| 中 | パフォーマンス | fee-web は全ルート（/ /sessions /monthly /sessions/[id]）が単一の `FeeWorkspace` クライアントコンポーネントを共有。コード分割ゼロ、64個の useState、正規表現NLPまでクライアントバンドルに同梱 | `apps/fee-web/components/fee-workspace.js` / `app/*/page.js` |
| 中 | ロジック | 請求月の決定が `claimMonth || serviceDate.slice(0,7)` のフォールバック。月遅れ請求・返戻再請求で診療月と請求月がズレるケースの扱いが曖昧 | `services/fee-api/src/server.js:3548` |
| 中 | スケーラビリティ | gateway が録音PCM・WSソケット・レート制限・信頼済み端末をすべてインスタンスローカルの Map に保持。Cloud Run のスケールアウト/再起動で録音喪失・制限バイパスが発生しうる | `services/charting-gateway/src/server.js:358-366,773` |

## 良い点（先に明記する）

分析全体を通して、このコードベースは**同規模スタートアップの平均よりセキュリティ・テストの素地が明確に良い**。

- 認証: scrypt（コスト16384）＋timingSafeEqual、パスワード12文字以上、特権ロールへのTOTP MFA強制、tokenVersion による即時失効
- CSRF: double-submit ＋ セッション埋め込みトークンの三重照合（`auth-client:47-57`）
- Firestore ルールは deny-all（サーバ経由アクセスのみ）で、クライアント直アクセスの事故が構造的に起きない
- 秘密情報: gateway は起動時に `replace-me` デフォルト値を拒否（`assertRequiredSecret`）。本番での runtime bootstrap 禁止も明示
- 監査ログは `safePayload`（件数・フラグのみ）で PHI を含めない設計が徹底
- STG は Netlify Edge の IPアローリスト（`stg-gate.js`）で二重防御
- テスト: fee-api だけで8,852行のテスト、SOAP→算定 E2E ゴールドデータセット391ケース、カバレッジ閾値スクリプト、Playwright UIスモーク

指摘の多くは「良い設計が9割できているのに、残り1割が全体を弱くしている」タイプであり、対処コストは比較的小さい。
