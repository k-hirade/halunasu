# 現在地と次の一手: 白箱抽出 (2026-07-25 実装後)

親:
[白箱抽出計画](./fee-whitebox-extraction-plan-20260724.md) /
[WX0完了ワークオーダー](./fee-whitebox-wx0-completion-workorder-20260725.md) /
[WX1後の計画](./fee-whitebox-next-after-wx1-shadow-20260725.md) /
[STG runbook](./fee-whitebox-three-lane-shadow-runbook-20260725.md)。

## 結論

WX1・WX2・WX3の成果物と、STGで3レーンを安全にshadow計測する実装は
ローカルで揃った。まだSTGへは配置しておらず、PRODはoffのまま。

「GLiNER方式が本番で完全に動く」段階ではない。現在は以下を正直に区別する。

- 成果物製造: 完了
- ローカル決定論・readiness: 完了
- 32セルSTG shadow計測経路: 実装・dry-run完了
- STG artifacts upload / deploy / 96件実測: 未実施
- 独立人手判定: 未実施
- route / propose / assist昇格: 禁止

## 成果物

| 層 | 成果物 | 主な結果 | 判定 |
| --- | --- | --- | --- |
| WX1 span | `span-wx1-multilingual-minilm-l12-v1` | 決定論100回合格 | shadowのみ |
| WX2 linker | `linker-ruri-v3-30m-v1` | dev recall@5 57.89% (exact alias 32.46%) | shadowのみ |
| WX3 context | `context-wx3-multilingual-minilm-l12-v1` | 決定論100回合格、危険側をabstain | shadowのみ |

WX3は`actionStatus`で高精度なクラスがある一方、
`temporalRelation`と`providerOwnership`は開発データ上で全件abstain。
standingには危険側false positive 1件 (0.529%) がある。したがって安全側の
shadow観測対象ではあるが、route可能という意味ではない。

## WX1カテゴリの根拠

開発データにpositive supportがあり、recall失敗を実測したカテゴリ:

- `imaging`: support 17、TP 0、FN 17
- `treatment`: support 19、TP 0、FN 19

positive supportがなく、失敗とはまだ言えない未計測カテゴリ:

- `material`
- `other`
- `outpatient_basic`
- `pathology`

詳細:
[category coverage](../whitebox-artifact-builds/wx1/wx1-multilingual-minilm-l12-v1/category-coverage.md)。

## 運用実装

1. `configs/runtime-feature-profiles/` に完全なSTG状態を宣言した。
2. profile loaderは全キー必須、環境不一致・`TARGET_ENV=all`をfail-closedにする。
3. モデルはGCSの`artifactType/artifactVersion`へimmutable uploadする。
4. デプロイ前に全ファイルsha256を検証してfee-api build contextへatomic配置する。
5. 白箱cold-load専用timeoutを120秒に分離した。
6. STGハーネスは8科 x 4区分 x 3件 = 96件、holdout 0件を固定選択する。
7. 電話再診は本番契約の`outpatient + telephone_revisit`から`telephone`セルへ正規化する。
8. ログレポータはハーネスのsession IDだけを集計し、欠損・重複・revision混在を拒否する。
9. machine precheckは人手goldを名乗らず、独立判定なしでは昇格ゲートが閉じる。

## 容量・性能

3モデルのartifact合計は1,399,804,036 bytes。独立cold process 3回の最大RSSは
1,650.53 MiBだった。既存fee-api既定の4GiBを維持する。

各層のローカルp95合計は984〜1,252msで、昇格ポリシーの500msを超える。
これはゲートを緩める理由ではなく、最適化または構成見直しが必要という結果。
Cloud Run上のend-to-end telemetryで再確認するまでroute化しない。

詳細:
[runtime summary](../whitebox-artifact-builds/runtime/three-lane-multilingual-minilm-ruri30m-v1/cold-process-summary.md)。

## 次の一手

1. 3成果物をSTG artifact registryへimmutable uploadする。
2. `stg-whitebox-three-lane-shadow` profileでfee-api-stgだけをデプロイする。
3. `/readyz`でrevision、3モード、3artifactを確認する。
4. 32セル96件を実行し、session allowlist付きでログを集計する。
5. latency、degraded、routable、棄却理由を評価する。
6. 別途作成した独立判定データをゲートへ入力する。
7. isolated shadowを理解した後だけ`stg-full-validation`で縦断・standing・月次背反を再走する。
8. その後にWX1 imaging/treatment補強と、L3 abstainのデータ拡張へ進む。

STG実測と独立判定を通過するまで、PROD反映およびencoder routingは行わない。
