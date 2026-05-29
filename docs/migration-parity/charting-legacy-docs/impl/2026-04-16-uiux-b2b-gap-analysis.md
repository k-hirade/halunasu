# UI/UX Gap Analysis and Improvement Plan

Date: 2026-04-16
Scope: `apps/web` (PC encounter workspace, session dashboard, admin/settings, mobile recorder)
Reference commit: `b676ffb`

## Purpose

本ドキュメントは、現行 UI (`SessionLauncher` / `EncounterWorkspace` / `AdminConsole` / `MobileJoinClient`) と、一般的な B2B SaaS (Linear, Notion, Salesforce, Zendesk, HubSpot, Intercom, Epic/Cerner のクリニカル画面など) で定着している UX パターンを突き合わせ、
「医療スクライブとして業務導入される最低ラインに必要だが、まだ実装されていない UI/UX」を洗い出し、修正方針を示すものである。

パイロット FB (docs/10 ほか) の個別改善タスクとは別レイヤで、**プロダクトの"土台"として B2B 標準に追いつくための改善**をまとめる。

---

## 評価フレーム

以下の観点で既存 B2B SaaS と比較した：

1. **ナビゲーションと世界観** — ユーザーが自分の位置とできることを常に把握できるか
2. **情報設計とダッシュボード** — 業務開始時に "今日やるべきこと" が 3 秒で分かるか
3. **操作効率** — キーボード操作・コマンドパレット・一括操作など熟達者向けの速度
4. **信頼性の可視化** — 障害・接続・AI 生成ステータス・保存状態が常に見えるか
5. **オンボーディングとヘルプ** — 新規ユーザーが放置されないか
6. **アクセシビリティとデバイス対応** — 色のみに依存しない表示、キーボード到達性、レスポンシブ
7. **ガバナンスと運用** — 監査ログ、エクスポート、権限の透明性

---

## P0 — 業務導入の前提として欠けているもの

### 1. グローバルコマンドパレット (⌘K / Ctrl+K)

- **現状**: キーボードショートカットは `?` ヘルプ、`⌘S` 保存、`/` 検索フォーカスのみ。`EncounterWorkspace` 内にしか効かない。
- **B2B 標準**: Linear, Notion, GitHub, Slack いずれも ⌘K で横断検索 + アクション起動が可能。医療領域でも Abridge/Suki 等が採用。
- **提案**: 任意画面で ⌘K 起動のコマンドパレット。以下を 1 箇所に統合：
  - 「新しい診療を開始」
  - 「直近の診療を開く」(サジェスト)
  - 「患者名で診療履歴を検索」
  - 「設定 > 権限管理 / プロンプト設定 / 操作ログ」へのディープリンク
  - 「ログアウト」
- **実装方針**:
  - `apps/web/components/command-palette.js` を新設し `layout.js` にマウント
  - ソースは `/api/v1/sessions` の結果と静的なナビ項目を `fuse.js` か簡易スコアラで統合
  - 状態は `useCommandPalette` フック (独立 Context) にまとめ、ESC/オーバーレイクリックで閉じる
  - 既存 `/` ショートカットは維持し、⌘K は上位互換として全画面バインド

### 2. グローバル通知 / バナー (システム障害・メンテ・接続喪失)

- **現状**: エラーはトースト or `workspace-footer-error` のインラインのみ。WebSocket 切断時のグローバル表示が無く、全画面で気づけない。
- **B2B 標準**: Salesforce, HubSpot, Intercom はページ最上部に "Degraded" / "Maintenance" / "You are offline" のバナーを常時表示。
- **提案**: `SiteNav` 直下に `GlobalBanner` コンポーネントを追加し、以下の状態を扱う：
  - `network.offline` (window `offline` イベント)
  - `gateway.degraded` (`/healthz` ポーリング 30s)
  - `session.ws.disconnected` (現在は `EncounterWorkspace` 内のみ)
  - `scheduled_maintenance` (将来的に Firestore `system_notices/{noticeId}` から取得)
- **実装方針**:
  - `apps/web/components/global-banner.js` を作成し `apps/web/app/layout.js` に常駐マウント
  - `apps/web/lib/system-status.js` に 1 本の Context/Provider を切り出し、`EncounterWorkspace` の切断検出もここに寄せる
  - デザインは既存 `status-card--warning` / `status-card--danger` トークンを踏襲

### 3. ユーザーアイデンティティの可視化（誰がログインしているか）

- **現状**: `SiteNav` の右上は "設定" 歯車アイコンのみ。ログイン中メンバー名・ロール・組織名が見えない。切り替えや「自分が誰か」の確認手段がない。
- **B2B 標準**: 右上のアバター + 組織名表示は Slack/Notion/Linear など業界共通。医療 SaaS は「誰として記録しているか」の明示が特に重要（監査要件）。
- **提案**: 右上の歯車を「アバター（イニシャル）+ displayName」ボタンに変更し、ポップオーバーで下記を表示：
  - メンバー表示名・ロール（`formatMemberRole`）・組織名
  - `設定` / `アカウント` / `ログアウト`
  - 「別アカウントで開く」(将来: マルチ組織切替)
- **実装方針**:
  - `components/site-nav.js` の `site-settings-button` を `UserMenuTrigger` に差し替え
  - 既存 `operatorSession.member.displayName` / `organization.displayName` を使って描画
  - アバターは `background-color` をロールごとに変えて色で区別（`doctor` 系はティール、`admin` 系はインディゴなど）

### 4. 診療ワークフローのプログレスステッパー

- **現状**: `EncounterWorkspace` 上部の `badge--{status}` で現状ステータスは見えるが、「今どこまで進んでいて、次は何か」が線形に可視化されていない。パイロット FB でも "状態不明" が頻出。
- **B2B 標準**: クリニカル SaaS / 経費精算 SaaS / Zendesk のチケット遷移はいずれもステッパー UI を上部常設。
- **提案**: Top Bar 下に 5 ステップの水平プログレスを常設：
  `接続 → 録音 → 録音完了 → SOAP 下書き → 確定`
  - 現在ステップはハイライト、完了ステップはチェック、失敗は感嘆符
  - 各ステップにホバーで補足説明（`degraded_recording` → 接続不安定だが再開可能、など）
- **実装方針**:
  - `components/encounter-progress.js` を追加
  - 入力は `sessionState.session.status` とし `STATUS_LABELS` と共通のラベル定義へ切り出し
  - `finalize` の細粒サブ進捗（`transcript-processing-steps`）と整合するよう、`finalizing` ステップを 2 段階（`transcribe` → `soap`）に分岐させるデータを `sessionState` に持たせる

### 5. 保存状態の単一ソース化（Autosave Pill）

- **現状**: `SOAP` は `review-status`、患者情報は `patient-info-status`、`patient-info-message` など、保存状態の表現が 3 種類以上に分散。ユーザーがどこで何が保存されているか混乱する。
- **B2B 標準**: Notion, Linear, Google Docs は常に 1 箇所に「保存中 / 保存済 / オフライン」だけを表示。
- **提案**:
  - `EncounterWorkspace` のトップバー右端に `AutosavePill` を常設し、全編集領域の保存状態を集約
  - 個別カードの "未保存" 表示は控えめな dirty indicator（左側の色付き縦線）に置き換える
- **実装方針**:
  - `useAutosaveStatus(areaId)` フックで各エリアの dirty/saving/error を登録し、ピルは集約結果を表示
  - 2 つ以上 dirty なら「複数の未保存あり」と表示、クリックで ToC 的に一覧へジャンプ

---

## P1 — 熟達者の生産性を上げる機能

### 6. ダッシュボードの "今日ビュー" / KPI カード

- **現状**: `/` は履歴リストのみ。件数は `filteredSessions.length / sessions.length 件` のみ。
- **B2B 標準**: HubSpot, Salesforce, Linear の Inbox は上部に 3–4 個の数値カード（今日の件数・確認待ち・要対応）。
- **提案**: ダッシュボード上部に 3 枚のサマリーカード：
  - 今日の診療 `N 件`（クリックで "今日" フィルタ）
  - 医師確認待ち `N 件`（status=`soap_ready`）
  - 要確認 `N 件`（status=`failed` / `degraded_recording`）
- **実装方針**:
  - `components/session-dashboard-summary.js` を追加
  - 既存 `sessions` 配列からクライアント側で集計（API 追加はせず現状の `/api/v1/sessions` を使い回す）
  - カードクリックで `sessionStatusFilter` を更新するだけで済むよう、親で `setSessionStatusFilter` を props 渡し

### 7. セッション一覧のテーブルビュー / 並び替え / 一括操作

- **現状**: 単純なカードリスト。列の並び替え、複数選択、一括削除、CSV エクスポートなし。
- **B2B 標準**: 業務用途ではテーブル表示（列並び替え、ソート、複数選択→一括アクション）が基本。
- **提案**:
  - 表示切替トグル `カード | テーブル`
  - テーブルでは `患者名` / `症状` / `ステータス` / `作成` / `確定` 列、ヘッダクリックでソート
  - チェックボックスで複数選択 → 「一覧から非表示」「CSV エクスポート」
- **実装方針**:
  - `components/session-table.js` を新設、`SessionLauncher` 内で `viewMode` ステートでスイッチ
  - CSV は `session.patientDisplayName / visitReason / status / createdAt / approvedAt` をフロントで組み立て `Blob` → ダウンロード
  - 将来の仮名化要件に備え、エクスポートには監査ログを 1 件残す（`GET /api/v1/sessions` が既に監査記録対象なので、エクスポート API を `/api/v1/sessions/export` として新設するのが理想）

### 8. 詳細キーボードショートカットと可視化

- **現状**: `⌘S` / `Esc` / `?` のみ。録音操作・承認・プロンプト切替はマウス必須。
- **B2B 標準**: Linear の数十種を見習わずとも、クリニカル領域では以下は業界水準：
  - `Space` 一時停止/再開、`⌘⏎` 確定、`⌘E` 編集、`⌘D` 差分、`⌘C` 記録コピー
- **提案**（`EncounterWorkspace` 優先）：
  - `Space`（入力中以外）: 録音開始/停止
  - `⌘⏎`: 停止状態で SOAP 生成 / `soap_ready` で確定ダイアログ
  - `⌘⇧C`: 診療記録全文コピー（現在はボタン必須）
  - `⌘L`: レイアウト循環（split→soap→stacked、既存 `cycleLayoutMode` を割当）
  - `G` → `S` (セッション一覧へ) / `G` → `A` (設定へ) のチョード
- **実装方針**:
  - `apps/web/lib/keyboard-shortcuts.js` に一覧を定数化し、ショートカットヘルプ UI も同じ定義から生成（現状はハードコード）
  - `useKeyboardShortcut(key, handler, { when })` フックで各画面が受信者側になる
  - `?` オーバーレイに全ショートカット表示

### 9. セッションのクイックプレビュー（ホバー / サイドピーク）

- **現状**: 履歴から診療を開くとフル画面遷移。SOAP 本文だけ見たいときも必ず `EncounterWorkspace` をロード。
- **B2B 標準**: GitHub の PR サイドピーク、Linear の詳細ペインのような「一覧で選んだ項目を右ペインで読む」。
- **提案**: ダッシュボードで行をクリック → 右側 40% にスライドインするプレビュー（読み取り専用）。フルページは「開く」で遷移。
- **実装方針**:
  - `components/session-quick-peek.js` を追加
  - `GET /api/v1/sessions/:sessionId` の `latestSoap` だけ読み、`soap.outputText` を表示
  - `reduced motion` 設定時はスライドなしで即切替

---

## P2 — プロフェッショナル感・信頼感を底上げする装飾

### 10. オンボーディング / 空状態の改善

- **現状**:
  - 初回ログイン後のガイドなし
  - 履歴 0 件時の文言は 1 行のみ `"まだ診療履歴はありません。..."`
  - 設定画面（`AdminConsole`）も空の組織に対して何をすべきかの誘導が弱い
- **B2B 標準**: Intercom, HubSpot は「最初の 1 件を作る」チェックリストが冒頭に常駐。
- **提案**:
  - 初回ログイン時にステップ付きチェックリスト：
    1. 診療を 1 件開始する
    2. SOAP 下書きを確認する
    3. （管理者）メンバーを招待 / プロンプトを設定する
  - 空状態にはイラスト + 主 CTA + 副 CTA「使い方を見る」を置く
- **実装方針**:
  - `components/onboarding-checklist.js` を追加
  - 完了判定は `sessions.length > 0`、`/admin/members` の件数、最新の `audit-events` で自動推定
  - ローカルストレージで dismiss を記録（`soaplane.onboarding.dismissed=true`）

### 11. ヘルプ / サポート導線

- **現状**: ヘルプは `?` キーボードショートカット一覧のみ。
- **B2B 標準**: 右下の `?` フローティングボタン（Intercom/Zendesk）から FAQ・問い合わせへ導線。
- **提案**:
  - 右下にフローティング `?` を置き、クリックで以下のメニュー：
    - 「使い方ガイド」（`docs/core` or 将来の公開ドキュメント URL）
    - 「キーボードショートカット」（既存オーバーレイを再利用）
    - 「不具合を報告」（`mailto:` または将来の社内フォーム）
  - 録音中は非表示（誤クリック防止）
- **実装方針**:
  - `components/help-fab.js` を追加して `layout.js` にマウント
  - `pathname` が `/sessions/[id]` かつ `status === "recording"` の間は `display: none`

### 12. トースト / 通知履歴

- **現状**: トーストは 2.8s で消え、過去の通知は見返せない。
- **B2B 標準**: Linear/Notion の Inbox、Salesforce の Notifications Bell。
- **提案**: `SiteNav` 右上にベルアイコンを追加、過去 50 件のクライアント内通知を閲覧可（サーバ永続化は後続）。
- **実装方針**:
  - `useNotificationCenter` Context を新設、既存 `addToast` を内部で呼び出しつつ履歴にも push
  - 24 時間経過で自動破棄、ログアウトでクリア

### 13. アクセシビリティ強化（色だけに依存しないステータス）

- **現状**: `badge--{status}` は色と日本語文言で区別しているが、`connection-dot` は色のみ。弱視・色覚特性ユーザーには区別困難。
- **B2B 標準**: WCAG 2.1 AA 相当。ステータスにはアイコン + テキスト。
- **提案**:
  - `connection-dot` にマイクロアイコン（チェック / 警告 / プロセス）を重畳
  - フォーカスリングを全ボタンで統一（現在 `.btn` のフォーカスリングが薄い箇所あり）
  - `prefers-reduced-motion` でスピナーとパルスアニメを停止
- **実装方針**:
  - `globals.css` の `:focus-visible` に共通トークン `--ring` を追加
  - `connection-indicator` のマークアップに `Icon` を追加、テキストと併記

### 14. 印刷・PDF 用の "診療記録" ビュー

- **現状**: コピー後に電子カルテに貼り付ける運用のみ。紙出力・PDF 保存不可。
- **B2B 標準**: Zendesk/Intercom の "Export to PDF"、クリニカル系の "印刷プレビュー" は業界水準。
- **提案**:
  - `承認済み` 画面に「印刷用ビュー」ボタンを追加し、ヘッダフッタ最小化 + `@media print` 最適化ページを表示
  - 患者名・日付・医師・プロンプト名・SOAP 全文・ハッシュを A4 1 枚に
- **実装方針**:
  - `/sessions/[sessionId]/print` ルートを追加して `EncounterWorkspace` とは別の薄いコンポーネントで描画
  - `globals.css` 末尾に `@media print { ... }` を追記

### 15. 監査ログのエクスポートとフィルタ拡張

- **現状**: `AdminConsole` の `操作ログ` は `auditTypeFilter` のみ。期間・アクター絞り込み・CSV エクスポートなし。
- **B2B 標準**: 医療・金融領域の監査ログは期間指定 + CSV/JSON エクスポート + 署名付き URL が業界水準。
- **提案**:
  - 監査ログに `期間（開始/終了）` `アクター` `対象メンバー` のフィルタ
  - "CSV でダウンロード" ボタン
- **実装方針**:
  - Gateway `/api/v1/admin/audit-events` に `from` / `to` / `actorId` クエリを追加
  - フロント側は既存 `groupEventsByDate` に期間フィルタを通すだけで済むよう配列段階で絞る

### 16. レスポンシブ閲覧（SOAP の確定済みをスマホで読めるように）

- **現状**: `EncounterWorkspace` は PC 前提。スマホでログインするとレイアウト崩れ。医師が外出先で過去 SOAP を確認できない。
- **B2B 標準**: 作成は PC 限定でも、閲覧はレスポンシブが標準。
- **提案**:
  - `status === "approved"` のセッションに限り、幅 <768px で 1 カラムの閲覧専用レイアウトに切替
  - 編集 UI は全て非表示化
- **実装方針**:
  - `workspace--layout-readonly-mobile` モディファイアを追加
  - 既存 `layoutMode` ステートに `readonly-mobile` を足すのではなく、ビューポート検出で排他的に適用
  - 録音・接続系 UI は `@media (max-width: 768px)` で `display: none`

### 17. ダークモード / 低輝度テーマ

- **現状**: ライトテーマのみ。夜間診療・当直で眩しい。
- **B2B 標準**: 医療系は夜勤対応で `prefers-color-scheme: dark` をサポートするケースが増加。
- **提案**:
  - `prefers-color-scheme: dark` 自動追従
  - ユーザー設定で `light / dark / system` を選択可
- **実装方針**:
  - `globals.css` の `:root` にライトトークン、`@media (prefers-color-scheme: dark)` または `[data-theme="dark"]` で上書き
  - 設定は `localStorage` `soaplane.theme` に保持
  - 既存 `--accent` `--bg` など全トークンを dark 用にマッピング

---

## 横断的な修正のまとめ

| # | 影響箇所 | 主な新規ファイル | 既存ファイル変更 |
|---|---|---|---|
| 1 | 全画面 | `components/command-palette.js`, `lib/command-items.js` | `app/layout.js` |
| 2 | 全画面 | `components/global-banner.js`, `lib/system-status.js` | `app/layout.js`, `components/encounter-workspace.js` |
| 3 | ナビ | `components/user-menu.js` | `components/site-nav.js` |
| 4 | ワークスペース | `components/encounter-progress.js` | `components/encounter-workspace.js` |
| 5 | ワークスペース | `components/autosave-pill.js`, `lib/autosave-status.js` | `components/encounter-workspace.js` |
| 6 | ダッシュボード | `components/session-dashboard-summary.js` | `components/session-launcher.js` |
| 7 | ダッシュボード | `components/session-table.js` | `components/session-launcher.js` |
| 8 | 全画面 | `lib/keyboard-shortcuts.js`, `hooks/use-keyboard-shortcut.js` | `components/encounter-workspace.js`, `components/site-nav.js` |
| 9 | ダッシュボード | `components/session-quick-peek.js` | `components/session-launcher.js` |
| 10 | ダッシュボード | `components/onboarding-checklist.js` | `components/session-launcher.js`, `components/admin-console.js` |
| 11 | 全画面 | `components/help-fab.js` | `app/layout.js` |
| 12 | ナビ | `components/notification-bell.js`, Context 拡張 | `components/site-nav.js`, `components/encounter-workspace.js` |
| 13 | 全画面 | — | `app/globals.css`, `components/encounter-workspace.js` |
| 14 | ワークスペース | `app/sessions/[sessionId]/print/page.js` | `app/globals.css` |
| 15 | 設定 | — | `services/gateway/src/routes/admin.ts` (相当箇所), `components/admin-console.js` |
| 16 | ワークスペース | — | `app/globals.css`, `components/encounter-workspace.js` |
| 17 | 全画面 | `lib/theme.js` | `app/globals.css`, `app/layout.js`, `components/site-nav.js` |

## 推奨実装順

1. **P0-3（ユーザーメニュー）** と **P0-4（ステッパー）** を最初に。視認性が一気に B2B 水準になり、パイロット医師の "状態不明" FB にも直接効く。
2. **P0-2（グローバルバナー）** と **P0-5（保存ピル）** を同スプリントで。現状の状態表示が散らばっている問題を根本解決する前提条件。
3. **P0-1（⌘K）** と **P1-8（ショートカット基盤）** は同一リファクタで取り組む。`lib/keyboard-shortcuts.js` を先に切り、⌘K はその上に載せる。
4. **P1（6→7→9）** はダッシュボードのリワーク。テーブルビュー導入と同時に KPI カードとプレビューを入れるとコンセプトが揃う。
5. **P2** はユーザー定着フェーズ以降。ただし 13（アクセシビリティ）と 17（ダーク）はブランディング/医療現場要件として早期に下駄を履かせたい。

## 非ゴール（本ドキュメントで扱わないもの）

- SOAP の LLM 品質改善（docs/09 Phase 4 で扱う）
- 音声・接続の信頼性改善（docs/09 Phase 1 で扱う）
- モバイル録音 UI の詳細（docs/10 および録音者 UX は別チケット）
- 外部 EMR 連携（双方向連携は別ロードマップ）
