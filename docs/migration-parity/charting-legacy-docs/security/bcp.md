# 事業継続計画（BCP）メモ

更新日: 2026-05-06

## 目的

本書は、ハルナスのサービス継続、障害時復旧、サイバー攻撃時の一次対応を整理する内部資料である。医療機関向け説明資料や監査対応時のたたき台として使う。

## 想定する主要インシデント

1. Cloud Run / Firestore / GCS 障害
2. OpenAI / Deepgram / Stripe / Resend の外部サービス障害
3. アカウント侵害、認証情報漏えい、管理者 MFA 問題
4. raw audio / 診療関連データの誤削除または利用不能
5. 大規模なサイバー攻撃や設定誤り

## 現在確認できている前提

- 複数の Cloud Run service に機能分離されている
- raw audio bucket には lifecycle と public access prevention がある
- retention cleanup scheduler が存在する
- 主要な管理操作には監査ログがある
- privileged role には MFA が要求される

## 初動方針

### サービス障害

- 影響 service の切り分け
- Cloud Run revision / secret / scheduler / Stripe webhook の状態確認
- 契約管理者への告知判断

### セキュリティ事故

- 影響範囲の切り分け
- 対応チャンネル固定
- 証跡保全
- 外部委託先への確認
- 個人情報保護法上の報告要否判断

## 未整備事項

1. 目標復旧時間の明文化
2. 復旧優先順位
3. 役割分担表
4. 夜間休日の連絡体制
5. 復元演習ログ

## 次に埋めるべきもの

1. Firestore 復元演習記録へのリンク
2. GCS 削除復元の可否確認
3. インシデント通知テンプレート
4. 医療機関への暫定運用案内テンプレート
