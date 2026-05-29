# セキュリティ & 医療法令準拠 監査レポート

作成日: 2026-05-06
作成者: Claude (Opus 4.7) によるレビュー
対象範囲:
- `medical/` (gateway / finalize / billing / web / packages)
- `medical-lp/` (Netlify 配信の静的 LP)

本書は、ハルナス (GENNAI 株式会社) の以下 2 軸で全体を点検した結果である。

1. **toB SaaS としての脆弱性** — OWASP Top 10 / 認可境界 / 暗号 / セッション管理 / WebSocket / 課金 (Stripe) / 委託 API。
2. **国の医療法令への準拠** — 厚労省「医療情報システムの安全管理に関するガイドライン 第6.0版」、経産省/総務省「医療情報を取り扱う情報システム・サービス提供事業者における安全管理ガイドライン 第2.0版」、厚労省「医療機関等におけるサイバーセキュリティ対策チェックリストマニュアル (令和7年5月)」、個人情報保護法 (要配慮個人情報・越境移転・委託管理・漏えい報告)、医師法/医療法。

過去の `2026-04-17-security-review.md` および `2026-04-19-medical-security-gap-analysis.md` とは重複しないよう、それらの実装状況を踏まえた **2026-05-06 時点の差分視点** で整理した。

---

## 0. サービス理解

### プロダクト

- **ハルナス** — 外来診療向けリアルタイム医療スクライブ。スマホで音声収録 → ライブ文字起こし → 停止後に最終再文字起こし + SOAP 下書き生成 → 医師が確認して電子カルテへ転記。
- ターゲット: 日本国内の外来診療を行う医療機関 (toB SaaS, monthly 22,000 円税込)。
- 提供主体: GENNAI 株式会社 (法人番号 6080401027397, 静岡県浜松市)。
- 法的位置付け: 医療機関が個人情報取扱事業者・診療録保存責任者であり、ハルナスは個人情報保護法 27 条 5 項 1 号の **委託先 (処理委託先)** として診療関連データを取扱う。SOAP は「下書き」であり医師法・医療法上の保存義務対象ではない (privacy.html §1 で明示)。

### システム構成

| Layer | 実体 |
|---|---|
| LP | `medical-lp/` 静的 HTML (Netlify) |
| 医師 / 管理 UI | `apps/web` Next.js 15.5.15 (Netlify) |
| Realtime gateway | `services/gateway` Express + ws (Cloud Run, asia-northeast1) |
| Finalize worker | `services/finalize` Express (Cloud Run, OPENAI 最終再文字起こし + SOAP 生成) |
| Billing | `services/billing` Express (Stripe Checkout / Webhook / 契約管理) |
| Store backend | Firestore (本番) / in-memory (開発) |
| Audio archive | Cloud Storage (`RAW_AUDIO_GCS_BUCKET`) |
| Async queue | Cloud Tasks (finalize, recording auto-stop) |
| 外部 API | OpenAI Realtime / Audio / Responses, Deepgram (fallback STT), Stripe, Resend |

### 取扱う「要配慮個人情報」

- 患者氏名、年齢、症状、病歴、診療内容、処方、検査結果、診療音声、文字起こし、SOAP 下書き。
- 担当者情報 (医療機関名・氏名・メール・電話) と請求情報。
- 操作ログ・監査ログ (PHI 本文を含めない設計)。

### 既存の主要セキュリティ実装 (2026-04-19 時点で実装済み)

`firestore.rules:8` 全拒否 / PBKDF2 SHA-256 210k iter + `crypto.timingSafeEqual` (`packages/core/src/lib/password.js`) / HMAC-SHA256 + timing-safe pairing/operator/stream トークン (`packages/core/src/lib/pairing-token.js`) / AES-256-GCM フィールド暗号化 (`packages/core/src/lib/field-crypto.js`) / TOTP MFA (privileged role 必須) / cookie-only セッション + double-submit CSRF (`services/gateway/src/server.js:289-322`) / CORS allowlist + credentials (`services/gateway/src/server.js:241-278`) / WebSocket origin 検証 + role 別認可 (`services/gateway/src/server.js:6211-6595`) / Stripe webhook HMAC + 5 分 replay window + timing-safe 比較 (`services/billing/src/webhook-verify.js`) / Firestore 共有レート制限 (`rate_limits` collection) / 監査イベント `safePayload` (`appendAuditEventSafe`)。

---

## 1. toB SaaS として残る脆弱性 / 改善点

新規発見または既存ドキュメントで「次バッチ」扱いとされていた観点に絞り、**信頼度・優先度・再現条件** を明記する。「過去レビューですでに HIGH なし」と評価されているコア部分は再評価して問題なしを確認したうえで、その下のゾーンを掘り下げた。

### 1.1 [HIGH] `app.set("trust proxy", true)` による IP スプーフィング

**該当**: `services/gateway/src/server.js:92`、`services/billing/src/server.js:19`

**事象**: Express で `trust proxy=true` を設定すると、`req.ip` は **X-Forwarded-For の最左**値を返す。Cloud Run/GCLB の挙動上、クライアントが任意の `X-Forwarded-For` を送ると最左値が攻撃者の指定値に置き換わる。`getClientIp(req)` を介して以下が IP 単位で識別されている。

- `rateLimit("operator-login", { limit: 10, windowMs: 10 * 60_000 })` (gateway:3745)
- `operator-login-account` 含む全 admin 系レートリミット
- billing 系 `assertWithinRateLimit({ identifier: getClientIp(req) })` (`services/billing/src/lib/rate-limit.js:5-7`)

**インパクト**:
- ログイン総当たり、MFA 総当たり、契約申込フォーム DoS の **IP 単位レートリミットが無効化** される (account-key 軸はあるので完全に骨抜きではないが、信用してはいけない)。
- 監査ログ・rate_limit collection の `identifier` が攻撃者指定値で汚染される。
- 2026-04-19 の SEC-08 で「leftmost XFF を使わない」と書かれているが、コードは `req.ip` を介してそれと等価な状態に戻っている (Express の `trust proxy=true` は内部的に leftmost を採用)。

**信頼度**: 8/10 (Cloud Run は他社報告でも同パターンの誤設定が多数。XFF 注入で容易に再現可能)。

**修正案**:
1. Cloud Run 1 ホップを前提に、`app.set("trust proxy", 1)` または `"loopback, linklocal, uniquelocal"` に置換。Express が rightmost-1 を返すようにする。
2. もしくは `req.headers["x-forwarded-for"]` を **rightmost** から取り、Cloud Run が自身で付与した「クライアント IP」のみを採用する小ヘルパに置き換える (`getClientIp` 内で `xff.split(",").map(s=>s.trim()).at(-1)`)。
3. account 軸 + IP 軸 + org 軸の 3 軸ロックを残しつつ、IP 軸を信頼可能な値に戻す。

### 1.2 [MED] `BILLING_INTERNAL_SECRET` の検証が弱い

**該当**: `services/billing/src/routes/internal-billing.js:15-21`、`services/billing/src/config.js:75`

```js
function internalRequestAllowed(req, config) {
  if (!config.billingInternalSecret && !config.isProduction) return true;
  return req.get("x-billing-internal-secret") === config.billingInternalSecret;
}
```

**問題点**:
1. **timing-safe 比較ではない** (`===`)。秘密長が長いので実用攻撃可能性は低いが、gateway 側では `constantTimeStringEqual` を使っており方針が不揃い。
2. **production で `BILLING_INTERNAL_SECRET` が空のときの挙動が安全側に倒れていない**。`config.isProduction === true` かつ `billingInternalSecret === ""` の場合、第 1 分岐は通らず `req.get(...) === ""` の比較になる。Express の `req.get` は未設定時 `undefined` を返すため通常は `false` だが、起動時アサーションがないため運用ミスで秘密未設定のまま production をデプロイしても起動時に検知できない。
3. `/internal/billing/process-stripe-event`, `reconcile-subscription`, `enforce-grace-periods`, `enforce-trial-expiration` を一括保護しているため、ここが緩むと **任意の組織のアクセスを suspended 化したり trial を勝手に終了** させられる。

**信頼度**: 6/10 (運用次第)。

**修正案**:
1. `loadBillingConfig` で `if (isProduction && !env.BILLING_INTERNAL_SECRET) throw new Error(...)` を追加。
2. 比較を `crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))` に変更。
3. 中期的には Cloud Run-to-Cloud Run の OIDC (Cloud Tasks や Cloud Scheduler から発火する場合) に寄せ、HMAC は補助に降格。

### 1.3 [MED] CSP に `'unsafe-inline'` (script-src/style-src) が残存

**該当**: `medical/netlify.toml:21`

```
script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
```

- 既存ドキュメント (SEC-10) が「Next runtime config 都合で残置」と記載しているとおり既知問題だが、医療機関向け toB として **`'unsafe-inline'` は CSP の意味を相当程度失わせる** ため最終的に外すべきもの。
- `connect-src` に `https://*.run.app wss://*.run.app` のワイルドカードがあるため、攻撃者が Cloud Run にデプロイした任意の URL とブラウザから通信可能になる潜在窓もある。本番ドメインが固定された段階で個別ホストに絞るべき。
- LP 側 (`medical-lp/netlify.toml`) には CSP / X-Frame-Options / Referrer-Policy / Permissions-Policy / HSTS が **一切設定されていない**。LP は静的だが、医療機関の購買担当が最初に触れる入口であり、frame による phishing/clickjacking 防御を入れるべき。

**信頼度**: 7/10 (確実に存在し、優先度は中)。

**修正案**:
1. Next の app router は nonce ベース CSP に切替可能。`next.config.mjs` で middleware ベースの nonce 注入を入れる。
2. `*.run.app` を確定 URL に変更する。
3. `medical-lp/netlify.toml` に最小セット (X-Frame-Options DENY、Referrer-Policy strict-origin-when-cross-origin、Permissions-Policy camera=()/mic=()/geolocation=()、HSTS、CSP `default-src 'self'; img-src 'self' data: https:; font-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'none'; frame-ancestors 'none'`) を追加。

### 1.4 [MED] `password-setup` エンドポイントにレートリミットが無い

**該当**: `services/billing/src/routes/password-setup.js:13,32`

- `GET /api/v1/password-setup/:tokenId` と `POST /api/v1/password-setup/:tokenId` のいずれにも `assertWithinRateLimit` がついていない。
- トークン本体は `crypto.randomBytes(24).toString("base64url")` (192 bit) で総当たり耐性は十分だが、
  - 大量 GET でトークンステータス枚挙 (active/expired) ができ、無効化済みトークンの存在を観測可能。
  - 大量 POST で **既存セッショントークンを誤入力で詰まらせる** 行為を抑制できない。
  - billing-portal や contact-signup は手厚くレート制限している中で **ここだけ素通り** という設計の不揃い。
- contact-signup から initial password 設定までの「招待 → 設定」フローはオンボーディングの要なので、ここを攻撃者が観測/連打できる状態は toB として説明しづらい。

**信頼度**: 7/10。

**修正案**: 既存 `assertWithinRateLimit` で IP 軸 + tokenId 軸の 2 軸を入れる (verify-contact-signup と同じパターン)。

### 1.5 [MED] `pendingFinalizeAudio` (gateway memory PHI) が inline モードで残置

**該当**: `services/gateway/src/server.js:332`、TTL sweep `:6625-6638`

- 2026-04-19 で TTL sweeper が入り、30 分超のバッファが auto-delete されるようになった。
- ただし `FINALIZE_MODE=inline` が **本番デフォルト** のままで (`README.md:136`、`.env.example:9`)、本番の Cloud Run が再起動するまで RAM 上に PHI 音声が滞留する経路が残る。
- production GCS bucket と Cloud Tasks への切替は SEC-13 / SEC-05 で「本番前必須」と書かれているが、まだ実施記録がない。

**信頼度**: 7/10。

**インパクト**: Cloud Run コンテナ侵害時 (依存関係 RCE 等) に PHI 音声が即時に漏えい可能。永続化されない分監査が難しい。

**修正案**: `FINALIZE_MODE=cloud_tasks` を本番デフォルトに切替、`RAW_AUDIO_GCS_BUCKET` 必須化、bucket lifecycle で 24h auto-delete。`scripts/deploy_finalize_cloud_run.sh` は既にあるので運用 runbook 化。

### 1.6 [MED] `downloadRawAudioFromGcs` の bucket 制限がない

**該当**: `packages/core/src/lib/raw-audio-storage.js:95-112`、`services/finalize/src/server.js:209-248`

```js
function parseGsPath(rawAudioPath) {
  const match = String(rawAudioPath || "").match(/^gs:\/\/([^/]+)\/(.+)$/);
  ...
  return { bucketName: match[1], objectPath: match[2] };
}
```

- `payload.rawAudioPath` を信頼してダウンロードする。bucket 名のホワイトリスト検証がない。
- 現在は内部 HMAC 認証で守られており、gateway しか呼ばないため exploitability は低い。
- ただし将来 finalize を Cloud Tasks 経由 OIDC に切替たとき、Cloud Tasks ペイロード自体は GCP プロジェクト内に保存されるので、CI/dev アカウント侵害時に **finalize に攻撃者の bucket からダウンロードさせる** 攻撃面が残る (SSRF 的)。

**信頼度**: 4/10 (現状非露出)。

**修正案**: `if (bucketName !== process.env.RAW_AUDIO_GCS_BUCKET) throw` を `parseGsPath` 内に追加。

### 1.7 [LOW] `SOAP_GENERATION_PREVIEW_MAX_CHARS=120000` の Firestore 永続化

**該当**: `services/gateway/src/server.js:342, 875-898`、`services/finalize/src/server.js:54-93`

- SOAP 生成のストリーミング途中テキストを Firestore `sessions/{sessionId}.soapGenerationPreview` に最大 120k 文字保存する設計。
- これ自体が PHI そのものなので Firestore のセッション本体と同等扱い (削除対象に入る) で良いが、retention ジョブの対象に確実に含まれているか docs に明記がない。
- Firestore export / backup を取る場合、preview フィールドが backup に乗ることに気づかず長期保存される懸念。

**信頼度**: 5/10。

**修正案**: `scripts/run_retention_cleanup.mjs` 側で `soapGenerationPreview` を nullify する dry-run / 実行モードを追加。BCP runbook に「Firestore export には PHI の preview が含まれる」を明記。

### 1.8 [LOW] CI / SCA / SBOM の不足

- `npm test` / `npm run build` 中心で **Dependabot, npm audit-ci, CodeQL/Semgrep, Gitleaks, Trivy/Grype, CycloneDX SBOM** がリポジトリ設定で見えない。SEC-14 と同じ指摘だが、医療機関提出資料 (3省2ガイドライン) では「脆弱性検出運用」の証跡が要求される。
- 現在 `package.json` の scripts には `audit` ジョブがない。手動の `npm audit` 実行のみ。

**信頼度**: 8/10 (証拠不足は確実)。

**修正案**: `.github/workflows/security.yml` で `npm audit --audit-level=high` + Gitleaks + (任意で) CodeQL を週次。container を作るタイミングが来たら Trivy を deploy 前に。

### 1.9 [LOW] LP に `お問い合わせ` リンクが `href="#"` のプレースホルダ

**該当**: `medical-lp/index.html:1314`

- 営業導線の不整備。脆弱性ではないが、tokushoho.html / privacy.html の問い合わせ先が `tsukusuta@gmail.com` (個人 Gmail 風) になっているので、医療機関向け B2B として独自ドメインの info@ または sales@ に切り替えるとともに、お問い合わせフォームを `/contact-signups` または個別フォームへ繋ぐべき。

### 1.10 [INFO] WebSocket の cookie 認証パスが Origin チェック経由になっている

**該当**: `services/gateway/src/server.js:6211-6230`

- Origin 検証 + `verifyOperatorToken(cookie)` + hello メッセージで token と sessionId を再確認する 3 段防御。これは現時点のベストプラクティスに合致。
- ただし `COOKIE_OPERATOR_SESSION_TOKEN` というセンチネル文字列で「cookie を使え」と PC クライアントが指示する仕組みは、ブラウザ以外のクライアントが偽装しやすいため、可能なら hello メッセージの `token` フィールドそのものを廃止し、すべて cookie 経路に統一する方向が望ましい。
- `config.allowOperatorBearerAuth` が default `true` なのも気になる。production では `false` を強制する旨が `2026-04-19` に書かれているが、`.env.example` ではデフォルト挙動が見えない。

**信頼度**: 4/10。

**修正案**: production 用の env サンプルを別途用意し `APP_ALLOW_OPERATOR_BEARER_AUTH=false` を必須記載。

---

## 2. 国の医療法令への準拠 — ギャップ整理

ここでは **2026-05-06 時点の現状 vs 法令/ガイドライン要求** を表で対比する。`docs/impl/2026-04-19-medical-security-gap-analysis.md` で挙がっている SEC-01〜SEC-18 の進捗を踏まえ、**法令側の文言にいま答えられないもの** を抽出している。

### 2.1 個人情報保護法 (令和 4 年改正)

| 要求 | 対応状況 | 不足 |
|---|---|---|
| 要配慮個人情報の取得時の同意 (法 20 条 2 項) | privacy.html §1 で「医療機関が同意取得主体」と整理。委託として処理 | (a) 委託契約書テンプレートの公開なし。医療機関が監査時に「処理委託契約 + 安全管理措置開示」を要求する想定 |
| 安全管理措置 (法 23 条) | privacy.html §7 に列挙 | 詳細な「組織的・人的・物理的・技術的」4 区分の安全管理措置一覧と委託先評価が `docs/security/` 等に未整備 |
| 委託先の監督 (法 25 条) | OpenAI/Deepgram/Stripe/Resend を privacy.html §5 に明示 | 委託先評価記録 (DPA / SOC2 / ISO 27001 などの証跡) を集約した内部資料がない。3省2ガイドラインの「委託先評価」要件に対する説明が弱い |
| 越境移転時の本人同意・情報提供 (法 28 条) | 米国移転を privacy.html §5 で開示 | 「米国の個人情報保護に関する制度」の明示 (GDPR-style 詳細) が概要のみ。OpenAI ZDR/MAM の契約証跡が docs に不存在 |
| 第三者提供記録 (法 30 条) | privacy.html §11 で開示請求対応に言及 | 第三者提供記録の保管手順 / フォーマットが未整備 |
| 漏えい等報告 (法 26 条 / 規則 7 条) | privacy.html §8 で「速報 3〜5 日 / 確報 30 日 (不正の場合 60 日)」を記載 | (a) インシデントレスポンス runbook が `docs/runbooks/` に未整備。`mfa-break-glass.md` と `security-operations.md` のみ。(b) 個人情報保護委員会報告フォームへの記入テンプレが存在しない |
| 仮名加工情報・匿名加工情報 (法 41-43 条) | privacy.html §10 で言及 | 加工方法・公表事項のテンプレが未整備 |

### 2.2 厚労省「医療情報システムの安全管理に関するガイドライン 第6.0版」

医療機関向けガイドラインだが、サービス事業者として「医療機関が説明できる材料」を出す必要がある (3省2ガイドラインで明示)。

| 章 (要旨) | 要求 | 現状 | 不足 |
|---|---|---|---|
| 8.1 / 8.2 認証 | 二要素認証 (令和 9 年度までに実装) | privileged role TOTP 必須。一般 operator は任意 | 一般 operator も将来必須化する **時期 / 手順** を docs に明記 |
| 8.3 アクセス制御 | 役職別アクセス制御、最小権限 | RBAC 実装済 (8 ロール) | 「権限定義表」を医療機関向け資料 (PDF/MD) として公開可能な形に整備していない |
| 8.4 暗号化 | 通信・保存暗号化 | TLS、AES-256-GCM (TOTP secret)、Firestore/GCS は GCP 標準 | (a) 患者氏名・問診内容など Firestore 上の field-level 暗号化が **TOTP secret 以外には適用されていない**。3省2ガイドライン上必須ではないが、KMS/CMEK 検討は SEC-18 と同様に未着手 |
| 8.5 ログ保管 | アクセスログ・操作ログ・改ざん耐性 | Firestore audit_events 実装。Cloud Logging sink まだなし | SEC-07 と同じ。Cloud Logging への sink・WORM 化が docs に存在しない |
| 9 リスクアセスメント | 年次リスクアセスメント | 該当 docs なし | リスクアセスメント記録テンプレ未整備 |
| 10 BCP/障害対応 | RPO/RTO、復旧演習、連絡体制 | Cloud Run min-instances 0 + Firestore 利用方針はあり | SEC-03 のとおり、復旧演習証跡 / RPO/RTO / 連絡体制図が未整備。**医療機関の立入検査で必ず指摘される** |
| 11 委託先管理 | サービス提供事業者の選定基準・監督 | privacy.html で外部サービス開示済 | 各委託先の SOC2 / ISO27001 / DPA の取得状況を整理した内部資料がない |

### 2.3 厚労省「医療機関等におけるサイバーセキュリティ対策チェックリストマニュアル (令和7年5月)」

医療機関がベンダーに提示するチェックリスト想定。

| 項目 | 現状 | 不足 |
|---|---|---|
| 安全管理責任者 | privacy.html §14 に「個人情報保護管理者: 平出景詩」 | サイバーセキュリティ責任者と兼任の明示・経歴情報が薄い (ISMS 取得時に必須) |
| サーバ・端末・NW 機器台帳 | docs にインフラ構成図はあるが資産台帳形式ではない | IaC (Terraform 等) と紐づく資産台帳を整備 |
| 開示書 / SLA / 責任分界表 (MDS/SDS/SLA) | 未整備 (SEC-16 と同様) | 「医療機関に渡せる開示書」フォーマットを整備しないと、立入検査・契約交渉でブロックされる |
| 不要アカウント削除・棚卸し | アカウント無効化 API/UI 実装済 (SEC-02 完了) | 月次/四半期棚卸しレポートが運用で出ていない |
| パッチ適用 | Next.js 15.5.15、protobufjs 7.5.5 などは更新済 | 適用記録 (changelog/audit) のテンプレが未整備 |
| 二要素認証 | privileged role 必須 | 一般 operator は任意。令和 9 年度までに必須化計画を社内で承認 |
| パスワード要件 | 12 文字 + 英数字記号 + 10 回失敗で 10 分 lockout | Have I Been Pwned 連携、履歴管理は未実装 (SEC-11) |

### 2.4 経産省/総務省「医療情報を取り扱う情報システム・サービス提供事業者における安全管理ガイドライン 第2.0版 (令和7年3月)」

事業者向けの 1 次資料。

| 要求 | 現状 | 不足 |
|---|---|---|
| リスクベースのリスクマネジメント | 該当 docs なし | リスクアセスメント計画 / 残存リスク台帳の整備 |
| 医療機関との責任分界 | privacy.html §1 で診療責任は医療機関と明示 | 責任分界表 (どこまでが事業者責任、どこまでが医療機関責任) のフォーマット文書が未整備 |
| サービス仕様 / SLA / 安全管理情報の提供 | docs/core/ にプロダクト仕様。SLA / 障害対応時間は未公表 | SLA / 稼働率 / 障害対応 RPO/RTO の数値コミットを docs/security/sla.md として作成 |
| 第三者認証 / 監査報告 | 未取得 | medimo (競合) は AI 自動カルテ範囲で ISO/IEC 27001 取得。販売前に最低 ISMS / プライバシーマーク 取得 or 同等の独立評価が必要 |
| サブプロセッサ管理 | privacy.html §5 で開示 | サブプロセッサのリスト・変更通知メカニズムが docs/security/subprocessors.md として未整備 |
| 情報漏えい時の通知体制 | privacy.html §8 | サービス事業者として医療機関に通知する SLA / 連絡先テンプレが未整備 |

### 2.5 医師法 / 医療法 / 電子カルテ運用ガイドライン

| 要求 | 現状 | 評価 |
|---|---|---|
| 診療録の保存義務 (医師法 24 条 2 項、5 年) | privacy.html §1, §9 で「SOAP は下書き、診療録の保存は医療機関責任」と明示 | OK。これは委託モデルとして適切 |
| 真正性・見読性・保存性 (3 基準) | 「下書き」位置付けにより本サービスは 3 基準対象外 | OK。ただし「最終保存先 (電子カルテ) への転記責任は医師」を画面上にも注記する必要があり (現状未確認) |
| 医療従事者守秘義務 (刑法 134 条 / 保助看法等) | 該当ロール定義あり (`doctor` / `nurse` / `medical_scribe`) | 守秘義務違反時の利用停止フローを利用規約に明記すべき |

### 2.6 個人情報保護委員会・厚労省「医療・介護関係事業者における個人情報の適切な取扱いのためのガイダンス」

| 要求 | 現状 | 評価 |
|---|---|---|
| 要配慮個人情報の取扱い | 委託として整理 | OK |
| 患者本人への利用目的説明 | 医療機関責任 | docs に「利用医療機関向けの患者掲示物テンプレ」を提供すると親切 |
| 死後の情報の取り扱い | 未言及 | privacy.html / 利用規約に追記推奨 |

---

## 3. 優先度付きアクションプラン

| # | 優先度 | 領域 | 推奨アクション | 関連 |
|---|---:|---|---|---|
| A1 | P0 | toB | `trust proxy` を Cloud Run 1 ホップ前提の値に変更し、`getClientIp` を rightmost 採用へ | 1.1 |
| A2 | P0 | toB | `BILLING_INTERNAL_SECRET` 起動時アサーション + timing-safe 比較 | 1.2 |
| A3 | P0 | toB | `password-setup` の GET/POST にレートリミット | 1.4 |
| A4 | P0 | 医療法 | `docs/security/` 配下に MDS/SDS/SLA/責任分界表/サブプロセッサ一覧を初版作成 | 2.4, SEC-16 |
| A5 | P0 | 医療法 | Firestore PITR/scheduled backup を有効化、復旧演習 1 回実施し runbook 化 | 2.2, SEC-03 |
| A6 | P0 | 医療法 | OpenAI ZDR/MAM、Deepgram の DPA・保持・サブプロセッサ確認証跡を `docs/security/external-ai-processing.md` に集約 | 2.4, SEC-06 |
| B1 | P1 | toB | CSP の `'unsafe-inline'` 排除 (nonce 化) と `*.run.app` 個別ホスト化 | 1.3 |
| B2 | P1 | toB | LP (medical-lp) に X-Frame-Options/HSTS/Permissions-Policy/CSP を追加 | 1.3 |
| B3 | P1 | toB | `FINALIZE_MODE=cloud_tasks` を本番デフォルト化、`RAW_AUDIO_GCS_BUCKET` 必須化 + bucket lifecycle 24h | 1.5, SEC-13 |
| B4 | P1 | toB | `parseGsPath` で許可 bucket 名のホワイトリスト検証 | 1.6 |
| B5 | P1 | toB | CI に `npm audit --audit-level=high` + Gitleaks + (将来 Trivy) | 1.8, SEC-14 |
| B6 | P1 | 医療法 | Cloud Logging sink を専用 project/bucket へ。WORM 化 / アラート | 2.2, SEC-07 |
| B7 | P1 | 医療法 | インシデントレスポンス runbook (個情委フォーム記入テンプレ含む) を `docs/runbooks/` に追加 | 2.1, SEC-03 |
| C1 | P2 | 医療法 | ISMS / ISO 27001 取得計画 (medimo 同等のシグナル) | 2.4, SEC-17 |
| C2 | P2 | toB | KMS/CMEK 検討 (Secret Manager → KMS への移行) | 2.2, SEC-18 |
| C3 | P2 | toB | LP の「お問い合わせ」を独自ドメインへ、専用問合せフォーム導線整備 | 1.9 |
| C4 | P2 | 医療法 | 一般 operator MFA 必須化計画 (令和 9 年度までに) | 2.2, SEC-01 |

---

## 4. 結論

### toB 観点

過去レビュー (`2026-04-17-security-review.md`) で HIGH 級が 0 件と評価されたコア (Firestore rules / 認証トークン / パスワードハッシュ / CORS / XSS / RCE) は再点検の結果いずれも変わらず安全水準を維持している。新規に検出した最重要は **#1.1 `trust proxy=true` による IP スプーフィング**。これはレートリミット・監査ログ識別子の信頼性を根底から崩すため P0 として即修正を推奨する。次点で billing 内部認証 (#1.2) と password-setup レート制限 (#1.4) を P0 で潰せば、toB SaaS としての一次防御線は妥当な水準まで戻る。

### 医療法令準拠観点

法的にもっとも痛いのは **コードの脆弱性ではなく、医療機関が立入検査で要求する「現物書類」の不在** である。具体的には:

1. **MDS/SDS/SLA/責任分界表** (経産省 3省2ガイドライン)
2. **Firestore バックアップ + 復旧演習証跡** (厚労省 6.0 / 医療機関チェックリスト)
3. **OpenAI / Deepgram の DPA / ZDR/MAM 証跡** (個情法 28 条 / 委託監督)
4. **インシデントレスポンス runbook** (個情法 26 条 / 26 条規則 7 条)
5. **ISMS or 同等の第三者評価** (販売シグナルとしては必須に近い。medimo は ISO/IEC 27001 取得済)

privacy.html / terms.html / tokushoho.html の文言レベルでは個人情報保護法・特商法への対応はおおむね揃っており、SOAP を「下書き」と位置付けて医師法・医療法上の保存義務を医療機関側に残す設計判断も法的に整合している。問題は **「医療機関のセキュリティ確認シートに即答できる内部証跡」** が欠けている点に尽きる。実装側の追加実装 (P0 で挙げた A1〜A3) は数日工数だが、書類整備 (A4〜A6) は数週間かかるため、販売スケジュールに対して逆算した着手が必要。

### 推奨順序

1. **今週**: A1 / A2 / A3 (コード修正、半日〜1 日)
2. **2 週間**: A4 / A5 / A6 (書類・運用整備)
3. **1 か月**: B1〜B7
4. **3〜6 か月**: C1 (ISMS) を販売前提の独立トラックに

---

## 付録: 参照ファイル一覧

- `services/gateway/src/server.js` (6644 行) — 認証 / WebSocket / レート制限 / CORS / セキュリティヘッダ
- `services/billing/src/server.js` ほか routes/handlers — Stripe webhook / 契約 / 申込
- `services/finalize/src/server.js` (334 行) — 内部 HMAC 認証で守られた SOAP 生成 worker
- `packages/core/src/lib/{password,pairing-token,field-crypto,raw-audio-storage,totp}.js` — 暗号系プリミティブ
- `packages/core/src/store/firestore-store.js` — token / member / signup の Firestore 永続化
- `firestore.rules` — 全クライアント直アクセス拒否
- `medical/netlify.toml`, `medical-lp/netlify.toml` — Web 側ヘッダ / CSP
- `medical-lp/{privacy,terms,tokushoho,security}.html` — 公開法務ページ
- `docs/impl/2026-04-17-security-review.md` — 過去レビュー
- `docs/impl/2026-04-19-medical-security-gap-analysis.md` — 医療系ギャップ分析 (本書はこの差分視点で構成)
- `docs/runbooks/{mfa-break-glass,security-operations}.md` — 既存 runbook (BCP/IR は不足)
