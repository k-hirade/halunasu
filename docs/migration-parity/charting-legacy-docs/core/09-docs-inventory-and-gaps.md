# Docs Inventory and Gaps

Last checked: 2026-05-07

この文書は、core docs を現行実装へ同期したうえで、まだ残っている差分だけを記録する。

## 今回同期した source of truth

- `medical/README.md`
- `docs/README.md`
- `core/02-product-spec.md`
- `core/03-system-architecture.md`
- `core/04-data-model.md`
- `core/05-api-and-events.md`
- `core/06-screen-flows.md`
- `core/07-gcp-deployment.md`
- `core/10-stripe-billing-and-onboarding.md`

## 現在の前提

- ダッシュボードの canonical path は `/`
- 設定画面は `/admin`
- live STT は OpenAI primary / Deepgram fallback
- browser state sync は HTTP + WebSocket
- standard finalize mode は `inline`
- billing / onboarding は `services/billing`

## まだ残るギャップ

### 高優先度

1. `GET /api/v1/sessions/{sessionId}/export`
   - docs 上の構想はあるが、gateway に未実装

2. async finalize の本番運用手順
   - code と deploy script はある
   - ただし current standard path は inline
   - 本番切替 runbook は別紙で詰める余地がある

3. billing service の deploy 手順
   - `cloudbuild.billing.yaml` はある
   - gateway / finalize のような専用 deploy script はまだない

### 中優先度

1. telemetry / SLO 文書
   - 目標値は docs にある
   - 実測 dashboard / alert 設計はまだ薄い

2. EMR export / writeback 設計
   - 現状は copy 前提
   - export API と UI は future

3. short code 中心 UX
   - backend は `pairingCode` を持つ
   - UI は QR / 接続リンク中心

### 低優先度

1. `core/11` と `core/12`
   - 歴史的な設計メモ / タスク色が強い
   - 最新実装の source of truth にはしない

2. `docs/impl` 配下
   - 経緯や監査メモとしては有用
   - 現行仕様の代表文書としては扱わない

## 更新ルール

- 実装名と API path はコードに合わせる
- target architecture を書く場合は current implementation を併記する
- historical note は `docs/impl` または task doc に寄せる
