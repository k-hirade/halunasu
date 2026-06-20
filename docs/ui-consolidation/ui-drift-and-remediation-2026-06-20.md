# 共通UIドリフト調査 & 是正方針 (2026-06-20)

対象アプリ: `fee-web`(診療報酬算定) / `charting-web`(カルテ自動作成) / `referral-web`(紹介状作成) / `core-admin`(施設管理画面)

## 1. 結論
**共有されているのは CSS 1枚(`packages/web-ui/styles/halunasu-ui.css`, 1016行)だけ**。
ログイン画面・サイドナビ・エラー文言ヘルパー・APIプロキシ・runtime設定・brand定義などの
**Reactコンポーネント/ヘルパーは各アプリにコピーされ、各自ドリフト**している。
新アプリを作るたびにコピー → 独自進化、が根本原因。

世代の偏り: **charting が最先端**(共有エラーモジュール・アイコン表示トグル・MFA)、
**referral が最も古い複製**(MFA無し・表示トグル無し・ナビはスタブ)、fee/core が中間。

---

## 2. ログイン画面のドリフト(代表例)

実装の分裂:
| アプリ | ログイン実装 | 行数 |
|---|---|---|
| fee-web | `components/platform-auth.js` | 588 |
| core-admin | `components/platform-auth.js`(fee とほぼ同一・差分18行) | 588 |
| referral-web | `components/platform-auth.js`(機能削減版) | 277 |
| charting-web | 別物 `components/operator-login-panel.js` | 別系統 |
| CSS | `auth.css` が fee 348 / core 330 / referral 319 行でバラバラ。charting は無し | — |

パスワード「表示」トグル(全て同じ `className="password-toggle"` なのに表示物が3通り):
| アプリ | 表示トグル | state名 | 根拠 |
|---|---|---|---|
| fee / core-admin | テキスト「表示 / 非表示」 | `passwordVisible` | platform-auth.js:392-399 |
| referral | **トグル自体が無い**(`<input type="password">` のみ)。なのに auth.css に `.password-toggle` がデッド定義 | — | platform-auth.js:207 |
| charting | 目のアイコン(SVG) | `showPassword` | operator-login-panel.js:282-299 |

その他:
- **MFA(2段階認証)**: fee/core/charting あり、**referral は完全に無し**(機能欠落)。
- **ログインボタン**: fee/core/referral は `<button>ログイン</button>`、charting は `<button><span>ログイン</span></button>`。
- **プレースホルダ**: charting のみ `例: clinic_tokyo_001` 等あり。
- **state命名/コード様式**: `passwordVisible` vs `showPassword`、1行if vs 波括弧if 等。
- 一致点: 説明文「病院コード、個人ID、ログイン用パスワードでログインしてください。」、主ボタン基底クラス `btn btn--primary btn--lg` は共通。

> 制約: charting のログインは **charting-gateway のオペレーター認証**、fee/referral/core は **platform-api 認証**で**認証バックエンドが異なる**。見た目(シェル)は共通化できるが、配線の完全1本化は不可。

---

## 3. ログイン以外の共通UIドリフト
| 共通要素 | 実態 | ドリフト |
|---|---|---|
| エラー文言ヘルパー `toUserFacingErrorMessage` | charting は共有モジュール `lib/user-facing-error.js`(約10コンポーネントが import)。**fee/core/referral は各ファイルにインライン定義**(4箇所以上) | 同関数が複数実装=メッセージ差の温床 |
| サイドナビ `site-nav.js` | fee 189 / charting 306 / core 179 / **referral 28(スタブ)** | 構成も項目も不一致 |
| APIプロキシ `proxy-utils.js` | 4アプリ複製。fee↔charting 10行差 / fee↔core 3行差 / fee↔referral 1行差 | インフラがアプリ毎に微差 |
| `globals.css` | fee 3084 / charting 6821 / referral 570 / core 644 | 共通基底も各自に散在 |
| `brand.js` | fee/referral/core は `PRODUCT_NAME` あり、**charting は構造が違い無し** | モジュールの形すら不一致 |
| `runtime-config.js` | 4アプリ複製(キー名が各自) | 設定取得が分散 |
| `auth.css` | fee 348 / core 330 / referral 319(charting無し) | 同名クラスを別々定義 |

**根本原因**: `@halunasu/web-ui` が CSS のみ共有。Reactコンポーネント/ヘルパー/設定/プロキシは未パッケージ化。

---

## 4. 是正方針の比較
| 方針 | 内容 | 既存への影響 | ドリフト解消 | 工数/リスク | ops新設との相性 |
|---|---|---|---|---|---|
| 1. 完全共通化(一括) | 共有パッケージに抽出し4アプリ一括差し替え | 大 | ◎ | 大・回帰リスク高 | ◎ |
| **2. 段階的共通化(採用)** | ①純粋ヘルパー共有→②referral追いつき→③ログイン/ナビ共有を1アプリずつ移行 | 小→中(可逆) | ○→◎ | 中・低リスク | ◎ |
| 3. referral追いつきのみ | referralにMFA+表示トグル追加 | 小 | △(複製は残る) | 小 | △ |
| 4. 現状維持+ドリフト検出 | 複製一致をテスト監視 | 極小 | ×(悪化防止のみ) | 極小 | △ |

### 採用: 方針2(段階的)＋「ops は最初から共有を使う」
- 「既存を壊さない/責務分離」と最も整合。新規 ops を5個目のコピーにしない。
- 共有の置き場は **`@halunasu/web-ui` を拡張**(CSS専用 → CSS+Reactコンポーネント/ヘルパー)。全アプリが既に依存済み。

---

## 5. 段階計画(各ステップ独立・可逆)
1. **共有ヘルパー抽出(低リスク先行)**: `toUserFacingErrorMessage` / `proxy-utils` / `runtime-config` を `@halunasu/web-ui` へ。charting の `user-facing-error.js` を **正(canonical)** として昇格。各アプリは薄い再エクスポートで段階移行。
2. **referral 追いつき**: ログインに MFA + 表示トグルを追加し fee/core と機能パリティ。
3. **正(canonical)ログイン/ナビ コンポーネントを共有化**(platform-api認証版を基準。charting系はプロップ吸収 or 別系統明示)。表示トグルは **アイコン+aria-label** に統一。
4. **新規 ops-web は 3 をそのまま使用**(コピーしない)。
5. **既存を1アプリずつ移行**: referral → fee → core-admin → charting。各移行後に画面回帰確認。
6. **ドリフト検出テスト追加**(保険): 共有を使わず再コピーした箇所を検知。

### 決定事項
- 表示トグルの正: **アイコン+aria-label(charting準拠)**。
- 共有置き場: **`@halunasu/web-ui` 拡張**。
- referral の MFA/表示トグル追いつきは優先度高(機能欠落)。

---

## 6. 進捗
- [x] 調査・是正方針レポート(本ドキュメント)
- [~] ステップ1: 共有ヘルパー抽出
  - [x] **`toUserFacingErrorMessage` を `@halunasu/web-ui/user-facing-error` に一本化**(canonical = charting版)。テスト3件追加。
        4アプリ(charting/referral/fee/core-admin)を共有importへ移行し、各 `next.config.mjs` に `transpilePackages: ["@halunasu/web-ui"]` を追加。全アプリ `npm run build` 成功。挙動はcanonicalに統一(referral等の欠落ケースも網羅へ改善)。
  - [x] **`proxy-utils.js` を `@halunasu/web-ui/proxy-utils` に一本化**(canonical=fee版, prefix既定"")。charting は `/api/v1` 既定を保つ薄いwrapperに。fee/referral/core は再エクスポート。テスト2件追加。4アプリ build 成功。
  - [x] `runtime-config.js`: **共通化対象外と判断**(各アプリ固有のキー/関数=fee/charting(gateway/billing)/referral/core で別物。ドリフトではなく正当な差)。現状維持。
  - [x] ステップ1 完了
- [x] **ステップ2: referral 追いつき(MFA/表示トグル)**
  - referral-web の platform-auth.js(277行・MFA無し・表示トグル無し)を fee/core 同等の canonical版(569行)へ置換。ブランド訴求文のみ紹介状向けに差し替え(`AuthBrandPanel` props)。
  - 結果: referral も **MFA(2段階認証)+ パスワード表示トグル(表示/非表示)** を獲得。必要CSSは globals/共有halunasu-ui.cssで網羅済み。build成功。
  - exports互換(`PlatformAuthProvider`/`AuthGate`/`usePlatformAuth`/`getStoredPlatformAccessToken`)で referral-workspace/site-nav は無改修。
- [x] **ステップ3: 共有ログイン コンポーネント**
  - `@halunasu/web-ui/platform-auth` に canonical を抽出(Provider/AuthGate/usePlatformAuth/getStoredPlatformAccessToken)。ブランドは `PlatformAuthProvider` の `brand` prop(name/product/login{title,copy,features})で受け取る。
  - **パスワード表示トグルをアイコン+aria-labelに統一**(decided canonical)。
  - fee/referral/core の `components/platform-auth.js` を再エクスポートに、`layout.js` で `brand` を渡し、各 `lib/brand.js` に `BRAND_LOGIN` 追加。3アプリ build成功。
  - ナビ(site-nav)は**メニュー項目がアプリ固有**のため共通化対象外(runtime-configと同様)。referralのスタブ差は将来必要なら個別整備。
  - charting のログインは charting-gateway 認証で別系統のため対象外(操作トグルは既にアイコンで新canonicalと一致)。
- [x] **ステップ4-5: 既存移行 + ops採用**
  - 既存の platform-api 系3アプリ(fee/referral/core)は共有 platform-auth へ移行済み(=ステップ3)。
  - ops(未作成)は新設時に `@halunasu/web-ui/platform-auth` をそのまま採用(コピーしない)。
- [x] **ステップ6: ドリフト検出テスト**
  - `packages/web-ui/test/consolidation-guard.test.js` を追加。①platform-auth が各アプリで再定義されず共有を再エクスポート、②proxy-utils が共有由来(canonical未再定義)、③`toUserFacingErrorMessage` をアプリで再定義していない、を検査。web-ui テスト計8件パス。

## 7. 完了サマリ
共有化(`@halunasu/web-ui`):`user-facing-error` / `proxy-utils` / `platform-auth`(+CSS)。
4アプリ build 成功、web-ui テスト8件パス、ドリフト検出テストで再発防止。
対象外(正当な差): `runtime-config`(各アプリ固有)、`site-nav`(メニュー項目固有)、charting ログイン(別認証系)。

### 実装メモ(ステップ1 第1項)
- 共有JSを Next アプリから import するため、各アプリの `next.config.mjs` に `transpilePackages: ["@halunasu/web-ui"]` が必要(charting は既存の `@medical/contracts` に追記)。
- `@halunasu/web-ui` の `exports` に `"./user-facing-error"` を追加、`files` に `src` を追加。
- charting の `lib/user-facing-error.js` は共有への薄い再エクスポートに変更(既存 import パス互換)。
