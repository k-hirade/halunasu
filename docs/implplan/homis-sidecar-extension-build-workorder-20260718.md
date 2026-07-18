# 作業依頼: HOMISサイドカー拡張の実装とmockデモ完成 (①mock改修〜④デモ検証) (2026-07-18)

親設計: `docs/implplan/homis-sidecar-extension-plan-20260718.md`(以下「親plan」)。
サーバ側(統合API `/v1/integrations/sidecar/calculate`・スコープトークン・ドラフト機構・
デプロイゲート)は**実装済み**。本チケットはその上に「mock_partner(bomis)の画面で実際に触れる」
状態を作る残り全部をまとめる。

## 意図

- デモ・検証のUIは**自社fee-webではなくbomisの画面＋拡張パネル**。顧客のカルテ画面の横で
  「読み取り→算定→候補表示」が動くことを見せるのがゴール。
- 拡張から見えるのは全て**候補(candidateOnly)**。確定・月次はfee-webの役割のまま
  (親plan §6.5の不変条件。デモでも崩さない)。
- 実HOMIS対応の前哨戦として、G-4(不変ID)・G-5(抽出の原子性)を**mockで先に成立**させ、
  実HOMIS交渉時に「あるべきDOM」の見本と回帰基盤を持っておく。

## 決定事項(2026-07-18レビューで改訂・確定)

1. **認証方式: 最初からデバイス認可方式**(クレデンシャル直接交換案は廃止)。
   - 当初はデモ最短のためパスワード+MFA直接交換を提案したが、①拡張にパスワードを
     入力させる方式は本運用へ持ち越せず作り直しになる、②デバイス認可なら
     パスワードが拡張に一切触れない、ため**移行を挟まず最初からデバイス認可**とする。
   - フロー: 拡張がユーザーコードを表示 → 利用者がfee-webの承認ページ(ログイン+MFA済み
     セッション)でコードを承認 → 拡張がポーリングでトークン取得。詳細はS2。
2. **配置: halunasuリポジトリ内の専用ディレクトリ `clients/homis-sidecar/`**
   (「別リポジトリ」の当初決定を改訂。親plan §6.1.2に決定記録)。
   - 理由: 分離の本体はAPI契約(統合API1本・サーバ側で強制済み)であり、リポジトリ分離は
     手段にすぎない。単独リポジトリはfixture・契約定義・CIの重複(冗長化)と
     契約変更時の2リポジトリ同期コストを生む。同一チーム運用では1リポジトリ内の
     ディレクトリ分離+依存ガードで同じ分離効果を得られる。
   - ガードレール(冗長な結合を防ぐ):
     - `clients/homis-sidecar/` は**独立package.json**を持ち、halunasuのworkspacesに入れない。
     - halunasu内部(`packages/`・`services/`)への import を**禁止し、テストでgrep検証**する
       (共有してよいのはAPI契約のJSONスキーマ/フィクスチャのコピーのみ。参照ではなく複製し、
       契約スナップショットテストで乖離を検知する)。
     - `.gcloudignore` に `clients/` を追加し、サーバのビルドコンテキストへ入れない。
     - 拡張のテストはサーバCIと独立したnpm scriptで実行する。
3. セレクタ契約バージョンは `homis-mock-v2`(v1=PoC契約+不変レコードID対応)。
4. **fee-webに追加するUIは「サイドカー承認ページ1枚」だけ**。ドラフトの閲覧UIは作らない
   (確認はAPIで行う。④#7参照)。ドラフト採用UIも本チケットのスコープ外。

---

## ① mock_homis改修(拡張の前提。mockリポジトリ側の作業)

1. **カルテ日付を2026-06系へ更新**。
   - 理由: 本番統合APIには日付移送が無い(PoC限定機能として意図的に廃止)。現在のmockは
     2025年日付のため、STGマスタ(適用2026-06-01〜)の期間外となり全カルテ0点になる。
   - halunasuの評価データセットに日付シフト済みの前例
     (`scripts/mock_homis_shift_recalculation_diff_dates.py` と
     `tmp/dataset_recalculation_diff_diagnosis/`配下)があるため、同じ月割当で揃える
     (患者1001〜1013の診療日を2026-06内の同一日付間隔で再配置)。
   - カレンダー表示(`.cal-title`)も2026年6月に追随すること。
2. **不変レコードIDのDOM露出**。
   - 表示中カルテのコンテナに `data-record-id="<一意ID>"` を追加する。
     形式は任意だが、**患者・診療日・同日複数レコードを跨いで一意**であること
     (推奨: `"{patientId}-{YYYYMMDD}-{連番}"` か UUID)。
   - 既存の表示用カルテID(患者+MMDD)は表示のまま残してよい(冪等キーには使わない。
     親plan G-4: 年欠落・同日複数で曖昧なため)。
   - カルテ切替(前/次)でこの属性が必ず更新されること。
3. 受け入れ: bomisの患者詳細で、任意のカルテ表示時に
   `#pdetail_karte[data-record-id]` が一意値を持ち、SOAP・日付が2026-06で表示される。

## ② STG有効化(halunasu側のデプロイ作業)

1. 開発用拡張のIDを固定する: 拡張の `manifest.json` に `key`(公開鍵)を設定し、
   unpackedロードでもIDが不変になるようにする(IDは32文字の`[a-p]`)。
2. デプロイ環境変数(デプロイゲートが形式検証する。親コミット済み実装):
   ```
   HOMIS_SIDECAR_ENABLED_STG=true
   HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS_STG=<固定した拡張ID>
   HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS_STG=homis-mock-v2
   HOMIS_SIDECAR_DRAFT_RETENTION_DAYS_STG=30
   ```
   `APP_FIELD_ENCRYPTION_KEY` が無ければデプロイが自動で落ちる(想定どおり。先にsecret作成)。
3. デモ用アカウント: yamamoto組織にMFA登録済みのメンバーを用意し、
   `homis_sidecar` エンタイトルメントを有効化する。
4. 受け入れ: `/readyz` 正常、`POST /v1/integrations/sidecar/calculate` が
   認証なしで401/フラグOFF環境で404を返す(有効化の確認)。

## ③ 拡張実装(halunasu内 `clients/homis-sidecar/`・4スライス)

### ディレクトリ構成(確定)

```
clients/homis-sidecar/          (独立package.json。workspaces非参加・内部import禁止)
├ extension/
│  ├ manifest.json        (MV3, key固定, sidePanel+tabs, host_permissions最小)
│  ├ sw.js                (sidePanel動作のみ)
│  ├ content.js           (抽出+契約検証+proof素材収集。通信しない)
│  ├ sidepanel.html / sidepanel.js
│  └ lib/ (api.js=通信, proof.js=extractionProof構築, contract.js=セレクタ契約定義)
├ test/
│  ├ fixtures/*.html      (mockの患者詳細HTMLスナップショット)
│  └ *.test.mjs           (node:test。抽出・契約検証・proofのユニット)
└ e2e/ (Playwrightスモーク)
```

host_permissions: mockのオリジン(localhost:8899)と STGのplatform/fee APIドメインのみ。
PoCコードの復元元: halunasu コミット `0acbf03` の `poc/homis-sidecar/` +
親plan §5.4(sidepanel.js全文)。

### S1: 抽出コアとセレクタ契約 homis-mock-v2

1. 契約定義(`contract.js`)を宣言的に持つ:
   - 患者ID: URL `patient_id` / レコードID: `#pdetail_karte[data-record-id]`(①で追加) /
     診療日: `.note-soap .karte-date` の M/D + `.cal-title` の年 /
     受付時刻: 同ラベルの HH:MM / SOAP: `#pdetail_karte .note-soap p`(karte-date除く)
   - **必須要素と最低件数**を契約に含める(コンテナ・record-id・日付・SOAP段落>=1)。
     欠落時は抽出失敗として停止(親plan §6.4「部分本文で算定させない」)。
2. `extractionProof` 生成(`proof.js`)。サーバ契約(実装済み
   `validateSidecarExtractionProof`)に一致させる:
   - `patientIdBefore/After`・`sourceRecordIdBefore/After`: 抽出の**前後で**URL/DOMから
     再取得した値(不一致はサーバが400にするが、拡張側でも不一致なら送信前に破棄して再試行)
   - `domMutationDetected`: 抽出中MutationObserverで対象サブツリー変更を監視。変更検知時は
     false以外→送信不可なので、破棄して自動再抽出(最大3回)
   - `contractValidationPassed` / `requiredElementCount` / `matchedRequiredElementCount` /
     `clinicalTextNodeCount`: 契約検証の実測値
   - `previewMatched`: パネルに表示中のプレビュー(患者ID+record-id+本文hash)と
     送信payloadの一致を送信直前に再検証した結果
   - `selectorContractVersion: "homis-mock-v2"` / `extractedAt`: ISO(サーバ側で15分失効)
3. テスト: fixtures(mockからHTML保存)に対して、正常抽出・record-id欠落で停止・
   患者切替(前後ID不一致)で破棄・必須件数不足で停止、をユニットで固定。
   **このfixture群がセレクタ契約の回帰基盤**(mock改修やHOMIS更新の検知器)。

### S2: 認証(デバイス認可方式。パスワードは拡張に一切触れない)

**フロー全体**:

```
拡張: デバイス認可を開始 ──→ platform: userCode発行(10分有効)
拡張: userCodeを表示        利用者: fee-webの承認ページ(ログイン+MFA済み)でコード承認
拡張: ポーリング ──────────→ platform: 承認済みなら grant(長寿命・失効可能) + 初回アクセストークン
拡張: 以後は grant で5分トークンを無音更新 ──→ fee-api 統合APIを呼ぶ
```

**halunasu側(サーバ変更)**:

1. `POST /v1/auth/sidecar-device-authorizations`(新設・認証不要):
   - 入力 `{extensionId, deviceId, codeChallenge}`(extensionIdはallowlist検証)
   - 出力 `{deviceAuthId, userCode, expiresAt, pollIntervalSeconds}`。
     userCodeは紛らわしい文字を除いた8文字英数、有効10分。
   - レート制限: device単位 5回/10分。
2. **fee-web承認ページ(本チケットでfee-webに追加する唯一のUI)**:
   - 例 `/settings/sidecar-approvals`。ログイン+MFA済みセッション必須、
     権限は `org_admin` または fee admin。
   - userCode入力 → 拡張ID・デバイスID・要求内容を表示 → 承認/拒否。
     承認で grant を作成し組織・メンバーに紐づけ、監査イベント
     (`auth.sidecar_device_approved` / `_denied`)を記録。
3. `POST /v1/auth/sidecar-token` を2モードに改修(既存のCookieセッションモードは廃止):
   - **ポーリングモード**: `{deviceAuthId, deviceId, codeChallenge}` →
     未承認なら `authorization_pending`(400系)、承認済みなら
     `{accessToken(5分・既存スコープ仕様), grantId, grantExpiresAt}` を1回だけ返す。
   - **更新モード**: `{grantId, deviceId, codeChallenge}` → 新しい5分アクセストークン。
     grantIdは高エントロピーのサーバ保存シークレット。deviceId・extensionId・
     エンタイトルメント・失効(サーバ側grant失効 + 既存 `HOMIS_SIDECAR_REVOKED_DEVICE_IDS`)を
     毎回検証する。
   - grant寿命は env `HOMIS_SIDECAR_GRANT_TTL_HOURS`(既定720=30日)。失効APIは
     承認ページからの取消(自分の組織のgrant一覧+取消)として同ページに含める。
   - PKCE: 各トークン発行リクエストの `codeChallenge` をそのトークンの
     `proofKeyChallenge` に埋める(算定時の `x-sidecar-code-verifier` 検証は実装済みのまま)。
   - レート制限: 既存の `sidecar-token` **10回/5分**をポーリング・更新の合算に適用
     (pollIntervalSeconds=5秒×10分ポーリングでも上限に収まるようポーリング側で間隔遵守)。
   - 監査: `auth.sidecar_token_issued` に `authMode: "device_poll" | "grant_refresh"` を記録。
4. テスト(platform-api): 発行→承認→ポーリング成功 / 未承認pending / 拒否 / userCode期限切れ /
   grant更新成功 / grant失効後の拒否 / allowlist外extensionId / エンタイトルメント無し /
   レート制限、の9ケース。

**拡張側(`api.js`)**:

- `deviceId`: 初回起動時に乱数生成し `chrome.storage.local` に保存(秘密ではない。失効単位)。
- `grantId`: **chrome.storage.localに保存してよい**(これが「長期資格」だが、サーバ側で
  即時失効できる・deviceId+extensionId拘束・パスワードではない、を根拠とする。
  アクセストークンとPKCE verifierはメモリのみ)。
- PKCE: トークン要求ごとに verifier(43-128字)を新規生成しメモリ保持、challenge(S256)を送信、
  算定時は `x-sidecar-code-verifier` ヘッダで送る。
- パスワードを扱うコード・フォームは**存在しない**ことをレビュー観点にする。

### S3: パネルUI

1. 画面フロー:
   `未接続 → デバイス認可(userCode表示+承認待ち) → 読み取り → プレビュー+区分選択 → 算定 → 結果`
   (grant保存済みなら次回以降は無音でトークン更新し「読み取り」から始まる)
2. **受診区分セレクタ**: `定期訪問(home_visit) / 往診(house_call) / 外来(outpatient)` を
   ユーザーが選択し、`setting` + `encounterTypeSource: "user"` で送る。既定は未選択とし、
   **未選択のまま算定不可**(区分をユーザー判断させるのが親plan G-1の当面の解)。
   同一建物区分はH3実装後に追加(それまで非表示)。
3. 結果表示:
   - `estimatedTotalPoints` を見出しに、**「算定案(承認前)」のバッジを常時表示**
     (「確定」の語を使わない。サーバ応答も全行 needs_review/candidateOnly)。
   - candidates を明細由来(calculated_line)と提案由来(proposal)で区分表示。
     codeCandidates付き(曖昧グループ)は「区分選択が必要」の注記。
   - warnings / reviewIssues を折りたたみで全件表示。
   - `sourceRevision` と「同じカルテの再算定は再計算になります」の説明。
4. エラーUX: 401/grant失効→デバイス再承認誘導(userCode再表示) /
   extractionProof失効(400)→「画面を再読み取りしてください」/
   429→待機表示 / 契約検証失敗→「画面の形式が想定と異なります(契約 homis-mock-v2)」。
5. XSS: DOM挿入は全て `textContent` または全値エスケープ(PoC既知欠陥の修正。親plan §6.4)。

### S4: E2Eスモーク(Playwright)

- 永続コンテキストでunpacked拡張をロードし、ローカルmockに対して
  「ログイン(STG)→患者1006を開く→読み取り→区分選択→算定→候補が1件以上表示」を1本通す。
- STG認証情報は環境変数から(リポジトリに置かない)。CIでは資格情報が無ければskip。
- 日常回帰はS1のfixtureユニット、S4はリリース前スモークという分担。

## ④ デモ検証(受け入れシナリオ=顧客デモ台本)

STG+mock_homisで以下が全て通ることを完了条件とする。各行はそのままデモ手順になる。

| # | 操作 | 期待 |
| --- | --- | --- |
| 1 | 患者1006のカルテ→読み取り→区分=定期訪問→算定 | 訪問診療料890点系の候補・がん性疼痛200点候補・**在宅酸素の曖昧候補グループ(区分選択要・点数未確定)**が表示される |
| 2 | 同じカルテをもう一度算定 | 新規ドラフトが増えず**再計算**になる(`sourceRevision`不変・応答200) |
| 3 | 区分=外来で患者の2回目受診カルテを算定 | 再診料+**明細書発行体制等加算1点**が候補に出る(初診カルテでは出ない) |
| 4 | カルテを「次へ」で切替えた直後に古いプレビューのまま算定 | 前後ID不一致で送信されず、再読み取りを促される |
| 5 | 読み取りから15分放置して算定 | extractionProof失効エラー→再読み取り誘導 |
| 6 | 区分未選択で算定ボタン | 押せない(無効) |
| 7 | API確認(fee-webのドラフト閲覧UIは無し) | `GET /v1/fee/sidecar-drafts` に上記ドラフトが見え、月次レセプトAPIの結果には**一切混ざっていない** |
| 8 | 初回セットアップ: userCodeをfee-web承認ページで承認 | 承認後に拡張が自動でトークン取得し算定可能になる。拒否したデバイスは算定不可 |
| 9 | トークン発行を連打 | 上限(**10回/5分**)超過で429となり、パネルが待機表示になる |

## 完了ゲート

- halunasu側: platform-api/fee-api全スイート+gold 2系統不変(S2はトークン発行のみで算定非接触)。
- 拡張側: S1 fixtureユニット全緑+S4スモーク1本緑。
- ④の9シナリオ全通過(実施記録をdocsに残す)。
- 不変条件の再確認: 拡張は候補のみ表示/PHI・トークン・パスワードを永続化しない/
  `sourceUrl`を送らない/パスワードを扱うコードが拡張に存在しない/
  `clients/homis-sidecar/` から `packages/`・`services/` へのimportが0件(grepテストで固定)/
  `.gcloudignore` により拡張コードがサーバのビルドコンテキストへ入らない。

## 明示的にスコープ外

- 同一建物区分・電話再診(H3待ち)。ドラフトの採用UI(fee-web側の役割)。
- 実HOMIS向けセレクタ契約(顧客環境4条件の回答後に `homis-yamamoto-v1` として別途)。
- Chrome Web Store公開・管理ポリシー配布(パイロット判断後)。
