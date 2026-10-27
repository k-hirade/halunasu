# Eye EMR production operations

Last updated: 2026-10-27

眼科カルテを本番で運用するための手順。環境の構築は `eye-environment-rollout.md` を参照。

## 1. データの置き場所

| データ | 場所 |
| --- | --- |
| 患者（氏名・生年月日・番号）、組織、ログイン | Core Firestore `medical-core-497610` |
| カルテ・版・プロファイル・文書・予約・会計連携・監査 | Eye Firestore `halunasu-eye-prod` |
| 画像・PDF・紙カルテ | GCS `gs://halunasu-eye-prod-files`（非公開、一律アクセス制御、CORS は眼科カルテの画面のみ） |

すべて東京リージョン（asia-northeast1）。AI は使っていない。

## 2. バックアップ

- Firestore の自動バックアップ（毎日、14日保持）を `halunasu-eye-prod` と `medical-core-497610` に設定する。
- 本番の Firestore には削除保護を付ける。
- GCS の画像・PDF は追加のみで上書きしない（ソフト削除7日）。

```bash
gcloud firestore backups schedules create --project halunasu-eye-prod --database="(default)" --recurrence=daily --retention=14d
gcloud firestore backups schedules create --project medical-core-497610 --database="(default)" --recurrence=daily --retention=14d
gcloud firestore databases update --project halunasu-eye-prod --database="(default)" --delete-protection
gcloud firestore backups list --project halunasu-eye-prod --location=asia-northeast1
```

標準仕様が求める「物理的かつ論理的に隔離した別環境」への定期バックアップ（別プロジェクト・保持ロック付きバケットへの週次エクスポート）は、認証申請の前に追加する。

## 3. 復元の訓練（3か月に1回、および本番の受け入れ前）

1. 最新のバックアップを一時データベースへ復元する（本番のデータベースは触らない）。

```bash
BACKUP="$(gcloud firestore backups list --project halunasu-eye-prod --location=asia-northeast1 --format='value(name)' | head -1)"
gcloud firestore databases restore --project halunasu-eye-prod --source-backup="${BACKUP}" --destination-database="restore-drill-$(date +%Y%m%d)"
```

2. 件数を本番と比べる（`eye_encounters`・`eye_encounter_versions`・`eye_patient_profiles`）。
3. 結果（日時・バックアップ名・件数・所要時間）をこの文書の末尾に記録する。
4. 一時データベースを削除する。

```bash
gcloud firestore databases delete --project halunasu-eye-prod --database="restore-drill-YYYYMMDD"
```

## 4. 監視

- Cloud Monitoring の外形監視で `eye-api-prod` の `/readyz` を15分ごとに確認し、失敗したら info@halunasu.com にメールする。
- `/readyz?deep=1` は署名付き URL の発行まで確かめる。デプロイ直後に必ず叩く（`fileSigning: ok`）。
- Cloud Logging に患者名・カルテ本文が出ていないことを、四半期ごとに確認する。患者検索は POST 本文で受け取り、URL に氏名を載せない。

## 5. データの出力

- 患者単位: 患者ページ「データの出力」（医師・管理者）。開示請求・転院時の写しに使う。
- 医院単位: 設定「医院データの出力」（管理者）。形式は `halunasu-eye-export-v1`。ファイル本体は含まず、GCS の保管場所を載せる。

## 6. 本番の受け入れ条件

- [ ] API・画面の通しテストがすべて通る（`npm test --workspace @halunasu/eye-web` ほか）。
- [ ] STG で医師・視能訓練士・医療事務の3役で1日分の流れを通す（受付 → 検査 → 診察 → 確定 → 会計連携 → 次回予約）。
- [ ] 本番の `/readyz?deep=1` が `fileSigning: ok`。
- [ ] 自動バックアップが1回以上作られ、復元の訓練を1回行った。
- [ ] 本番の Cloud Logging に患者名・カルテ本文が出ていない。

## 7. 記録

| 日付 | 内容 | 結果 |
| --- | --- | --- |
| | | |
