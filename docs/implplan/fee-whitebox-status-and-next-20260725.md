# 現在地と次の一手: 白箱抽出 (2026-07-25 実装後)

親:
[白箱抽出計画](./fee-whitebox-extraction-plan-20260724.md) /
[WX0完了ワークオーダー](./fee-whitebox-wx0-completion-workorder-20260725.md) /
[WX1後の計画](./fee-whitebox-next-after-wx1-shadow-20260725.md) /
[STG runbook](./fee-whitebox-three-lane-shadow-runbook-20260725.md)。

## 結論

WX1・WX2・WX3の成果物はSTG revision `fee-api-stg-00183-vhx`へ配置済みだが、
4 GiB環境でPython workerが終了し、3artifactは`available=false`。
signal診断付き修正はローカルで完了しており、再デプロイ待ち。PRODはoffのまま。

「GLiNER方式が本番で完全に動く」段階ではない。現在は以下を正直に区別する。

- 成果物製造: 完了
- ローカル決定論・readiness: 完了
- 32セルSTG shadow計測経路: 96本測定+64本決定性対照を実装・dry-run完了
- STG artifacts upload / deploy: 実施済み、worker健全化は未完
- 96+64件実測: readiness不合格のため未実施
- 独立人手判定: 未実施
- P4訓練データ拡張: 96件・32/32セル準備完了。v2再学習はP2実測待ち
- P5 holdout母数: 32/32セル分を準備済み。人手レビュー済みは0/32
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
6. STG診断ハーネスは8科 x 4区分 x 3件 = 96件、holdout 0件を固定選択し、
   各セル1件を3回反復するため合計160計算する。
7. 電話再診は本番契約の`outpatient + telephone_revisit`から`telephone`セルへ正規化する。
8. ログレポータはsession allowlistで、欠損・重複・revision混在を拒否する。
   span/linker/context別p95、context abstain軸、route理由、コード差分を出す。
9. machine precheckは人手goldを名乗らない。run-bound独立判定キューは
   未レビュー/本文・比較改ざんを拒否し、dev/train結果を昇格不能にする。
10. `--purpose promotion`はholdoutの3件・20行・10span/セル不足を通信前に拒否する。
11. P4のtraining-only対立コーパス96件を生成し、WX1/WX3入力を384件
    (train 288 / development 96)へ拡張した。holdout本文は引き続き物理的に除外する。
12. P5の全32セルに1件ずつ未レビューsupplementを用意し、既存候補と合わせた
    80件のreview queueを生成した。レビュー後の母数は全セルで
    3実行・24〜59行・17〜32spanだが、未レビューをgoldには数えない。

## 容量・性能

3モデルのartifact合計は1,399,804,036 bytes。独立cold process 3回の最大RSSは
1,650.53 MiBだった。ただしCloud Runの4 GiB同居構成ではworker停止を実測した。
signal診断後に4 GiB/8 GiBをA/Bし、availableを満たす最小値を採用する。

各層のローカルp95合計は984〜1,252msで、昇格ポリシーの500msを超える。
これはゲートを緩める理由ではなく、最適化または構成見直しが必要という結果。
Cloud Run上のend-to-end telemetryで再確認するまでroute化しない。

詳細:
[runtime summary](../whitebox-artifact-builds/runtime/three-lane-multilingual-minilm-ruri30m-v1/cold-process-summary.md)。

## 次の一手

**2026-07-27追記**: 正規化修正によりspan検出は41.2%→95.5%へ改善し、
律速は「ゲート設計とマスタ構造の不整合」へ移った。実装項目は
[ゲート再設計ワークオーダー(S1〜S4)](./fee-whitebox-gate-redesign-workorder-20260727.md)
を参照(根拠計測: `docs/20260727-whitebox-v2-v3-stg-remeasurement/20260727_165842/`)。


**フェーズ2の詳細計画(根拠・実装含む)**:
[shadow phase2 plan (P1〜P7)](./fee-whitebox-shadow-phase2-plan-20260726.md)。
以下は要約。

1. signal診断入りrevisionを4 GiBで再デプロイし、worker終了原因を確定する。
2. SIGKILLなら8 GiB A/Bへ進み、3artifact availableを確認する。
3. 診断用32セル96+64計算を実行し、session allowlist付きでログを集計する。
4. レーン別latency、degraded、span-bearing routable、abstain軸を評価する。
5. run-bound独立判定を実施する。ただし診断結果は昇格には使わない。
6. P4データ拡張は完了済み。P2の結果を確認後、v2再学習・dev較正・
   MiniLM/ModernBERT比較を行う。
7. P5の必要母数は準備済み。80件を独立人手レビューして昇格し、
   promotion測定を実施する。
8. isolated shadow後に`stg-full-validation`、最終artifact後に同回帰を再実行する。

STG実測と独立判定を通過するまで、PROD反映およびencoder routingは行わない。
