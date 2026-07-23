# 診療報酬抽出安定性コーパス

## 目的

このコーパスは、同じカルテ本文を複数回処理したときの再現性を測る第3のゲートです。

- `fee-gold`: 決定論エンジンの正しさ
- `fee-soap-e2e-v2 exact`: カルテから期待算定への正しさ
- `fee-stability`: 同一入力に対する確定点数と候補集合の再現性

実患者の本文は含みません。管理継続記載を当日実施と誤認しやすい一般構造を合成しています。

## STG前提

`fee-clinical-events-v15`を含むrevisionをSTGへデプロイし、恒常算定レーンは
`FEE_STANDING_FACTS_STG=true`で明示的に有効化します。PRODは実顧客データでの検証が
終わるまで`FEE_STANDING_FACTS_PROD=false`のままにします。

```bash
FEE_STANDING_FACTS_STG=true \
TARGET_ENV=stg \
TARGET_SERVICE=fee-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

デプロイ後は、対象revisionと環境変数を確認してから基線を作成します。

```bash
gcloud run services describe fee-api-stg \
  --project halunasu-fee-stg \
  --region asia-northeast1 \
  --format='yaml(status.latestReadyRevisionName,spec.template.spec.containers[0].env)'
```

## 判定

- 確定点数: 3反復の分散が `0` であることを必須とします。
- 候補集合: コード、コード候補、表示名から作った集合の全ペア Jaccard を測ります。
- イベント数: 3反復の最大差を記録します。単独では合否にしません。

各反復は新しい合成患者と新しいセッションで実行します。抽出メモ、患者履歴、前回の
standing factを再利用しないため、ここで観測する差は全文抽出経路の揺れです。

## 初回基線

候補 Jaccard の閾値は推測で置かず、デプロイ後の最初の STG 計測で作成します。
初回だけ次を実行し、生成された `result.json` と差分を人が確認してから
`baseline.json` をコミットしてください。

```bash
npm run eval:fee-extraction-stability -- \
  --organization-code yamamoto-demo-stg \
  --login-id yamamoto-admin \
  --password-file .secrets/yamamoto-demo-stg-password.txt \
  --write-baseline \
  --output-dir "docs/fee-stability/$(date +%Y%m%d_%H%M%S)"
```

既存の基線は通常の評価では変更されません。意図的に更新する場合だけ
`--replace-baseline` を併用し、変更理由と比較結果をレビューに残します。

## 通常実行

```bash
npm run eval:fee-extraction-stability -- \
  --organization-code yamamoto-demo-stg \
  --login-id yamamoto-admin \
  --password-file .secrets/yamamoto-demo-stg-password.txt \
  --output-dir "docs/fee-stability/$(date +%Y%m%d_%H%M%S)"
```

フィクスチャだけをネットワーク通信なしで検証する場合:

```bash
npm run eval:fee-extraction-stability -- --dry-run
```

エンジン、抽出プロンプト、候補生成ロジックの変更時は必ず実行します。それ以外は
週次を目安に実行します。基線を下げる変更は自動受入せず、候補差分を確認します。

## 指標の限界

このコーパスは既知の揺れ構造を合成した回帰試験です。全ての診療領域の正解率や、
実顧客カルテにおける揺れ率を表すものではありません。制度上の正しさはgold 2系統と
一次資料による確認を別に維持します。
