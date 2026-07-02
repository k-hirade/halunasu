# 01. セキュリティ

対象: `apps/fee-web`, `apps/charting-web`, `services/fee-api`, `services/charting-gateway`, `services/platform-api`, `packages/auth-client`, `packages/web-ui`。

---

## 総評

認証・認可の土台は堅い。scrypt(N=16384) パスワードハッシュ、HMAC署名セッション＋timingSafeEqual検証、tokenVersion即時失効、double-submit CSRF、特権ロールへのTOTP MFA強制、Firestore deny-all ルール、起動時のデフォルト秘密拒否——このあたりは同規模のプロダクトより明確に成熟している。

一方で、**「トークンの置き場所」と「エラーの返し方」と「境界の緩さ」**に、本番前に潰すべき穴が集中している。以下、深刻度順。

---

## 高-1: アクセストークンを localStorage に保存（XSSでセッション奪取）

**場所**: `packages/web-ui/src/platform-auth.js:13, 427-446`

```js
const ACCESS_TOKEN_STORAGE_KEY = "halunasu_platform_access_token";
function writeAccessToken(token) {
  window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
}
```

fee-web / charting core-admin のプラットフォーム認証は、Bearerアクセストークンを `localStorage` に保存し、リクエスト時に `authorization: Bearer` として付与する（`platform-auth.js:50, 161`）。セッション cookie は HttpOnly/SameSite/Secure で保護されている（`auth/session.js:173-182`）のに、**同じ権限を持つBearトークンがJSから読める場所に併存している**。

- XSS が1つでも成立すると、攻撃者は `localStorage` からトークンを抜いて任意の端末からAPIを叩ける。HttpOnly cookie の防御が無意味化する。
- しかも fee-api は Bearer 認証時に CSRF 検証をスキップする（`server.js:5991-5995`）。これは Bearer 単体では正しい判断だが、「localStorage のトークンは盗める」前提と組み合わさると、盗んだトークンでの変更操作に追加障壁がない。

**なぜ問題か**: 診療報酬・カルテという最上位機微データを扱う以上、セッションクレデンシャルは「JSから読めない」ことが最低ライン。医療系は標的型XSS/サプライチェーン混入の対象になりやすい。

**推奨**:
1. アクセストークンの localStorage 保存を廃止し、HttpOnly cookie（既にある `halunasu_session`）に一本化する。Bearer 経路が本当に必要なのはネイティブ/CLIだけのはず。
2. 残すなら、後述のCSP強化（`unsafe-inline` 除去）とセットにして被害面を最小化する。

---

## 高-2: 500未満のエラーで `error.message` を素通しでクライアントへ返す

**場所**: `services/fee-api/src/server.js:3399-3405`

```js
message: statusCode === 500 ? "Internal server error" : error.message,
```

500 の場合だけ "Internal server error" にマスクされ、それ以外（400/401/403/**502/503/504**）は `error.message` がそのままレスポンスに載る。ここに Python 算定エンジンの失敗が乗る:

- `python-calculator.js:398, 513` — ワーカー/spawn の close ハンドラで、`error.message = stderr`（Pythonトレースバック全文）を 502 エラーに詰める。
- 結果、算定失敗時に **Pythonスタックトレース・内部モジュールパス・DBパス・場合によっては入力データ片** がクライアントに露出する。

**なぜ問題か**: 内部構造の露出は攻撃の下見に使われる。トレースバックに患者データ由来の値が含まれれば PHI 漏えいにもなる。

**推奨**: 5xx も含めてクライアント向けメッセージを固定文言＋エラーコードにし、詳細はサーバログ（`logFeeApiError` は既に stack を stderr へ出している）だけに残す。`FeeCalculationError` の `message` はログ専用フィールドに移す。

---

## 高-3: gateway のセッション状態がインスタンスローカル（スケール時の破綻＋制限バイパス）

**場所**: `services/charting-gateway/src/server.js:358-367`

```js
const socketIndex = new Map();
const rateLimitBuckets = new Map();          // ← store.checkRateLimit があればそちら優先だが…
const trustedRecorderRegistry = new Map();
const pendingFinalizeAudio = new Map();      // ← 録音PCMをメモリ保持(TTL 30分)
```

`checkRateLimit` は `store.checkRateLimit` があればそれを使うフォールバック設計になっている（`server.js:1379-1394`）ので、ストア次第でレート制限は共有可能。ただし **録音音声・WSソケット・信頼済み端末レジストリはインメモリ固定**。

**なぜ問題か**（Cloud Run 前提）:
- スケールアウトすると、ログイン試行が別インスタンスに分散し、インメモリ側だけを見ればレート制限を実質バイパスできる（ストア共有が効いていない環境では顕著）。
- 録音中にインスタンスが再起動/切替されると `pendingFinalizeAudio` が消え、録音が finalize されず失われる。医療記録の消失は重大インシデント。

**推奨**: レート制限とセッション/録音状態は必ず共有ストア（Firestore/メモリストア→Redis等）に寄せる。gateway はステートレスにする。少なくとも「単一インスタンス固定運用」である旨を運用ドキュメントに明記する。

---

## 中-1: CORS がデプロイプレビュー全ドメインを許可

**場所**: `services/fee-api/src/server.js:5938-5943`

```js
|| /^https:\/\/[a-z0-9-]+--halunasu-[a-z0-9-]+\.netlify\.app$/.test(origin)
|| /^http:\/\/localhost(:\d+)?$/.test(origin)
```

`*--halunasu-*.netlify.app`（＝あらゆるブランチ/デプロイプレビュー）を本番APIが受け入れる。プレビュー環境は保護が緩く、そこでのXSSや第三者PRのビルドが本番APIの正当なオリジンとして振る舞える。localhost 許可も、環境ガードなしなら本番でも通る点に注意（`env` 分岐がない）。

**推奨**: プレビュー用ワイルドカードは STG-API 限定にする。本番 fee-api の許可オリジンは固定リスト＋環境変数のみに絞る。localhost は非本番環境限定に。

---

## 中-2: PHI の外部送信（OpenAI）— 技術的低減はあるが運用整理が未完

**場所（fee）**: `packages/medical-core/src/fee/openai-fee-clinical-facts.js:373, 441-452`

```js
"Clinical text:", String(clinicalText || "").trim()   // カルテ全文
patientDisplayName: context.patientDisplayName || "",  // 患者氏名
diagnoses: ...slice(0, 20)                             // 診断名
```

**場所（charting）**: `services/charting-gateway/src/server.js:518-610` — 診療音声PCMを `transcribePcmAudioWithOpenAi` で逐語化、SOAP生成でも本文を送信。

技術的低減は効いている（`safePreprocessedClinicalLines` で行数・文字数を制限、`safeSessionContext` で送信フィールドを絞る、監査ログは件数のみ）。しかし**患者氏名とカルテ全文・診療音声が第三者API事業者に渡る**という事実は残る。

**推奨**（詳細は [07-compliance-phi-ops.md](07-compliance-phi-ops.md)）:
- OpenAI へ送る `patientDisplayName` を仮名化/除去する（算定精度に氏名は不要なはず）。
- 個人情報保護法上の第三者提供/委託の整理、患者への周知、OpenAIのゼロデータ保持設定・データ処理契約（DPA）の確認。国内リージョン・国内AI（medimo等が医療特化を謳う）への切替も選択肢。

---

## 中-3: WebSocket 由来入力の検証境界

**場所**: `services/charting-gateway/src/server.js:7524-7546`, `WS_MAX_PAYLOAD_BYTES`, `WS_AUDIO_BYTES_PER_MINUTE_LIMIT`

ペイロード上限・分あたりバイト制限は設定済みで良い。ただし WS は long-lived かつ pairing token をURLフラグメント経由で受け取る設計（`createPairingUrl:1030` の `#...&token=`）。フラグメントはサーバログに残りにくい利点はあるが、リファラや履歴・共有時の漏えい面は残る。

**推奨**: pairing token は短命・ワンタイム・使用後失効を担保（既に refresh 機構はある）。トークンのサーバ側保存がハッシュ化されているか確認（`hashText`/`sha256` は存在するが pairing 側の保存経路の突き合わせを推奨）。

---

## 中-4: CSP の `script-src 'unsafe-inline'`

**場所**: `apps/fee-web/netlify.toml`（charting-web も同様）

```
script-src 'self' 'unsafe-inline';
```

ヘッダ群（HSTS, X-Frame DENY, nosniff, frame-ancestors none）は良好。だが `'unsafe-inline'` があるため CSP による XSS 緩和効果がほぼ消える。これは **高-1（localStorageトークン）と直列に効く**: XSS→トークン奪取のチェーンを止める最後の砦が無い。

Next.js のインラインスクリプト事情はあるが、nonce ベース CSP に移行可能。ランタイム設定注入（`layout.js:28` の `dangerouslySetInnerHTML`）も nonce 付与で対応できる。

**推奨**: nonce ベース CSP へ移行。少なくとも本番のみ strict-dynamic + nonce を検討。

---

## 低: その他

- **`icon.js:31` の `dangerouslySetInnerHTML`**（charting-web）: `ICONS[name]` は内部定数辞書由来でユーザ入力は入らないため現状は安全。ただし将来 `name` に外部値が流れないようコメントで固定を明示すると安全。
- **`fee-workspace.js:1986-1987` の `editor.innerHTML = renderedHtml`**: 赤文字アノテーションのレンダリング。`escapeHtml`（`:2518`）でエスケープしている経路なら安全。カルテ本文が必ずエスケープを通ることをテストで固定するのが望ましい。
- **エラーメッセージの日本語UX**: gateway/platform は「セキュリティ確認に失敗しました。再読み込みを」等、利用者に優しい固定文言。良い。

---

## 対応の優先順位（セキュリティ）

1. **高-1 + 中-4 を同時に**: localStorage トークン廃止 ＋ CSP nonce 化（XSSチェーンの遮断）
2. **高-2**: 5xx エラーメッセージのマスク（PHI/内部露出の即時停止）
3. **高-3**: gateway ステートの共有ストア化 or 単一インスタンス運用の明文化
4. **中-1**: 本番 CORS の許可オリジン厳格化
5. **中-2**: OpenAI 送信の氏名仮名化＋委託整理
