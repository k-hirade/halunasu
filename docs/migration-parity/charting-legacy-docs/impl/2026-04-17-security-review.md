# Security Review — 2026-04-17

## プロダクト理解

- **Product**: リアルタイム外来診療記録アシスタント (medical scribe, Japanese outpatient clinics, pre-release pilot)。PC 医師セッションにスマホがペアリング参加して音声ストリーム → ライブ文字起こし → 停止時に最終再文字起こし + 臨床事実抽出 + SOAP 生成 → 医師が確認して EMR へ貼付。
- **Architecture**:
  - `apps/web` — Next.js (Netlify) 、PC / モバイルの両面を提供。
  - `services/gateway` — Express + WebSocket (Cloud Run, asia-northeast1) 。セッション制御・音声リレー・STT オーケストレーション・SOAP 生成のトリガー。
  - `services/finalize` — 最終文字起こし + SOAP ワーカー。**現在は `FINALIZE_MODE=inline` (gateway プロセス内実行) がデフォルトで、外部サービスとしてはデプロイされていない scaffolding 状態**。
  - `packages/core` — pairing トークン (HMAC-SHA256)、password (PBKDF2 210k + timingSafeEqual)、store、STT、SOAP ロジック。
  - `packages/contracts` — Zod スキーマによる入力境界バリデーション。
- **Auth モデル**: 臨床医パスワード → 署名済み operator access token。モバイルは署名済み pairing / stream token (URL hash fragment 経由)。Firestore は `allow read, write: if false` で全クライアント直アクセス禁止、gateway 経由のみ。
- **Threat surface**: PHI を扱うため、auth bypass / 越境アクセス / PHI leak / RCE が最重要。

## レビュー対象

ブランチ `stg` の差分は `docs/impl/2026-04-17-security-review.md` の削除のみで新規コード変更はなし。ユーザー要望に従いプロダクト全体を対象に包括的セキュリティレビューを実施した。

## 検査方法

1. Phase 1 — レポジトリコンテキスト調査: `firestore.rules` / CORS allowlist / 認証ミドルウェア / HMAC 実装 / Zod バリデーション境界を把握。
2. Phase 2 — 比較分析: 認可チェックの一貫性、pairing token 検証、timing-safe 比較、CORS origin reflection の境界。
3. Phase 3 — 脆弱性評価: 各入力経路 (HTTP / WS / 内部 endpoint) から sensitive operation (Firestore write, SOAP 生成, 音声 blob 参照) までの data flow を追跡。以下カテゴリを網羅的に検査。
   - 認証バイパス / 認可バイパス / IDOR
   - SQL / NoSQL / コマンド / path traversal / template / SSRF (host/protocol 制御)
   - 暗号 (weak HMAC、timing side channel、JWT none、hardcoded secret)
   - RCE (eval / new Function / vm / 危険な deserialize)
   - XSS (`dangerouslySetInnerHTML` / `innerHTML` / 未エスケープの HTML 応答)
   - データ露出 (PHI ログ、CORS with credentials の origin reflection、debug leak)

## 確認した防御機構 (問題なし)

| 領域 | 実装箇所 | 評価 |
|---|---|---|
| Firestore 直アクセス遮断 | `firestore.rules:8` (`allow read, write: if false`) | OK |
| パスワードハッシュ | `packages/core/src/lib/password.js:44` (PBKDF2 210,000 iter + `crypto.timingSafeEqual`) | OK |
| Pairing / stream token 署名検証 | `packages/core/src/lib/pairing-token.js:32` (`crypto.timingSafeEqual`) | OK |
| セッション ID | `crypto.randomUUID` 由来 (unguessable) | OK |
| CORS | `services/gateway/src/server.js:149-170, 3371, 3441` でオリジン allowlist 照合後に `Access-Control-Allow-Credentials` を付与、wildcard reflection なし | OK |
| React XSS | `apps/web/components/icon.js:31` と `apps/web/app/layout.js:25` の `dangerouslySetInnerHTML` はいずれも静的アイコン SVG / サーバー env 由来の `gatewayBaseUrl` のみ、ユーザー入力を一切埋め込まない | OK |
| コード実行系 | 全ツリーに `eval` / `new Function` / `child_process` / `execSync` の利用なし | OK |
| Firestore クエリ | Admin SDK 経由で field-level フィルタ、文字列連結クエリなし | OK |

## Findings

**HIGH / MEDIUM 信頼度 ≥ 8 の報告すべき脆弱性はなし。**

### 参考: confidence 未満で除外した候補

以下は本レビューのスコープに含まれるが、信頼度が 8 に達しないため報告対象から除外した。次フェーズの deployment 判断時に再評価を推奨する。

#### 候補: `services/finalize/src/server.js:21` — `/internal/finalize` の認証欠如 (confidence 2, 除外)

- **事実**: `POST /internal/finalize` は `parseJsonBody(finalizeTaskPayloadSchema, req.body)` で Zod バリデートするのみで、認証・署名検証・呼出元検査を一切しない。
- **除外理由**:
  1. gateway は `config.finalizeMode !== "inline"` のときだけこの endpoint を叩く (`services/gateway/src/server.js:1805, 1858`) 。現行本番は **inline モード** で動作しており、finalize サービスは Cloud Run にデプロイされていない。
  2. `FINALIZE_ENDPOINT` のデフォルトも `http://localhost:8082/internal/finalize` でループバック。
  3. セッション ID は `crypto.randomUUID` で推測不可能。仮に外部公開されても有効 sessionId 知得には事前侵害が必要。
- **推奨 (phase 2 で外部化する前に実施)**:
  - gateway → finalize を HMAC 署名ヘッダ付き、または Cloud Run IAM で service-to-service OIDC に限定。
  - payload に operator `orgId` / `memberId` を載せ、finalize 側で Firestore の `session.orgId` と突合して IDOR を二重防御。
  - Cloud Run は `--no-allow-unauthenticated` 、Cloud Tasks 経由なら OIDC audience 検証。

この項目は**現時点で脆弱性ではなく将来デプロイ時の設計要件**として追跡することを推奨する。

## 結論

`stg` ブランチおよびプロダクト全体で、本レビュー基準 (exploitable / ≥80% confidence / HIGH or MEDIUM) を満たす新規セキュリティ脆弱性は検出されなかった。既存の認証・暗号・CORS・Firestore ルール・XSS 対策はいずれも妥当な水準。次の注意点のみ追跡すること:

- Finalize サービスを外部サービス化するフェーズに入ったら、認証層 (HMAC or Cloud Run IAM) を **コードマージ前に** 実装する。
- Pilot で PHI を扱うログ出力 (audit event の `safePayload` 、`console.error` 系) は継続的にレビューし、`message` フィールドなどに PHI を含まないかサンプリング監査する。
