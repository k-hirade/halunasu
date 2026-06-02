# 診療報酬算定 UI: カルテ作成との差分監査

作成日: 2026-06-02

## 目的

診療報酬算定アプリを、カルテ作成アプリと同じ利用感に寄せるため、現行UIの差分を洗い出し、修正方針を定義する。

今回の目的は「少し似せる」ではなく、ユーザーが `charting.halunasu.com` と `fee.halunasu.com` を行き来しても同じプロダクトとして扱える状態にすること。画面構造、余白、カード、検索、ドロップダウン、文言、エラー、ローディング、テストまで含めて、カルテ作成を徹底的にまねる。

## 調査対象

### カルテ作成

- `apps/charting-web/app/layout.js`
- `apps/charting-web/app/globals.css`
- `apps/charting-web/components/operator-login-panel.js`
- `apps/charting-web/components/session-launcher.js`
- `apps/charting-web/components/encounter-workspace.js`
- `apps/charting-web/components/site-nav.js`
- `apps/charting-web/components/admin-select.js`
- `apps/charting-web/test/e2e/*`

### 診療報酬算定

- `apps/fee-web/index.html`
- `apps/fee-web/auth.css`
- `apps/fee-web/scripts/validate-static-site.mjs`
- `apps/fee-web/README.md`
- `services/fee-api`
- `packages/fee-core`
- `packages/fee-contracts`

### 旧 `medical-fee-calculation`

旧 `medical-fee-calculation` はPython/CLI、マスター、CSV、テスト、ドキュメント中心で、Web UI本体は存在しない。そのため本監査では、旧Fee UI復元ではなく、現行 `fee-web` をカルテ作成UIへ揃えることを対象にする。

## 結論

現行 `fee-web` は、セッション一覧の一部クラス名とログイン画面の一部をカルテ作成から取り込んでいる。ただし、実態は単一HTML + インラインCSS/JSの静的アプリであり、カルテ作成のNext/Reactアプリとは設計粒度が違う。

そのため、見た目の違和感の主因は3つある。

1. `fee-web` は `topbar`、`dashboard`、詳細カードを独自実装しており、カルテ作成の `SiteNav`、`workspace`、患者情報カード、検索UIを使っていない。
2. Fee詳細画面は「カード内フォーム + JSONテキストエリア + 結果テーブル」で、カルテ作成の「固定ヘッダー下の全画面ワークスペース」と構造が違う。
3. Feeには画面E2Eがなく、静的HTML文字列検証だけなので、カルテ作成レベルのUI退行防止ができない。

完全に揃えるなら、`fee-web` をカルテ作成のUI構造へ寄せるだけでなく、共有デザインシステム化と、将来的なNext/React化を前提にするべき。短期は静的HTMLのまま改修できるが、コピーするレベルの再現を長期運用するには現在の単一HTML構造は弱い。

2026-06-02時点ではSTG/PRODとも実ユーザーがいないため、単発の見た目修正ではなく、最初から長期的にずれにくい設計へ倒す。具体的には、空の `packages/web-ui` を正式な共有UI置き場にし、カルテ作成のデザイントークンと共通コンポーネントCSSを `halunasu-ui.css` として抽出する。Fee、Core Admin、Referral、LPの静的HTMLはこのCSSを読み、Chartingは同じCSSをimportする。

## レポート突合で更新した設計判断

提示レポートと本Docを突合した結果、以下を追加の決定事項にする。

1. `fee-web` の `:root` を個別調整しない。カルテ作成のトークンを共有CSSへ抽出し、Feeは共有CSSを読む。
2. `packages/web-ui` を空のREADMEだけの状態から、Halunasu全Webアプリの共有UI基盤へ昇格する。
3. `fee-web` のCSS差分は純CSSだけでは解消しない。JSテンプレート内のクラス名も書き換える。
4. 実装順は `トークン -> ボタン -> カード -> ナビ -> テーブル -> モーダル -> バッジ/トースト -> ワークスペース` とする。
5. 長期の最終形は、FeeもReact/Nextのアプリシェルへ寄せる。ただし最初の実装単位は共有CSS + クラス名統一にする。これにより静的HTMLのままでもSTG/PRODへ安全に段階反映できる。

## ASIS / TOBE

| 領域 | ASIS | TOBE |
| --- | --- | --- |
| アプリ構造 | Feeは `index.html` 2466行にHTML/CSS/JSが集中。 | カルテ作成と同じReact component単位、または最低限 `fee-web` 内でshell/session/workspace/form/resultを分離する。 |
| グローバルナビ | Fee独自の `topbar`。ブランドは文字の `H`、ログアウトや施設管理導線なし。 | カルテ作成の `SiteNav` と同じ配置、ブランド画像、メニュー、アカウント/ログアウト導線。 |
| ログイン | 見た目は近いが、Fee側は静的HTMLで別実装。ボタンdisabled、ローディング、エラー、セッション同期が独自。 | `OperatorLoginPanel` と同じフロー、同じ見た目、同じ2段階認証文言、同じエラー変換。 |
| セッション一覧 | クラス名は近いが、見出し・カード情報・ID露出・空状態がFee独自。 | カルテ作成の `SessionLauncher` と同じ情報設計。見出し、検索、状態filter、カード、ローディング、空状態を同じにする。 |
| 詳細画面 | `fee-session-detail-grid` の2カラムカード。縦にフォームと結果を積む。 | カルテ作成の `workspace` と同じ全画面作業領域。左/中央/右の作業面を診療報酬向けに割り当てる。 |
| 患者UI | 患者作成フォームが詳細画面内に常設。患者選択は通常select。 | カルテ作成の患者情報カードと検索selectをコピー。患者作成/編集は施設管理画面へ寄せ、Feeでは検索/選択を主にする。 |
| 施設UI | 施設selectを常時表示。 | 1施設なら表示しない。複数施設だけカルテ作成の固定表示/選択UIに合わせる。 |
| 診療科UI | 通常select。 | カルテ作成の患者・診療情報カードと同じ見た目。診療科未指定も同じ文言にする。 |
| 算定入力 | `ordersText` と `claimContext JSON` / `calculationOptions JSON` を直接表示。 | 一般ユーザーには構造化入力を見せる。JSONは管理者向けの詳細設定/開発者向け折りたたみに退避する。 |
| 結果表示 | `line-table` で全体を表示。結果、レビュー、レセプト案がカード分断。 | カルテ作成のSOAP/会話パネル風に、算定候補、レビュー理由、レセプト案を同じ作業面に統合する。 |
| 文言 | `coverage`, `support level`, `claimContext JSON`, `患者ID alias` など開発者語が残る。 | ユーザー向け日本語へ置換。必要なら補助説明で内部概念を隠す。 |
| エラー | `toUserFacingErrorMessage` はあるが、Fee独自実装。 | カルテ作成と同じエラー辞書、同じ表示位置、同じローディング/成功toast。 |
| テスト | `validate-static-site.mjs` の文字列チェックのみ。 | ログイン、一覧、詳細、計算、レビュー、reload、logout、mobile overflowをE2Eで守る。 |

## デザイントークン差分

Feeの見た目が「なんとなく違う」主因は、クラス名以前に `:root` のトークンが違うこと。カルテ作成は `apps/charting-web/app/globals.css` の先頭に体系化されたトークンを持つが、Feeは `apps/fee-web/index.html` のインラインCSSで独自トークンを持つ。

| 用途 | fee-web ASIS | charting-web TOBE | 対応 |
| --- | --- | --- | --- |
| 文字 | `--ink: #152033` | `--ink: #111827` | 共有トークンへ置換 |
| 補助文字 | `--muted: #667085` | `--muted: #5b6573` | 共有トークンへ置換 |
| 罫線 | `--line: #d8e0eb` | `--border: #e5e7eb` | 名称も値も統一。短期は `--line: var(--border)` alias可 |
| 背景 | `--bg: #f6f8fb` | `--bg: #f7f8fa` | 共有トークンへ置換 |
| 面 | `--surface` | `--card` | `--surface: var(--card)` aliasから始め、使用箇所を `--card` へ移行 |
| アクセント | `--accent: #0f8f7f` | `--accent: #0d9488` | 共有トークンへ置換 |
| アクセント濃 | `--accent-dark: #0a665d` | `--accent-hover: #0f766e` | `--accent-dark` を廃止し `--accent-hover` へ |
| 警告 | `--warn: #a15c07` | `--warning`, `--warning-soft`, `--warning-ink` | 状態別3トークンへ移行 |
| 危険 | `--danger: #b42318` | `--danger`, `--danger-hover`, `--danger-soft`, `--danger-ink` | 状態別4トークンへ移行 |
| 成功 | `--success: #087443` | `--success`, `--success-hover`, `--success-soft`, `--success-ink` | 状態別4トークンへ移行 |
| アクセント淡 | `--soft-accent: #e8f5f2` | `--accent-soft: rgba(13, 148, 136, 0.08)` | 名称も値も統一 |
| radius | 8px固定が中心 | `--radius-sm/md/lg/full` | スケールへ移行 |
| modal幅 | なし | `--modal-sm/md/lg/xl` | モーダル共通化時に導入 |
| nav高さ | なし | `--site-nav-h` | app shell共通化時に導入 |
| font | `Inter, "Noto Sans JP"...` | `"Noto Sans JP", "Hiragino Sans"...` | Interを除去しNoto Sans JP先頭へ |

Fee側に欠けているトークン:

- `--info`, `--info-soft`, `--info-ink`
- `--neutral`, `--neutral-soft`
- `--muted-strong`
- `--border-strong`
- `--shadow-sm/md/lg`
- `--radius-sm/md/lg/full`
- `--modal-sm/md/lg/xl`
- `--site-nav-h`
- `--site-nav-shell-max`
- `--workspace-shell-pad-x`
- `--dashboard-shell-max`
- `--admin-shell-max`
- `--font`

### トークン移行方針

最初に `packages/web-ui/styles/halunasu-ui.css` を作り、カルテ作成のトークンをここへ移す。

短期はFeeの既存CSSを壊さないため、互換aliasを置く。

```css
:root {
  --line: var(--border);
  --surface: var(--card);
  --accent-dark: var(--accent-hover);
  --warn: var(--warning-ink);
  --soft-accent: var(--accent-soft);
  --soft-warn: var(--warning-soft);
}
```

ただしaliasは暫定。P2以降でFeeの使用箇所を正式トークンへ置換し、最終的には旧名を削除する。

## 共有デザインシステム TOBE

`packages/web-ui` を共有UI基盤にする。

```text
packages/web-ui/
  README.md
  package.json
  styles/
    halunasu-ui.css
    halunasu-ui.static.css  (必要なら静的HTML用に同じ内容を配布)
```

### 入れるもの

プロダクト固有の業務ロジックは入れない。入れるのは横断利用する見た目と基本UIだけ。

| 入れる | 入れない |
| --- | --- |
| tokens, reset, typography | SOAP生成ロジック |
| `.site-nav`, drawer | Fee算定ロジック |
| `.btn`, `.card`, `.field` | 患者保存API |
| `.badge`, `.status-dot` | Stripe/契約判定ロジック |
| `.data-table` | product-specific route |
| `.admin-modal-*` | Charting専用録音状態 |
| `.toast`, `.skeleton` | Fee計算結果の意味付け |
| session list primitives | 各アプリ固有のデータ取得 |
| workspace shell primitives | 各アプリ固有の入力フォーム状態 |

### 配信方法

ChartingはNext appなので、`apps/charting-web/app/globals.css` から共有CSSをimportする。

静的HTMLアプリはNetlify用distへコピーして読む。現行の静的ビルドは `scripts/p11_build_static_apps_runtime_config.mjs` が `apps/core-admin`, `apps/fee-web`, `apps/referral-web`, `apps/lp` を `dist/runtime-apps/{env}/{app}` へコピーするため、このスクリプトで `packages/web-ui/styles` を各静的app配下へ同梱する。

想定配置:

```text
dist/runtime-apps/prod/fee-web/web-ui/halunasu-ui.css
dist/runtime-apps/prod/core-admin/web-ui/halunasu-ui.css
dist/runtime-apps/prod/referral-web/web-ui/halunasu-ui.css
```

静的HTML側:

```html
<link rel="stylesheet" href="web-ui/halunasu-ui.css" />
```

これにより、GCPリソースや外部CDNは追加しない。Netlify静的配信だけで完結する。

### なぜこの順番にするか

FeeをいきなりNext/React化すると、APIや認証、Netlify設定、E2Eの変更が同時に大きくなる。一方、共有CSS化は以下の利点がある。

- Chartingの既存デザインを正本にできる。
- Fee/Core Admin/Referral/LPを同じルールへ段階的に寄せられる。
- 静的HTMLのままでもSTG/PRODへ低リスクで反映できる。
- 将来FeeをNext/React化してもCSS正本はそのまま使える。

## コンポーネント別差分と移植方針

### ナビゲーション

| 項目 | fee-web ASIS | charting-web TOBE | 対応 |
| --- | --- | --- | --- |
| shell | `.topbar` 高さ64px固定 | `.site-nav-wrap` + `.site-nav` sticky/blur | `.topbar` を廃止 |
| ブランド | `H` の角丸ボックス | 画像マーク36px + wordmark | `site-brand` へ |
| メニュー | なし | `.site-menu-button` + `.admin-nav-drawer` | Feeにも導入 |
| 右側 | `session-chip` のみ | アプリ共通のログイン/メニュー導線 | ログアウト、施設管理導線を追加 |

### ログイン

構造はすでに近い。ただしFeeは `auth.css` で自前コピーしているため二重管理になっている。

方針:

- `operator-gate` 系CSSは共有CSSへ移す。
- Feeの `auth.css` は削除または最小化する。
- Charting/Fee/Core Admin/Referralのログインは同じ見た目にする。

### ボタン

Feeには `.btn--primary`, `.btn--ghost` と、旧 `button.accent`, `button.secondary`, `button.warn` が混在している。

方針:

- 旧 `button.accent`, `button.secondary`, `button.warn` を全廃。
- すべて `.btn` + modifierへ統一。
- 保存操作は警告色にしない。破壊操作だけ `.btn--danger`。

### カード/テーブル/モーダル/バッジ/トースト

| 要素 | fee-web ASIS | charting-web TOBE | 対応 |
| --- | --- | --- | --- |
| カード | `.panel`, `.card`, radius 8固定 | `.card`, `--radius-md` | `.panel` 廃止、見出しサイズ統一 |
| テーブル | `table.line-table` | `.data-table`, `.data-table-row`, `.data-table-head` | 算定明細をgrid/table共通ルールへ |
| モーダル | Feeは現状ほぼ未整備 | `.admin-modal-overlay`, `.admin-modal-card` | 患者追加/詳細JSONに使う |
| バッジ | `.badge review/supported/partial` | `.badge--ready/...`, `.status-dot` | Fee状態用modifierを定義 |
| トースト | `showMessage` 1行 | `.admin-toast-container` | Feeにもtoast導入 |
| フォーカス | `box-shadow`中心 | Chartingのフォームルール | 共有CSSへ |

## 詳細差分

### 1. アプリ構造

カルテ作成はNext/Reactで、レイアウトに `SiteNav` を常設している。

- `apps/charting-web/app/layout.js`
- `apps/charting-web/components/site-nav.js`

一方、Feeは `apps/fee-web/index.html` の1ファイルにHTML、CSS、状態管理、API、描画関数がまとまっている。

- CSS tokens: `apps/fee-web/index.html:12`
- app shell: `apps/fee-web/index.html:912`
- state/API/render: `apps/fee-web/index.html:1122`

この構造では、カルテ作成で修正したUI改善をFeeへ安全に反映しにくい。コピーするたびにHTML文字列生成、イベント再バインド、手動CSS同期が必要になる。

#### 方針

短期は `index.html` のまま修正できる。ただし、完全一致を継続するなら次のどちらかが必要。

| 案 | 内容 | 評価 |
| --- | --- | --- |
| A. FeeをNext/React化 | `SessionLauncher` 相当、Fee workspace、login panelをReact化し、カルテ作成のCSS/部品を再利用する。 | 長期推奨。コピー精度と保守性が高い。 |
| B. 静的HTML + 共有CSSで寄せる | `packages/web-ui` の共有CSSを読み、`index.html` とJSテンプレのクラス名をCharting体系へ移す。 | 実装開始時の推奨。早く揃えられ、将来Next化してもCSS正本を使える。 |

長期の最終形はA。ただし現時点の実装開始はBを推奨する。理由は、まずデザイン正本を `packages/web-ui` に作ることで、Fee、Core Admin、Referral、LPまで同じUI基盤に乗せられるため。FeeのNext/React化はP5のworkspace化に入る直前に判断する。

### 2. グローバルナビ

カルテ作成は `SiteNav` がブランド、メニュー、管理画面導線を担う。

- ブランド画像とワードマーク: `apps/charting-web/components/site-nav.js:233`
- メニューdrawer: `apps/charting-web/components/site-nav.js:262`
- メイン導線: `apps/charting-web/components/site-nav.js:270`

Feeは独自の `topbar` を持つ。

- `apps/fee-web/index.html:913`
- ブランドは画像ではなく `H`: `apps/fee-web/index.html:915`
- 右側は候補支援バッジとセッションチップのみ: `apps/fee-web/index.html:918`

#### 問題

- カルテ作成とヘッダーの位置、ブランド表現、メニュー導線が違う。
- ログアウトがない。
- 施設管理画面への導線がない。
- `算定候補・レビュー支援` がトップバーに常時出ており、プロダクト名より目立つ。

#### TOBE

- Feeもカルテ作成と同じ `SiteNav` 配置にする。
- 左: ハルナスロゴ + メニュー。
- 右: ログイン状態、ログアウト、施設管理画面への導線。
- `算定候補・レビュー支援` はトップバーではなく、Fee詳細画面の注意カードまたは結果パネルに表示する。

### 3. ログイン/2段階認証

カルテ作成は `OperatorLoginPanel` が通常ログインと2段階認証を同じコンポーネントで管理する。

- 2段階認証画面: `apps/charting-web/components/operator-login-panel.js:112`
- 通常ログイン画面: `apps/charting-web/components/operator-login-panel.js:202`
- ローディングボタンとdisabled制御: `apps/charting-web/components/operator-login-panel.js:303`

FeeはHTMLとして似せているが、別実装。

- 通常ログイン: `apps/fee-web/index.html:792`
- 2段階認証: `apps/fee-web/index.html:866`
- platform login: `apps/fee-web/index.html:1198`

#### 問題

- 同じUIに見えても、エラー処理、セッション同期、disabled条件、ローディング表現が別々に進化する。
- Fee側はPlatform cookieを使い `hydrateExistingPlatformSession` で復元するが、カルテ作成のaccess token式と異なるため、reload時の挙動がズレやすい。

#### TOBE

- 表示はカルテ作成の `OperatorLoginPanel` と同じ。
- 文言はFee向けに最低限だけ差し替える。
  - title: `診療報酬算定にログイン`
  - description: `算定履歴の確認と算定候補の作成にはログインが必要です。`
- 2段階認証は同じ画面構造、同じQR/シークレット表示、同じ戻る動作。
- reload後のログイン維持、logout、CSRFをE2Eで守る。

### 4. セッション一覧

カルテ作成の一覧は「診療一覧」「新しい診療」「過去の診療」という業務語に寄せている。

- title: `apps/charting-web/components/session-launcher.js:388`
- quick start: `apps/charting-web/components/session-launcher.js:410`
- history: `apps/charting-web/components/session-launcher.js:432`
- search/filter: `apps/charting-web/components/session-launcher.js:443`
- card: `apps/charting-web/components/session-launcher.js:496`
- loading skeleton: `apps/charting-web/components/session-launcher.js:466`

Feeは近い構造を持つが、情報設計がまだ違う。

- title: `診療報酬算定セッション`: `apps/fee-web/index.html:926`
- quick start label: `クイックスタート`: `apps/fee-web/index.html:933`
- description: `患者、施設、オーダーは算定画面で入力します...`: `apps/fee-web/index.html:935`
- history label: `セッション履歴`: `apps/fee-web/index.html:945`
- cardにFee session IDを表示: `apps/fee-web/index.html:1701`

#### 問題

- `セッション` が残っている。
- `クイックスタート` がカルテ作成側で既に避けた文言と同じ問題を持つ。
- カードに `feeSessionId` が出ていて、運用ユーザーに不要な長いIDが目立つ。
- カルテ作成の「患者名、症状、作成/確定時刻」という読みやすい順序に対し、Feeは施設、診療科、点数、レビュー、IDが1行に詰まる。

#### TOBE

| Fee ASIS | Fee TOBE |
| --- | --- |
| `診療報酬算定セッション` | `算定一覧` |
| `クイックスタート` | `新しい算定` |
| `すぐに算定を始められます` | `新しい算定記録を作成します` |
| `患者、施設、オーダーは算定画面で入力します。...` | `次の画面で患者、診療日、オーダーを入力できます。新しい算定記録を開いてください。` |
| `算定を開始` | `算定記録を作成` |
| `セッション履歴` | `履歴` |
| `算定履歴` | `過去の算定` |
| `患者名、患者ID、算定IDで検索` | `患者名・患者IDで検索` |

カードはカルテ作成と同じ優先順位にする。

1. 患者名または `患者名なし`
2. 診療日、診療科、算定状態
3. 作成時刻、点数候補、レビュー件数
4. 状態バッジ

`feeSessionId` はカードに出さない。必要な場合は詳細画面の折りたたみ、またはコピー用アイコンに退避する。

### 5. 詳細画面/ワークスペース

カルテ作成の詳細画面は `workspace` と `workspace-main` による全画面作業領域。

- `workspace`: `apps/charting-web/app/globals.css:2940`
- `workspace-main`: `apps/charting-web/app/globals.css:2960`
- panel heading: `apps/charting-web/app/globals.css:2984`
- panel title: `apps/charting-web/app/globals.css:3084`

Feeの詳細画面は `dashboard` の中のカード型2カラム。

- detail head: `apps/fee-web/index.html:969`
- notice: `apps/fee-web/index.html:979`
- grid: `apps/fee-web/index.html:987`
- side form cards: `apps/fee-web/index.html:989`
- main result cards: `apps/fee-web/index.html:1095`

#### 問題

- カルテ作成の作業画面と視覚構造が違うため、同じプロダクトに見えない。
- Feeでは入力、算定、レビュー、レセプト案がカード分断され、作業順序が見えにくい。
- 詳細画面の上に注意カードが常時大きく出て、作業領域を押し下げる。
- `claimContext JSON` / `calculationOptions JSON` が一般ユーザー画面に露出している。

#### TOBE

Fee詳細画面はカルテ作成の `encounter-workspace` をまねて、以下のように割り当てる。

```text
SiteNav
┌──────────────────────────────────────────────────────────┐
│ 算定記録: 患者名 / 診療日 / 状態                         │
├──────────────────────┬───────────────────────────────────┤
│ 患者・算定情報       │ 算定候補                           │
│ - 患者検索           │ - 合計点数候補                     │
│ - 診療科             │ - レビュー件数                     │
│ - 診療日/請求月      │ - 対応範囲                         │
│ - オーダー入力       │ - 明細                             │
├──────────────────────┴───────────────────────────────────┤
│ footer: 保存 / 算定候補を作成 / 一覧へ戻る / 状態         │
└──────────────────────────────────────────────────────────┘
```

カルテ作成の `transcript-panel` / `soap-panel` 相当をFeeでは次のように使う。

| Charting | Fee |
| --- | --- |
| 患者・診療情報カード | 患者・算定情報カード |
| 会話記録パネル | オーダー/診療情報パネル |
| 診療記録パネル | 算定候補/レビュー/レセプト案パネル |
| footer録音操作 | footer保存/算定実行/戻る |

### 6. 患者・施設・診療科

カルテ作成には患者検索select、固定施設表示、診療科選択のためのデザインがある。

- patient search container: `apps/charting-web/app/globals.css:3214`
- patient search menu: `apps/charting-web/app/globals.css:3271`
- static facility display: `apps/charting-web/app/globals.css:3330`

Feeは通常のselectを使う。

- patient search input: `apps/fee-web/index.html:1033`
- patient select: `apps/fee-web/index.html:1038`
- facility select: `apps/fee-web/index.html:1042`
- department select: `apps/fee-web/index.html:1046`

#### 問題

- 検索inputとselectが分離していて、選択体験がカルテ作成と違う。
- 1施設の病院でも施設selectが出る。
- 患者作成フォームがFee詳細画面に常設され、入力画面が重い。
- `患者ID alias` という開発者向け文言が残る。

#### TOBE

- 患者はカルテ作成の `patient-search-select` をコピーする。
- 施設が1件なら、Fee詳細画面では施設欄を表示しない。
- 複数施設ならカルテ作成の固定表示/選択UIに合わせる。
- 診療科はカルテ作成と同じ見た目のselectにする。
- 患者追加/編集は施設管理画面を主導線にする。Fee詳細では「登録済み患者を検索して選ぶ」を主にする。
- Fee詳細内で患者を作成する必要がある場合は、常設フォームではなく `+ 患者を追加` のモーダル/ドロワーにする。

### 7. 算定入力

現行Feeは、ユーザーが直接以下を入力する。

- `診療テキスト`: `apps/fee-web/index.html:1068`
- `オーダー`: `apps/fee-web/index.html:1072`
- `claimContext JSON`: `apps/fee-web/index.html:1077`
- `calculationOptions JSON`: `apps/fee-web/index.html:1081`

#### 問題

- `claimContext JSON` と `calculationOptions JSON` は一般ユーザー向けではない。
- オーダー入力のplaceholderが `procedure|血液検査|160000410|1` で、ルールを知らないと使えない。
- カルテ作成のような「作業に集中できる画面」ではなく、内部データ投入画面に見える。

#### TOBE

入力を3層に分ける。

| 層 | 表示先 | 内容 |
| --- | --- | --- |
| 通常入力 | 常時表示 | 患者、診療日、診療科、診療テキスト、オーダー行 |
| 詳細入力 | 折りたたみ | 施設基準、既算定履歴、コメント、入外区分など |
| 開発/移行入力 | 管理者向け折りたたみ | `claimContext JSON`, `calculationOptions JSON` |

通常入力では、最低限以下を用意する。

- オーダー行追加ボタン
- 種別select: 検査、投薬、注射、処置、画像、診療行為、特定器材、その他
- 名称
- 標準コード
- 数量
- 行削除

### 8. 算定候補/レビュー/レセプト案

現行Feeの結果表示は `innerHTML` でテーブルを生成する。

- result: `apps/fee-web/index.html:1897`
- line table: `apps/fee-web/index.html:1928`
- review: `apps/fee-web/index.html:1801`
- receipt: `apps/fee-web/index.html:1833`

#### 問題

- 表が業務的には必要だが、カルテ作成の画面密度と違う。
- `対応範囲`, `support level`, `coverage` の文言が混在している。
- レビューとレセプト案が別カードで下に流れ、算定結果との関係が弱い。

#### TOBE

- 上部にサマリー帯:
  - 合計点数候補
  - 要確認件数
  - 対応範囲
  - 確定請求ではない注意
- 明細はカルテ作成のパネル内スクロールに合わせる。
- レビューは明細行内、または右パネルの「確認が必要な項目」に統合する。
- レセプト案は別タブまたは下段パネルにする。
- `coverage` はUI上 `対応範囲` に統一する。
- `support level` はUI上 `判定の強さ` または `対応状況` に統一する。まずは `対応状況` を推奨。

### 9. 文言

Feeに残っている修正対象:

| ASIS | TOBE |
| --- | --- |
| `診療報酬算定セッション` | `算定一覧` |
| `算定セッション` | `算定記録` |
| `クイックスタート` | `新しい算定` |
| `患者、施設、オーダーは算定画面で入力します。ここではそのまま算定セッションを開始してください。` | `次の画面で患者、診療日、オーダーを入力できます。新しい算定記録を開いてください。` |
| `患者ID alias` | `患者番号` |
| `claimContext JSON` | `詳細条件` の折りたたみに退避 |
| `calculationOptions JSON` | `算定オプション` の折りたたみに退避 |
| `coverage と support level を確認してからレビューしてください。` | `対応範囲と確認が必要な理由を確認してください。` |
| `算定実行` | `算定候補を作成` |
| `再読み込み` | `最新の状態に更新` |
| `レビュー項目はありません` | `確認が必要な項目はありません` |
| `レセプト案はまだありません` | `算定候補を作成すると、レセプト案が表示されます` |

### 10. ローディング/エラー/toast

カルテ作成はskeleton、inline error、processing overlay、toastを持つ。

- skeleton: `apps/charting-web/app/globals.css:5160`
- toast: `apps/charting-web/app/globals.css:5080`
- session create overlay: `apps/charting-web/components/session-launcher.js:582`

Feeは `message` 1箇所と `session-card--loading` が中心。

- `message`: `apps/fee-web/index.html:395`
- `showMessage`: `apps/fee-web/index.html:2338`
- static validationで raw error禁止はある: `apps/fee-web/scripts/validate-static-site.mjs`

#### TOBE

- 成功/失敗はカルテ作成と同じtoastへ。
- ログイン/2段階認証のエラーは `inline-error`。
- セッション作成中はカルテ作成のprocessing overlay相当。
- 算定実行中は結果パネルにskeletonまたは処理中カード。
- APIのraw messageを出さないE2Eを追加。

### 11. テスト

カルテ作成には画面E2Eがある。

- `apps/charting-web/test/e2e/session-login-csrf.test.js`
- `apps/charting-web/test/e2e/encounter-ui-regression.test.js`
- `apps/charting-web/test/e2e/logout-flow.test.js`
- `apps/charting-web/test/e2e/user-facing-error.test.js`

FeeのWebテストは静的HTML検証のみ。

- `apps/fee-web/scripts/validate-static-site.mjs`

#### TOBE

FeeにもE2Eを追加する。

最低限:

1. ログイン -> 一覧表示 -> reloadしてもログイン維持。
2. 2段階認証要求時にログイン画面直後ではなく確認コード画面へ進む。
3. logoutでき、reload後もログイン画面へ戻る。
4. 算定記録を作成し `/sessions/{id}` に移動できる。
5. `/sessions/{id}` 直アクセス/reloadで詳細が復元される。
6. 患者検索/選択ができる。
7. 1施設なら施設欄が表示されない。
8. 診療科を選択できる。
9. 入力保存と算定候補作成ができる。
10. 結果、確認が必要な項目、レセプト案が表示される。
11. raw API errorがUIに出ない。
12. desktop/tablet/mobileで横スクロールしない。

## 実装計画

### P0: 共有デザインシステムを作る

目的: 今後のズレを防ぐ正本を先に作る。

1. `packages/web-ui/package.json` を追加する。
2. `packages/web-ui/styles/halunasu-ui.css` を追加する。
3. `apps/charting-web/app/globals.css` から以下を抽出する。
   - design tokens
   - base typography/reset
   - `.site-nav-*`
   - `.btn*`
   - `.card`
   - `.field`
   - `.badge*`
   - `.data-table*`
   - `.admin-modal-*`
   - `.admin-toast-*`
   - `.skeleton*`
   - session history/list primitives
   - workspace shell primitives
   - patient search/static select primitives
4. Charting側は抽出後も見た目が変わらないように `globals.css` から共有CSSをimportする。
5. 共有CSSには暫定aliasを置き、Feeの旧CSS名を段階移行できるようにする。
6. `packages/web-ui/README.md` に「入れるもの/入れないもの」を明記する。

完了条件:

- ChartingのE2Eが共有CSS import後も通る。
- `packages/web-ui` が空き家ではなく、Web UI正本として機能する。

### P1: 静的アプリへ共有CSSを配布する

目的: Fee/Core Admin/Referral/LPが同じCSS正本を読めるようにする。

1. `scripts/p11_build_static_apps_runtime_config.mjs` で `packages/web-ui/styles` を各静的アプリのdistへコピーする。
2. `apps/fee-web/index.html` に `<link rel="stylesheet" href="web-ui/halunasu-ui.css" />` を追加する。
3. `apps/core-admin/index.html`, `apps/referral-web/index.html`, 必要に応じてLPにも同じ読み込みを追加する。
4. Feeの `:root` は共有CSSへ委譲する。
5. FeeからInter指定を外し、`--font` を使う。
6. `apps/fee-web/auth.css` は共有CSSと重複する `operator-gate` 系を削る。

完了条件:

- `npm run build:runtime-apps` で各distに `web-ui/halunasu-ui.css` が入る。
- Feeのログイン画面がChartingログインと同じトークン/フォント/radiusになる。
- 静的検証で共有CSSリンクを必須にする。

### P2: Feeの基本コンポーネントクラスを統一する

目的: 体感差の大半を消す。

1. `button.accent`, `button.secondary`, `button.warn` を廃止する。
2. すべて `.btn`, `.btn--primary`, `.btn--ghost`, `.btn--danger`, `.btn--success`, `.btn--lg`, `.btn--sm`, `.btn--loading` へ統一する。
3. `.panel` を廃止し `.card` へ寄せる。
4. `.badge review/supported/partial` をFee用の明確なmodifierへ移す。
5. `showMessage` の1行固定表示をtoastへ寄せる。
6. `line-table` はすぐ全廃しないが、見た目は `.data-table` 系へ寄せる。

完了条件:

- Feeのボタン色、角丸、フォント、カード密度がChartingと一致する。
- 保存操作が警告色にならない。
- 破壊操作だけ危険色になる。

### P3: ナビゲーションとログインを揃える

目的: アプリを開いた瞬間の別物感をなくす。

1. Feeの `.topbar` を廃止し、`.site-nav-wrap` / `.site-nav` / `.site-brand` へ置換する。
2. ブランドは `H` ボックスではなく、ハルナスマーク画像 + wordmarkにする。
3. Feeにもメニューdrawerを導入する。
4. ログアウトを追加する。
5. 施設管理画面への導線を追加する。
6. `算定候補・レビュー支援` バッジはtopbarから外し、詳細画面または結果パネルの注意表示へ移す。
7. ログイン/2段階認証画面は共有 `operator-gate` CSSだけで表示する。

完了条件:

- FeeのヘッダーがChartingと同じ余白・高さ・ブランド表現になる。
- ログイン、2段階認証、logout、reload復元がE2Eで通る。

### P4: Feeセッション一覧をChartingのSessionLauncherへ寄せる

目的: 親パスの画面をChartingと同じ情報設計にする。

1. 見出しを `算定一覧` にする。
2. quick startを `新しい算定` / `新しい算定記録を作成します` へ変更する。
3. CTAを `算定記録を作成` にする。
4. 履歴を `履歴` / `過去の算定` にする。
5. 検索placeholderから `算定ID` を外す。
6. session cardから `feeSessionId` を外す。
7. cardの情報順をChartingと同じにする。
8. loading skeleton、empty state、paginationをChartingと同じにする。
9. 作成中processing overlayを追加する。

完了条件:

- Fee一覧を見た時に、Charting一覧と同じ親画面に見える。
- session IDや内部語が通常ユーザー画面に出ない。

### P5: Fee詳細画面をworkspace化する

目的: カルテ作成の個別画面と同じ作業体験にする。

1. `fee-session-detail-grid` を廃止する。
2. `.workspace` / `.workspace-main` ベースの全画面作業領域へ移す。
3. 左側: 患者・算定情報。
4. 中央: 診療テキスト/オーダー入力。
5. 右側: 算定候補/確認が必要な項目/レセプト案。
6. footer: 保存、算定候補を作成、一覧へ戻る、状態表示。
7. 1施設なら施設欄は表示しない。
8. 患者selectをChartingの `patient-search-select` へ置換する。
9. 患者作成は常設フォームからモーダル/施設管理導線へ移す。

完了条件:

- Fee詳細画面がChartingの診療記録画面と同じshellに見える。
- desktop/tablet/mobileで横スクロールがない。

### P6: 一般ユーザー向け入力へ再設計する

目的: JSON投入画面から業務画面へ変える。

1. `claimContext JSON` と `calculationOptions JSON` を常時表示から外す。
2. 通常入力としてオーダー行UIを作る。
3. 種別、名称、標準コード、数量、削除を持つ。
4. 施設基準、既算定履歴、コメント、入外区分は詳細入力の折りたたみにする。
5. JSONは管理者/移行用の折りたたみに退避する。
6. `coverage`, `support level`, `claimContext`, `alias` などを日本語化する。

完了条件:

- 医療機関ユーザーがJSONや内部contractを知らなくても算定候補を作れる。
- 詳細入力は必要時だけ開ける。

### P7: Fee E2EとDeploy gate

目的: 完全移行後に再びUIが崩れないようにする。

1. Fee E2E harnessを追加する。
2. `npm run test --workspace @halunasu/fee-web` が静的検証だけでなくUI回帰を含むようにする。
3. 主要E2E:
   - login
   - 2段階認証
   - logout
   - reload後のログイン維持
   - 算定一覧
   - 算定記録作成
   - `/sessions/{id}` 直アクセス/reload復元
   - 患者検索/選択
   - 1施設時に施設欄非表示
   - 診療科選択
   - 入力保存
   - 算定候補作成
   - 結果/確認項目/レセプト案表示
   - raw API error非表示
   - desktop/tablet/mobile overflowなし
4. STG/PROD deploy前にE2Eを通す。
5. Netlify deploy後に `https://fee.halunasu.com` と `https://fee.stg.halunasu.com` の表示確認を行う。

完了条件:

- Deploy前後でFee主要画面が保護される。
- Chartingとの差分が再発した時にテストで検出できる。

## Next/React化の判断

本Docの更新後方針では、まず共有CSS + クラス名統一で進める。ただし、P5以降でworkspaceを本気で揃える時点で、FeeをNext/React化するか判断する。

判断基準:

| 条件 | 判断 |
| --- | --- |
| Fee詳細画面の状態管理がさらに増える | Next/React化する |
| E2Eで静的HTMLの手動DOM生成が不安定 | Next/React化する |
| Referralも同じworkspaceを使う | 共通React component化を進める |
| まず見た目を早く揃えたい | 静的HTML + 共有CSSを継続 |

現時点の推奨は、P0〜P4は静的HTMLのまま進め、P5開始前にNext/React化を判断すること。ただし、顧客がいない現在は大胆に変更できるため、P5で実装量が大きくなると分かった時点でNext/React化へ切り替える。

## 完了条件

Fee UI完全移行の完了条件:

- ログイン/2段階認証の見た目と操作がカルテ作成と同じ。
- グローバルナビ、ブランド、メニュー、ログアウトがカルテ作成と同じ。
- 一覧画面の情報設計がカルテ作成と同じ。
- 詳細画面がカルテ作成のworkspaceに見える。
- 施設が1件の場合は表示しない。
- 患者検索UIがカルテ作成と同じ。
- JSONや内部IDが通常画面に露出しない。
- 算定候補/レビュー/レセプト案が、同じUI密度で確認できる。
- desktop/tablet/mobileで横スクロールがない。
- E2Eで主要操作を保護している。
- STG/PROD deploy後に同じ確認が通る。

## 最終推奨判断

今すぐやるべきことは、Feeだけを個別に化粧直しすることではない。`packages/web-ui` を作り、Chartingのトークンと共通コンポーネントCSSを全アプリの正本にする。

推奨順序:

1. `packages/web-ui` に共有CSSを作る。
2. Chartingが共有CSSをimportしても見た目が変わらないことを確認する。
3. Fee/Core Admin/Referral/LPの静的distへ共有CSSを同梱する。
4. Feeのトークン、ボタン、カード、ナビ、テーブル、モーダル、バッジ、トーストを順にCharting体系へ移す。
5. Fee一覧をChartingの親画面と同じ情報設計へ寄せる。
6. Fee詳細をworkspaceへ移す前に、静的HTML継続かNext/React化か判断する。
7. P5以降で手動DOM生成の複雑さが増えるなら、FeeをNext/React化する。

顧客がいない現在の判断として、P0〜P4は共有CSS + 静的HTMLのクラス統一で進める。P5のworkspace化で実装が大きくなる場合は、そこでNext/React化へ切り替える。これが最も長期的にきれいで、かつSTG/PRODに段階反映しやすい。

## 2026-06-02 実装結果

今回の実装で、上記推奨順序の1〜6を次の範囲で進めた。

### 完了

1. `packages/web-ui` に共有CSS基盤を追加した。
   - `packages/web-ui/package.json`
   - `packages/web-ui/styles/halunasu-ui.css`
   - tokens, base, nav, button, card, field, badge, session list, modal, toast, skeleton, operator gate, workspace primitivesを配置した。
2. `charting-web` が共有CSSをimportするようにした。
   - import順は `@halunasu/web-ui` -> `globals.css`。
   - 既存Charting固有CSSが後勝ちするため、Chartingの見た目を壊さない順序にした。
3. 静的アプリのruntime buildで共有CSSを配布するようにした。
   - `scripts/p11_build_static_apps_runtime_config.mjs` が `packages/web-ui/styles` を各app distの `web-ui/` へコピーする。
   - `fee-web`, `core-admin`, `referral-web`, `lp/signup` が `web-ui/halunasu-ui.css` を参照する。
4. `fee-web` の親画面をCharting寄りへ修正した。
   - `.topbar` 表示を廃止し、`.site-nav-wrap` / `.site-nav` / `.site-brand` を使う。
   - ブランドは `H` 文字ではなくハルナスマーク画像を使う。
   - `施設管理画面` への導線を追加した。
   - ログアウトボタンを追加し、Platformの `/v1/auth/logout` を呼ぶ。
   - `算定一覧`, `新しい算定`, `算定記録を作成します`, `過去の算定` へ文言を整理した。
   - 検索placeholderから内部的な `算定ID` を外した。
   - session cardから `feeSessionId` 表示を外した。
5. `fee-web` の詳細画面で最低限のユーザー向け整理を実施した。
   - `算定セッション` を通常表示から外し、`算定記録` に統一した。
   - `患者ID alias` を `患者番号` に変更した。
   - `coverage と support level` を日本語説明へ置換した。
   - `claimContext JSON` / `calculationOptions JSON` を常時表示から折りたたみの `詳細条件・算定オプション` へ退避した。
   - レビュー操作ボタンを共有 `.btn` 系へ変更した。
   - レセプト案から `receiptDraftId` の通常表示を外した。
   - `showMessage` を固定1行表示からtoastへ寄せた。
6. 検証を追加/更新した。
   - `apps/fee-web/scripts/validate-static-site.mjs` に共有CSS、logout、施設管理導線、toast、文言退行防止を追加した。
   - `算定セッション`, `クイックスタート`, `患者ID alias`, `coverage と support level`, `class="secondary"` が戻らないことを静的検証で見る。

### 検証結果

- `npm run test --workspace @halunasu/fee-web`: pass
- `npm run build:runtime-apps`: pass
- `npm run build --workspace @halunasu/charting-web`: pass
- Playwright desktop確認:
  - login title: `ログイン`
  - shared nav count: `1`
  - heading: `算定一覧`
  - primary CTA: `算定記録を作成`
- Playwright mobile確認:
  - 小画面では補助バッジを隠し、ブランドとログアウトを優先する。

### 意図的に未完了として残すもの

今回の実装では、FeeをNext/React化していない。静的HTMLのまま共有CSSとクラス統一で進めた。

そのため以下は未完了であり、次段階で実装判断する。

- Fee詳細画面の完全workspace化。
- 患者追加フォームを施設管理画面またはモーダルへ完全移動すること。

理由:

P5以降は状態管理とDOM更新が大きくなり、静的HTMLの手動DOM生成のまま実装すると長期保守性が落ちる可能性が高い。今回の実装で共有CSSと親画面の土台はできたため、次に詳細画面を本格的に揃える時点で、FeeをNext/React化するかを判断する。

## 2026-06-02 追加実装

前回の未完了項目のうち、静的HTMLのまま安全に進められる範囲を追加実装した。

### 追加完了

1. Fee詳細画面を3ペイン風へ寄せた。
   - 左: 患者
   - 中央: 算定条件
   - 右: 算定候補 / レビュー / レセプト案
   - 完全なCharting workspace component化ではないが、2カラムフォームよりChartingの作業画面に近い情報配置にした。
2. 1施設時の施設欄を非表示にした。
   - `renderFacilities()` で施設が1件だけなら `#facility-field` を隠す。
   - 保存時はその施設を自動で `facilityId` として使う。
3. オーダー入力を行単位UIへ変更した。
   - 種別、名称、標準コード、数量を行ごとに入力できる。
   - 既存API互換のため、保存前に hidden `ordersText` へ同期する。
4. 患者追加フォームの常時露出をやめた。
   - 詳細画面では `患者を追加する` の折りたたみに退避した。
   - 将来的には施設管理画面またはモーダルへ完全移動する。
5. Fee UI smoke testを追加した。
   - `apps/fee-web/scripts/ui-smoke.mjs`
   - login, shared nav, parent screen, structured order row, one-facility hiding, mobile overflowを確認する。
   - `npm run test --workspace @halunasu/fee-web` は static validation + UI smoke を実行する。

### 追加検証結果

- `npm run test --workspace @halunasu/fee-web`: pass
- `npm run build:runtime-apps`: pass
- `npm run build --workspace @halunasu/charting-web`: pass
- Playwright detail visual check:
  - `facilityHidden: true`
  - `orderRows: 1`
  - desktop horizontal overflow: `false`

### まだ残るもの

- Fee詳細画面をReact/Next componentとしてCharting workspaceと完全共通化するかの判断。
- 患者追加を完全に施設管理画面へ移すか、Fee内モーダルを残すかの判断。
- API接続込みのSTG/PROD E2E。今回追加したUI smokeは静的HTMLのUI退行検知であり、本番APIのデータ作成までは行わない。
