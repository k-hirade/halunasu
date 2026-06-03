# Fee/Core Admin Next.js Migration Plan

作成日: 2026-06-03

## 結論

診療報酬算定アプリとCore Adminは、SOAP/カルテ作成と同じ Next.js 構造へ移行する。

ただし、現行の `apps/fee-web/index.html` と `apps/core-admin/index.html` は本番稼働中の静的SPAなので、最初から本番の Netlify 設定を切り替えない。まず各アプリ内に Next.js App Router の骨格を追加し、SOAPと同じナビゲーション/管理ページ構造を作る。その後、既存機能を段階的にReactコンポーネントへ移す。

## 現状

### SOAP/カルテ作成

- `apps/charting-web`
- Next.js App Router
- `app/layout.js` でグローバルナビを常時表示
- `components/site-nav.js` にハンバーガーメニュー
- `/admin?section=...` で管理/設定ページを切り替え
- メニュー構成:
  - 診療一覧
  - 権限管理
  - プロンプト設定
  - 音声テスト
  - 操作ログ
  - アカウント

### 診療報酬算定

- `apps/fee-web`
- 現状は静的HTML/JS/CSSのSPA
- `platform-api` と `fee-api` を直接叩く
- Netlify静的デプロイで配信
- 画面構造は算定一覧/詳細中心で、SOAPのような管理/設定ページ構造がない

### Core Admin

- `apps/core-admin`
- 現状は静的HTML/JS/CSSのSPA
- `platform-api` を叩く
- Netlify静的デプロイで配信
- 病院共通データの管理本体だが、SOAPと同じNext.jsレイアウトではない

## 移行後のCore Adminページ構造

Core AdminもSOAPの設計を踏襲し、全ページ共通のトップバーとハンバーガーメニューにする。

### トップバー

`ハンバーガーメニュー + ハルナスアイコン + ハルナス + 施設管理画面`

### メニュー

Core Adminは病院共通管理の本体なので、現行の管理対象をそのままNextルートへ移す。

- 職員
- 施設
- 診療科
- 患者
- アプリ利用設定
- 個人情報の依頼
- 操作ログ
- アカウント

トップバーから病院コードのドロップダウンは出さない。病院選択/切替が必要な場合は、管理権限に応じてCore Admin内の一覧/設定ページで扱う。

## Core Adminルート設計

| Route | 役割 |
| --- | --- |
| `/` | `/admin` へ集約する管理トップ |
| `/admin` | 病院共通データの設定ホーム |
| `/admin?section=members` | 職員 |
| `/admin?section=facilities` | 施設 |
| `/admin?section=departments` | 診療科 |
| `/admin?section=patients` | 患者 |
| `/admin?section=entitlements` | アプリ利用設定 |
| `/admin?section=data-requests` | 個人情報の依頼 |
| `/admin?section=audit` | 操作ログ |
| `/admin?section=account` | アカウント |
| `/api/platform/[...path]` | platform-api proxy |

## 移行後のFeeページ構造

SOAPの設計を踏襲し、Feeでは以下の構造にする。

### トップバー

`ハンバーガーメニュー + ハルナスアイコン + ハルナス + 診療報酬算定`

SOAPの `site-nav` と同じ思想で、全ページ共通にする。

### メニュー

Feeアプリ内のメニューは以下に絞る。

- 算定
- 権限管理
- 算定設定
- 操作ログ
- アカウント

`施設`、`診療科`、`患者` はFeeメニューには追加しない。これらはCore Adminの病院共通管理領域であり、Fee側では選択UIだけを持つ。

### SOAPとの対応

| SOAP | Fee |
| --- | --- |
| 診療一覧 | 算定 |
| 権限管理 | 権限管理 |
| プロンプト設定 | 算定設定 |
| 操作ログ | 操作ログ |
| アカウント | アカウント |

Feeでは `プロンプト設定` という名称は使わない。診療報酬算定はプロンプトよりも算定条件、レビュー方針、マスター/ルールの扱いが重要なので、対応ページ名は `算定設定` とする。

## ルート設計

Next.js移行後のルートは以下を基本にする。

| Route | 役割 |
| --- | --- |
| `/` | `/sessions` 相当の算定トップ |
| `/sessions` | 算定一覧 |
| `/sessions/new` | 新しい算定 |
| `/sessions/[sessionId]` | 算定詳細 |
| `/admin` | 設定ホーム |
| `/admin?section=members` | 権限管理 |
| `/admin?section=settings` | 算定設定 |
| `/admin?section=audit` | 操作ログ |
| `/admin?section=account` | アカウント |
| `/api/platform/[...path]` | platform-api proxy |
| `/api/fee/[...path]` | fee-api proxy |

メニュー上は `算定` だけを主導線にする。`算定一覧`、`新しい算定`、`算定詳細` は算定領域内のページ遷移として扱い、ハンバーガーメニューには別項目として増やさない。

## Core Adminとの分担

Core Adminは引き続き病院共通管理の本体として残す。

### Feeアプリ内

- 算定セッション
- 算定条件
- オーダー入力
- 算定候補
- レビュー
- レセプト案
- Fee権限確認
- Fee設定
- Fee操作ログ
- アカウント

### Core Admin

- 職員
- 施設
- 診療科
- 患者
- アプリ利用設定
- 個人情報の依頼
- 共通操作履歴

Feeだけを使うユーザーにもCore Adminが必要になる可能性はあるため、アカウント画面などに `施設管理画面` への導線を置く。ただしFee内にCore Adminのページを複製しない。

## 移行フェーズ

### Phase 0: Next骨格の追加

- `apps/fee-web` に Next.js App Router を追加
- `apps/core-admin` に Next.js App Router を追加
- SOAPと同じ `layout + SiteNav + AdminNavContext` 構造を作る
- Fee用の `算定 / 権限管理 / 算定設定 / 操作ログ / アカウント` を表示できるようにする
- Core Admin用の `職員 / 施設 / 診療科 / 患者 / アプリ利用設定 / 個人情報の依頼 / 操作ログ / アカウント` を表示できるようにする
- API proxyの骨格を追加する
- 現行静的SPAの本番デプロイは切り替えない

Status: 2026-06-03 に着手済み。Fee/Core Adminともに Next.js App Router、SOAP型トップバー、ハンバーガーメニュー、管理ページ骨格、API proxy骨格を追加済み。

### Phase 1: ログイン/セッション移植

- `platform-api` の `/v1/auth/session`、`/v1/auth/login`、`/v1/auth/mfa/verify`、`/v1/auth/logout` をReact化
- SOAPと同じように、ログイン済みリロード時にログイン画面を一瞬表示しない
- アカウント画面に病院コード、個人ID、権限、ログアウトを表示する

Status: 2026-06-03 に着手済み。Fee/Core AdminのNext版に `PlatformAuthProvider` と `AuthGate` を追加し、セッション復元中はログイン画面を表示しない構造にした。ログイン、MFA確認、管理者向けMFA登録、ログアウト、アカウント画面のセッション表示を追加済み。

### Phase 2: Core Admin主要画面の移植

- 職員
- 施設
- 診療科
- 患者
- アプリ利用設定
- 個人情報の依頼
- 操作ログ

現行の `admin-bootstrap` を活かし、初回ロードのファンアウトを増やさない。

Status: 2026-06-03 に完了。Next版Core Adminで `admin-bootstrap` に接続し、職員、施設、診療科、患者、アプリ利用設定、個人情報の依頼、操作ログを表示する。職員/施設/診療科/患者/個人情報依頼の作成、施設/診療科/患者の編集、患者検索、操作ログ検索、職員の2段階認証リセット、個人情報依頼の完了処理、権限制御を移植済み。

### Phase 3: Fee算定一覧/作成/詳細の移植

- 現行HTML内の算定一覧をReactコンポーネント化
- `/sessions/new` で新規算定作成
- `/sessions/[sessionId]` で算定詳細
- `fee-api` の既存エンドポイントを維持する

Status: 2026-06-03 に完了。Next版Feeの `/sessions` で `GET /v1/fee/sessions` に接続し、算定一覧、検索、状態フィルタ、ページングを表示する。新規作成、詳細表示、患者追加、患者/施設/診療科/区分/診療日/請求月/診療テキスト/病名/オーダー/詳細条件/算定オプションの保存、マスター検索、算定候補作成、レビュー更新、レセプト案表示を移植済み。

### Phase 4: Fee管理ページの実装

- 権限管理
- 算定設定
- 操作ログ
- Core Adminへの導線

Status: 2026-06-03 に完了。Fee専用の管理ページとして、診療報酬算定の権限確認、算定設定/対応範囲/マスター検索状態、操作ログ検索、アカウント表示、Core Adminへの導線を実装済み。施設/診療科/患者の共通管理はCore Adminへ残し、Fee側には複製しない。

### Phase 5: Netlifyデプロイ切替

- `config/netlify-sites.json` の `fee-web` を Next デプロイ扱いに変更
- `config/netlify-sites.json` の `core-admin` を Next デプロイ扱いに変更
- Charting用の `p16` と同等の Fee Next デプロイスクリプトを追加
- Charting用の `p16` と同等の Core Admin Next デプロイスクリプトを追加
- STGで動作確認後にPRODへ切替

Status: 2026-06-03 に完了。`config/netlify-sites.json` で `core-admin` と `fee-web` を Next デプロイ扱いに変更し、`scripts/p18_deploy_admin_fee_next_netlify.mjs` を追加済み。STG/PRODともにNext版へ切替済み。

## 検証結果

2026-06-03 時点で以下を実行済み。

- `npm run build --workspace @halunasu/fee-web`
- `npm run build --workspace @halunasu/core-admin`
- `npm run test --workspace @halunasu/fee-web`
- `npm run test --workspace @halunasu/core-admin`
- `npm run build:runtime-apps -- --env all`
- `git diff --check`

FeeのUI smokeはmacOSのChromium起動権限が必要なため、権限付きで再実行して成功した。

## 実装上の注意

- 現行 `index.html` は切替完了まで残す。
- 既存の `fee-api` 契約は変更しない。
- 既存の `platform-api` 契約は変更しない。
- `施設/診療科/患者` の管理ページはFeeに作らない。
- `プロンプト設定` という文言はFeeでは使わない。
- まずはSOAPの構造をコピーし、Fee独自の設計は最小限にする。
- Core AdminはFeeへ取り込まない。病院共通管理の本体としてNext化する。
- Netlify本番切替は、Next版が少なくともログイン、算定一覧、新規作成、算定詳細まで移植されてから行う。
- Core AdminのNetlify本番切替は、ログイン、職員、施設、診療科、患者、アプリ利用設定、操作ログの主要画面が移植されてから行う。
