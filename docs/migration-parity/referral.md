# Referral Migration Parity

## Verdict

紹介状作成は旧アプリが存在しないため、旧移行ではなく新規アプリ。`referral-web` / `referral-api` はCore shared患者・施設・診療科・医師snapshotを使った下書き作成、編集、inline printable document生成、プレビュー、印刷導線まで実装済み。Netlify静的配信とReferral APIはSTG/PRODへ反映済みで、post-deploy検証ではSTG/PRODとも下書き作成とHTML document artifact生成まで確認した。

## 現行実装

- patient/facility/department/member snapshotを使うdraft作成
- referral update
- `/v1/referral/referrals/{id}/document`
- inline printable HTML document artifact
- browser preview iframe and print button
- 静的HTML UI

## 不足

| 領域 | 状態 | 修正方針 |
| --- | --- | --- |
| UI | プレビュー/印刷導線まで実装済み | 添付/検査値欄は将来拡張 |
| PDF | inline printable HTML | ブラウザ印刷でPDF化。Cloud Run内PDF rendererは費用と運用が必要なため未追加 |
| template | 最小テンプレート | 紹介状/診療情報提供書テンプレートの医療レビューが必要 |
| charting連携 | 直接連携しない | 共通患者/施設/診療科/医師情報のみCore経由で共有 |
| tests | API/Core/staticあり | post-deploy API document生成まで確認済み |

## TO-BE

- Core Platform: shared org/member/facility/department/patient
- Referral product: referral drafts, recipient data, clinical summary, attachments metadata, generated document artifact metadata

## 完了条件

- STG/PRODで紹介状下書き作成、プレビュー用HTML document artifact生成ができる。Done.
- ブラウザの印刷/PDF保存はHTML preview + print buttonで対応する。Done.
- Charting/Feeとは直接DB共有せず、Core shared IDs/snapshotsだけ使う。
- placeholder文言が本番UIから消える。Done.
