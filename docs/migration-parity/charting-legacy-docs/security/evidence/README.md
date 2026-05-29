# 証跡収集メモ

更新日: 2026-05-06

本ディレクトリには、外部委託先、保持設定、Data controls、復元演習などの証跡を保存する。

## まず集めるもの

### OpenAI

1. 本番 key が属する org / project 名
2. `Data controls` 画面のスクリーンショット
3. `Zero Data Retention` または `Modified Abuse Monitoring` の設定値
4. 契約・DPA の参照先

### Deepgram

1. DPA / 利用規約
2. 保持期間
3. モデル学習利用有無
4. subprocessor 一覧
5. データ保管地域

### 復元演習

1. Firestore 復元手順
2. 実施日時
3. 所要時間
4. 問題点

## 追加したテンプレート

- [openai-data-controls-checklist.md](/Users/hiradekeishi/medical-ai/medical/docs/security/evidence/openai-data-controls-checklist.md)
- [deepgram-vendor-evidence.md](/Users/hiradekeishi/medical-ai/medical/docs/security/evidence/deepgram-vendor-evidence.md)
- [restore-drill-template.md](/Users/hiradekeishi/medical-ai/medical/docs/security/evidence/restore-drill-template.md)

## 保存ルール

- 生データを含まない
- スクリーンショットは日時が分かる形で保存する
- 外部契約書は社外再配布可否を確認して格納する
