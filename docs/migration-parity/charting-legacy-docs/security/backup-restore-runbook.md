# バックアップ・復元・保持運用メモ

更新日: 2026-05-06

## 現在確認できている実装・設定

### Firestore / アプリデータ

- 診療関連データは Firestore を主ストアとして扱う
- retention cleanup scheduler が有効
- 監査ログ、診療関連テキスト、音声ポインタの整理ロジックがある

### Raw audio bucket

- 本番 bucket: `medical-492407-raw-audio`
- `public_access_prevention: enforced`
- `uniform_bucket_level_access: true`
- lifecycle delete age: 7 日

### 定期ジョブ

- `medical-retention-cleanup`
- `medical-billing-enforce-trial-expiration`
- `medical-billing-enforce-grace-periods`

## 現時点で不足しているもの

1. Firestore 復元演習の記録
2. GCS オブジェクト復元演習の記録
3. 復元対象の優先順位と目標時間
4. 連絡体制と承認フローの明文化

## 今後の実施項目

1. STG で Firestore 復元演習を行い、手順と所要時間を記録する
2. raw audio bucket の削除・復元可能性を確認し、runbook に追記する
3. 本書を BCP 文書と相互参照にする
