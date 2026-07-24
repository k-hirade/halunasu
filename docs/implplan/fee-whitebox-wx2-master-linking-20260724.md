# WX2: マスタ照合レイヤ(L2) — 埋め込み検索による候補コード解決 (2026-07-24)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)。前提: WX0のE1/E4。

## 実装ステータス (2026-07-24)

版付きartifact loader、ONNX決定論runtime、索引builder、effective date、top-k/score/margin、
category penalty、build/runtime埋め込みparity検証、worker/API統合は実装済み。
実マスタ成果物と精度ゲートは未完了のため、`FEE_LINKER_MODE`の既定値は`off`であり、
`propose`は未有効化。

## 意図

現行の辞書スキャン(`name_scan`)は正規化完全一致+alias展開であり、
表記揺れ・略語・言い換え(「胃カメラ」→EF-胃・十二指腸、「サチュレーション」→
経皮的動脈血酸素飽和度測定)を取れない。ここをベクトル照合で補い、
**LLMに「コード名の想起」をさせない**構造へ寄せる(LLMの誤コード幻覚の根絶と、
ルールベースで取れない表現の回収を同時に達成する)。

最初の製品投入レイヤに選ぶ理由: 既存経路の**後段追加**なので現行動作を壊さず、
WX0の結果がどうであれ辞書スキャン強化として独立の価値がある。

## 実装

### 1. 索引アーティファクト(G1方式)

- 生成: `scripts/build_fee_linker_index.py`(新規)。
  `standard-master.sqlite` の `medical_procedures` / `drugs` / `diseases` から
  1コード=複数文書(正式名/短縮名/かな/alias展開/告示名)を作り、
  埋め込み(Ruri v3系、WX0で選定したサイズ)を計算して索引化する。
- 保存形式: sqlite内の専用テーブル(`linker_embeddings`: code, kind, doc,
  vector BLOB, model_version)+近傍検索は numpy 全探索から開始
  (5.8万コード×数文書なら全探索で十分速い。FAISS導入は計測後に判断)。
- **バージョンと完全性**: `linker_manifest.json`(model_version, 次元数,
  文書数, 各表のソースmaster世代, sha256)。ロード時に検証する。
  **用語の整理(P2指摘反映)**: 不整合時に「name_scanのみで継続」するのは
  fail-closedではなく **degraded(fail-open)** である。照合は提案補助レイヤ
  なのでdegraded継続を許容するが、必ず①metrics `linkerScan.degraded=true`
  ②構造化ログ(運用アラート対象)③readyzへの露出、の3点で可視化する。
  提出系(背反強制等)のfail-closedとは明確に区別して呼ぶ。
- モデルファイルはONNX化してアーティファクトに同梱。ランタイムは
  onnxruntime CPU・intra_op_num_threads=1・決定論設定。

### 2. ワーカーAPI

`python/medical_fee_calculation/worker.py` のdispatchに `link_spans` を追加:

```
入力: {spans: [{text, category?}], kinds?: ["procedure","drug","disease"],
      top_k: 5, service_date}
出力: {status: "complete" | "index_unavailable",
      modelVersion, indexVersion,
      results: [{text,
                 margin,   // top1とtop2のスコア差(第5改訂: API契約に明記)
                 candidates: [{code, name, kind, score, matchedDoc,
                               categoryMatched: boolean}]}]}
```

- スコアはコサイン類似度。`category` は**ハードフィルタにしない**(第5改訂):
  L1のカテゴリ自体が誤りうるため、カテゴリ不一致候補も `categoryMatched=false`
  で候補集合に残し、スコアを減衰(初期: ×0.9)して順位を下げる。
  不一致top1は自動候補にせず確認事項側へ。
- **コード集合で返す(P2指摘反映)**: 同名・類似名の複数コード(材料違い・
  部位違い・点数区分違い)を類似度だけでtop1に潰さない。
  `candidates` は常に集合であり、`margin`(top1とtop2のスコア差)を含める。
  下流の採用判定は score と margin の両方を使い、margin < 閾値のときは
  単一コードを提示せず「コード集合の確認事項」にする。
- `service_date` でマスタ有効期間フィルタ(既存の期間規約と同じ)。
- envelope型(status)で「候補0件」と「索引不能」を区別(背反X1と同じ規約)。

### 3. 統合(Node側)

- `services/fee-api/src/python-calculator.js` に `linkSpans()` を追加。
- `clinical-calculation-input.js` の辞書スキャン
  (`dictionaryScanCandidateProposals`)の**後段**に埋め込み照合を追加:
  1. 現行name_scanのヒットはそのまま(完全一致は最強の証拠)。
  2. name_scanが拾えなかった行のうち、LLM抽出イベントの行為名・
     billable行の名詞句をクエリに `linkSpans` を呼ぶ。
  3. score ≥ 高閾値(初期0.92、WX0で校正)**かつ margin ≥ 閾値(初期0.05)かつ
     categoryMatched**: 通常の候補提案として出す
     (根拠文「表記『{原文}』をマスタ『{名称}』と照合しました(類似度{score})」)。
  4. 中間帯(score 0.80〜0.92、または score高でも margin低・category不一致):
     単一コードを断定せず**コード集合の確認事項**として提示。
  5. 閾値未満: 出さない。
- **提案のみ**。確定・点数への直接影響なし(candidateOnly原則)。
- trace stage `linker_scan` に {query, topK, scores, chosen} を記録。
- metrics `linkerScan: {queryCount, hitCount, reviewCount, indexVersion}`。

### 4. フラグと展開

- `FEE_LINKER_MODE = off | shadow | propose`(デプロイスクリプトの検証パターンは
  背反と同型)。shadowはtrace/metricsのみで候補を出さない。
- 展開: STG shadow(1週間、linker候補と人の承認の突合)→ propose。
  PRODはWX全体の方針に従い保留。

### 5. 対照学習(第2段。初期はゼロショット埋め込みで開始)

- WX0でrecall@5が不足したkind(想定: 略語・俗称の多い検査・処置)に対し、
  SapBERT方式で対照FT: 正例=同一コードの名称バリアント同士
  (マスタ内の正式名/短縮名/かな/alias)、hard negative=近傍の別コード
  (同区分・編集距離近傍)。訓練データはマスタのみから機械生成(合成原則に適合)。
- 学習スクリプト `python/experiments/wx2_contrastive_ft.py`、
  昇格はWX0マトリクス+3ゲート(親ページ原則5)。

## テスト

- 索引manifest不整合→照合無効化+warning(計算は継続)。
- 決定論: 同一クエリ100回で同一結果。
- category/有効期間フィルタ。
- 閾値帯ごとの候補/確認事項/非表示の分岐。
- 反例: 「胃カメラの説明を行った(実施なし)」等、文脈で当日実施でないものは
  L3(WX3)までは既存の決定論述語ゲートを通すこと(linkerは文脈判定をしない)。
- gold 2系統+安定性コーパス不変(propose モードで差分が出る場合は
  一件ずつ一次資料照合の上でgold更新判断)。

## 受入基準

- WX0マトリクスでlinking recall@5がname_scan比+10pt以上(または表記揺れ
  サブセットで+20pt以上)。
- STG shadow計測で、linker候補の人承認率(=提案の質)を基線化し、
  proposeへの切替判断を記録する。
- レイテンシ追加 < 100ms/カルテ(中央値)。
