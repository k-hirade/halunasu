# replicate-2 chart-main（カルテの中央・右のオーダー・右下の操作帯・カルテのダイアログ）2026-11-11

比較画像（ローカルのみ）13・25〜31・35〜40・49 と、「ハルナスに対応する画面がない競合の機能」のうち定期・下書きカルテ・カルテガイドを対象に、レイアウトと流れを写した。色はハルナスの配色のまま。競合の絵・画像・文言は使わず、ラベルと線画の絵は自前。

## 写したもの

| 比較 | 競合の出典 | 写した内容 | 主なファイル |
|---|---|---|---|
| 13 カルテ全体 | デジカル p.28 | 中央の「主訴・所見｜処置・行為」の 2 列を中央の下端まで伸ばす（768px 以上・高さ 501px 以上）。検査の帯はトプコンの作法なので上に残し、［▾］で畳めるようにした（畳むと 1 行の要約＋未確認の印。端末ごとに覚える）。 | chart-exam-band.js, chart-main.css |
| 35 操作帯 | デジカル p.31 | 右下を大きい絵＋文字のボタン 5 つに: 左に［¥ 送信］［検査依頼］、右に［保存］［印刷］［→ 次へ］。送れるとき（確定済み・修正中でない・受診日以降）の［送信］と［次へ］は塗りのボタン。［次へ］の要確認の数は角のバッジ。版履歴・下書きの破棄・修正は中央の見出しの［…］へ移した。右ペインは 5 つが 1 列に入るよう最小 300px（1280px 以上）。 | encounter-editor.js, chart-icons.js, chart-main.css |
| 35 検査依頼 | デジカル p.31（検査依頼ボタン） | ［検査依頼］（キー R）で検査項目（院内の検査カタログ）を選ぶダイアログ。視・圧などの組み合わせで一括選択、眼（両・右・左）。選んだ項目は今日のカルテの検査・処置に「予定」として入り（受付一覧の予定・検査室に出る）、同じ日の受付を「検査中」にする。受付が無ければ予定だけ入れる。API は既存の保存と受付の状態変更を使う（新しい API なし）。 | encounter-editor.js, encounter-dialogs.js |
| 25 オーダー | デジカル p.46 | 学習リストの検査・処置の行と、処置・行為の検査・処置の行に、診療行為マスターの点数を出す（コードのある行だけ）。医薬品の検索結果は従来どおり薬価。新しい API: `GET /v1/eye/masters/lookup?type=procedure&codes=…`（公開マスターをコードで引く。最大 100 件）。 | chart-points.js, chart-rp.js, chart-order-panel.js, services/eye-api/src/masters.js |
| 25・逆引き 定期 | デジカル p.94〜96 | 患者ごとの「定期」: 中央の見出しの［定期登録］で、今のカルテの処方・検査処置を名前と繰り返し（次回・毎回・N か月ごと）で残す。右のオーダー欄の下端に畳める「定期」欄（今回の対象は印つきで上・自動で開く）。押すと中央に入り、入れた日を記録する。✎で名前・繰り返しの変更と削除。保存先はセットと同じ（patientId を持つセット）で、セットの木・設定画面には出さない。 | services/eye-api/src/regular-orders.js, chart-order-panel.js, encounter-dialogs.js |
| 26 学習リスト | デジカル p.83 | 学習リストの束を点線の枠で出し、薬の行の下に用法・日数の行。検索中も、語を含む学習リストの束を結果の上に点線の枠で出す。 | chart-order-panel.js, chart-main.css |
| 29 用法 | デジカル p.106 | 用法が未入力の Rp は「用法を選んでください」の赤いボタン（押すと従来の回数・用法の候補）。 | chart-rp.js, chart-main.css |
| 30 コメント追加 | デジカル p.87 | 薬・検査のバッジのメニューに「コメントを追加（探す・記載先を選ぶ）…」を足し、ダイアログで 記載先（処方箋・レセプトに載せる／カルテのみ）→ キーワード → 候補を押す（Enter でその文のまま）。従来の 2 つのメニュー項目も残す。 | encounter-dialogs.js, chart-rp.js |
| 31 定型文 | トプコン パンフ p.2 | 定型文をボタンの並び（2 列のタイル）にした。眼ごとの欄の定型文はタイルの中に 右・左・両。 | chart-order-panel.js |
| 36 警告一覧 | デジカル p.136 | 種類の列に線画の印（要修正・確認・注意）。行ごとの［無効化］で今回はその確認を出さない（確定の記録には警告として残る。検査値の確認・引き継ぎの確認を無効化すると、進むときに自動では済ませない）。「元に戻す」あり。［次へ］のバッジも無効化を引いた数。 | encounter-dialogs.js, encounter-editor.js |
| 38 ショートカット | デジカル p.29 | 1 行「操作 … キー」の枠付きの一覧にし、文字を 14px に上げて余白を詰めた。よく使う操作は 2 列。 | encounter-dialogs.js, chart-main.css |
| 40 印刷 | デジカル p.109 | 印刷メニューを作れる帳票だけの一覧に: カルテ（2 号紙）、カルテ（2 号紙・確定 vN）、眼鏡処方箋／CL 指示書（未発行なら理由つきで押せない）、紹介状・診断書などの文書（左のファイルタブの文書へ）、会計連絡票（確定後。会計連携の画面で印刷）。 | encounter-editor.js |
| 49 会計送信 | デジカル p.167 | カルテの［¥ 送信］の確認ダイアログに、会計連携と同じ品目（区分ごと）を出す。連携済み・再連携の注意。送ると CSV を保存（従来は保存されていなかった）し、受付が会計待なら会計済。API は既存の `/billing/send` と `/billing/day`。 | encounter-dialogs.js, encounter-editor.js |
| 逆引き 下書きカルテ | デジカル p.74〜77 | 受診日より前のカルテに「下書き」の札。会計送信と検査依頼は受診日まで押せない（デジカルの制限と同じ）。保存・確定の流れはハルナスの下書き（未確定）と同じなので、それ以上は足していない。 | encounter-editor.js |
| 逆引き カルテガイド | トプコン | 中央の見出しの下に 主訴・検査・所見・病名・処方・処置・方針・次回 のボタン。入力済みは緑、要確認（検査値が未確認・用法未入力・引き継ぎ未確認・予定のまま）は黄、未入力は白。押すとその欄へ移る（病名は左の病名タブ）。 | lib/chart-guide.js, encounter-editor.js |

27（セット）・28（セット登録）・37（患者ステータス）・39（次回予約）は比較表で「同じ」とされていたため変えていない。

## 写さなかったもの・理由

- 40 の 処方箋（院外）・予約票・受付票・処置行為ラベル・レセプト類: ハルナスに印刷できる帳票が無い（作るなら別の作業。院外処方箋は法定の様式のため、レセコン側での発行を前提にしている）。メニューには実際に作れるものだけを出した。
- 30 のレセプト記載位置（摘要欄内・上部・下部）: ハルナスのコメントは「処方箋・レセプトに載せる／カルテのみ」の 2 つで、CSV に位置の項目が無い。位置を選べても使われないため、記載先の 2 択として写した。
- 25 の院内カタログ（視力検査など）の点数: カタログの項目は診療行為マスターのコードを持たないため出さない（どのコードに当たるかは医院の算定で変わる。点数の計算はレセコン側）。
- デジカルの定期タブ（左の患者情報タブ）と、定期からの処方箋の印刷: 左のタブは別の担当（chart-left）。処方箋の印刷は上のとおり無い。
- 13 のデジカルには検査の帯が無いが、トプコンの読み方（検査を上に）を残し、畳めるようにした。
- 35 の操作帯の絵はデジカルのものを使わず、自前の線画。

## API（追加のみ。platform-api の変更なし）

- `GET /v1/eye/masters/lookup?type=drug|disease|modifier|procedure&codes=a,b`（英数字・最大 100 件）
- `GET /v1/eye/patients/:patientId/regular-orders?date=YYYY-MM-DD`（読める人すべて。date を渡すと due＝今回の対象）
- `POST /v1/eye/patients/:patientId/regular-orders`（医師・管理者。`{ encounterId, name, repeat: next|every|months, repeatMonths }`。CSRF）
- `PATCH /v1/eye/regular-orders/:setId`（名前・繰り返し・`active:false` は医師・管理者、`appliedDate` だけはカルテを書ける人。CSRF）
- bootstrap と `GET /v1/eye/order-sets` は定期（patientId を持つセット）を除いて返す。

## 確認

- `node --test services/eye-api/test/*.test.js`（新規 chart-main.test.js: 定期の権限・検証・一覧から除く・繰り返しの判定、マスターのコード引き）
- `node --test apps/eye-web/test/*.test.mjs`（新規 chart-main.test.mjs: カルテガイドの判定、CSS がトークンだけ）
- `node scripts/next-ui-smoke.mjs`（`assertChartMainRep2`・`assertChartMainSendRep2` を追加）
- `npx next build`
- ui-audit の新しい状態: editor-exam-collapsed, editor-actionbar-finalized, editor-exam-request, editor-send, editor-rp-comment, editor-rp-usage-missing, editor-next-dismissed, editor-regular-create, editor-order-regular（既存の editor, editor-side, editor-order-all, editor-order-phrase, editor-next, editor-shortcuts, editor-print-menu も見た目が変わる）
