# 紹介状作成AIアプリ 要件レビュー 2026-06-20

## 結論

紹介状作成アプリの現状実装は、`referral-web` / `referral-api` / `referral-core` / `referral-contracts` により、紹介状下書きの保存、宛先マスタ、テンプレート、HTMLプレビュー、印刷、添付、返書、診療情報提供料への連携状態管理の土台まではできています。

一方で、提示された要件定義案 v0.1 が求める「医療文書作成支援システム」としては、まだ **P0の安全要件が未完成** です。特に不足しているのは、別紙様式11/11の2への明示対応、根拠付きAI下書き、根拠なし記述のブロック、医師のみが確定できる署名/確定フロー、患者・宛先取り違え防止、AI生成・編集・出力の監査ログ、PDF最終成果物の版管理です。

現状は「紹介状下書き管理アプリの基礎」としては良いですが、「AIがカルテから安全に紹介状下書きを作るアプリ」と呼ぶには、AI生成より先に **構造化された紹介状データ、根拠台帳、医師確認ゲート、監査ログ** を固めるべきです。

加えて、このレビューは「新規構築」ではなく **既存の `referral-*` と `platform-api` を拡張する計画** として読むべきです。Patient、Provider/Member、Facility、Department、監査ログ、認証は既存 platform を正とし、紹介状側で重複マスタを作らない方針にします。

## v0.2で明確化すべき前提

### 既存資産を正とする

このアプリはゼロから作るのではなく、既存資産を前提に拡張します。

- `platform-api`: Patient、Member/Provider、Facility、Department、Product RBAC、AuditLog を正とする。
- `referral-contracts`: 紹介状の入力契約、ステータス、宛先、テンプレート、添付、返書、fee linkage の契約を拡張する。
- `referral-core`: 紹介状下書き、文書生成、確認チェック、AI下書き補助を拡張する。
- `referral-api`: CRUD、文書生成、AI下書き、添付、返書、fee linkage、監査ログを拡張する。
- `referral-web`: fee-web / charting-web と同じ platform login とワークスペースUIを踏襲する。

新規に作るべき主な referral 独自データは、宛先医療機関・担当医マスタ、紹介状テンプレート、紹介状下書き/確定版、添付、返書、送付履歴、紹介状用AI生成ログです。患者・医師・施設・診療科・監査基盤は platform と重複させません。

### 認証・権限

FR-01の「医療機関IdP/SSO/MFA」は将来要件です。現行MVPでは、既存の platform 認証を前提にします。

- 病院コード/組織コード + 個人ログインID + パスワード + 既存MFA。
- product role は `referral` を使う。
- draft 作成・編集は医師、クラーク、看護師など施設設定に応じて許可できる。
- final 確定・署名相当操作は医師ロールに限定する。
- IdP/SSO連携はP2以降の施設展開要件として分離する。

### 入力源

MVPの主入力は外部電子カルテ連携ではなく、自社プロダクト連携と手入力です。

- charting: SOAP/診療記録の明示インポート。
- fee: 病名、処方、診療条件、必要に応じた算定候補情報の明示インポート。
- manual: ユーザーが貼り付けたカルテ本文。

SS-MIX2、FHIR、CLINS、外部電子カルテAPI、画像/検査システム連携はP2以降です。

### 外部AI利用方針

要件案では「国内リージョン」「学習利用禁止」「最小化」が求められています。一方、現行の charting / fee は OpenAI など外部AI APIに診療テキストを送る構成を持っています。

紹介状アプリでも外部AIを使う場合は、次のどちらかを製品横断で決める必要があります。

1. 紹介状だけ国内LLM/専用環境にする。
2. 全社として国外AI利用を許容し、DPA、学習利用禁止、保存期間、再委託、国外移転、委託先監督、監査権限を契約と画面表示で担保する。

この方針が決まるまでは、AI下書きは「利用施設の設定で有効化する機能」とし、外部AIに送る入力範囲を監査ログに残します。

### SaMD境界

記載漏れ検出は「カルテに存在する事実が紹介状に転記されていない可能性」を示す文書整合チェックに限定します。新たな禁忌、診断候補、治療提案、緊急度、紹介要否、紹介先選定をAIが判断する機能は入れません。

### 署名・確定

MVPではHPKI等の厳密な電子署名連携までは扱いません。MVPの確定は、platformで本人確認済みの医師が行う「記名相当」の確定操作として扱い、確定者、確定日時、確定版、差分、監査ログを保存します。HPKIや医師資格証連携はP2以降です。

## 現状実装の確認

### 実装済み

- `referral-api` は platform session / CSRF / product role を使い、`referral` product として認証・認可されています。
- `referrals` の作成、一覧、更新、文書生成、確認項目更新、下書き補助、添付、返書、診療情報提供料連携、宛先マスタ、テンプレートのAPIがあります。
- `referral-core` は referral draft の生成、更新、HTML文書生成、簡易下書き補助、確認チェックリスト、添付、返書、fee linkage を持っています。
- `referral-web` は一覧、新規作成、詳細ワークスペース、編集、プレビュー、確認項目、宛先/テンプレート管理のUIを持っています。
- `sourceImports` により、charting/feeなど他プロダクト由来の情報を明示的にスナップショットとして取り込む設計になっています。
- APIテストでは、認証必須、患者作成、紹介状作成、文書生成、宛先、テンプレート、取り込み、下書き補助、添付、返書、fee linkage、viewer拒否が確認されています。

### 部分実装

- `draft-ai` は存在しますが、現状は外部AIによる根拠付き生成ではなく、SOAP風テキストを簡易分解して目的・経過・処方などへ反映するルールベース補助です。
- `reviewChecklist` はありますが、内容は患者、宛先、目的、経過、傷病名、依頼事項、作成者などの必須項目チェック中心です。患者取り違え、宛先誤り、古い処方、根拠なし文、添付漏れ、疑い病名の断定などの医療安全チェックにはまだなっていません。
- `documentArtifact` はHTMLとtextを保存します。ブラウザ印刷でPDF保存はできますが、サーバ側で正式PDFを生成・版管理しているわけではありません。
- `finalize` APIはありますが、現状のコード上は referral write 権限があれば呼べます。医師だけが確定できる制御、署名情報、未確認項目がある場合の確定ブロックは未完成です。
- 添付・返書の器はありますが、検査結果・画像レポート・退院サマリー等の自動候補化や、添付同意/出力可否管理は未実装です。
- 診療情報提供料への連携は `feeLinkage.status` の状態管理であり、Fee側へ実際に算定候補を作る連携ではありません。
- platform-api の Patient / Member / Facility / Department / AuditLog を前提にしており、これらを referral 側で重複実装すべきではありません。

### 未実装または要注意

- 別紙様式11/11の2に対応する正式な項目スキーマとレイアウト。
- 生成文の文単位/項目単位の根拠リンク。
- 根拠がない医学的記述のブロック。
- 検査値、薬剤量、日付をLLMに創作させないための構造化差し込み。
- 患者ID、氏名、生年月日、性別、紹介先の確定前二重確認。
- 医師署名または記名押印相当の確定処理。
- 医師以外の確定禁止。
- AI生成時の入力範囲、モデル、プロンプト、出力、編集差分、出力先の監査ログ。
- 患者同意、外部AI利用、第三者提供、送付先確認の記録。
- FHIR/CLINS形式の出力。
- 送付管理、自動送信、再送履歴。
- SaMD該当性を避けるための文言・機能境界のUI明示。

## 要件案へのレビュー

### 良い点

要件案の方向性は妥当です。特に次の方針は維持すべきです。

- AIは診断、治療方針、緊急度、紹介要否、紹介先推奨を判断しない。
- AIは下書き、要約、転記補助、記載漏れ検出に限定する。
- 医師の確認・修正・署名なしに確定出力しない。
- 生成文には元カルテ、検査、処方、画像所見などの根拠を表示する。
- 薬剤、検査値、日付、患者情報、宛先はLLMで自由生成せず、構造化データから差し込む。
- 外部AIに実患者データを送る場合は、契約、学習利用禁止、保存期間、国外移転、委託先監督を明確にする。
- MVPでは外部自動送信、FHIR送信、診療報酬自動算定を入れない。

### 注意点

要件案は広い範囲を含んでいるため、初期実装で一気に入れると責務が膨らみます。MVPでは次のように境界を切るべきです。

- 「電子カルテ情報共有サービス連携」「FHIR/CLINS」「SS-MIX2」「外部送信」はP2以降の拡張にする。
- MVPは院内利用、別紙様式11の項目構成、PDF/印刷、医師確定、監査ログまでに絞る。
- 様式11の罫線・見た目まで厳密再現するPDFはP2でよい。P0/P1では「様式11の必要項目を満たすHTML/PDF」を目標にする。
- 診療情報提供料の算定連携は「Fee側へ候補を渡す」までにし、referral側で算定可否や点数を決めない。
- 宛先自動推奨は入れない。宛先マスタからユーザーが選択する。
- 返書管理は器だけならP1でよいが、本格的な連携ループ管理はP2にする。
- 根拠リンクはMVPで文単位まで要求すると重い。P0ではセクション単位の根拠、P1で重要文単位、P2で文単位の完全トレースを目標にする。
- FR-13/14の検査値要約・画像所見要約は、構造化Lab/Imagingが入力にある場合だけ対象にする。現状は charting SOAP と fee 病名/処方が中心なので、MVPで過度に期待しない。

## 推奨するASIS / TOBE

### ASIS

```text
手入力/貼り付け
  ↓
referral draft
  ↓
簡易draft-ai補助
  ↓
free text項目に反映
  ↓
HTML文書生成
  ↓
ブラウザ印刷/PDF保存
```

現状は、紹介状本文が主に自由テキスト項目として扱われています。根拠付き文書生成、構造化検証、医師確定ゲートは薄いです。

### TOBE

```text
入力スナップショット
  - 患者
  - 紹介先
  - 紹介目的
  - 対象期間
  - カルテ/病名/処方/検査/画像/退院サマリー
  ↓
根拠台帳
  - sourceId
  - sourceType
  - date
  - quote
  - structuredValue
  ↓
紹介状構造データ
  - 患者情報
  - 宛先
  - 傷病名
  - 紹介目的
  - 既往歴/家族歴
  - 症状経過/検査結果
  - 治療経過
  - 現在処方
  - 依頼事項
  - 備考
  ↓
AI下書き
  - 文章化のみ
  - 根拠ID必須
  - 根拠なし文は要確認
  ↓
安全チェック
  - 患者確認
  - 宛先確認
  - 薬剤の古さ
  - 検査値/日付/単位一致
  - 疑い病名の断定
  - センシティブ情報過剰記載
  ↓
医師レビュー
  - セクション確認
  - 修正
  - 署名/確定
  ↓
最終成果物
  - PDF
  - 印刷
  - 電子カルテ保存用本文
  - 将来FHIR/CLINS
```

## P0: 安全なMVPに必要な修正

P0は「AI紹介状の完成版」ではなく、「既存platform/referral資産を使って、安全に出せる紹介状作成ワークスペース」を成立させる範囲です。

### 1. 別紙様式11ベースの構造スキーマ

現状の `purpose`、`clinicalSummary`、`diagnoses`、`medications`、`requestedAction` だけでは、正式な診療情報提供書としての項目が粗いです。

追加すべき項目:

- 紹介先医療機関
- 紹介先診療科/担当医
- 紹介元医療機関
- 作成医師
- 患者情報
- 傷病名
- 紹介目的
- 既往歴/家族歴
- 症状経過/検査結果
- 治療経過
- 現在処方
- アレルギー
- 添付資料
- 備考
- 署名/確定情報

### 2. 医師確定ゲート

`finalize` は医師だけが実行できるようにします。クラークや看護師は下書き編集・準備までに制限します。

確定前に必須:

- 患者確認
- 宛先確認
- 紹介目的確認
- 傷病名確認
- 現在処方確認
- 根拠なし文の確認
- 添付資料確認
- 医師署名情報

### 3. 根拠付き下書きモデル

自由テキストだけでなく、各セクションに根拠参照を持たせます。

例:

```json
{
  "section": "clinical_course",
  "text": "3か月前から労作時息切れが増悪しています。",
  "evidenceRefs": [
    {
      "sourceType": "clinical_note",
      "sourceId": "note_001",
      "date": "2026-06-12",
      "quote": "3か月前から坂道で息切れが強くなった"
    }
  ],
  "needsReview": false
}
```

根拠がない医学的記述は、確定前に必ず警告します。

MVPでは、最初から文単位の完全な根拠リンクを要求しません。まずはセクション単位の根拠から始めます。

```json
{
  "section": "clinical_course",
  "text": "紹介状の症状経過欄",
  "evidenceRefs": [
    {
      "sourceProduct": "charting",
      "sourceType": "soap_note",
      "sourceId": "note_001",
      "date": "2026-06-12"
    }
  ],
  "evidenceGranularity": "section"
}
```

P1以降で、重要な検査値、処方、診断名、画像所見だけを文単位/値単位の根拠に引き上げます。

### 4. AI下書きの位置づけを明確化

現状の `draft-ai` は簡易補助です。本格AIを入れる場合は、出力を自由文ではなくJSONにします。

AIにやらせること:

- カルテ記載の要約
- 様式項目への振り分け
- 文体整形
- 記載漏れ候補の提示

AIにやらせないこと:

- 診断名の創作
- 検査値の計算/補完
- 薬剤名・用量・日数の創作
- 治療方針の提案
- 紹介要否判断
- 紹介先選定

特に禁忌・アレルギー関連は、AIが新たに医学的危険を判定するのではなく、元データに存在するアレルギー/禁忌/注意情報が紹介状に転記されていない場合の整合チェックに限定します。

### 5. 文書出力の版管理

HTMLプレビューだけでなく、最終版として次を保存します。

- finalDocumentId
- version
- renderedText
- renderedHtml
- PDF artifact metadata
- finalizedByMemberId
- finalizedAt
- sourceSnapshotHash
- aiGenerationId
- editDiff

### 6. 監査ログ拡張

現状もAPI操作ごとのauditはありますが、医療文書としては粒度を増やすべきです。

最低限必要:

- 患者閲覧
- 紹介状作成
- AI下書き生成
- 取り込み元データ
- 編集
- 確認チェック
- 文書生成
- 印刷/PDF保存
- 確定
- 送付/再送
- 添付追加/削除
- 返書登録
- 権限変更

監査ログは既存 platform の `createAuditEvent` を正とし、referral-api はそこへイベントを追加します。referral 独自の監査基盤を別に作りません。

### 7. PDF/印刷の段階分け

現状の `buildReferralDocument` はHTML/text生成です。P0では印刷CSS付きHTMLとブラウザPDF保存を明確にサポートし、P1でサーバPDF生成、P2で様式厳密PDFに進めます。

## P1: 差別化と実務効率

### 1. charting / fee からの明示インポート

カルテ作成アプリや診療報酬算定アプリから、ユーザー操作で紹介状用スナップショットを取り込めるようにします。referral-apiが他プロダクトDBを直接読むのではなく、明示的なエクスポート/インポートにします。

### 2. 構造化処方・検査・画像の差し込み

薬剤、検査値、画像所見はLLMに生成させず、構造化データから差し込みます。ただし現状は構造化Lab/Imagingが一級データとして常に存在する前提ではないため、P1ではまず処方と病名、SOAP由来の明示記載を対象にします。検査値・画像レポートの本格要約はデータソース確認後に段階追加します。

- 現在処方: 薬剤名、用量、用法、日数、最終処方日、中止/休薬
- 検査値: 項目、値、単位、日付、異常フラグ
- 画像: レポート所見、診断、検査日、レポート作成者

### 3. 安全チェックUI

「確認項目」タブを、必須項目チェックから医療安全チェックへ拡張します。

- 患者取り違え
- 宛先確認
- 古い処方
- 根拠なし文
- 疑い病名の断定
- 重要検査の未添付
- アレルギー未記載
- センシティブ情報過剰記載

### 4. 宛先マスタの実務化

宛先マスタに次を追加します。

- 医療機関コード
- 診療科
- 担当医
- 住所
- 電話
- FAX
- 電子送信先ID
- よく使うテンプレート
- 過去送付履歴

### 5. 診療情報提供料との連携

referral側は「紹介状作成の事実」をFee側へ渡すだけにします。診療情報提供料の算定可否、月1回、紹介先、添付、診療情報提供書要件はFee側で判定します。

### 6. 返書管理

紹介状は「紹介して終わり」ではなく、返書受領まで含めて病診連携のループです。現状も `replies` の器はあるため、P1では返書受領、要約、紹介状へのひも付け、未返書一覧までを追加候補にします。

## P2: 標準連携・多施設運用

- FHIR/CLINS形式の出力。
- 退院時サマリー添付。
- 電子カルテ情報共有サービス連携。
- SS-MIX2取り込み。
- 返書管理の本格化。
- 外部送信・再送履歴。
- 施設別テンプレート。
- 品質ダッシュボード。
- 医師修正率、根拠なし文率、作成時間短縮率の評価。
- HPKI等の電子署名連携。
- IdP/SSO連携。
- 様式厳密PDF。

## 反例・過剰実装になりやすい点

### 宛先推奨は入れない

紹介先医療機関の自動選定は、医療判断・地域連携・責任分界が絡みます。MVPでは宛先マスタからユーザーが選ぶだけにします。

### 紹介要否判定は入れない

「紹介すべきか」をAIが判断すると、診断・治療方針支援に近づきます。紹介状作成支援に限定します。

### AIに薬剤・検査値を生成させない

薬剤名、用量、用法、日数、検査値、単位、日付は構造化データをそのまま使います。LLMは文章化だけにします。

### 自動送信は後回し

誤送信は重大事故になります。MVPではPDF/印刷/電子カルテ保存までにし、外部送信はP2以降にします。

## 受け入れ基準

P0完了時点で最低限次を満たすべきです。

1. 医師以外は確定できない。
2. 未確認項目がある場合は確定できない。
3. 確定前に患者と宛先の確認が必要。
4. 医学的記述には根拠参照がある、または根拠なしとして警告される。
5. 薬剤、検査値、日付は構造化データまたは明示入力から出力される。
6. AI下書き、編集、確定、文書生成の監査ログが残る。
7. 最終版文書は版管理される。
8. UI上で「AI下書き」「医師確認必須」が明示される。
9. 診断・治療・紹介要否・紹介先推奨をAIが行わないことが画面と仕様で明確。
10. P0のテストで、クラーク確定不可、根拠なし文警告、患者/宛先未確認確定不可、HTML/PDF出力、audit記録を確認する。
11. 検証データは診療科数・件数を明示する。例: 5診療科 x 20件のゴールドセットで重大誤記0、根拠なし医学記述0、患者/宛先誤り0。

## 実装優先順位

### 最初にやるべき

1. 既存 platform / referral 資産を正とする設計前提をコード・docs・テストに反映。
2. 別紙様式11の構造スキーマを `referral-contracts` に追加。
3. `referral-core` の文書生成を自由テキスト結合から様式項目ベースに変更。
4. `reviewChecklist` を医療安全チェックへ拡張。
5. `finalize` を医師ロール限定にし、未確認項目がある場合は拒否。
6. `draft-ai` の出力を根拠付きJSONへ変更するための契約を追加。
7. `documentArtifact` に final/draft、version、finalizedBy、sourceSnapshotHash を追加。
8. 監査ログにAI生成、編集、確定、印刷/PDF保存を明示。
9. 外部AI利用方針を製品横断で決め、UI文言と契約要件に反映。

### その次

1. chartingから紹介状用スナップショットを明示エクスポート。
2. 処方・検査・画像の構造化差し込み。
3. 根拠確認ビュー。
4. 添付候補。
5. 診療情報提供料のFee連携。

## 具体的な修正方針

ここでは、既存の `platform-api` / `referral-contracts` / `referral-core` / `referral-api` / `referral-web` を前提に、実装タスクへ分解します。新規アプリを作り直すのではなく、既存の紹介状基盤を医療文書作成支援として強化します。

### Phase 0: 既存前提の整理

目的: 既存 platform と referral の責務を明確にし、重複実装を防ぐ。

修正対象:

- `docs/referral-app-design-and-implementation-plan-2026-06-19.md`
- `packages/referral-contracts`
- `services/referral-api`
- `apps/referral-web`

実装内容:

1. Patient / Provider / Facility / Department / AuditLog は platform を正とすることをREADMEまたは設計docsに明記する。
2. referral側に新規で持つデータを限定する。
   - referral draft
   - referral final document
   - recipient directory
   - referral template
   - attachment
   - reply letter
   - fee linkage
   - AI generation log
3. `referral-api` のコメントまたはREADMEに「charting/fee DBを直接読まない。明示インポートのみ」と明記する。
4. テストに「referral-api does not import sibling product services」が既にあるため、これを維持し、charting/fee直接依存が入ったら落ちる状態にする。

受け入れ基準:

- referral 側で Patient / Provider / Facility を独自マスタとして作らない。
- charting-api / fee-api を referral-api が直接 import しない。
- platform の product context / CSRF / RBAC を使う。

### Phase 1: 別紙様式11に寄せた構造スキーマ

目的: 自由テキスト中心の draft から、診療情報提供書の項目単位で扱える draft へ移行する。

修正対象:

- `packages/referral-contracts/src/index.js`
- `packages/referral-core/src/index.js`
- `packages/referral-core/test/index.test.js`
- `services/referral-api/test/server.test.js`
- `apps/referral-web/components/referral-workspace.js`

追加するデータ構造:

```js
referralFormSections: {
  recipient: {
    institutionName,
    departmentName,
    doctorName,
    address,
    phone,
    fax
  },
  sender: {
    facilityName,
    departmentName,
    doctorName
  },
  patient: {
    displayName,
    birthDate,
    sex,
    patientId
  },
  diagnoses: [],
  referralPurpose: "",
  pastHistory: "",
  familyHistory: "",
  clinicalCourseAndFindings: "",
  treatmentCourse: "",
  currentMedications: [],
  allergies: [],
  requestedAction: "",
  attachments: [],
  notes: ""
}
```

方針:

- 既存の `purpose` / `clinicalSummary` / `diagnoses` / `medications` / `requestedAction` はすぐ消さず、移行互換フィールドとして残す。
- 新しい `referralFormSections` を優先して文書生成する。
- 古いフィールドしかない紹介状は、`referral-core` で表示時に新形式へ変換する。

受け入れ基準:

- 新形式だけで紹介状HTMLが生成できる。
- 旧形式の既存データも壊れず表示できる。
- 別紙様式11の主要項目が欠落しない。

### Phase 2: 根拠台帳とセクション単位の根拠

目的: AI下書きやインポート内容が、どの元データに基づくかを追えるようにする。

修正対象:

- `packages/referral-contracts/src/index.js`
- `packages/referral-core/src/index.js`
- `services/referral-api/src/server.js`
- `services/referral-api/src/store/*`
- `apps/referral-web/components/referral-workspace.js`

追加するデータ構造:

```js
sourceEvidenceRefs: [
  {
    evidenceId,
    sourceProduct,  // charting / fee / manual
    sourceType,     // soap_note / diagnosis / medication / free_text
    sourceId,
    sourceDate,
    label,
    excerpt,
    snapshotHash
  }
]

sectionEvidence: {
  clinicalCourseAndFindings: ["evidence_001", "evidence_002"],
  currentMedications: ["evidence_003"],
  diagnoses: ["evidence_004"]
}
```

方針:

- MVPでは文単位ではなく、セクション単位の根拠を必須にする。
- 手入力の場合も `sourceProduct=manual` として evidence を作る。
- AI下書きが作ったセクションに根拠がない場合は `needsReview=true` にする。

受け入れ基準:

- 各主要セクションに、少なくとも「どの取り込み元から作ったか」が表示できる。
- 根拠なしセクションは確認チェックに出る。
- 医師が根拠なしのまま確定しようとするとブロックまたは明示確認が必要になる。

### Phase 3: 医師確定ゲート

目的: 医師確認なしに正式文書化できない状態にする。

修正対象:

- `services/referral-api/src/server.js`
- `packages/referral-core/src/index.js`
- `packages/referral-contracts/src/index.js`
- `apps/referral-web/components/referral-workspace.js`
- `services/referral-api/test/server.test.js`

実装内容:

1. `finalize` APIを医師ロール限定にする。
   - `doctor`
   - `admin` は施設運用上必要なら許可。ただし本番では原則doctorのみ推奨。
2. `finalize` 前に `reviewChecklist` を必ず評価する。
3. 必須チェック未通過なら `400` で拒否する。
4. 確定時に以下を保存する。
   - finalizedByMemberId
   - finalizedByMemberSnapshot
   - finalizedAt
   - finalDocumentVersion
   - confirmationChecklist

最低限の確認項目:

- 患者確認
- 宛先確認
- 紹介目的確認
- 傷病名確認
- 現在処方確認
- 根拠なしセクション確認
- 添付確認

受け入れ基準:

- クラーク/看護師は下書き編集できるが確定できない。
- 未確認項目があると確定できない。
- 確定者・確定日時が残る。
- 確定後の文書には final version が付く。

### Phase 4: 医療安全チェックの拡張

目的: 現在の必須入力チェックを、紹介状としての安全チェックへ拡張する。

修正対象:

- `packages/referral-core/src/index.js`
- `packages/referral-contracts/src/index.js`
- `apps/referral-web/components/referral-workspace.js`

追加するチェック:

```text
patient_identity_confirmed
recipient_confirmed
purpose_present
diagnoses_present
current_medications_reviewed
allergies_reviewed
source_evidence_present
no_unsupported_ai_statement
attachments_reviewed
doctor_author_confirmed
```

注意:

- 禁忌やアレルギーの「新規医学的警告」は行わない。
- 元データにアレルギー情報があるのに紹介状に出ていない、という転記整合チェックに限定する。

受け入れ基準:

- チェックはUIで見える。
- どの項目が不足しているかが医師に分かる。
- `reviewChecklist` がAPIレスポンスとUIで一致する。

### Phase 5: AI下書き契約の再定義

目的: `draft-ai` を自由文反映ではなく、根拠付き構造化下書きへ移行する。

修正対象:

- `packages/referral-contracts/src/index.js`
- `packages/referral-core/src/index.js`
- `services/referral-api/src/server.js`
- `apps/referral-web/components/referral-workspace.js`

AI出力の目標形式:

```js
{
  provider: "openai" | "local_rule" | "domestic_llm",
  generatedAt,
  model,
  promptVersion,
  sections: {
    referralPurpose: { text, evidenceIds, needsReview },
    clinicalCourseAndFindings: { text, evidenceIds, needsReview },
    treatmentCourse: { text, evidenceIds, needsReview },
    requestedAction: { text, evidenceIds, needsReview }
  },
  warnings: []
}
```

方針:

- 薬剤名、用量、日付、検査値はAIに生成させない。
- 構造化データがある場合はプログラム側で差し込む。
- 外部AI利用は設定でON/OFFできるようにする。
- 外部AIに送った入力範囲、モデル、プロンプトバージョンを監査ログへ残す。

受け入れ基準:

- AI出力に根拠IDがない医学的セクションは確認対象になる。
- AI出力をそのまま確定文書にできない。
- UIに「AI下書き」「医師確認必須」が表示される。

### Phase 6: 文書出力と版管理

目的: プレビューHTMLではなく、正式な紹介状成果物として管理できるようにする。

修正対象:

- `packages/referral-core/src/index.js`
- `services/referral-api/src/store/*`
- `apps/referral-web/components/referral-workspace.js`

実装内容:

1. `documentArtifact` に draft/final を分ける。
2. `documentVersion` を付与する。
3. final artifact は確定後のみ作成できる。
4. P0ではHTML + print CSS + ブラウザPDF保存でよい。
5. P1でサーバPDF生成を追加する。
6. P2で様式厳密PDFを追加する。

受け入れ基準:

- 下書きプレビューと確定版を区別できる。
- 確定版の作成者・作成日時・versionが残る。
- 確定後の再編集は新version扱いになる。

### Phase 7: fee連携

目的: 紹介状作成の事実を診療報酬算定アプリに渡せるようにする。ただし referral 側で算定判断しない。

修正対象:

- `packages/referral-core/src/index.js`
- `services/referral-api/src/server.js`
- `apps/referral-web/components/referral-workspace.js`
- 将来 `services/fee-api`

方針:

- referral側では `feeLinkage.status=suggested` まで。
- Fee側へ渡す場合は、紹介状ID、作成日、宛先、文書種別、確定者、確定日時を渡す。
- 診療情報提供料の算定可否、月1回制限、紹介先条件、添付条件はFee側で判断する。

受け入れ基準:

- referral UIで「診療情報提供料の候補としてFeeへ送る」操作ができる。
- referral側で点数や算定可否を決めない。

### Phase 8: 返書管理

目的: 紹介状と返書をひも付け、病診連携のループを管理する。

修正対象:

- `packages/referral-contracts/src/index.js`
- `packages/referral-core/src/index.js`
- `services/referral-api/src/server.js`
- `apps/referral-web/components/referral-workspace.js`

実装内容:

- 返書受領日
- 返書送信元
- 返書要約
- 返書artifact
- 返書ステータス
- 未返書一覧

受け入れ基準:

- 紹介状ごとに返書を登録できる。
- 返書未受領の紹介状を一覧できる。
- 返書操作が監査ログに残る。

### Phase 9: テスト計画

最低限追加するテスト:

- `referral-contracts`
  - 様式11構造スキーマのvalidate
  - evidenceRefsのvalidate
  - AI下書きJSONのvalidate
- `referral-core`
  - 旧形式から新形式への互換変換
  - 様式項目ベースのHTML生成
  - reviewChecklist拡張
  - final document versioning
- `referral-api`
  - doctor以外finalize不可
  - 未確認項目ありfinalize不可
  - draft-ai audit
  - document_created / finalized audit
  - sibling product direct import禁止
- `referral-web`
  - 新規作成
  - 詳細編集
  - 根拠表示
  - 確認項目
  - プレビュー/印刷

### 実装順

実際の着手順は次を推奨します。

1. contractsに様式11構造・evidence・finalize契約を追加。
2. coreで旧形式互換変換と様式項目HTML生成を追加。
3. coreでreviewChecklistを医療安全チェックへ拡張。
4. apiでfinalize権限制御と未確認ブロックを追加。
5. apiでauditイベントを拡張。
6. webで編集UIを様式項目ベースへ寄せる。
7. webで確認項目と根拠表示を追加。
8. draft-aiを根拠付きJSON契約へ移行。
9. PDF/版管理を強化。
10. fee連携・返書管理を拡張。

## 最終評価

要件定義案 v0.1 は、医療安全、個人情報、AIガバナンス、実務フローの観点がよく押さえられています。現状実装はその土台として使えますが、まだ「AI紹介状作成アプリ」としては安全機構が足りません。

今すぐ本格AI生成を入れるより、先に **紹介状の構造スキーマ、根拠台帳、医師確定ゲート、医療安全チェック、監査ログ、版管理** を作る方がよいです。その上でAIは、根拠付きJSONを返す下書き生成器として接続するのが安全で、長期的にも保守しやすい設計です。

v0.2への更新方針としては、次の5点を最優先にします。

1. 新規構築ではなく、既存 `referral-*` と `platform-api` の拡張として書く。
2. Patient / Provider / Facility / Department / AuditLog は platform を正とする。
3. OpenAI等の外部AI利用と国内リージョン要件の整合を製品横断で決める。
4. MVPは、様式11の項目準拠、セクション単位の根拠、charting/fee社内連携、HTML/PDF出力、医師確定に絞る。
5. SaMD境界、署名粒度、返書管理、診療情報提供料連携を段階別に明記する。
