# WX1: span検出とルーティング(L1+L4) — 抽出主経路の転換 (2026-07-24)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)。
前提: **WX0の分岐判定、WX2・WX3の稼働**(依存順はWX3→WX1で確定。
本ページのルーティングはL3の文脈判定とL2の照合を前提にする)。
対象範囲: 外来・訪問・往診・電話のみ(setting=inpatientでは起動しない。親の決定事項1)。

## 実装ステータス (2026-07-24)

ランタイム・ルーティング・candidateOnly・入院除外・degraded時のLLM全面フォールバック・
科×受診区分セル別しきい値・監査metrics・回帰テストは実装済み。しきい値設定が
不正な場合はencoder routeを禁止してLLMへ戻す。学習済みspan成果物と
WX0/gold/shadowの昇格判定は未完了のため、`FEE_SPAN_DETECTOR_MODE`の既定値は
`off`であり、`route`は未有効化。

## 意図

最終形: **エンコーダが主経路、LLMは例外係**。
L1(span検出)+L2(照合)+L3(文脈)で大半の行為を決定論的に構造化し、
低確信・未知表現・複雑文脈だけを現行v15 LLM経路に流す。
揺れは主経路から構造的に消え、レイテンシは10秒級→sub-second級、
LLM使用率は下げ続けるKPIになる(Fathom型のconfidence routing)。

## 実装

### 1. span検出器

- 方式: GLiNER系(bi-encoder。エンティティタイプ埋め込み×トークンspan照合)。
  WX0の分岐に従い、ゼロショット開始 or E2合成コーパスでFT
  (GLiNER形式の訓練データ `{text, entities:[{span, label}]}` はblueprintの
  expectedSpansから機械変換)。
- エンティティタイプはWX0 E3と同一のマスタ由来閉集合+定義文。
  タイプ集合のバージョンをモデルmanifestに含める。
- 出力: `{lineId, charStart, charEnd, text, category, confidence}`。
  行前処理(`buildClinicalTextPreprocessing`)のline_idにアンカーする
  (line_review契約・メモのlineKey体系とそのまま接続)。
- ワーカーdispatch `detect_spans`。envelope型。ONNX CPU決定論設定。

### 2. パイプライン統合とルーティング(L4)

`clinical-calculation-input.js` に新経路を追加(現行v15経路は残す):

```
行前処理 → detect_spans(L1) + 行関連性判定(下記)
        → 行ごとに判定:
           - 全spanが高確信 かつ L2照合が高確信 かつ L3が高確信
             → エンコーダ経路で clinical_events / line_role を構成(LLM不要)
           - いずれか低確信・未知カテゴリ・spanと辞書の矛盾
             → その行を「要LLM行」に積む
           - **spanなし行の扱い(P1-1反映。黙殺の禁止)**:
             span未検出は「算定関連なし」の証明ではない。独立した
             **行関連性判定**(この行に算定関連記載があるか、の二値+abstain。
             L1とは別ヘッドまたは別の小型分類器)を全行に適用し、
             「関連あり/abstain なのにspanなし」の行は要LLM行へ。
             この判定の見逃し率が実測で十分低くなるまでは、保守既定として
             **非自明な行(空行・純バイタル値・日付のみ等の決定論パターンを
             除く全行)のうちspanなしの行はLLMへ送る**。
        → 要LLM行だけを line_subset モードでLLMへ(既存機構の流用)
        → merge(既存の統合規約)
```

- **受診単位facts(P1-5反映)**: line_subsetはvisit_facts等の受診単位情報を
  返さない既知制約がある(院外処方の新規記載で古いvisit factsが残る問題は
  実測済み)。whitebox経路では visit_facts を**行抽出から分離**する:
  ①セッション入力(setting/encounterDetails/orders)からの決定論導出を第一源に、
  ②本文由来のvisit facts(院内外処方等)は毎回の全行スキャン
  (`VISIT_FACTS_SENSITIVE_PRESCRIPTION_PATTERN` 系の決定論判定+L3分類)で
  更新し、③判定不能時のみfull LLM抽出へ戻す(既存の
  `visit_facts_sensitive_change` フォールバック条件をwhitebox経路にも適用)。

- **line_subset抽出機構(メモで実装済み)をそのまま「LLMフォールバック」に転用**
  できるのがこの設計の要。新しい統合規約を発明しない。
- **provenanceゲート(第2改訂で機構を具体化)**: `extractionSource` の
  付与だけでは防げない。現行実装ではイベントが
  `convertClinicalCalculationEvents` → `inferred.procedure_codes`
  (`clinical-calculation-input.js:2588, 2733`)で算定入力に入り、
  **レビュー対象でない明細は承認なしで合計にincludedされる**
  (`packages/fee-core/src/index.js` `lineInclusionStatus`: reviewRequiredも
  candidate系statusも付いていない行の既定は "included")。したがって
  3層の構造的防御を実装する:
  1. **生成層**: エンコーダ由来イベントから生じる明細は、変換時に必ず
     `reviewRequired=true` かつ `status="candidate"` を強制する
     (`convertClinicalCalculationEvents` にprovenance分岐を追加)。
     候補型の出力(linker中間帯等)は従来どおり `candidateProposals` へ。
  2. **集計層の防御**: `lineInclusionStatus` に
     「`extractionSource === "encoder"` かつ承認decisionなし → 常にpending」を
     追加する(生成層のバグがあっても合計に入らない最終防衛線)。
  3. **検証**: 「未承認encoder明細が0点」を**セッション明細・月次集計・
     CSV/UKE出力の3層それぞれ**でアサートする回帰テストをgold全ケースで
     機械実行する(エンコーダ経路on/off比較+未承認状態の出力比較)。
  高確信は表示順・既定チェック状態にのみ影響し、確定には影響しない
  (親の決定事項2)。
- 空抽出ガード・line_review照合・降格ゲート・standing_mentionsの既存下流は
  経路によらず共通(エンコーダ経路の出力もv15契約の形に正規化して流す)。
- confidence閾値は科×区分マトリクスのセル別に較正ファイルへ
  (`linker/routing-thresholds.json`、アーティファクト管理)。初期は保守側
  (=LLM行き多め)から始めて下げていく。ランタイムの適用順は
  `defaults → *|encounterSetting → specialty|* →
  specialty|encounterSetting`。適用セルと設定versionはmetricsへ残し、
  schema・値域・セル定義が不正ならrouteせずLLMへ戻す。

### 3. shadow計測プロトコル

切替前に必ず: `FEE_SPAN_DETECTOR_MODE = off | shadow | route`。

- shadow: L1〜L3をフル実行するが結果は使わず、以下をmetrics/traceへ:
  - **gold基準の指標(主)**: 固定gold・マトリクスに対するコード単位
    recall/precision、算定対象の見逃し率、過剰候補率、confidence別の
    coverage-risk曲線(閾値を動かした時のカバレッジと誤り率のトレードオフ)
  - **LLM経路との突合(診断指標のみ。P1-4反映)**: LLM自体が揺れるため
    一致率を昇格条件にしない。不一致は「エンコーダのみ検出/LLMのみ検出」に
    分類し、**人が裁定**した結果(どちらが正しいか)を記録する——
    これがWX4の穴レポートと訓練対象の源泉
  - 想定LLM使用率(ルーティングした場合に何%の行がLLM行きだったか)
- STG計測はL7再走プロトコル+標準5患者+マトリクスサンプルで実施し、
  README化(いつもの計測規律)。

### 4. 段階切替

1. shadow 2週間: 一致率とエンコーダ限定検出の人手レビュー
2. route開始(保守閾値): LLM使用率60〜80%想定。開始条件はgold recall非劣化+
   shadow裁定のみ(使用率の条件はまだ課さない)
3. 閾値を下げる度に3ゲート+マトリクス+安定性コーパスで昇格判定。
   **LLM使用率<50%は「route開始条件」ではなく閾値較正後の最初の
   マイルストーン(M1)**(第2改訂で受入基準と開始条件の矛盾を解消)
4. **KPI**: LLM使用率(行ベース)、抽出レイテンシ中央値、確定点数の反復分散、
   科別recall。ダッシュボードはmetricsから集計

### 5. 抽出メモとの整合

- メモのsnapshot妥当性キーに `extractorVersion`(モデル+タイプ集合+閾値の
  ハッシュ)を追加。モデル更新でsnapshotは自動失効(promptVersionと同じ)。
- エンコーダ経路は元々決定論なので、同一行の再計算はメモなしでも同一結果。
  メモの価値は主に「LLM行きになった行の結果再利用」に縮退していく(良いこと)。

## テスト

- 決定論: 同一カルテ100回で全経路出力完全一致(エンコーダ経路)。
- ルーティング分岐(高確信/低確信/矛盾/ワーカー不能→全行LLMへfail-open。
  抽出は提案レイヤなのでfail-openで良い——提出系のfail-closedとは区別)。
- v15契約への正規化(line_review全行・evidence_line_ids・standing_mentions)が
  エンコーダ経路でも完全に満たされること(既存の契約テストを両経路で回す)。
- gold 2系統・安定性コーパス・マトリクスを**route有効**で全green。

## 受入基準(P1-4反映: gold基準を主、LLM一致は診断のみ)

- shadow: 固定gold+マトリクスholdoutでコード単位recallが現行LLM経路比
  **非劣化**(親KPI: 漏れ抑制優先)、かつ人が裁定した不一致で
  「エンコーダが正しい」割合が過半
- route開始: gold recall非劣化+「承認なしで確定点数不変」回帰テスト green
  (LLM使用率60〜80%で可)
- マイルストーンM1: 確定点数の反復分散=0(安定性コーパス)を維持したまま
  LLM使用率 < 50%
- 過剰候補率(候補却下率)≤ 親の初期上限50%
- レイテンシ: E6の負荷条件(10並行)でエンコーダ経路p95 < 1秒
