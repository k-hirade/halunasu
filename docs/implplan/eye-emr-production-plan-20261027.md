# 眼科カルテ 本番化計画（A〜H）

- 作成: 2026-10-27
- 基準: `~/medical-ai/mock_medical`（GENNAI Eye・M3 デジカル風参照画面）の機能を、Halunasu のクラウド構成（Cloud Run・Firestore・Platform 認証）で本番運用できる形で実装する。
- 範囲外: AI 下書き、検査機器・ORCA・オンライン資格確認・電子処方箋との直接接続（CSV・PDF の受け渡しまで）。
- 進め方: 段階ごとに テスト → STG 反映 → ブラウザ確認 → コミット。本番反映は最後にまとめて確認を取る。

## データの持ち方

| データ | 置き場所 | 版管理 |
|---|---|---|
| 患者基本情報（氏名・生年月日・番号） | Core `organizations/{org}/patients` | 既存 |
| アレルギー・副作用歴・傷病名・既往 | `eye_patient_profiles/{patientId}` | revision で楽観ロック、変更は監査 |
| 受診カルテ | `eye_encounters` / 確定版 `eye_encounter_versions` | 既存（確定で不変の版） |
| 文書（紹介状・診断書など） | `eye_documents` | 下書き → 確定（版） |
| ファイル（OCT・視野・写真・紙カルテ・他院紹介状） | メタデータ `eye_files`、本体は GCS `halunasu-eye-{env}-files` | 追加のみ。削除は論理削除 |
| セット・定型文・検査カタログ・薬剤 | `eye_sets` `eye_phrases` `eye_order_catalog` `eye_drug_presets` | 管理者のみ編集 |
| 予約・受付 | `eye_appointments` | 既存 |

Firestore は配列の入れ子を保存できない。座標などは平らな配列で持つ（テストで検査する）。

## 受診カルテの追加項目

- `exam[side]`: 矯正の種類（眼鏡・CL・ピンホール・検眼レンズ）、測定時刻。確認は `examConfirmations[side] = {by, at}`。値を変えると確認は外れる。
- `orders[]`: 検査・処置オーダー `{orderId, code, name, kind, eye, status: planned|performed|cancelled, performedAt, performedBy, note}`。
- `prescriptions[]`: 院内・院外 `route`、用法 `usage`、`issued`（false＝継続中だが今回は出さない）。左右に分ける操作は行を左右に複製する。
- `flags`: 散瞳 `dilated` と開始時刻 `dilationStartedAt`、CL 装用者、近視治療中。
- `optical`: 眼鏡・CL 処方 `{type, purpose, od/os: {sphere, cylinder, axis, add, prism, base, bc, dia, product}, pd, validDays, note, issued}`。
- `diagnoses`: 確定時に患者の傷病名リストから写し取る（その時点の記録として残す）。

## 確定前のチェック（サーバーで判定し、理由を返す）

止めるもの: 病名・薬剤名の空行、未確認の検査値、予定のままのオーダー、眼鏡・CL 処方の不正値（軸 0〜180、円柱と軸の片方だけ等）。
注意だけのもの: 主訴・方針が空、処方があるのに次回受診がない。

## 段階

| 段階 | 内容 | 主な API |
|---|---|---|
| A | アレルギー・副作用歴（バナー常時表示）、患者単位の傷病名、既往 | `GET/PUT /v1/eye/patients/:id/profile` |
| B | 3列のカルテ画面（左: 過去カルテと項目単位の複写、中央: 今回、右: 候補・比較・予約・履歴）、確定前チェックの表示 | `GET /v1/eye/encounters/:id`（blockers 付き） |
| C | 検査オーダー、検査員の作業画面（受付ボードから）、測定値の確認、散瞳タイマー | `POST /encounters/:id/exam-confirm`、オーダー更新 |
| D | 処方の詳細（院内外・用法・日数・発行なし・左右分割）、セット・定型文 | `GET/POST /v1/eye/sets` `/phrases` |
| E | 眼鏡・CL 処方箋、紹介状・診断書（ひな形・差し込み・印刷・確定） | `/v1/eye/documents` |
| F | ファイル取り込み（GCS）、画像の左右・前回比較、紙カルテ取り込みと要約確認 | `/v1/eye/files` |
| G | 会計連携: 日ごとの確定カルテから実施行為・処方を集計、CSV と会計連絡票、連携済みの記録 | `/v1/eye/billing/handoffs` |
| H | 自動バックアップと復元の実証、患者・医院データの出力、暗室表示、監視、本番の受け入れ | 運用手順 |

## 本番の受け入れ条件

- 全段階の API テスト・画面の通しテストが通る。
- STG で、医師・視能訓練士・医療事務の3役で1日分の流れ（受付 → 検査 → 診察 → 確定 → 会計連携 → 次回予約）を通す。
- バックアップから別データベースへの復元を1回実施し、記録を残す。
- 本番の Cloud Logging に患者名・カルテ本文が出ていない。
