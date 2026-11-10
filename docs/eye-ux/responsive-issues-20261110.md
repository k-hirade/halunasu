# 眼科カルテ（apps/eye-web）レスポンシブ不具合一覧（2026-11-10）

全画面・主要な状態を 12 の画面幅で撮影し、自動の検出器と目視で確認した結果です。この文書では修正はせず、一覧だけをまとめます。修正は次の段階で、領域（A〜D）ごとに並行して行います。

## 調べ方

- 実行したコマンド: `node scripts/ui-audit.mjs --viewports responsive --dark-viewports 1366x768,390x844 --no-full --concurrency 5 --out <dir>`
  - 撮影したのは 130 状態 × 12 幅で、合計 1,410 枚です。
  - 暗室表示は 1366x768 と 390x844 だけで撮りました。
- 画面幅（12）と端末の扱い
  - PC（タッチなし）: 1920x1080、1440x900、1366x768、1280x800、1024x768
  - タブレット（タッチあり）: 1024x1366、820x1180、768x1024
  - スマホ（タッチ＋モバイル表示）: 430x932、390x844、360x740
  - スマホ横: 844x390
- 検出器（`scripts/ui-audit-metrics.js` の `responsive`）は、次の指摘を要素ごとに出します。各指摘には選択子・位置・大きさ・理由が付きます。
  - 画面外へのはみ出し
  - overflow hidden による切れ
  - 隣の要素へのはみ出し
  - スクロールできない枠（fixed・ダイアログ・メニューで、下端が画面外にあるもの）
  - 覆われた操作、またはスクロールしても届かない操作
  - 小さいタップ領域（32px 未満）と小さい文字（11px 未満）
  - 文字の重なり
  - 省略記号で切れているのに、全文を見る手段（title）がない文字
- 目視は、全状態について 1366x768・1024x768・768x1024・390x844・844x390 の撮影結果を見ました。主要な状態は残りの幅も見ています。
- スクショの置き場所（リポジトリには入れていません）: `/private/tmp/claude-502/-Users-hiradekeishi-medical-ai-halunasu/9b17e973-ca9a-47f5-b119-7c87aada937c/scratchpad/responsive-20261110/`
  - ファイル名は `<状態>-<幅>x<高さ>.png` です。
  - 同じ場所に、`responsive.json`（要素ごとの指摘）、`responsive-summary.txt`（状態 × 幅ごとの件数）、`digest.txt`（同じ要素の指摘を幅ごとにまとめたもの）があります。
- 重大度の基準
  - **致命的**: 操作できない、または見えない。
  - **重要**: 明らかに崩れている、または使いにくいが、操作はできる。
  - **軽微**: 見た目の問題。

### 撮れなかったもの・注意

- ネイティブの `<select>`（受付ステータス・医師・目的など）は、開いた状態を撮れません。展開後の表示は確認していません。
- login-totp（2 段階認証の入力）のスマホ 4 幅は、撮影中にログインの試行回数制限（「短時間に操作が続いています」）に当たったため撮れていません。password-error の 768x1024 と 390x844 も、制限の表示が出た状態で撮られています。
- images-ou の 768x1024 だけ、右眼の面が「表示するファイルを選んでください」になっていました。撮影時の読み込みの順番による可能性があるので、再現するか確認が必要です。

## 件数

| 領域 | 致命的 | 重要 | 軽微 | 計 |
| --- | ---: | ---: | ---: | ---: |
| (A) 受付・予約・検索・登録・ヘッダー・ログイン・パスワード | 1 | 7 | 9 | 17 |
| (B) カルテ編集（全タブ・ダイアログ・右パネル） | 1 | 13 | 9 | 23 |
| (C) 検査入力・診察・患者ページ・画像比較 | 2 | 7 | 12 | 21 |
| (D) 会計連携・文書・印刷・設定 | 1 | 7 | 13 | 21 |
| 計 | 5 | 34 | 43 | 82 |

## 共通の原因（複数の領域にまたがるもの）

修正の担当が重ならないよう、先に共通の部分を直すことをおすすめします。

1. **ダイアログに高さの上限がない**（A-1、B-1、C-19）
   - `.dialog` に `max-height` も `overflow` も指定されていません。`.dialog-backdrop` は `align-items:center` の fixed 枠です（app/globals.css 921〜949 行）。
   - このため、画面より高いダイアログは上下の両方にはみ出し、ボタンに届かなくなります。
   - 共通の修正案:
     - `.dialog{max-height:calc(100dvh - 32px);overflow-y:auto}`
     - `.dialog-backdrop{align-items:safe center;overflow-y:auto}`
     - `.dialog-actions{position:sticky;bottom:0;background:var(--surface);flex-wrap:wrap}`
2. **ラジオボタンが幅 100% になる**（B-1、B-9）
   - 共有の CSS（packages/web-ui/styles/halunasu-ui.css）の `input{width:100%}` がラジオボタンにも効いています。そのため、ラベルが 1〜2 字ずつ縦に折り返します。
   - checkbox だけは chart-editor.css の 2120 行で打ち消し済みです。
   - 修正案: 同じ打ち消しに `input[type="radio"]` を加え、`flex:0 0 auto;width:auto` にする。
3. **下の固定バーの分の下余白が足りない**（B-12、C-1）
   - 固定バーの高さは段数で変わります。それに対して、下の余白が固定値で、しかも足りていません。
   - 修正案: ResizeObserver でバーの実際の高さを CSS 変数（`--actionbar-h` / `--exam-bar-h`）に入れ、`padding-bottom` に使う。
4. **ポップオーバーが、親のスクロール枠の端や画面の端で切れる**（A-2、B-6、B-7、B-8、C-2、D-2）
   - 修正案: 開くときに位置を測り、上向き・左寄せ・右寄せを切り替える。exam.css の `.more-menu.is-up` と同じ仕組みを共通化する。
5. **横向きスマホ（高さ 390px）で、固定の帯が高さを奪う**（A-17、B-11、C-4、D-13）
   - 修正案: `@media (max-height:500px)` で、患者バナー・操作バー・見出しを 1 段に詰める。
6. **タッチ端末のタップ領域が 32px 未満**（A-12、B-14、C-21、D-21）
   - 修正案: `@media (pointer:coarse)` で、チップ・summary・小さい入力欄を `min-height:36〜40px` にする。

---

## (A) 受付・予約・検索・登録・ヘッダー・ログイン・パスワード

- **A-1 [致命的] パスワード変更ダイアログ**（password / password-error / password-empty）
  - 画面幅: 844x390。ソフトキーボードが出たスマホ縦でも同じことが起きる見込みです。
  - 問題: ダイアログの下端が 418〜457px で、画面の高さ 390px を超えます。上では見出しの「パスワード変更」が切れ、エラーが出ると「キャンセル」「変更する」が画面外に出ます。背景もダイアログもスクロールできないので、ボタンを押せません。ショートカットのヘルプ（`.dialog.eh-help`）も同じ作りで、844x390 ではぎりぎり収まっているだけです。
  - 要素: `div.dialog-backdrop > div.dialog.pw-dialog`（app/styles/nav.css 231 行、components/password-change-dialog.js）
  - スクショ: password-error-844x390.png
  - 修正案: 上の「共通の原因 1」と同じです。

- **A-2 [重要] 受付一覧の行メニュー「…」**（reception-rowmenu）
  - 画面幅: すべての幅
  - 問題: 開いたメニューの項目（患者のページ・検査入力・受付を編集…）が縦に並ばず、横一列になります。2 つ目以降は表の枠の右端で切れ、1366 では x≈1336 より右が見えません。原因は、`td{white-space:nowrap}` が `.more-menu-list` 内のボタンにも継承されていることです。
  - 要素: `td.rc-col-actions details.more-menu > .more-menu-list`（reception.css 469〜484 行、components/reception-workspace.js 430 行）
  - スクショ: reception-rowmenu-1366x768.png
  - 修正案: `.rc-col-actions .more-menu-list{display:grid;gap:4px;white-space:normal}` にする。最下段の行では上向きに開く。

- **A-3 [重要] 受付一覧の表の列あふれ**（reception）
  - 画面幅: 1920〜360 のすべて
  - 問題: 列が多すぎて、主な操作が最初の表示で見えません。
    - 1920 でも、最後の列の「…」が右端で約 15px 切れています。
    - 1280・1366 では「会計・進捗・予約・…」が、1024・768 では目的の列より右がすべて、表の枠の外にあります。
    - 横にスクロールすると、番号・氏名・ステータスが固定されていないので左に消え、誰の行か分からなくなります。
    - タッチ端末ではスクロールバーが出ないので、横にスクロールできることにも気づけません。
    - 横幅が広がる主な原因は、進捗のチップが折り返さないことです（`.rc-progress{flex-wrap:nowrap}`）。
  - 要素: `.rc-table-wrap` / `.rc-table` / `.rc-progress`（reception.css 287〜303 行、409 行）
  - スクショ: reception-1366x768.png（あわせて reception-1920x1080.png、reception-rowmenu-768x1024.png）
  - 修正案:
    - 氏名の列を `position:sticky;left:0`、操作の列を `position:sticky;right:0` で固定する。
    - `.rc-progress{flex-wrap:wrap;max-width:18em}` にする。
    - 1100px 未満では、診療科・医師・患者メモの列を既定で隠す。
    - 右端に影を付けて、横に続きがあることを示す。

- **A-4 [重要] 受付一覧のスマホ表示**（reception）
  - 画面幅: 430、390、360
  - 問題: スマホでも PC 用の表のままで、画面に入るのは「番号・予約時間・ステータス・氏名」の 4 列だけです。会計・予約・行メニューを押すには、1 行ずつ横に大きくスクロールする必要があります。768px 未満では表の枠に max-height がないため、見出しの行の sticky も効かず、縦にスクロールすると見出しが流れていきます。
  - 要素: `.rc-table`（reception.css 287〜330 行）
  - スクショ: reception-390x844.png
  - 修正案: 患者検索のカード表示（reception.css 1158 行〜 の `.ps-table`）と同じやり方で、720px 以下は 1 人 1 枚のカードにする。

- **A-5 [重要] 患者検索モーダルの結果の行**（reception-search / reception-search-results / search）
  - 画面幅: 768x1024、820x1180、844x390（721〜1024px）
  - 問題: 行の「表示・編集・受付・予約」のボタンが縦に 4 段積みになり、1 行が約 187px の高さになります（844x390 では 1 人しか見えません）。最近の患者の一覧では、ボタンが右端で半分切れます。原因はクラス名の衝突です。consult.css の `.ps-actions{display:flex;flex-wrap:wrap}`（カルテ概要パネル用）が、検索モーダルの `td.ps-actions` にも当たっています。
  - 要素: `td.ps-actions`（consult.css 427 行と reception.css 974〜981 行、components/patient-search-modal.js 206 行、patient-summary-pane.js 37 行）
  - スクショ: reception-search-768x1024.png
  - 修正案: consult.css 側を `.ps-summary .ps-actions` のように限定するか、クラス名を変える。検索側は `td.ps-actions{display:table-cell;white-space:nowrap}` にする。

- **A-6 [重要] 新規患者登録ダイアログ**（reception-register / register）
  - 画面幅: 1366x768、1280x800、1024x768、844x390、390x844、360x740
  - 問題: 高さが 768px の画面では、「キャンセル／登録／登録して受付」がダイアログの下端（y≈752）で上半分しか見えません。スマホでは電話番号 1 の途中までしか見えず、ボタンがあること自体に気づけません。ダイアログの中をスクロールすれば届きます。住所の placeholder も「郵便番号（ハイフ」で切れています（768 以下）。
  - 要素: `.dialog.register-dialog`（nav.css 476 行）、`.dialog-actions`（components/patient-register-dialog.js 307 行）
  - スクショ: reception-register-1366x768.png
  - 修正案: `.register-dialog > .dialog-actions{position:sticky;bottom:-22px;background:var(--surface);border-top:1px solid var(--line)}` にする。placeholder は「郵便番号」に短くする。

- **A-7 [重要] 予約登録・当日受付のダイアログ**（reception-booking / reception-add-booking / reception-walkin）
  - 画面幅: 390x844、360x740、844x390
  - 問題: スマホでは予約一覧が下に回り（`order:2`）、その下の「キャンセル」「登録」が画面外になります。844x390 では予約時間の欄で切れます。ダイアログの中をスクロールすれば届きます。患者欄の placeholder「氏名・カナ・患者番号で検索（未登録なら氏名を入力）」は、1366 でも切れています。
  - 要素: `.dialog.ap-dialog`（reception.css 496 行）、`.ap-list{order:2}`（658 行）、components/appointment-dialog.js 293 行
  - スクショ: reception-booking-390x844.png
  - 修正案: ボタンの行を sticky で下に固定する。スマホでは予約一覧を折りたたみにする。placeholder は「氏名・カナ・患者番号」に短くし、補足は欄の下に出す。

- **A-8 [重要] 予約登録の「予約状況」カレンダー**（reception-booking-calendar）
  - 画面幅: すべての幅
  - 問題: スクロールが 2 重になっていて、狭い枠に押し込まれています。`.ap-calendar` は `position:absolute;inset:0` でダイアログの高さに縛られ、その中の週の表も `max-height:60dvh` で別にスクロールします。
    - 1366x768: 週の表が 16:00 で切れ、その下に約 160px の空白があります。
    - 1024x768 / 768x1024: 週の表は 12〜13 時あたりでダイアログの下端に切られます。768x1024 では画面の下に約 150px 余っています。
    - 390x844: 4 時間分しか見えず、横にもスクロールが要ります。
    - 844x390: 週の表は完全に画面の外です。
  - 要素: `.dialog.ap-dialog.is-calendar`（reception.css 601 行）、`.ap-calendar`（612 行）、`.ap-calendar .bk-grid-scroll`（802 行）、`.bk-cal`（1080 行）
  - スクショ: reception-booking-calendar-1024x768.png
  - 修正案: カレンダーを出している間はダイアログを `height:calc(100dvh - 32px)` にする。grid の `1fr` を使い、スクロールを週の表の 1 か所だけにする。1100px 以下では月のカレンダーを折りたたみにする。

- **A-9 [軽微] 予約状況のページ**（reception-schedule）
  - 画面幅: 1024x768、768x1024、844x390、390x844
  - 問題: 1100px 以下では月のカレンダーの下に週の表が来ます。そのため 1024x768 で最初に見えるのは 8〜13 時だけで、右側には約 600×250px の空白が残ります。844x390 では週の表が見えません。
  - 要素: `.bk-cal` / `.bk-cal-side`（reception.css 1080〜1093 行）
  - スクショ: reception-schedule-1024x768.png
  - 修正案: 2 列にするしきい値を 900px に下げる。または、月のカレンダーと医師の選択を横に並べる。

- **A-10 [軽微] 絞り込みのパネル**（reception-filter）
  - 画面幅: 1024x768、844x390、390x844、360x740
  - 問題: 背景を暗くしないので、パネルの範囲が分かりません。患者メモ・受付メモの欄と「閉じる」が下端より外にあります。1024 では医師の列の下が空白です。
  - 要素: `.rc-popover.rc-filter`（reception.css 1103〜1112 行）
  - スクショ: reception-filter-1024x768.png
  - 修正案: 「閉じる」を右上に移す（または sticky で下に固定する）。半透明の背景を付け、外を押すと閉じるようにする。

- **A-11 [軽微] 受付一覧の表の高さ（横向きスマホ）**（reception）
  - 画面幅: 844x390
  - 問題: `max-height:calc(100dvh - var(--nav-h) - 96px)` のため、表の枠が約 254px（4.5 行分）になり、枠の中だけでスクロールします。
  - 要素: `.rc-table-wrap`（reception.css 294 行）
  - スクショ: reception-844x390.png
  - 修正案: 条件を `(min-width:768px) and (min-height:600px)` にする。

- **A-12 [軽微] 受付まわりのタップ領域**（reception 系の全状態）
  - 画面幅: タッチ端末のすべての幅
  - 問題: 次の部品が 32px 未満です。
    - `select.rc-status`: 高さ 30px
    - `button.bk-slot`: 72×24px
    - 月・週の ‹ › ボタン: 28×40px
    - `a.eh-brand`: 24px
    - 検索の × ボタン: 31×40px
  - 要素: reception.css 192 行ほか
  - スクショ: reception-390x844.png
  - 修正案: `@media (pointer:coarse)` で、高さか幅を 40px 以上にする。

- **A-13 [軽微] 予約件数の小さい文字**（reception-booking-calendar / reception-schedule）
  - 画面幅: すべての幅
  - 問題: `.mcal-count`（「11件」）が 10px、`.bk-day-head small`（「(日)」）が 10.8px です。選んでいる日（緑の地に白い文字）は特に読みにくいです。
  - 要素: reception.css 739 行
  - スクショ: reception-schedule-1366x768.png
  - 修正案: `font-size:var(--fs-xs)` にする。

- **A-14 [軽微] 患者検索のスマホのカード**（reception-search / search）
  - 画面幅: 430、390、360
  - 問題: 選んだ行の背景が td ごとに塗られるため、縞模様になります。名前がカードの 3 段目に来ます。空の「患者メモ」のラベルも表示されます。
  - 要素: `.ps-table tr / td`（reception.css 1158〜1200 行）
  - スクショ: reception-search-390x844.png
  - 修正案: 選択の背景は `tr` に付ける。`td.ps-name{order:-1}` にする。空の td は出さない。

- **A-15 [軽微] 入力中に患者検索モーダルが動く**（reception-search → reception-search-results）
  - 画面幅: 1366、1024、768、844x390
  - 問題: 結果の件数が変わると、ダイアログが上下中央に置き直されます。そのため、入力欄が約 200px 跳びます。
  - 要素: `.dialog-backdrop{align-items:center}` と `.dialog.ps-dialog`
  - スクショ: reception-search-results-1366x768.png
  - 修正案: 検索モーダルだけ `align-items:flex-start;padding-top:min(8vh,64px)` にする。

- **A-16 [軽微] ショートカットのヘルプ**（header-help）
  - 画面幅: 390x844、360x740
  - 問題: 「…ショートカット一覧」の「覧」だけが次の行に回ります。また、キーボードのないスマホにキーボードのショートカットを出しています。
  - 要素: `.dialog.eh-help`（nav.css 308 行）
  - スクショ: header-help-390x844.png
  - 修正案: キーの列を `grid-template-columns:auto 1fr` にする。`(pointer:coarse)` ではスマホ向けの案内に替える。

- **A-17 [軽微] ログイン（横向きスマホ）**（login）
  - 画面幅: 844x390
  - 問題: 上の帯（約 134px）が場所を取り、フォームは病院コードまでしか見えません。ログインボタンはスクロールしないと出てきません。
  - 要素: ログイン画面の上の帯
  - スクショ: login-844x390.png
  - 修正案: `@media (max-height:500px)` でキャッチコピーを隠し、帯の高さを約 56px にする。

（暗室表示の header-dark・password-dark・reception-dark・reception-booking-calendar-dark では、暗室表示に固有の崩れはありませんでした。）

---

## (B) カルテ編集（全タブ・ダイアログ・右パネル）

- **B-1 [致命的] 患者ステータス選択のダイアログ**（editor-status。→次へで出るダイアログ）
  - 画面幅: すべての幅。一番ひどいのは 844x390、次が 360x740・390・430 です。
  - 問題:
    - ラジオボタンが行の中央に置かれ、ラベルが右端で 1〜2 字ずつ縦に折り返します（「予約/済」「受付/中」）。1 項目が約 60px になり、ダイアログがとても縦長になります（共通の原因 2）。
    - 844x390 では、ダイアログの上端が -159px です。「決定」「キャンセル」「確定のみ」が画面外にあり、スクロールしても届かないので操作できません（共通の原因 1）。
    - 360x740 では下端（756px）が切れます。
    - 360〜430 の幅では `.dialog-actions` が折り返さないため、「確定のみ（受付は変えない）」が左に -12〜-36px はみ出して「定のみ（…）」と欠けます。
  - 要素: `.status-next label.check-line > input[type=radio]`、`.dialog`、`.dialog-actions`（globals.css 921〜949 行、components/encounter-dialogs.js 129 行）
  - スクショ: editor-status-844x390.png（あわせて editor-status-390x844.png）
  - 修正案: 共通の原因 1・2 を直す。`.dialog-actions{flex-wrap:wrap}` にし、狭い幅では左のボタンを 1 行使って置く。次のステータスは 2〜3 列の grid にする。

- **B-2 [重要] アレルギーのバッジから開く編集ダイアログ**（editor-allergy）
  - 画面幅: すべての幅
  - 問題: ダイアログが、ほかの要素より奥に表示されます。
    - すべての幅で、ダイアログの上端がアプリのヘッダーの下に潜り、見出しが隠れます。ヘッダーは暗くならずに手前に残ります。
    - 430・390・360 では、画面下の操作帯（保存・印刷・→次へ）がダイアログの上に重なり、「キャンセル」「保存」が隠れます。
    - 原因は、ダイアログが sticky の `.chart-topbar`（z-index:20 で重なり順の文脈を作る）の中に描かれていることです。
  - 要素: components/patient-banner.js 110 行の `.dialog-backdrop`、chart-editor.css 1820 行
  - スクショ: editor-allergy-390x844.png（あわせて editor-allergy-1366x768.png）
  - 修正案: `createPortal(…, document.body)` で body の直下に描く。または、editor-profile と同じ ProfileDialog を使う。

- **B-3 [重要] 右の「オーダー」引き出しの見出しとカテゴリが消える**（editor-set-panel / -side / -order-exam / -order-phrase / -order-all）
  - 画面幅: 1279px 以下で引き出しになるすべての幅。844x390 では常に起き、1024x768 と 390x844 では一覧が長い状態で起きます。
  - 問題: 引き出しは `.chart-right` 全体でスクロールします。そのため、カテゴリを選んだりスクロールしたりすると、見出し（オーダー・閉じる）とカテゴリの 1〜2 段目がアプリのヘッダーの直下に隠れます。844x390 では、「閉じる」は下端の数 px しか見えません。
  - 要素: `.chart-right > .pane-head.drawer-only`、`.order-cats`（encounter-editor.js 545 行、chart-editor.css 1420 行）
  - スクショ: editor-order-phrase-844x390.png（あわせて editor-set-panel-844x390.png）
  - 修正案: 引き出しを「見出し＋カテゴリ＋検索（固定）」と「一覧（overflow-y:auto）」の縦の flex にする。または、見出しから検索までを sticky にする。

- **B-4 [重要] 左の「患者の情報」引き出しの見出しが流れる**（editor-tab-exam / editor-tab-historylist ほか）
  - 画面幅: 767px 以下（430、390、360）
  - 問題: スクロールすると「患者の情報／閉じる」が一緒に流れて消えます。sticky なのはタブだけです。キーワードの入力欄の上半分も、タブの下に隠れます。
  - 要素: `.chart-left > .pane-head.drawer-only`、`.chart-left .pane-tabs`（chart-editor.css 104 行）
  - スクショ: editor-tab-historylist-390x844.png
  - 修正案: 見出しとタブを 1 つの sticky のかたまりにする。

- **B-5 [重要] 左のペインの診療履歴カードが 1 字ずつ折り返す**（editor / editor-tab-historylist / editor-tab-exam / header-editor）
  - 画面幅: 768〜1279px（1024x768、1024x1366、820x1180、768x1024、844x390）
  - 問題: 左のペインは約 250〜340px しかないのに、履歴カードが「主訴・所見｜処置・行為」の 2 列のままです。所見の値が 1 字ずつ縦に並び（「前/房/清/明…」）、読めません。1024 では検査の表の値が 2〜4 行に折り返します。
  - 要素: `.history-cols`、`.history-finding`（chart-editor.css 211、262、1887 行）
  - スクショ: editor-768x1024.png（あわせて header-editor-768x1024.png）
  - 修正案: `.chart-left{container-type:inline-size}` にし、`@container (max-width:440px)` で `.history-cols` を 1 列、`.history-finding` を 1 列にする。

- **B-6 [重要] 用法のポップオーバーと Rp のメニュー**（editor-rp / editor-rp-menu）
  - 画面幅: すべての幅。ひどいのは 1024x768、844x390、768、390 です。
  - 問題:
    - 中央のペイン（overflow-y:auto）の中に、absolute で下向きに開きます。そのため下端で切れます。1024x768 と 844x390 の用法メニューは「1回」しか見えません。1024x768 の rp-menu では「この薬を削除」が操作帯の裏に隠れます。
    - 1366x768 では、用法メニューが中央のペインの右端を越えて切れます。
    - `.more-menu-list .btn{width:100%}` が回数のチップにも効き、1回〜6回が 1 行ずつ縦に並びます。
  - 要素: `details.usage-menu > .more-menu-list.usage-list`、`details.rp-badge-menu > .more-menu-list`（components/chart-rp.js 129、296 行、chart-editor.css 1141、1331 行）
  - スクショ: editor-rp-1024x768.png
  - 修正案: `.usage-list .btn.btn-chip{width:auto}` にする。下に空きがなければ上向きに開き、右端に近ければ右寄せにする（共通の原因 4）。

- **B-7 [重要] 操作帯の「…」メニュー**（editor-more）
  - 画面幅: 1279px 以下のすべての幅
  - 問題: メニューが `right:0` を基準に左へ開くため、左端の「…」から画面の左外へ 46px はみ出します。「下書きを破棄」が「書きを破棄」と欠けます。
  - 要素: `.chart-actionbar .actionbar-more .more-menu-list`
  - スクショ: editor-more-1024x768.png
  - 修正案: `left:0;right:auto` にする。

- **B-8 [重要] 印刷メニュー**（editor-print-menu）
  - 画面幅: 390、360
  - 問題: スマホでは印刷のボタンが左寄りにあるのに、メニューは `right:0` で開きます。左外へ 32px はみ出し、「カルテ（2 号紙）」が切れます。
  - 要素: `.actionbar-print .more-menu-list`（chart-editor.css 1654 行）
  - スクショ: editor-print-menu-390x844.png
  - 修正案: 767px 以下では `left:0;right:auto` にする。

- **B-9 [重要] 傷病名の編集の転帰ラジオ**（editor-dx-edit）
  - 画面幅: すべての幅
  - 問題: 「継/続」「治/癒」「移行/（転/医）」「そ/の/他」と 1〜2 字ずつ縦に折り返し、2 行に散らばります（共通の原因 2）。
  - 要素: `.dx-outcomes label.check-line > input[type=radio]`（chart-diagnoses.js 313 行）
  - スクショ: editor-dx-edit-1366x768.png
  - 修正案: 共通の原因 2 を直す。

- **B-10 [重要] 病名の表と薬歴の表の右側が見えない**（editor-history / editor-tab-drugs）
  - 画面幅: 1366（病名の転帰の列）、1024、768、844、390
  - 問題: 表は横にスクロールできますが、続きがあることが分かりません。
    - 病名の表: 1366 では転帰の列が欠けます。1024 では開始日が「2026/09」で切れ、390 では日付が見えません。
    - 薬歴の表: 768 と 844 で、最新の月の列が見えません。
  - 要素: `.table-scroll > table.dx-table`、`table.drug-matrix`（chart-editor.css 362、456 行）
  - スクショ: editor-history-768x1024.png
  - 修正案: 狭い幅では、主病・疑いをバッジにして傷病名のセルに入れ、列を減らす。薬歴は最新の月を右に sticky で固定し、右端に影を付ける。

- **B-11 [重要] 横向きスマホのカルテ全体**（editor ほか全状態）
  - 画面幅: 844x390
  - 問題: 幅が 768 以上なので、「ページはスクロールせず、ペインの中だけスクロールする」3 ペインのままです。ヘッダー（40px）、患者バナー（約 90px）、操作帯（約 55px）を除くと、各ペインの表示域は約 140px しかありません。中央のペインには検査の帯の見出ししか入りません。ダイアログ（病名・セット登録・予約・既往・ショートカット）は、保存や閉じるのボタンが最初は画面外にあります。シェーマのキャンバスが画面の大半を占め、ダイアログをスクロールしにくくなります。
  - 要素: `.chart-page`（height:calc(100dvh - var(--nav-h));overflow:hidden）、`.chart-shell`（chart-editor.css 7、47 行）
  - スクショ: editor-844x390.png
  - 修正案: `@media (max-height:500px)` で、767px 以下と同じ「ページ全体をスクロールし、左右は引き出しにする」配置に切り替える。バナーは 1 行にする。シェーマのキャンバスは `max-height:calc(100dvh - 180px)` にする。

- **B-12 [重要] スマホで一番下の操作が操作帯に隠れる**（editor-bottom）
  - 画面幅: 390、360（430 も少し）
  - 問題: 下の操作帯は 2 段（約 100〜110px）なのに、`.chart-page` の下の余白は 72px です。一番下までスクロールしても「検査・処置を選ぶ」の下半分と「予定に追加」が帯の裏に隠れます。上には sticky の患者バナー（約 135px）も残り、表示域の約 3 割を上下の帯が占めます。
  - 要素: `.chart-page{padding-bottom:calc(72px + …)}`、`.chart-actionbar`、`.encounter-bar.chart-topbar`（chart-editor.css 1813〜1830、1879 行）
  - スクショ: editor-bottom-390x844.png
  - 修正案: 共通の原因 3 を直す。操作帯は 1 段にする（送信を「…」の中に移す）。バナーを詰める。

- **B-13 [重要] 中央の「処置・行為」の列が狭い**（editor）
  - 画面幅: 1024x768、1024x1366、1280x800（1440 も少し）
  - 問題: 中央を 2 列のままにするしきい値（`@container (max-width:600px)`）が低いため、処置・行為の列が約 320px になります。Rp のカードでは、薬剤名が 3 行に折れ、「×」が 1 行を占め、「継続」が次の行に落ちます。
  - 要素: `.chart-columns`、chart-editor.css 83 行の `@container`、`.rp-row`、`.rp-foot`
  - スクショ: editor-1024x1366.png
  - 修正案: しきい値を約 720px に上げる。または、Rp の行を grid にして 2 段に固定する。

- **B-14 [重要] カルテのタップ領域**（全状態）
  - 画面幅: 1024 以下のタッチ端末のすべての幅（32px 未満が 54〜80 個）
  - 問題: 主な例は次のとおりです。
    - `summary.rp-badge`（点眼▾）: 40×20px
    - R/L/両: 30×30px
    - `.btn-chip`（散瞳なし・検査入力を開く・R確認・予定のプリセット）: 28px
    - Rp の数量・単位・日数・院内外・用法: 30px
    - `.col-tool`（A−・A＋・🗑）: 30px
    - 既往の編集（link-button）: 26×24px
  - 要素: chart-editor.css の `.btn-chip` / `.rp-badge` / `.col-tool` / `.segmented`
  - スクショ: editor-rp-menu-390x844.png
  - 修正案: `@media (pointer:coarse)` で `min-height:36〜40px` にする。

- **B-15 [軽微] 患者情報タブのアレルギーのバッジ**（editor-tab-info）
  - 画面幅: 1024、768、844、390
  - 問題: 赤い背景のバッジが途中で改行し、背景が段違いになります。
  - 要素: `.allergy-badge`
  - スクショ: editor-tab-info-1024x768.png
  - 修正案: `display:inline-flex;flex-wrap:wrap` にするか、`box-decoration-break:clone` を付ける。

- **B-16 [軽微] 左のペインのタブが 2 段になる**（editor-tab-*）
  - 画面幅: 768〜1279、844、390
  - 問題: 2 段目に「病名」（768・844 では「ファイル」も）だけが残り、表示域が約 36px 減ります。
  - 要素: `.chart-left .pane-tabs`
  - スクショ: editor-tab-files-1024x768.png
  - 修正案: 1 行の横スクロールにするか、余白を詰めて 1 段に収める。

- **B-17 [軽微] 検査の帯の記録者で折り返す**（editor / header-editor）
  - 画面幅: 1920、1440、1366、1280、844
  - 問題: 「NCT 20:59 院長（管理者・医」で折れ、「師）」だけが次の行に残ります。RV の「Ax180°）」も単独で次の行に落ちます。
  - 要素: `.exam-block-label .exam-block-stamp`（chart-editor.css 838〜846 行）
  - スクショ: editor-1366x768.png
  - 修正案: `white-space:nowrap` に省略記号と title を付ける。または、記録者を別の行に出す。

- **B-18 [軽微] 省略された文字に全文を見る手段がない**（editor-tab-drugs / editor）
  - 画面幅: 1440 以下のほぼすべての幅
  - 問題: 薬歴の薬剤名と主訴欄の「既往」の行が … で切れますが、title がありません。
  - 要素: `.drug-matrix tbody th`、`.history-line-text`
  - スクショ: editor-tab-drugs-768x1024.png
  - 修正案: title に全文を入れる。

- **B-19 [軽微] 病名の新規登録の候補の行**（editor-dx-add）
  - 画面幅: 390、360
  - 問題: 名前の長さによって、確定・主病・疑いのボタンが同じ行に並ぶ候補と、次の行に落ちる候補が混ざり、ボタンの位置がそろいません。
  - 要素: 病名追加ダイアログの候補の行
  - スクショ: editor-dx-add-390x844.png
  - 修正案: 狭い幅では、常に「名前」と「ボタン 3 つ」の 2 段にそろえる。

- **B-20 [軽微] 警告一覧**（editor-next）
  - 画面幅: 390、844x390
  - 問題: 「確認して次へ」に autoFocus があるため、ダイアログが一番下までスクロールした状態で開きます。見出しと表の先頭が見えません。390 では表の文字が「検/査/値」と折れます。
  - 要素: 警告一覧のダイアログ、`.warnings-table`
  - スクショ: editor-next-390x844.png
  - 修正案: 最初のフォーカスを見出し（tabIndex=-1）にする。狭い幅では 2 列の表にする。

- **B-21 [軽微] ファイルタブの文書の行**（editor-tab-files）
  - 画面幅: 768
  - 問題: 「診療情報提供書 紹介 / 状」と種類が途中で折れます。「下書き」と「編集」が縦に並び、行が高くなります。
  - 要素: `td.docs-title > span.docs-type`
  - スクショ: editor-tab-files-768x1024.png
  - 修正案: `.docs-type{white-space:nowrap}` にし、2 段に配置する。

- **B-22 [軽微] 3 ペインのときの右のペインの幅**（editor）
  - 画面幅: 1280、1366、1440
  - 問題: 右のペインが約 250〜280px なので、学習リストの薬剤名が「…0.5% 2 / 本」と割れます。1280 では検索欄の placeholder が切れます。
  - 要素: `.chart-right` の一覧と検索欄
  - スクショ: editor-1280x800.png
  - 修正案: 右の列を `minmax(280px, 20fr)` にする。placeholder は「投薬を検索」に短くする。

- **B-23 [軽微・要確認] スマホで一番下まで送ったときに固定の帯がずれる**（editor-bottom）
  - 画面幅: 360、390、430
  - 問題: ヘッダーと操作帯が 19〜32px 下にずれて写り、操作帯の 2 段目の下が切れています。撮影のスクリプトが html・body・main の scrollTop をまとめて最大にしたことが原因の可能性もあります。
  - 要素: `.eh`、`.chart-actionbar`
  - スクショ: editor-bottom-360x740.png
  - 修正案: iOS Safari と Android Chrome の実機で確かめる。再現すれば、html と body が 2 重にスクロールしていないかを確認する。

（暗室表示、版履歴、カルテ更新、シェーマの選択、ショートカット、予約、セット登録は、844x390 でダイアログの中をスクロールする必要があること（B-11）のほかは問題ありませんでした。）

---

## (C) 検査入力・診察・患者ページ・画像比較

- **C-1 [致命的] 検査入力: 下の固定バーに申し送りのチップが隠れて押せない**（exam、exam-iop〜exam-other、exam-bottom、exam-checklist）
  - 画面幅: 1023px 以下のすべての幅（820x1180、768x1024、430、390、360、844x390）
  - 問題: 一番下までスクロールしても、「医師への申し送り」のチップ（眼鏡持参なし・CL装用中・固視不良・測定困難・再検希望）が固定バー「検査の操作」の下に隠れ、押せません。
    - 原因は CSS の読み込み順です。exam.css は globals.css の先頭で @import されています。後に書かれた globals.css 219 行の `.eye-page{padding:20px 20px 64px}`（720px 以下では 995 行で 48px）が、同じ詳細度の `.rd-page{padding-bottom:150px}`（exam.css 1266 行）を上書きしています。
    - 実際の下余白は 64px か 48px しかないのに、バーは 2〜3 段で 115〜170px あります。
  - 要素: `main.eye-page.exam-workbench.rd-page`、`div.exam-bar.rd-bar`
  - スクショ: exam-bottom-768x1024.png
  - 修正案: `.eye-page.rd-page{padding-bottom:calc(var(--exam-bar-h,180px) + env(safe-area-inset-bottom))}` と詳細度を上げる。バーの高さは ResizeObserver で取る（共通の原因 3）。

- **C-2 [致命的] 検査入力: テンキーのポップオーバーが画面の下にはみ出す**（exam-keypad）
  - 画面幅: 640px 以上のすべての幅（768x1024、820x1180、844x390、1024x768、1366x768）
  - 問題: テンキーが入力欄の真下に `position:absolute;top:100%` で開き、画面の下にはみ出します。下のバーとも重なります。
    - 768・820: 「前回」「キー入力」「次へ」が画面外です。
    - 1024・1366・844: 1〜3 と 0 の段から下が画面外です。
    - タッチ端末のタブレット縦やスマホ横でも、下のシートになりません（シートになるのは 639px 以下だけです）。
  - 要素: `.num-pad` / `.va-picker`（exam.css 476 行、1001 行の media）、components/exam-inputs.js の revealAboveSheet
  - スクショ: exam-keypad-768x1024.png
  - 修正案: シートにする条件を `(max-width:639px), (pointer:coarse), (max-height:600px)` にし、revealAboveSheet の matchMedia もそろえる。PC では下の空きを測り、足りなければ上向き（`.is-up`）に開く。

- **C-3 [重要] 検査入力: スマホのテンキーのシートで、編集中の欄がヘッダーに重なる**（exam-keypad）
  - 画面幅: 390x844、430x932、360x740
  - 問題: `scrollIntoView({block:"start"})` で、編集中の欄が固定ヘッダーの下に送られます。さらに `.num-field.is-pad-open{z-index:36}` がヘッダー（z-index:30）より上に描かれるので、欄がヘッダーのメニューや検索のボタンを覆います。
  - 要素: `.rd-grid .input`（scroll-margin-top がない）、`.num-field.is-pad-open`、`header.eh`
  - スクショ: exam-keypad-390x844.png
  - 修正案: `.rd-grid .input{scroll-margin-top:calc(var(--nav-h) + 16px)}` を付ける。z-index は 29 以下にする。block は "center" にして、シートの高さを差し引く。

- **C-4 [重要] 検査入力: 横向き・スマホで入力欄が見えない**（すべての exam の状態）
  - 画面幅: 844x390、390x844、360x740
  - 問題: 844x390 では、ヘッダー（40px）と 2 段の固定バー（約 115px）で、使える高さが約 235px しかありません。タブを選んでも入力欄が 1px も見えません。390x844 では、患者バナー・記録の行・3 段のタブ（約 600px）と 3 段のバー（約 165px）で、入力欄は約 70px しか見えません。
  - 要素: `div.exam-bar.rd-bar`、`.exam-banner`、`.rd-record-row`、`.rd-tabs`
  - スクショ: exam-iop-844x390.png
  - 修正案: `@media (max-height:500px)` でバーを 1 段にする。スマホではタブを 1 行の横スクロールにする。

- **C-5 [重要] 検査入力: スマホの視力表**（exam / exam-keypad）
  - 画面幅: 390、430、360
  - 問題: C・A・RG の列が画面外にありますが、横にスクロールできることが見た目で分かりません。横に送ると「遠見/近見」の見出しと R/L の列が左に消え、どの眼のどの行か分からなくなります。
  - 要素: `.rd-grid-scroll` / `.rd-grid`（exam.css 2006 行〜）
  - スクショ: exam-keypad-360x740.png
  - 修正案: 見出しの列と R/L の列を `position:sticky;left:0` にする。または、639px 以下では 2 段の配置にする。右端に影を付ける。

- **C-6 [重要] 患者ページ: 視力・眼圧のグラフの数値ラベルが重なる**（patient-vaiop / patient）
  - 画面幅: 1920〜390 のすべての幅
  - 問題: 右端の「13」と「14」、視力の「1.2」と「1.0」、左端の「0.3/0.4/0.2」が、点同士や Y 軸の目盛りと重なり、読めません。1024 では日付が間引かれて消えます。測定値の読み違いにつながります。
  - 要素: components/va-iop-view.js 155 行の `text.vi-value`
  - スクショ: patient-vaiop-1366x768.png
  - 修正案: 系列ごとにずらす量を変える。重なるラベルは押し出すか省く。または、最新の値だけを出し、ほかはホバーやタップで見せる。

- **C-7 [重要] 画像比較: 縦に積まれて、2 枚を同時に比べられない**（images / images-ou）
  - 画面幅: 768x1024、820x1180（1 列になる）、1366x768、1920x1080、1024x1366（高さが合わない）、844x390、390x844
  - 問題: 900px 以下では縦 1 列に積まれ、2 枚目は 1 画面分スクロールしないと見えません。`.file-preview{height:max(360px, calc(100vh - 430px))}` のため、1366x768 ではパネルの下端が画面外に出ます。1024x1366 では大半が黒い余白です。844x390 では、最初の画面に画像が出てきません。
  - 要素: `.cmp-page .file-preview`（patient.css 957 行）、`.compare-grid`（globals.css 1569 行）
  - スクショ: images-ou-768x1024.png
  - 修正案: 600px 以上は 2 列のままにする。高さは `clamp(200px, calc(100dvh - 300px), 70vh)` にし、横幅に合わせた上限も付ける。

- **C-8 [重要] 診察・患者: カルテ概要で臨床値が数値の途中で折り返す**（home-summary / patient / exam-data）
  - 画面幅: 1024〜1920（概要のペイン）、390（データ表示）
  - 問題: 「RV=0.9 (1.2×S−1.00D=C− / 0.50D Ax180°)」のように、値の途中で折り返します。1920 でも起きます。カナ（「モギ カズ / コ」）や、ラベル（「性別・生年月 / 日」）も崩れます。
  - 要素: `section.ps-pane .ps-grid`、`.ps-va .ps-lines`、`.ps-dl > div`、`.ps-kana`
  - スクショ: home-summary-1366x768.png
  - 修正案: S・C・Ax を nowrap の span に分ける。`.ps-kana{white-space:nowrap}` にする。ペインが 480px 未満なら、container query で 1 列にする。

- **C-9 [重要] 診察: 未確定カルテの「最終保存…」が切れる**（home-tasks）
  - 画面幅: 1920〜768 では切れる。767px 以下では表示されない。
  - 問題: 「最終保存 20:23 院長（管理者・医師）」が、余白があっても途中で切れます。`.flow-note{display:inline-flex;max-width:16em}` のため、省略記号も出ず、title もありません。767px 以下では状態（修正中・下書き）ごと隠れ、どれが修正中か分かりません。
  - 要素: `li.flow-row.status-task > span.flow-purpose > span.flow-note`（globals.css 2417、2541、2563 行）
  - スクショ: home-tasks-1366x768.png
  - 修正案: `.status-task .flow-note{max-width:none}` にし、文字を省略記号付きの子要素に入れて title を付ける。スマホでは状態を 2 段目に出す。

- **C-10 [軽微] 診察: 場所のタブが折り返す**（home / home-all / home-tasks）
  - 画面幅: 390、360（4 段）、768、844（2 段）
  - 問題: スマホでは約 170px を使います。区切りの「|」が行の末尾に残ります。
  - 要素: `div.cl-tabs`、`.consult-chip-divider`（consult.css 103 行）
  - スクショ: home-390x844.png
  - 修正案: 767px 以下は 1 行の横スクロールにする。

- **C-11 [軽微] 診察: 患者名が途中で折り返す**（home）
  - 画面幅: 1024x768、768x1024
  - 問題: 「初診 太 / 郎」と折れます。
  - 要素: `.cl-table .cl-name strong`
  - スクショ: home-1024x768.png
  - 修正案: `white-space:nowrap` にし、タグは 2 行目に出す。

- **C-12 [軽微] 検査入力: 大タブが中途半端に折り返す**（exam）
  - 画面幅: 1280（「その他」だけ 2 段目）、768・820・844（8 個と 3 個）、390（3 段）
  - 要素: `.rd-tabs`
  - スクショ: exam-1280x800.png
  - 修正案: `repeat(auto-fit,minmax(76px,1fr))` で均等にする。スマホは 1 行の横スクロールにする。

- **C-13 [軽微] 検査入力: 右側のカードの空白**（exam-bottom / exam-checklist）
  - 画面幅: 1024〜1279
  - 問題: 3 列のカードが同じ高さに引き伸ばされ、「本日の検査」「散瞳」に大きな空白が出ます。
  - 要素: `.rd-side`（exam.css 1979 行）
  - スクショ: exam-bottom-1024x768.png
  - 修正案: `align-items:start` にする。

- **C-14 [軽微] 検査入力: 検者名が切れる**（exam）
  - 画面幅: すべての幅（390 では「院長（管理者」まで）
  - 問題: 欄の幅で名前が切れ、全体を見る手段がありません。
  - 要素: `.input.rd-examiner`
  - スクショ: exam-390x844.png
  - 修正案: 欄を広げる。title を付ける。

- **C-15 [軽微] 検査入力: 1920 で下のバーがずれる**（exam）
  - 画面幅: 1920x1080
  - 問題: 下のバーの中身が中央に寄らず、本文（中央の 1480px）とボタンの位置がずれます。
  - 要素: `.rd-bar` / `.rd-bar .exam-bar-row`（exam.css 2082 行）
  - スクショ: exam-1920x1080.png
  - 修正案: 中身を `max-width:1440px;margin:0 auto` の入れ物で包む。

- **C-16 [軽微] 検査入力: テンキーの「キー入力」が 2 行に折れる**（exam-keypad）
  - 画面幅: 640px 以上
  - 要素: `.num-key.is-text`
  - スクショ: exam-keypad-1024x1366.png
  - 修正案: 2 列分の幅にする。

- **C-17 [軽微] 患者ページ: 右の欄の見出しが切れる**（patient）
  - 画面幅: 1024x768、1024x1366
  - 問題: サムネイルの見出し（「眼底…」）と文書名が切れます。
  - 要素: `section.panel.side-panel` の `.thumb-caption` と文書の行
  - スクショ: patient-1024x768.png
  - 修正案: 右の欄を 320px にするか、見出しを 2 行まで出す。

- **C-18 [軽微] 患者ページ: 視力の記録の表が 360 で切れる**（patient-vaiop）
  - 画面幅: 360x740
  - 問題: 「左眼」の列が「0.4 (0」で切れます。
  - 要素: `.vi-table-wrap`
  - スクショ: patient-vaiop-360x740.png
  - 修正案: 「種」と「遠近」の列をまとめる。

- **C-19 [軽微] 患者ページ: 取り込みのダイアログ**（patient-upload）
  - 画面幅: 844x390
  - 問題: 下端が 393px で、画面を 3px 超えます。上端は余白なしで画面の端に貼り付きます。ボタンは見えています。
  - 要素: `form.dialog.upload-dialog`
  - スクショ: patient-upload-844x390.png
  - 修正案: 共通の原因 1 を直す。

- **C-20 [軽微] 患者ページ: ファイルの表示**（patient-file）
  - 画面幅: 844x390
  - 問題: 画像が画面に入りきらず、下の部分と「このファイルを削除する」は、ダイアログの中をスクロールしないと見えません。
  - 要素: `.dialog-viewer .file-preview`（globals.css 1551 行 height:70vh）
  - スクショ: patient-file-844x390.png
  - 修正案: `height:auto;max-height:calc(100dvh - 160px)` にする。

- **C-21 [軽微] タップ領域**（検査入力・画像比較・患者ページ）
  - 画面幅: 1024 以下
  - 問題: 次の部品が 32px 未満です。
    - `.rd-device-step .btn`: 28×40px
    - `.cmp-ou-head .btn-chip`: 28×40px
    - `a.back-link`: 26×29px
    - 経過グラフの点眼マーカー `g[role=button]`: 16×22px
    - 削除の summary: 高さ 22px
  - 要素: 上のとおり
  - スクショ: exam-768x1024.png
  - 修正案: `(pointer:coarse)` で 40px にする。SVG には透明な当たり判定を足す。

### 修正結果（C 領域・ブランチ `feat/responsive-c`）

- **C-1 済**: 共通の修正（`--exam-bar-h` と `.eye-page.rd-page`）で解決。exam-bottom の全幅で、申し送りのチップがバーの上に出ることを確認しました。
- **C-2 済**: 共通の修正（シートの条件・上向きのポップオーバー）で解決。768・844・1024・1366 で、テンキーが画面とバーの内側に収まることを確認しました。
- **C-3 済**: シートのときは `.num-field.is-pad-open` の z-index を外しました（ヘッダーを覆わない）。欄の送り方は `block:"start"` をやめ、シートの上端を測って「ヘッダーとシートの間の中ほど」へ送ります。横にスクロールする表では、固定した列の下に潜らないよう横も合わせます（exam-inputs.js の revealAboveSheet）。iPhone・iPad の実機での送り方（ソフトキーボードは出ない設定）は、実機での確認をおすすめします。
- **C-4 済**: 大タブは 768px 以上で 1 行、767px 以下は 1 行の横スクロールにしました。高さ 500px 以下では、記録の行・タブ・パネルの余白を詰め、小タブが 1 つだけの行は省きます。バーの「…は未入力です」も省いて 1 段を保ちます。844x390 では、最初の画面にパネルの先頭まで入り、少しスクロールすれば入力欄に届きます（使える高さは約 300px）。
- **C-5 済**: 639px 以下の視力の表は、「遠見/近見」と R/L の列を sticky にしました。右に続きがあるときは右端に影を出します（スクロールする枠の外側の `::after`）。`scroll-padding-left` で、フォーカスで送った欄も固定の列の下に潜りません。
- **C-6 済**: 値のラベルは、新しい測定から順に「右眼は上・左眼は下 → だめなら反対側 → それでも重なれば省く」で置きます。目盛り・下の日付・ほかの点も避け、左右は枠の中に寄せます（lib/label-layout.mjs の placeLabels、test/label-layout.test.mjs）。省いた値は、点の title と上の表で見られます。日付の間引きは従来どおりです（重なる日付を省く仕様）。
- **C-7 済**: 600px 以上は 2 面を左右に並べたままにしました。面の画像の高さは、一番上までスクロールしたときに面の下端が画面に収まる高さ（画像の上端を image-compare.js が測って `--cmp-preview-top` に入れる）で、面の幅より高くしません。599px 以下は 2 面がほぼ 1 画面に入る高さです。高さ 500px 以下では、サムネイルを横長にして列を詰めました。
  - images-ou の 768x1024 で右眼が「表示するファイルを選んでください」になる件は、今回も 1 回出ました。画像の取得が遅れたか失敗したときの表示で、取得の順番・負荷によるものです。表示を「読み込み中…」「画像を読み込めませんでした。開き直してください」に分けました（files-panel.js の FilePreview）。取得の失敗そのものは **実機確認が必要** です（多数の同時撮影の負荷で起きている可能性があります）。
- **C-8 済**: 概要の値は、区切り（空白・×・= の後、括弧の前）でだけ折り返します（patient-summary-pane.js の Breakable）。見出しの列は一番長い見出しの幅にそろえて折り返さず、カナはまとめて次の行に送ります。ペインが 400px 未満なら、container query で 1 列にします（1366 の 420px のペインは 2 列のまま）。データ表示の行は、折り返した 2 行目以降を字下げしました。
- **C-9 済**: 要対応の行は、目的の欄を進み具合・待ち時間の欄まで広げ、「最終保存 …」は入らないときだけ省略記号にし、title で全文を見られます。767px 以下では、状態と最終保存を 2 段目に出します。
- **C-10 済**: 1023px 以下と高さ 500px 以下では、場所のタブを 1 行の横スクロールにしました（区切りの「|」が行末に残らない）。
- **C-11 済**: 患者名は折り返さず、「未登録」などのタグは入らなければ 2 行目に出します。
- **C-12 済**: C-4 と同じ（768px 以上は 11 個を均等に 1 行）。
- **C-13 済**: `.rd-side{align-items:start}`。
- **C-14 済**: 検者の欄を 220px に広げ、title を付けました。639px 以下は、行の残りの幅まで広げます。
- **C-15 済**: 1024px 以上のバーの左右の余白を `max(20px, (100% - 1440px) / 2)` にし、本文と同じ幅にそろえました。
- **C-16 済**: 「キー入力」「クリア」を 1 行に収めました（12px・nowrap）。
- **C-17 済**: 1024〜1279 も右の欄を 320px にしました（サムネイルの見出し・文書名が切れない）。
- **C-18 済**: 480px 以下では、「種」と「遠近」を 1 列（「自覚・遠」）にまとめ、右眼・左眼の値は括弧の前で折り返します。
- **C-19 済**: 共通の修正で解決。844x390 で、ダイアログとボタンが画面に収まることを確認しました。
- **C-20 済**: `.dialog-viewer .file-preview` の高さを `min(70vh, calc(100dvh - 160px))` にし、844x390 で画像の全体と「このファイルを削除する」が見えます。
- **C-21 済**: 経過グラフの点眼マーカーの当たり判定を 32×32 にしました。戻るリンク（患者帯の中。患者帯は B 領域の部品なので、patient.css の `.pt-page` / `.cmp-page` の中だけで指定）、OU の日付送り、機器の値の ‹ ›、削除の summary は、PC でも 32px 角にしました。タッチ端末では共通の 36〜40px が効いています。

検出器の件数（C 領域の 27 状態 × 12 幅 ＋ 暗室 3 状態 × 1366x768 = 327 枚。修正前は `feat/eye-replicate` の 7191a44 で撮影）:

| 指摘 | 修正前 | 修正後 |
| --- | ---: | ---: |
| 文字の重なり | 57 | 0 |
| 省略記号で切れて title がない | 10 | 0 |
| 小さいタップ領域（タッチの幅） | 32 | 0 |
| 小さいタップ領域（PC の幅） | 76 | 28 |
| 覆われた操作 | 102 | 102 |
| 画面外・切れ・はみ出し・スクロールできない枠・小さい文字 | 0 | 0 |

- PC の幅の残り 28 件は、ヘッダーのロゴ（A 領域、27 件）と、ファイルの表示の削除の summary（今回 32px にしたので、次の撮影で消えます）です。
- 覆われた操作の 102 件は、すべて 1024px 未満の概要シート（home-summary）の背景の幕です。意図した重なりなので **対応不要** です。

確認: `node --test test/*.test.mjs`（58 件）、`node scripts/next-ui-smoke.mjs`（検査入力の大タブ・視力の表の固定の列・バーの位置の確認を末尾に追加）、`npx next build` はすべて通りました。

---

## (D) 会計連携・文書・印刷・設定

- **D-1 [致命的] 文書: 「カルテから挿入」のシート**（document-insert）
  - 画面幅: 844x390
  - 問題: 下から出るシートが `max-height:75vh`（約 292px）に収まりません。挿入する項目の一覧（`.doc-insert-groups`）がまったく見えません。下の「閉じる」「選んだ 12 件を…挿入」も、約 32px 切れます。項目を選べず、挿入もほぼできません。
  - 要素: `.doc-insert`（documents.css の 1099px 以下の部分、`overflow:hidden`）
  - スクショ: document-insert-844x390.png
  - 修正案: 見出しと下のボタン以外を 1 つのスクロール領域にまとめる。`@media (max-height:500px)` で `max-height:calc(100dvh - var(--nav-h));overflow:auto` にし、下のボタンを sticky にする。

- **D-2 [重要] 会計連携: 「?」の説明がスマホで右に切れる**（billing-help）
  - 画面幅: 390x844、360x740
  - 問題: ポップオーバーが「?」の左端（x≈100）から始まり、幅が 358px あります。右端が約 458px になり、文末が読めません。
  - 要素: `.bill-help > p`（billing.css 31 行付近、`left:0`）
  - スクショ: billing-help-390x844.png
  - 修正案: 767px 以下では、`left:16px;right:16px;width:auto` を見出しを基準にして指定する。

- **D-3 [重要] 会計連携: 品目の差分と変更の文字が切れる**（billing / billing-diff）
  - 画面幅: 768x1024、820x1180、360x740（ほかの幅でもチップは省略されます）
  - 問題: 差分のチップが「+チモ…」「-ラタ…」まで省略され、何が増えて何が減ったか分かりません。title もありません。「連携済 v1 のあと修正中 理由: …」は、省略記号も出ずに文字の途中で切れます。
  - 要素: `.bill-chip`、`.bill-extra-text`（billing.css 287〜316 行）
  - スクショ: billing-768x1024.png
  - 修正案: title を付ける。省略記号が出るようにする。1200px 以下ではチップを折り返して全文を出す。

- **D-4 [重要] 設定: よく使う薬剤の名前で濃度が見えない**（settings-drugs ほか）
  - 画面幅: 430、390、360
  - 問題: 「ジクアホソルナトリウム点眼液…」のように省略され、濃度（3%、0.1% など）が見えません。濃度だけが違う薬剤を見分けられず、医療上のリスクがあります。title もありません。
  - 要素: `.drug-cols .master-name strong`（settings.css の 640px 以下の部分）
  - スクショ: settings-drugs-390x844.png
  - 修正案: 2 行まで折り返して全文を出す。title を付ける。

- **D-5 [重要] 印刷: スマホで印刷の帯が 3 段になる**（document-print / encounter-print / optical）
  - 画面幅: 390、360、430
  - 問題: sticky の `.print-bar` が 3 段（戻る＋題名／状態／印刷）に折れます。約 145〜165px あり、画面の約 2 割を常に占めます。
  - 要素: `.print-bar`（print.css 23 行、750 行）、components/print-shell.js
  - スクショ: encounter-print-390x844.png
  - 修正案: 719px 以下では 2 段に固定する（状態と印刷を同じ行に置く）。または、スマホでは sticky をやめる。

- **D-6 [重要] 印刷: 実際の印刷でスマホ用の紙面ルールが当たる恐れ**（document-print-media / encounter-print-media / optical-media）
  - 画面幅: 実際の印刷（A4・A5）。-media の 390x844 で症状を確認しました。
  - 問題: print.css の `@media (max-width:719px)` は screen に限定されていません。Chrome は印刷のとき、用紙の印字幅（A4 で約 703px、A5 で約 484px）でこの条件を評価します。そのため、処方箋の単位（D・°・Δ・mm）が消える、表の見出しが 8pt になる、署名欄が縦に積まれる、といったスマホ用のルールが紙に当たる可能性があります。
  - 要素: app/styles/print.css 750〜835 行（globals.css の 767px 以下の部分も同じ懸念があります）
  - スクショ: optical-media-390x844.png
  - 修正案: `@media screen and (max-width:719px)` に変える。Chrome の印刷プレビューで、A4・A5 の結果を確かめる。

- **D-7 [重要] 会計連携: スマホの見出しの行と状態のタブ**（billing）
  - 画面幅: 390、360、430
  - 問題: 見出しの行が、ラベルのないチェックボックス 1 つだけの行になります。状態のタブは「未確」で切れますが、続きがあることが分かりません。
  - 要素: `.bill-head-row`、`.bill-chips-row > .flow-chips`
  - スクショ: billing-390x844.png
  - 修正案: 「未連携をすべて選ぶ」の文字を出す。タブにフェードを付けるか、2 段にする。

- **D-8 [重要] 印刷: カルテの紙面のクラス名の衝突と TEL の改行**（encounter-print）
  - 画面幅: すべての幅（画面と印刷の両方）
  - 問題: chart-editor.css のカード用の `.chart-sheet`（枠線・角丸・`var(--surface)`）が紙面にも当たり、角丸の枠が印刷されます。暗室表示では紙面が暗くなる恐れもあります。「TEL 03-1234-/5678」と、番号の途中で改行されます。
  - 要素: chart-editor.css 1936 行の `.chart-sheet`、print.css の `.cs-facility`、components/print-view.js 133 行
  - スクショ: encounter-print-1366x768.png
  - 修正案: 紙面のクラス名を変える（例: `.cs-sheet`）。施設の情報は要素ごとに nowrap にする。

- **D-9 [軽微] 文書: 「【見出し】を付ける」が 3 行に折れる**（document-insert）
  - 画面幅: すべての幅
  - 要素: `.doc-insert-options .check`（documents.css 362 行）
  - スクショ: document-insert-1366x768.png
  - 修正案: `flex:none;white-space:nowrap` にする。

- **D-10 [軽微] 設定: セットの「フォル/ダ」の折れ**（settings-sets）
  - 画面幅: 1024x768（801〜1100px）
  - 要素: `.set-tree-head`（settings.css 1230 行）、`.set-browser`（1426 行）
  - スクショ: settings-sets-1024x768.png
  - 修正案: nowrap にするか、列を 220px にする。

- **D-11 [軽微] 設定: 利用者のカードにラベルがない**（settings-users）
  - 画面幅: 390、360、430
  - 問題: 「医師 / 有効 / あり・なし」にラベルがなく、「あり／なし」（設定の権限）の意味が分かりません。
  - 要素: `.user-cols .user-admin` ほか（settings.css 1450 行〜）
  - スクショ: settings-users-390x844.png
  - 修正案: 「設定権限あり」と出す。

- **D-12 [軽微] 設定: スマホで戻る手段がない**（settings-facility-edit / settings-sets-folder）
  - 画面幅: 390、360
  - 問題: 全画面のダイアログに「‹ 戻る」がなく、閉じるには一番下までスクロールする必要があります。項目が 2 つだけのフォルダ追加も全画面で、空白が大きいです。
  - 要素: `.master-panel.settings-dialog`（settings.css の 640px 以下の部分）
  - スクショ: settings-facility-edit-390x844.png
  - 修正案: `master-panel-back` を付ける。小さいダイアログは中央に出す。

- **D-13 [軽微] 設定: 横向きで本文が狭い**（settings-*-edit / -new / settings-panel）
  - 画面幅: 844x390
  - 問題: 固定の見出しと下のボタンで、本文が約 200px しかありません。
  - 要素: `.master-panel-head`、`.master-panel-actions`
  - スクショ: settings-sets-edit-844x390.png
  - 修正案: `@media (max-height:500px)` で上下の余白を詰める。

- **D-14 [軽微] 設定: セットの編集の入力欄が狭い**（settings-sets-edit / -new）
  - 画面幅: 390、360
  - 問題: 説明の欄の placeholder が切れます。検査の行の「削除」が単独の行に回ります。
  - 要素: `.master-panel-body .field-row`
  - スクショ: settings-sets-edit-390x844.png
  - 修正案: 1 列にする。検査の行を `minmax(0,1fr) auto auto` にする。

- **D-15 [軽微] 設定: ナビの 2 段目の先頭に区切り線が残る**（settings）
  - 画面幅: 768、820、844
  - 要素: `.settings-nav-group + .settings-nav-group`（settings.css 776 行）
  - スクショ: settings-768x1024.png
  - 修正案: 区切りを gap で描くか、1 段の横スクロールにする。

- **D-16 [軽微] 会計連携: 差分の「両」が次の行に回る**（billing-diff）
  - 画面幅: 390、360
  - 要素: `.bill-detail` の品目の行
  - スクショ: billing-diff-390x844.png
  - 修正案: 薬剤名と眼のチップを nowrap でまとめる。

- **D-17 [軽微] 会計連携: 省略された文字に title がない**（billing）
  - 画面幅: 1024 以下
  - 要素: `.bill-final > .muted`、`.bill-name .flow-kana`
  - スクショ: billing-820x1180.png
  - 修正案: title を付ける。

- **D-18 [軽微] 眼鏡処方箋: スマホでの表の見出し**（optical）
  - 画面幅: 430、390、360
  - 問題: 見出しが 8pt で、「プリズ/ム」「基底方/向」と折れます。「累進焦点（」の後で改行されます。
  - 要素: `.rx-values thead th`（print.css 776 行）、`.rx-paren`
  - スクショ: optical-390x844.png
  - 修正案: 9pt にし、`word-break:keep-all` にする。括弧は nowrap でまとめる。

- **D-19 [軽微] 会計の連絡票の印刷**（billing-print）
  - 画面幅: すべての幅（印刷）
  - 問題: 1 枚目の上に約 80px の余白があります。`@page` の用紙・余白の指定もありません。
  - 要素: `.billing-page` / `.bill-slips`（billing.css 756 行）、components/billing-workspace.js 499 行
  - スクショ: billing-print-1366x768.png
  - 修正案: `@media print{.billing-page{padding:0;max-width:none}}` にする。用紙と余白の指定を足す。

- **D-20 [軽微] 文書: 1280 で見本が小さい**（document）
  - 画面幅: 1280x800
  - 問題: A4 の見本が縮小され、本文が約 10〜11px で読みにくいです。
  - 要素: `.doc-preview-pane` / `.doc-preview-sheet`
  - スクショ: document-1280x800.png
  - 修正案: 1100〜1366px では、入力欄の列を `minmax(420px,0.8fr)` に詰める。

- **D-21 [軽微] タップ領域**（settings-audit / document / billing）
  - 画面幅: 1024 以下のタッチ端末
  - 問題: 次の部品が 32px 未満です。
    - 操作記録の患者名のリンク: 高さ約 20px（80 件）
    - 差し込みのチップ: 約 28px
    - 「?」: 約 30px
  - 要素: `.audit-table .audit-patient a`、`.doc-insert-seg .btn-chip`、`.bill-help > summary`
  - スクショ: settings-audit-390x844.png
  - 修正案: `(pointer:coarse)` で `min-height:36px` にする。操作記録は行全体を押せるようにする。

---

## 検出器の誤検出と、検出器で拾えなかったもの

### 誤検出として外したもの

- **行の中の文字が折り返したときの「文字の重なり」**
  - 対象: `.exam-block-stamp`、`.exam-prev-line`、`.rx-choice` と `.rx-paren`、`ps-info` のカナ、`suggestion` など
  - 理由: 2 行にまたがる inline 要素の外接矩形が重なっただけです。文字そのものは重なっていません。
  - 不自然な折り返しは、軽微の項目として一覧に載せました。
- **印刷時の透かし（`.print-watermark`、position:fixed）の切れと、スクロールできない枠の指摘**（-media の 844x390）
  - 理由: 画面の高さで判定したためです。紙では用紙ごとに置かれます。
- **紙面の 8pt の文字（押印欄・日付の注記）の小さい文字の指摘**
  - 理由: 紙の書式としては一般的な大きさです。ただし、スマホの画面での表の見出しは D-18 に載せました。
- **概要シート（1024 未満）の背景の幕に覆われた操作と、開いたポップオーバーの下の操作**
  - 理由: 意図した重なりです。検出器はこれを `coveredByOverlay` として数だけ出します。
- **1024x768 と PC の幅での小さいタップ領域**
  - 理由: マウスで操作するので問題ありません。ラベル全体が押せるチェックボックスも問題ありません。

### 目で見て初めて分かったもの

次の項目は、主に目視とコードの読み込みで見つけました。

- A-2〜A-10、A-14〜A-17
- B-2（PC でヘッダーの下に潜ること）、B-3〜B-6、B-10、B-11、B-13、B-15〜B-17、B-19〜B-22
- C-2〜C-17
- D-2、D-5、D-6、D-8〜D-16、D-18〜D-20

検出器は位置と大きさを測るので、次のような問題は拾えません。

- 「overflow:auto の枠の中で切れている」「横スクロールの奥に隠れている」ような、スクロールすれば理屈の上では届くもの
- 1 字ずつの折り返しのような見た目の崩れ
- CSS の詳細度や読み込み順による上書き（C-1 は、症状は検出器が拾い、原因は CSS を読んで特定しました）

## 次の段階（修正）への注意

- 共通の原因 1〜6 は、領域ごとの担当が別々に直すと衝突します。共通の担当が先に直すか、`globals.css`・共有のダイアログ・メニューの部品を誰が直すかを先に決めてください。
- 直した後は、同じコマンド（`--viewports responsive`）で撮り直し、`responsive-summary.txt` の件数と、この文書の各スクショ名に当たる画面を見比べてください。
- 領域だけを撮り直すには、`--pages "editor*"` のように後ろに `*` を付けて、前方一致で指定します。

## 共通部分の修正（済）

ブランチ `feat/responsive-shared` で、共通の原因 1〜6 を共通の部分だけで直しました。各領域の担当は、下の部品と CSS 変数を使って、残りの画面ごとの項目を直してください。

### 直したこと

1. **ダイアログの高さの上限**（app/globals.css の「ダイアログ」）
   - `.dialog`: `max-height:calc(100dvh - 32px)`、中をスクロール（`overflow-y:auto`）。
   - `.dialog-backdrop`: `align-items:safe center`、`overflow-y:auto`。
   - `.dialog-actions`: スクロール中も下端に残る（sticky）、折り返す（`flex-wrap:wrap`）。下端の合わせに `--dialog-pad-y` / `--dialog-pad-x`（既定 22px / 24px）を使います。余白を変えるダイアログは、`padding` ではなくこの 2 つの変数を変えてください（`.dialog.ps-dialog` はそうしました）。
   - 100vh で上限を決めていたもの（`.dialog-wide`・`.dialog-viewer`・`.rd-data-dialog`・設定の `.master-panel`）は 100dvh に、概要シート `.cl-sheet` は `min(82vh, calc(100dvh - var(--nav-h)))` にしました。
   - 引き出し（`.chart-left` / `.chart-right`）・ヘッダーのメニュー・受付の絞り込みは、もともと端までスクロールできるので変えていません。
2. **チェックボックスとラジオの幅**（app/globals.css）
   - `input:where([type=checkbox],[type=radio])` と `.field input:where(…)` を `width:auto; flex:0 0 auto; padding:0` にしました。packages/web-ui は変えていません。詳細度は共通 CSS と同じなので、各画面の `.xx input{width:18px}` などはそのまま効きます。
   - chart-editor.css の `.chart-page input[type="checkbox"]` は、もう要りません（消しても同じ見た目です）。
3. **下の固定バーの高さ**
   - 新しいフック `useMeasuredHeight(変数名)`（components/use-measured-height.js）。返り値を `ref` に渡すと、その要素の高さ（枠線・安全領域の余白を含む）を `:root` の CSS 変数に書き込み、ResizeObserver で追いかけます。外れたときは変数を消します。
   - `--actionbar-h`: カルテの操作帯（encounter-editor.js）。767px 以下の `.chart-page` の `padding-bottom: calc(var(--actionbar-h, 72px) + 8px)`。
   - `--exam-bar-h`: 検査入力の下のバー（exam-workbench.js）。`.eye-page.rd-page` の `padding-bottom: calc(var(--exam-bar-h, 150px) + 16px)`。
   - C-1 の原因（globals.css の `.eye-page{padding}` が後から効いて `.rd-page` の余白を消していた）は、選択子を `.eye-page.rd-page` にして直しました。ほかの画面で同じことをするときも、`.eye-page.xx-page` と 2 つ並べてください。
   - 2 つのバーには `data-fixed-bar="bottom"` を付けました。下のポップオーバーの位置合わせが、この属性の付いた fixed の要素を避けます。患者ページの `.pt-actions` など、ほかの固定バーにも付けると同じように扱われます。
4. **ポップオーバーの位置合わせ**（components/popover-placement.js）
   - 開いたときに位置を測り、CSS の既定の位置で画面（とスクロール枠）に収まれば何もしません。収まらないときだけ、`position:fixed` にして親のスクロール枠の外へ出し、上下の向き・左右の寄せを切り替え、画面の中に寄せ、入らない高さは `max-height` にして中をスクロールさせます。幅は既定の位置での幅のままです。固定ヘッダーと `data-fixed-bar` のバーには重ねません。スクロール・画面の大きさの変化では置き直します。置いた向きは `data-placement="up|down"` で分かります。
   - `<PopoverAutoPlacement />` を app/layout.js に 1 回だけ置きました。`details.more-menu > .more-menu-list` と `details[data-popover] > [data-popover-panel]` は、部品を変えなくても自動で合わせます。
   - details 以外は `usePopoverPlacement(panelRef, open, { anchorRef, disabled })` を使います（テンキー・視力の選択で使用）。関数の `placePopover(panel, { anchor })` / `resetPopover(panel)` も使えます。
   - CSS で `position:fixed` にしているもの（スマホの下のシートなど）には触りません。
   - `.more-menu-list` は `white-space:normal` にし、表の td の nowrap を受け継がないようにしました（A-2 の横一列）。
   - 会計連携の「?」（`.bill-help`）に `data-popover` / `data-popover-panel` を付けました。
   - テンキー・視力の選択は、`(max-width:639px), (pointer:coarse), (max-height:600px)` で画面下のシートにします。条件は exam-inputs.js の `KEYPAD_SHEET_QUERY` と exam.css の末尾の @media でそろえています。シートは `max-height:calc(100dvh - var(--nav-h) - 16px)`、幅は最大 560px で中央です。`.rd-grid .input` にも `scroll-margin-top` を付けました（C-3 の前半）。
5. **高さ 500px 以下（スマホ横）の詰め**（app/globals.css の末尾）
   - 患者バナーは 1 行にしました（氏名とフラグを横に並べ、カナと生年月日の行は省きます）。
   - カルテ・検査入力・患者ページの下のバーは余白とボタンの高さ（36px）を詰め、検査入力のバーは 1 段にしました。
   - ページの見出しを `--fs-lg` に、設定の編集パネルの見出しと下のボタン、印刷の帯、ダイアログの余白も詰めました。
   - ログインの説明の帯は約 48px にしました（キャッチコピーは隠します）。
   - テンキーのキーは 36px にしました。
6. **タッチ端末のタップ領域**（app/globals.css の末尾の `@media (pointer:coarse)`）
   - 40px 以上にしたもの: `.btn-chip`・`.btn-sm`・`.segmented button`・`.segmented-option`・`.input`。チップと選択肢は、幅も 36px 以上にしました。
   - 36px 以上にしたもの: `.col-tool`・`.num-pad-close`・`.master-panel-close`・すべての `summary`・`.link-button`・`.back-link`・`.eh-brand`。
   - `:is(.x, #_)` で ID 1 個分の詳細度を足しているので、画面側の CSS の小さい `min-height` には負けません。逆に、画面側でこれより小さくしたいときは、同じ書き方が必要です。
   - 入力欄の最小の高さは、タッチ端末で 44px から 40px にそろいました。

### 確認

- 撮影: `node scripts/ui-audit.mjs --viewports responsive --no-full --pages "<24 の状態>"`。対象は editor・editor-status・editor-rp・editor-rp-menu・editor-more・editor-print-menu・editor-dx-edit・editor-bottom・exam・exam-iop・exam-keypad・exam-bottom・reception・reception-rowmenu・billing・billing-help・password-error・patient-upload・login・settings-sets-edit・settings-audit・document・patient・header-help です。
- 同じ状態・同じ幅で、修正前の件数と比べました。
  - 画面外: 7 → 0
  - スクロールできない枠: 8 → 0
  - 覆われた操作: 122 → 0
  - 小さいタップ領域: 5,238 → 1,948
  - overflow による切れ（6）は変わっていません。
- 1366x768・1024x768・768x1024・390x844・844x390 の画面を目で確認しました。1280 以上の PC の見た目（カルテ・受付）は変わっていません。
- `node --test test/*.test.mjs`、`node scripts/next-ui-smoke.mjs`、`npx next build` はすべて通りました。smoke には、操作帯の「…」と印刷のメニューが 1024・390 で画面に収まること、844x390 でショートカットのダイアログとボタンが画面に収まることの確認を足しました。

### 各項目の状態

- **共通の修正だけで解決したもの**（画面ごとの作業は要りません）
  - A-1、A-2、A-17
  - B-1（ステータスを 2〜3 列の grid にする案は任意）、B-7、B-8、B-9
  - C-1、C-2、C-19
  - D-2
- **一部が解決し、画面ごとの作業が残るもの**
  - **B-6**: 位置（上向き・寄せ・切れ）は解決しました。残りは次の 2 点です。
    - 回数のチップが 1 行ずつ縦に並ぶこと（`.usage-list .btn.btn-chip{width:auto}`）。
    - `.usage-list{min-width:260px}` が globals.css の `.more-menu-list{min-width:160px}` に上書きされていること（読み込み順）。直すには `.more-menu-list.usage-list` にします。
  - **B-11**: バナーの 1 行化とバーの詰めは済みました。残りは次の 2 点です。
    - `@media (max-height:500px)` で、767px 以下と同じ「ページ全体のスクロール＋左右は引き出し」に切り替えること。
    - シェーマのキャンバスの高さ。
  - **B-12**: 下の余白は、操作帯の実際の高さで足りるようになりました。残りは、操作帯を 1 段にすること（送信を「…」へ移す）と、スマホのバナーを詰めることです。
  - **C-3**: `scroll-margin-top` は付けました。残りは `.num-field.is-pad-open` の z-index（ヘッダーより上に出る）と、`block:"center"` にすることです。
  - **C-4**: バーは 1 段（約 45px）になりました。残りは、上の記録の行と大タブの 2 段（C-12）、スマホのタブを横スクロールにすることです。
  - **D-13**: 見出しと下のボタンの余白は詰めました。本文の高さが足りるかを、画面ごとに確認してください。
  - **A-12・B-14・C-21・D-21**（タップ領域）: 共通の部品は直りました。次は画面ごとのクラスなので、各領域で直してください。
    - (A) `select.rc-status`（`.input` が付いていない）、`.bk-slot`
    - (B) `.rp-x`、`.drug-check`、`.exam-cell-button`、`summary.rp-badge` / `.usage-pill` の見た目（高さは 36px になりました）
    - (C) 経過グラフの `g[role=button]`（透明の当たり判定）
    - (D) `.audit-patient a`、`.flow-group-toggle`、`.set-tree-toggle`
- **まだ手を付けていないもの**
  - D-1（文書の「カルテから挿入」のシート）は共通の範囲の外です。シートの中を 1 つのスクロール領域にまとめる作業が要ります。
  - A-15（検索モーダルの上寄せ）は、`.dialog-backdrop` の既定は変えずに、検索モーダルだけで直してください。
  - そのほかの項目も、それぞれの領域で直してください。
