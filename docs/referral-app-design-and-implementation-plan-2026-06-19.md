# 紹介状作成アプリ 設計・実装方針

作成日: 2026-06-19

## 結論

紹介状作成アプリは、ゼロから新規に作るのではなく、既存の `referral-web` / `referral-api` を実務向けに拡張する。

現在の土台は、患者・施設・診療科・医師の snapshot を使った紹介状下書き作成、編集、HTMLプレビュー、印刷導線まで実装済み。ただし、現状の `referral-web` は静的HTMLベースで、診療報酬算定アプリやカルテ作成アプリのような業務ワークスペースにはまだなっていない。

今後の方針は、`fee-web` の画面構成・認証・APIプロキシ・ワークスペースUIを踏襲し、紹介状作成を「カルテから診療情報提供書を下書きし、医師・医療事務が確認して出力する」業務アプリにする。

## 製品コンセプト

紹介状作成アプリの主目的は、医師と医療事務の実務を分けて支援すること。

医師の主作業:

- 診療情報提供書を書く
- 紹介目的を明確にする
- 経過、検査結果、処方、依頼事項を整理する
- 最終確認して発行可能な文書にする

医療事務の主作業:

- 宛先医療機関、診療科、医師、住所、電話、FAXを管理する
- 添付資料の有無を確認する
- 印刷、PDF、FAX運用に耐える書式を整える
- 診療情報提供料などの算定もれを防ぐ

実務の文書種別:

- 専門医紹介
- 検査依頼
- 入院依頼
- 逆紹介
- 返書

我々の強みは、すでにカルテ/SOAP、病名、処方、検査、診療報酬算定の情報を扱っていること。したがって、核になる体験は「カルテから紹介状を下書きする」ことに置く。

## 現状

既存実装:

- `apps/referral-web`
- `services/referral-api`
- `packages/referral-contracts`
- `packages/referral-core`
- `organizations/{orgId}/referrals/{referralId}` への保存
- 患者、施設、診療科、医師 snapshot の保存
- referral draft 作成/更新
- `/v1/referral/referrals/{id}/document`
- inline printable HTML document artifact
- ブラウザプレビューと印刷導線

不足:

- `fee-web` / `charting-web` と同等のNext.js業務UI
- 紹介状一覧、詳細ワークスペース、宛先管理、テンプレート管理
- カルテ/SOAPからの明示的インポート
- AI下書き生成
- 実務用の必須項目チェック
- 添付資料管理
- 診療情報提供料の算定連携
- 返書管理

## アーキテクチャ方針

### UI

`referral-web` は `fee-web` をベースに Next.js 化する。

流用するもの:

- app router 構成
- platform auth
- product context
- API proxy
- 2ペインの業務ワークスペース
- sticky footer / action footer
- patient selector
- modal / toast / tabs のUIパターン

新規ログイン実装は作らない。既存のPlatform認証を利用し、`PRODUCT_ID = "referral"` の権限で制御する。

### API

`referral-api` を拡張する。認証は既存の `requireProductContext` を使う。

既存:

- `GET /v1/referral/bootstrap`
- `GET /v1/referral/patients`
- `POST /v1/referral/patients`
- `GET /v1/referral/referrals`
- `POST /v1/referral/referrals`
- `GET /v1/referral/referrals/{id}`
- `PATCH /v1/referral/referrals/{id}`
- `POST /v1/referral/referrals/{id}/document`

追加候補:

- `GET /v1/referral/recipient-directory`
- `POST /v1/referral/recipient-directory`
- `PATCH /v1/referral/recipient-directory/{id}`
- `GET /v1/referral/templates`
- `POST /v1/referral/templates`
- `PATCH /v1/referral/templates/{id}`
- `POST /v1/referral/referrals/{id}/imports`
- `POST /v1/referral/referrals/{id}/draft-ai`
- `POST /v1/referral/referrals/{id}/validate`
- `POST /v1/referral/referrals/{id}/fee-linkage`
- `POST /v1/referral/referrals/{id}/finalize`

### 製品間連携

Charting / Fee のDBをReferralが直接読む実装にはしない。

既存の product boundary 方針に従い、カルテ作成アプリや診療報酬算定アプリから紹介状へ情報を渡す場合は、必ず明示的なユーザー操作にする。

例:

```text
カルテ画面の「紹介状を作成」
↓
charting export 作成
↓
referral import 作成
↓
referral draft に sourceSnapshot として保存
```

これにより、どのカルテから、いつ、誰が、何を取り込んだかを監査できる。

## 画面構成

| fee-web | referral-web |
| --- | --- |
| `/sessions` | `/referrals` 紹介状一覧 |
| `/sessions/new` | `/referrals/new` 新規作成 |
| `/sessions/[id]` | `/referrals/[id]` 編集ワークスペース |
| `/admin` | `/admin` 宛先・テンプレート管理 |

### `/referrals`

紹介状一覧。

表示項目:

- 状態
- 患者
- 宛先医療機関
- 宛先診療科/医師
- 紹介目的
- 作成者
- 更新日
- 発行日

主な操作:

- 新規作成
- 下書きを開く
- 発行済みを確認
- 返書有無を確認

### `/referrals/new`

新規作成。

最初に選ぶもの:

- 患者
- 宛先
- 紹介目的
- 文書種別
- 取り込み元カルテの有無

### `/referrals/[id]`

2ペインの編集ワークスペース。

左ペイン:

- 患者情報
- 作成条件
- 元カルテ/SOAP
- 病名
- 検査結果
- 処方
- 添付資料

右ペイン:

- 下書き編集
- プレビュー
- 確認項目

下書き編集タブ:

- 宛先
- 紹介目的
- 傷病名
- 経過
- 既往歴/合併症
- 検査結果
- 処方
- アレルギー
- 依頼事項
- 備考

プレビュータブ:

- 診療情報提供書として印刷可能な表示
- PDF保存/印刷

確認項目タブ:

- 未入力項目
- 宛先不足
- 添付不足
- 医師確認待ち
- 算定連携未確認

## 優先度

### P0: 最小実用

目的: 書いて、確認して、出せる状態にする。

実装内容:

- `referral-web` を Next.js 化し、`fee-web` の業務UIを流用する
- Platform login / product context / CSRF / API proxy を流用する
- 紹介状一覧、作成、詳細編集画面を作る
- 既存 `referral-contracts` の項目をUI化する
  - 宛先
  - 目的
  - 経過
  - 傷病名
  - 処方
  - アレルギー
  - 依頼事項
  - 備考
- `buildReferralDocument` のHTMLを右ペインでプレビューする
- 印刷/PDF保存に耐える `@media print` を整える
- 下書き保存と状態変更を実装する
  - `draft`
  - `needs_review`
  - `ready`
  - `document_ready`
- 必須項目チェックを入れる
  - 患者
  - 宛先医療機関
  - 宛先医師または診療科
  - 紹介目的
  - 傷病名
  - 経過
  - 依頼事項
  - 作成医師/施設

PDFについて:

- P0ではブラウザ印刷/PDF保存を前提にする
- サーバ側PDFレンダリングは、運用コストとフォント/レイアウト検証が必要なため、P1以降の選択肢にする

### P1: 差別化・事務効率

目的: カルテから下書きでき、宛先と算定もれを管理できる状態にする。

実装内容:

- AI下書き生成
  - カルテ/SOAP、病名、処方から紹介状項目を下書きする
  - AIは文章作成補助に限定する
  - 不明な情報は空欄または要確認にする
- 明示的なCharting/Fee連携
  - `charting` から `referral` への explicit import
  - sourceSnapshot 保存
  - audit event 記録
- 宛先医療機関・医師マスタ
  - 医療機関名
  - 診療科
  - 医師名
  - 医療機関コード
  - 住所
  - 電話
  - FAX
- 目的別テンプレート/定型文
  - 専門医紹介
  - 検査依頼
  - 入院依頼
  - 逆紹介
  - 返書
- 診療情報提供料の算定連携
  - 診療情報提供書を作成した事実を fee 側に橋渡しする
  - B009 診療情報提供料(I) などは令和8マスタと要件を確認してから扱う
  - 点数・自動算定可否はReferralでは決めず、Fee側に候補/根拠として渡す

### P2: 病診連携の運用基盤

目的: 紹介、返書、添付、発行履歴まで管理する。

実装内容:

- 返書管理
  - 紹介状に対する返書を保存
  - 返書未受領の管理
- 添付資料管理
  - 検査結果
  - 画像
  - 処方一覧
  - お薬手帳情報
  - 退院サマリ
- 標準様式準拠
  - 診療情報提供書の標準レイアウト
  - 施設別レイアウト
- 月次・宛先別集計
  - 発行件数
  - 宛先別件数
  - 返書率
  - 算定連携状況
- サーバ側PDFレンダリング
  - 必要な場合のみ
  - Cloud Run/フォント/保存先/コストを別途設計する

## データモデル拡張

既存 `referral` に追加する方向。

### referral

既存:

- `patientId`
- `patientSnapshot`
- `facilityId`
- `facilitySnapshot`
- `departmentId`
- `departmentSnapshot`
- `authorMemberId`
- `authorMemberSnapshot`
- `recipientInstitutionSnapshot`
- `recipientDoctorSnapshot`
- `title`
- `purpose`
- `clinicalSummary`
- `diagnoses`
- `medications`
- `allergies`
- `requestedAction`
- `notes`
- `documentArtifact`
- `status`

追加候補:

- `documentType`
- `urgency`
- `sourceImports`
- `attachments`
- `reviewChecklist`
- `feeLinkage`
- `finalizedAt`
- `sentAt`
- `sentMethod`
- `replyStatus`

### recipientDirectory

宛先マスタ。

- `recipientId`
- `institutionName`
- `departmentName`
- `doctorName`
- `medicalInstitutionCode`
- `postalCode`
- `address`
- `phone`
- `fax`
- `notes`
- `lastUsedAt`

### referralTemplate

目的別テンプレート。

- `templateId`
- `templateType`
- `displayName`
- `purposeTemplate`
- `summaryTemplate`
- `requestedActionTemplate`
- `requiredFields`
- `enabled`

### replyLetter

返書。

- `replyId`
- `referralId`
- `receivedAt`
- `senderInstitution`
- `senderDoctor`
- `summary`
- `documentArtifact`

### feeLinkage

診療報酬算定との橋渡し。

- `feeSessionId`
- `suggestedBillingConcept`
- `status`
- `linkedAt`
- `linkedByMemberId`

## AI方針

AIは紹介状の下書き補助に使う。

AIにやらせること:

- カルテ/SOAPから経過を要約する
- 紹介目的を文章化する
- 検査結果、処方、依頼事項を下書きする
- 文体を整える

AIにやらせないこと:

- 送付可否の最終判断
- 医学的な事実の創作
- ない検査結果や処方の補完
- 診療情報提供料の点数や算定可否の決定

AI出力には、元にしたカルテ/SOAP snapshot を保存する。根拠がない情報は空欄または要確認にする。

## セキュリティ/PII

紹介状は患者氏名、病名、経過、処方、宛先FAX/住所を含む高PII文書。

守ること:

- 既存Platform認証を使う
- product role で読み書きを制御する
- TLS通信
- Firestore保存時の既存at-rest暗号化
- audit eventを残す
- PHI本文をaudit safePayloadに入れない
- 紹介状作成、更新、文書生成、発行、インポートを記録する

AI利用時:

- 外部AIに送信する可能性があることを画面/ポリシーで正直に示す
- 実装していない匿名化や秘匿化をUI上で謳わない
- 文言は実装と一致させる

## 実装順

1. `referral-web` のNext.js化方針を確定する
2. `fee-web` のログイン、APIプロキシ、ワークスペースUIを流用する
3. `/referrals` 一覧を作る
4. `/referrals/new` 作成画面を作る
5. `/referrals/[id]` 2ペイン編集画面を作る
6. 既存APIで下書き保存・更新・document生成を通す
7. print CSSを整える
8. 必須項目チェックを入れる
9. 宛先マスタとテンプレートを追加する
10. Chartingからの明示インポートを追加する
11. AI下書き生成を追加する
12. Fee連携を追加する
13. 返書・添付・発行履歴を追加する

## 完了条件

P0完了条件:

- Platform login後、Referralアプリに入れる
- 患者を選んで紹介状下書きを作れる
- 宛先、目的、経過、傷病名、処方、依頼事項を編集できる
- 保存できる
- 右ペインでプレビューできる
- 印刷/PDF保存できる
- 必須項目の不足が分かる
- 発行可能状態に変更できる

P1完了条件:

- カルテ/SOAPから明示的に取り込める
- AIで下書きを作れる
- 宛先マスタを再利用できる
- 目的別テンプレートを使える
- 診療情報提供料の算定候補をFee側へ橋渡しできる

P2完了条件:

- 返書を管理できる
- 添付資料を管理できる
- 発行履歴を集計できる
- 必要ならサーバ側PDFを生成できる
