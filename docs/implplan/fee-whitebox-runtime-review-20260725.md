# レビュー結果と必須修正: 白箱抽出ランタイム実装(commit 724f7ea) (2026-07-25)

対象: WX1〜WX4製品ランタイム実装(8,044行)。
親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)。

## 検証サマリ(全green)

| 検証 | 結果 |
| --- | --- |
| fee-api | 313/313 pass(whitebox 19+feedback 7テスト含む) |
| fee-core / fee-contracts | 72 pass(3層防御テスト含む) |
| python | 105 pass(whitebox runtime 含む) |
| gold 2系統 | 150/150 / 138/138 |
| 全モード既定off・デプロイ検証 | 4フラグともenum検証あり、既定off確認 |

## WXごとの評価

### WX2(マスタ照合) — 合格

- envelope(complete/index_unavailable)・margin・categoryソフト減衰(×0.9)・
  有効期間フィルタ・コード単位dedup、全て仕様どおり。
- readinessが推論プローブ+索引次元整合まで検証するのは仕様以上。
- Node側の採用判定は score∧margin∧categoryMatched の3条件。

### WX3(文脈分類器) — 合格

- 真理値表は第5改訂の最終版と完全一致(除外系がstanding/planより先、
  standingは全軸ガード、same_day_but_unknown→LLM、else→LLM)。
- abstain 3つ組{value, confidence, abstained}、軸別abstainThresholdsを
  manifest必須で検証、同一語複数出現の文字オフセット対応。

### WX1(span+ルーティング) — 合格

- **candidateOnly 3層防御が全て実装**: 生成層(reviewRequired=true+
  status=candidate強制)/fee-core `lineInclusionStatus` の
  encoder→常時pending最終防衛線(コメント付き)/3層検証テスト
  「unapproved encoder lines stay out of session, monthly, CSV, and UKE totals」。
- spanなし非自明行→LLM(relevance=irrelevant∧conf≥0.95 or trivialのみnone)。
- 行所有権: LLM行きの行はencoderイベントを生成しない(mergeは行集合が
  互いに素なので二重生成が構造的に起きない)。
- visit_facts_sensitive_change→full LLM、入院除外、セル別閾値の階層適用+
  設定不正時route禁止、degraded→全LLMフォールバック(テストあり)。
- snapshot schema v4 + extractorVersion失効。

### WX4(フィードバック) — 合格

- patientId参照ゼロ+禁止フィールド機械検査(テストあり)、org秘密鍵HMAC
  (Secret Manager経由・keyVersion付き)、rejectReason enum、
  specialty/failureFeatureTags保存、既定off。
- wx_retrain: ゲート(gold等)不合格でpromotion blocked、
  「本番昇格は意図的に不可能」(人の判断)の設計どおり。

---

## 必須修正(実装は上記のとおり健全。以下は有効化前に塞ぐ穴)

### F1. [P1] ライセンス判断表の記録なしにモデル成果物を同梱・配布できてしまう

**現状**: `python/data/whitebox/` へのアーティファクト同梱導線
(.gcloudignore許可・deployのパス検証・build_fee_linker_index.py)が完成したが、
WX0-E1のライセンス判断表(Ruri系・GLiNER系・tokenizer等の商用利用可否の
一次情報確認)は依然未記録。このまま index をビルドすれば、利用条件未確認の
モデル派生物が本番イメージに入る。

**修正**:
1. WX0ページのE1に判断表を記録する(モデルID・ライセンス・確認URL・確認日・
   商用利用可否・帰属表示義務)。**これが済むまでアーティファクトをビルドしない**。
2. アーティファクトmanifestに `license: {modelId, license, verifiedAt, sourceUrl}`
   を必須フィールドとして追加し、`load_whitebox_artifact` で欠落を
   validation errorにする(構造的に「未確認モデルの同梱」を不可能にする)。
3. `wx_retrain.py` のmanifest生成にも同フィールドを必須化。

**意図**: 推測実装禁止と同格のガバナンス。「確認した」を人の記憶ではなく
manifest検証で強制する。

### F2. [P1] 実行時決定論の実測検証がない

**現状**: ONNX設定は決定論構成(intra/inter=1・ORT_SEQUENTIAL)だが、
docsが要求する「同一入力N回で完全一致」を実測するテスト・自己チェックが
存在しない。ORT_ENABLE_EXTENDEDの最適化が環境差で挙動を変えた場合、
検出手段がない(揺れ排除が本計画の存在理由なので、ここは信頼ではなく検証)。

**修正**:
1. **CIテスト**: テストフィクスチャとして極小ONNXモデル
   (数KB・ダミー重みで可。生成スクリプト付き)を追加し、
   linker/context/spanの各ランタイムで**同一入力20回の出力バイト一致**を
   アサートするpythonテストを追加。
2. **デプロイ時自己チェック**: 各readinessのプローブを2回実行し、
   出力ベクトル/ロジットの完全一致を検証項目に追加(不一致なら
   available=false=degraded。実モデル+実環境での決定論を毎起動確認)。
3. `whitebox_onnx.py` に「CPU+単一スレッド+SEQUENTIALでEXTENDED最適化は
   決定論」という根拠コメントを追記(将来のEP追加・スレッド変更への警告)。

## 推奨修正(P2)

### F3. route_ready時のメモ全無効とWX1§5の不整合

実装は route_ready でメモを完全無効化する(encoder行は決定論なので合理的)が、
WX1§5は「メモの価値はLLM行き行の再利用に縮退」と書いており、現実装では
route時のLLM fallback行が毎回再抽出される。どちらかへ揃える:
実装を仕様へ(memoPlanをllmLinesサブセットに適用)か、仕様を実装へ
(route時メモ無効を明記。LLM行が少ない前提ならコスト影響小)。
**当面は後者(doc修正)で可**。LLM使用率が下がらないセルが出たら前者を再検討。

### F4. shadow有効化の前提条件チェックリスト

E6(負荷実験)未実施のままランタイムが同梱された。全off既定なので現状リスクは
ないが、**STGでshadowを有効化するとcalculate毎にONNX推論が同期workerに載る**
(単一worker直列の懸念に直撃)。shadow有効化前の必須手順として:
E6実測(1/10/40/80並行)→ readyzのwhitebox readiness確認をpre-flightに追加
→ shadow計測、の順をWX1ページの展開手順に明記する。

### F5. encoderFacts のv15契約パリティテストの確認

encoderFactsがv15契約(line_review全行・evidence_line_ids・mixed行の
standing_mentions=[]等)を満たすことを、既存の契約テスト群を両経路で回す形で
担保しているか確認し、無ければ「同一入力に対しencoder経路出力を既存契約
バリデーション+降格ゲート+照合機構へ通すパリティテスト」を追加する。

## 実施順

F1(ライセンス+manifest必須化)→ F2(決定論検証)→ F5(確認)→
以後は計画どおりWX0のE1〜E6→コーパス→実測→shadow(F4手順)。
F3はdoc修正のみ即時。

## 対応結果 (2026-07-25)

| 指摘 | 対応 |
| --- | --- |
| F1 | E1判断表を一次情報URL・確認日・商用可否・帰属義務付きへ更新。全WX成果物の共通ローダーで`license`を必須化し、欠落・非商用条件・未来日・非HTTPS URLを拒否。WX2ビルダーの必須引数と再学習登録結果にも伝播 |
| F2 | CPU/単一スレッド/SEQUENTIALの維持理由をコード化。linker/context/span readinessは同一プローブを2回実行し、バイト不一致なら`available=false`。生成スクリプト付き極小ONNX 3種で各20回一致するテストを追加 |
| F3 | route_ready時はメモを使わず、LLM fallback行も毎回再抽出する現行判断をWX1仕様へ明記 |
| F4 | E6の1/10/40/80並行計測、同一revisionのreadyz・決定性確認、shadow計測の順をWX1 pre-flightへ明記 |
| F5 | encoder単独の候補降格・根拠行に加え、encoder/LLM混在後の`line_review`全行照合、未知・欠落・重複なし、`evidence_line_ids`有効性をパリティテスト化。mixed performed/standing行の`standing_mentions=[]`も明示検証 |

実ONNXテストを必須ゲートとして実行する環境では、先に
`python/requirements-fee-test.txt`を導入し、
`npm run test:fee-whitebox-runtime:ci`を実行する。通常の
`test:fee-whitebox-runtime`は依存未導入環境では実ONNXテストだけをskipし、
構造・契約テストは継続して実行する。

既存manifestに`license`がない場合、更新後ランタイムでは意図どおり
readinessが`available=false`になる。DB移行は不要だが、shadow/routeを
有効にする前に、採用モデルの一次情報を再確認してmanifestを再生成する。
