# Referral Migration Parity

## Verdict

紹介状作成は旧アプリが存在しないため、旧移行ではなく新規アプリ。`referral-web` / `referral-api` はCore shared患者・施設・診療科・医師snapshotを使った下書き作成、編集、inline printable document生成まで実装済み。Netlify静的配信はSTG/PRODへ反映済み。ただしブラウザ印刷/PDF UX確認と、医療文書としてのテンプレート精度確認は未完了。

## 現行実装

- patient/facility/department/member snapshotを使うdraft作成
- referral update
- `/v1/referral/referrals/{id}/document`
- inline printable HTML document artifact
- 静的HTML UI

## 不足

| 領域 | 状態 | 修正方針 |
| --- | --- | --- |
| UI | 最小実装済み | プレビュー表示、印刷導線、添付/検査値欄を追加 |
| PDF | inline printable HTML | ブラウザ印刷でPDF化。将来、必要ならCloud Run内PDF rendererを追加 |
| template | 最小テンプレート | 紹介状/診療情報提供書テンプレートの医療レビューが必要 |
| charting連携 | 直接連携しない | 共通患者/施設/診療科/医師情報のみCore経由で共有 |
| tests | API/Core/staticあり | ブラウザUI smokeと印刷プレビューsnapshot相当を追加 |

## TO-BE

- Core Platform: shared org/member/facility/department/patient
- Referral product: referral drafts, recipient data, clinical summary, attachments metadata, generated document artifact metadata

## 完了条件

- STG/PRODで紹介状下書き作成、編集、プレビュー、印刷/PDF出力相当ができる。Static deploy Done / end-to-end Pending.
- Charting/Feeとは直接DB共有せず、Core shared IDs/snapshotsだけ使う。
- placeholder文言が本番UIから消える。Done.
