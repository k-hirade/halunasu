# 計画: 3レーンshadowフェーズ2 — STG実測から昇格判断まで(P1〜P7) (2026-07-26)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md) /
現在地: [status-and-next](./fee-whitebox-status-and-next-20260725.md) /
手順書: [three-lane shadow runbook](./fee-whitebox-three-lane-shadow-runbook-20260725.md)

## 前提となる現在地(2026-07-26 readyz再実測)

- STG(`fee-api-stg-00183-vhx`): 3モードはshadow、3artifactもconfiguredだが、
  Python workerが停止しており3artifactすべて`available=false`。
  readyz理由は`medical fee worker exited with code null`。Cloud Runは1 CPU / 4 GiB。
  **P2を開始できる状態ではない**。
- `code null`だけではOOMと断定できない。ローカル実装ではworkerの終了code・signal・
  uptime・処理中operation数・stderr有無/sha256をPHIなし構造化ログ
  `fee.python_worker.exited`へ出すよう修正済み。再デプロイ後に原因を確定する。
- ローカル: 3レーン成果物・GCS管理(sha256検証)・featureプロファイル(fail-closed)・
  96ケース本測定+64件の同一入力対照・レーン別レポート・独立判定キュー/
  集計器・昇格ゲートまで実装済み。
- GLiNERそのものは不採用(ゼロショットF1 1.16%)。動くのは「GLiNER方式に着想を得た」
  MiniLM token classifier(WX1)+Ruri埋め込み(WX2)+MiniLM 5軸分類器(WX3)。

**フラグ運用の位置づけの変更(重要な判断の記録)**: 以前「STGフラグ落ち」として
指摘した memo/standing/exclusion=off は、featureプロファイル導入により
**変数分離のための明示的な選択**になった(`stg-whitebox-three-lane-shadow.env` は
白箱観測を隔離するため意図的にoff、縦断・背反の検証は `stg-full-validation.env` で
別途行う)。loaderが全キー必須+環境不一致fail-closedのため、
「env未指定で黙って既定値に戻る」事故は構造的に解消された。

## P1. worker健全化+3レーンshadowデプロイ

**根拠**: span単独shadowはルーティング判定材料を生まない(encoder委譲は
spanHigh∧linkerHighの合議で決まるため)。3レーンが揃って初めて
routable率・棄却理由・コード一致の観測が始まる。

**実施順**:

1. 診断ログ入りrevisionを同じ4 GiBで1回デプロイする。
2. readyzと`fee.python_worker.exited`を確認し、`signal=SIGKILL`ならOOMを確定する。
   signalが別なら、そのsignal/uptime/pending operationから原因を分ける。
3. OOM確定時だけ8 GiBでA/B再デプロイする。8 GiBで3artifactがavailableになれば
   P2へ進む。4 GiBのままavailableになれば増量しない。
4. `/readyz`でrevision・3モード=shadow・3artifact availableを確認する。

ローカルの独立cold process最大RSS 1.65 GiBは、1プロセス内にSQLite 1.67 GBと
3モデルを同居させたCloud Runのピークメモリを保証しないため、4 GiB継続の根拠にはしない。

**注意**: shadowは calculate 同期経路で3レーンを実行するため、STGの体感
レイテンシが約1秒増える。STG限定・計測目的として許容し、PRODには波及させない。

## P2. 96ケースSTG実測+同一入力対照(shadow計測の時計はここから)

**根拠**: ローカルdry-runは経路検証のみ。判定材料はSTGの実測でしか得られない。
ハーネスは8科×4区分×3件=96件・holdout 0件・session allowlist・revision固定を
強制済み。さらに各セルの先頭1件を同一入力で3回計算するため、
追加64件、合計160計算になる。追加対照は精度/性能の本測定母数から除外し、
white-box経路のfingerprint完全一致だけに使用する。

**実装済み**: runbookの計測節どおり実行し、レポートに:
セル別 routable行率 / encoder-only・LLM-only検出 / 合議棄却理由の分布
(span低確信・linker低margin・context abstainの内訳) / p50・p95(レーン別+合計) /
degraded発生 / 決定性(同一入力再計算の一致)。

ここはdev/trainを使う**診断計測**であり、独立判定を実施しても
`promotionEligible=false`。昇格の数値根拠はP5完了後の
`--purpose promotion` holdout計測だけに限定する。

**予測される結果とその解釈(先に書いておく)**:
- **span-bearing routable率はほぼ0%になる見込み**。全行routable率には
  自明な非span行が混ざるため、律速判断には使わない。WX3の `temporalRelation` と
  `providerOwnership` がdev全件abstainのため、真理値表#1(abstain→要LLM)で
  ほぼ全spanがLLM側に落ちる。これは失敗ではなく「**律速がL3のabstainである**」
  ことの実測確認であり、P4の投資判断の根拠になる。
- 棄却理由の分布が「どの軸・どのカテゴリを直せばroutable率が上がるか」の
  優先順位表そのものになる。

### 8セル診断計測を受けたゲート観測の修正(2026-07-26)

STG revision `fee-api-stg-00189-jtt`で8セルを1件ずつ診断した結果、8/8計算は完了し、
degradedは0件だった。一方、gold上のcurrent/own対象22 spanに対して
encoder codeは0件だった。原因は単一ではなく、次のゲートが混在していた。

- WX1 artifactのカテゴリ別検出閾値を通ったspanにも、Node側で一律0.9を再適用していた。
- WX2はstrict用のscore 0.92 / margin 0.05をshadow観測にも適用し、
  expected codeが候補内にあるか、何位だったかを記録していなかった。
- WX3 v2は特に`actionStatus` / `sourceOrigin`でabstainが多かったが、
  span単位の棄却軸をレポートから特定できなかった。
- visit factsが曖昧な場合、実点数を守るfull fallbackだけでなく、
  無関係な行のshadow観測まで全停止していた。

これを受け、次の診断基盤を実装した。

1. **strict昇格ゲートとdiagnostic shadowゲートを分離**した。strictは従来の
   0.9 / 0.92 / 0.05を維持し、算定結果への影響を変えない。diagnostic shadowだけ
   WX1 artifactのカテゴリ別閾値、WX2 score 0.8 / margin 0.02を使用する。
2. WX2のsemantic順位に加え、正規化後の完全一致だけを使う決定論的な
   shadow lexical rerankを追加した。prefix一致は記録だけ行い、marginを迂回しない。
   このrerankはshadow専用で、strict候補順・確定明細・点数には使わない。
3. spanごとに、WX1閾値、WX2 strict/shadow順位・score・margin、WX3の採用role/
   uncertain軸、visit-facts blockerを構造化traceへ記録する。本文は保存せず、
   line/span ID、offset、SHA-256だけを使用する。
4. ハーネスはgold expected codeのsemantic/shadow top-1・top-5順位、
   strict/shadow joint eligibility、blocker理由を集計する。これにより
   「span未検出」「linker検索失敗」「context abstain」を分離して判断できる。
5. pure shadow時のvisit-facts fallbackは曖昧な行だけを観測対象外にした。
   実算定経路は従来どおり全行LLMへfail closedし、shadowの観測範囲だけを広げる。
6. 閾値世代を`whitebox-routing-wx-v3-diagnostic-shadow`として固定した。

この修正後もroute/propose/assistへの昇格条件は不変である。まず同じ8セルを再計測し、
expected code順位とblocker分布を確認する。8件・対照1回は原因診断に限定し、
決定性と昇格判断には32セル×3対照のP2本測定を使う。WX3再学習は再計測で
context blockerが律速と確認できた場合にのみP4として実施する。

## P3. 独立人手判定(実装済み、P2では診断専用)

**根拠**: 機械precheckは「人手goldを名乗らない」設計にした(昇格ゲートは
独立判定なしで閉じる)。encoder/LLM不一致の正誤は人にしか裁定できない。

**実装済み**:

- `prepare:fee-whitebox-adjudication`: run manifest・dataset・policyのsha256を固定し、
  encoder/LLM不一致全件+セルごとの決定論的agreement標本をレビューキューへ出す。
- レビュー者はgoldラベルを見ず、`truthCodes`、`truthSpanCount`、
  dangerous false positive/opportunityを入力する。双方が見落としたコードも追記可能。
- `compile:fee-whitebox-adjudication`: 未レビュー、本文改ざん、machine比較改ざん、
  不正なdangerous分母、実行目的とholdout利用の不一致を拒否し、
  `fee-whitebox-adjudication-v1`と`fee-whitebox-feedback-event-v1`を生成する。
- dev/train由来queueは常にdiagnostic。holdout由来かつセル別3レビュー/
  20行/10spanを人手結果で満たした場合だけ`promotionEligible=true`。
- コンパイラはqueueに固定されたpolicy SHA-256を再検証する。最終レポートも
  run manifestと判定結果のrun ID・dataset SHA-256・policy SHA-256、および
  全3レーンの時間計測の完全性を再検証する。欠損値を0msとして扱わない。

## P4. L3 abstain解消のデータ拡張(routable率の律速)

**根拠**: P2の予測どおりならroutable率の律速はWX1の精度ではなくL3の
temporal/ownership全abstain。原因は訓練データの軸分布
(current_visit/own_clinicに偏り、past/other_providerの正例が少ない)。

**実装**:
1. E2コーパスへ「時制・実施主体が対立する文」を集中的に追加生成
   (各セルにpast/other_provider/patient_reported/same_day_but_unknownの
   spanを最低3件ずつ。テンプレ単位split維持)
2. `build_wx3_context_artifact.py` で再訓練→dev較正でabstain閾値を再算出
3. 併せてWX1弱カテゴリ(imaging: FN17/17、treatment: FN19/19)の
   ケース追加も同じ生成バッチで行う(N4を吸収)
4. v2訓練時に**ベース比較を1回**: MiniLM-L12 vs modernbert-ja-130m
   (E1採用候補・日本語特化。トークン化品質でtemporal系の改善が見込める)

**2026-07-26の進捗**:

- データ拡張は完了。`context-contrast-cases.json`へ8科×4区分×3件=96件を
  生成し、全セルでpast/other_provider/patient_reported/
  same_day_but_unknownを各3 span以上、imaging/treatmentを各6 span収録した。
- このコーパスは`trainingOnly=true`、`notGold=true`でholdoutを含まない。
  `training-view.json`は384件(train 288 / development 96)、train 935 span /
  development 356 spanへ更新した。holdout本文の物理的除外も維持している。
- WX1/WX3 builderのdry-runは新training viewで成功した。
- **未完**: P2のSTG実測前なのでv2再学習、dev較正、MiniLM対
  modernbert-ja比較、artifact確定はまだ行わない。比較モデルのimmutable
  revisionとライセンス証跡を固定してから実行する。
- 比較候補は
  `sbintuitions/modernbert-ja-130m@28c180b16463ba6f3fa79b48756fbf21586fe23e`
  (MIT)へ固定した。これはTransformers 4.48以降のモデル契約なので、
  `requirements-whitebox-modernbert-build.txt`の専用venvへ隔離する。
  比較環境のTokenizers 0.22.1とfee-api runtimeの0.20.3は異なるため、
  artifact採用前にruntime環境でtokenizer/ONNX load・100回決定論・
  runtime測定を必須にする。

## P5. holdout完成(strict 32/32+昇格母数)

**根拠**: 現状のholdoutは外来8セル×2件=16件のみ。非外来48本文
(24セル×2件)は生成済みだが、span/5軸の独立レビュー前で`cases.json`には未昇格。
さらに昇格ポリシーは各セル3実行・20行・10spanを要求するため、
既存48件を昇格するだけでも実行数3を満たさない。

**実装済みのfail-closed境界**: ハーネスの`--purpose promotion`は、各セルで
`human_reviewed`由来、spanレビュー完了、各セル3実行・20行・10spanを満たす
holdoutだけを選ぶ。不足セルが1つでもあればネットワーク通信前に停止する。
2026-07-26時点では最初の外来セルが
`runs=2/3, lines=43/20, spans=10/10`で停止することを確認済み。

**2026-07-26の準備結果**:

- 全32セルへ1件ずつ、16行・13 span以上の別生成系supplementを生成した。
- 既存非外来48件とsupplement 32件を合わせたレビューqueueは80件。
- レビュー後の準備母数は全32セルで3実行、24〜59行、17〜32 spanとなり、
  3実行・20行・10 spanの条件を満たす。
- queue内のdraft spanは全件`approved=false` /
  `suggestion_only`であり、自動昇格しない。現時点のreviewed completeは0/32。

**残作業**:

1. queue 80件のspan+5軸ラベルを独立人手レビューし、H1 CLIでatomic昇格する。
2. `test:fee-specialty-matrix:strict`と`--purpose promotion --dry-run`を通す。
3. holdout本測定→独立判定→レポートゲートの順で実施する。

## P6. レイテンシ最適化(route昇格の前提。ただしP2の実測後に着手)

**根拠**: ローカルp95合計984〜1,252ms > 500msゲート。ゲートを緩めない判断は
正しい(親計画のsub-second目標はUXとコストの根拠)。ただし**Cloud Run実測前に
最適化するのは早計**——ローカルとCPU特性が違い、ボトルネックの内訳
(モデル推論か、索引全探索か、worker直列待ちか)も未確定。

**実装(P2のレーン別telemetryで内訳を見てから、効果順に)**:
1. ONNX動的量子化(INT8): 2〜4倍の高速化が定番。**決定論の再検証が必須**
   (量子化後も同一入力100回一致+readinessプローブ)
2. L2索引の全探索→事前正規化済み行列積の最適化/次元削減
3. 3レーン呼び出しのバッチ化(span→context/linkerへspanをまとめて1往復)
4. モデル小型化(MiniLM-L12→L6)は精度トレードオフがあるため最後
5. worker直列の限界が支配的ならE6の構成比較表に従い専用推論サービス分離
   (親計画・決定事項5で許容済み)

## P7. 分離検証の再走(白箱と独立に)

**根拠**: 白箱shadow観測とは独立に、縦断メモ・standing・背反enforceの
STG検証環境を維持する必要がある(B2=背反受入の自動再現が未完)。

**実装**:

- P7a: P2診断後に現成果物の回帰baselineとして1回実施する。
- P7b: P4/P6でartifactを更新した場合、最終artifact/revisionで同じ一式を再実施し、
  こちらだけを昇格判定へ使う。

`stg-full-validation` プロファイルでデプロイし、
①standing fixture再走(`--resolve-exclusions choose_a`込み、H3実装の受入:
未解決検知→409→解決→3,502×3一致の自動再現)②W4安定性ゲート再実行
③L7型5患者再走、を1セッションで消化して各チケットをクローズする。

## 実施順と担当

```
P1 worker診断/健全化(平出: deploy) → P2 96+64計測 → P3 診断判定
                                          ├ P4 データ拡張+v2訓練(Claude→平出GPU/CPU実行)
                                          ├ P5 holdout母数完成→promotion計測/判定
                                          └ P6 レイテンシ(P2の内訳を見てから)
P7aはP2後、P7bは最終artifact後
```

**昇格(route/propose/assist)の条件は不変**: STG実測+独立判定+devでのgold
recall非劣化+500msゲート+「承認なしで確定点数不変」回帰テスト。
これらが揃うまでPROD反映・encoder routingは行わない。

## ローカル実装の検証結果(2026-07-26)

- `npm test --workspace @halunasu/fee-api`: **326/326 pass**
- `npm run test:fee-whitebox-ops`: Node **16/16 pass**、Python **30/30 pass**
- `npm run test:fee-whitebox-runtime`: Node **37/37 pass**、Python **22 pass /
  7 skip**。skipはONNX実体を要求する任意環境テストで、STG readinessで別途確認する。
- 診断dry-run: 32セル、96本測定、32対照群、合計160計算を選択。
- promotion dry-run: `internal_medicine|outpatient`の既存holdoutが
  `runs=2/3`のため通信前に停止。これはP5未完を正しく閉じる期待結果。
- P4コーパス監査: 96件、32/32セルcomplete。P5 supplement監査:
  32件、32/32セルcomplete。レビュー後のpromotion準備母数は
  32/32セルで3実行・24〜59行・17〜32 span。
- P5のreviewed completeは0/32のまま。strictが24セル不足で失敗することを確認し、
  未レビュー候補をgold扱いしない境界を維持した。
- `git diff --check`および新規3 CLIの`node --check`: pass。

ここまででP1の診断実装、P2/P3の計測・判定基盤、P4のデータ拡張、
P5の母数準備とfail-closed境界は完了した。
P1の実環境原因確定、P2実測、P4モデル再学習、P5の独立レビューとpromotion実測、
P6最適化、P7再走は未実施。P4再学習/P6はP2の同一revision実測を、
P5 promotionは独立人手レビューを前提とする。
