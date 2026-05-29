# OpenAI Data Controls 証跡チェックリスト

更新日: 2026-05-06

目的:

- 本番で利用している OpenAI project が、期待する保持制御になっていることを証跡化する
- 医療機関向け審査、社内監査、プライバシーポリシーの裏付け資料として利用する

## 1. repo / runtime から確認済みの事実

- 本番で使用している主な endpoint
  - `/v1/responses`
  - `/v1/audio/transcriptions`
  - `/v1/realtime`
- `Responses API` では `store: false` を明示
- OpenAI 公式 docs では、以下は ZDR eligible
  - `/v1/responses`
  - `/v1/audio/transcriptions`
  - `/v1/realtime`

参考:

- OpenAI `Your data` guide
  https://developers.openai.com/api/docs/guides/your-data#storage-requirements-and-retention-controls-per-endpoint

## 2. OpenAI 公式 docs で押さえるべきポイント

OpenAI 公式 docs では、以下が明記されている。

1. ZDR eligible endpoint でも、**実際の ZDR は org / project の Data controls 設定次第**
2. `/v1/responses` は既定では application state retention が 30 日だが、ZDR 有効時は `store` が常に `false` 扱いになる
3. `/v1/audio/transcriptions` は abuse monitoring retention / application state retention とも `None`

## 3. 収集する証跡

### 必須

1. 本番 API key が属する **organization 名**
2. 本番 API key が属する **project 名**
3. OpenAI Platform `Settings > Organization > Data controls` のスクリーンショット
4. project-level retention 設定のスクリーンショット

### 推奨

5. API key 一覧画面で、本番 key がどの project に属しているか分かるスクリーンショット
6. 契約 / DPA / BAA の所在メモ

## 4. 記録テンプレート

### 確認日時

- YYYY-MM-DD HH:mm JST:

### 確認者

- 氏名:

### Organization

- org 名:
- Data controls タブの有無:

### Project

- project 名:
- retention setting:
  - `Zero Data Retention`
  - `Modified Abuse Monitoring`
  - `None`
  - `Default`

### スクリーンショット保存先

- `docs/security/evidence/openai-data-controls-<YYYYMMDD>-org.png`
- `docs/security/evidence/openai-data-controls-<YYYYMMDD>-project.png`

## 5. 判定

以下を満たす場合に、`OpenAI 側の保持制御証跡あり` と判断する。

1. 本番 key の属する project が特定できる
2. Data controls の設定値が保存されている
3. 利用 endpoint が公式 docs 上 ZDR eligible と照合できる

## 6. 未完了項目

- [ ] 本番 key の属する project 特定
- [ ] org-level Data controls スクリーンショット
- [ ] project-level retention スクリーンショット
- [ ] DPA / 契約資料の保管先記録
