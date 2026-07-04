# 01. レイテンシ改善

「LLM抽出が長い処理（long pole）」という前提で、**その周りを詰める**＋**LLM自体を速くする**の2軸。
各施策に 効果 / コスト / 実装箇所 / リスク を付す。

---

## L1. 準備段の並列化（★最優先・低リスク・大効果）

**現状**: `prepareSessionForCalculation`（`server.js:4723`）で **enrichOrders → facilityProfile → feeSettings → patientHistory → externalBillingHistory → clinicalCalculationPreparation(LLM) → shadowCalculationPreparation** を**全て直列 await**。

**問題**:
- `facilityProfile / feeSettings / patientHistory / externalBillingHistory` は**互いに独立**（依存なし）なのに直列。
- さらにこれら＋`enrichOrders` は **LLM抽出の入力ではない**（LLMは text＋sessionContext のみ使用）。LLMは変換段で feeSettings/priorSessions を使うが、**抽出コール自体はDB前処理を待つ必要がない**。

**施策（2段階）**:
1. **独立DB前処理を `Promise.all`** に（facility/settings/history/externalの4つ）。すぐできる・低リスク。
2. **LLM抽出を先行起動**：`buildClinicalCalculationPreparation` を「抽出（textのみ）」と「変換（feeSettings/priorSessions依存）」に分離し、**抽出コールをDB前処理と並列**で走らせ、両者が揃ってから変換。long pole（LLM）とDB処理を重ねる＝**準備段の壁時計が max(LLM, DB) に近づく**。

**効果**: 大（DB前処理ぶんが実質ゼロ時間に）。 **コスト**: 小（1）/中（2・リファクタ）。 **リスク**: 低。

---

## L2. プロンプトキャッシュの最大化（★大効果・低コスト）

**背景**: OpenAI プロンプトキャッシュは**自動**で、1024トークン超の**共通プレフィックス**を再利用し**レイテンシ最大80%・入力コスト最大90%削減**。ただし **静的を先頭・可変を末尾**、かつ**バイト一致**が条件。キャッシュは5–10分で失効（[OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching), [OpenAI blog](https://openai.com/index/api-prompt-caching/)）。

**現状**: 巨大な静的 `instructions` を先頭に、可変 `input`（sessionContext/preprocessed/checklist/clinicalText）を後段に置いており**構造は概ね正しい**（`openai-fee-clinical-facts.js:356-376`, `responses-structured.js:303-304`）。

**施策**:
1. **instructions のバイト安定化**：プロンプト文字列を版ごとに固定し、動的差し込み（施設名・日付等）を絶対に instructions へ混ぜない（`patientDisplayNameRedacted` 化済みは good）。空白・JSONキー順の揺れもキャッシュを壊す。
2. **input の静的部分も前方へ**：`input` 冒頭の定型文はキャッシュ対象だが、`checklist menu`（textから生成）を末尾へ寄せ、**より長い共通プレフィックス**を作る。
3. **ウォームアップ**：低頻度運用だと5–10分で失効しTTFTが伸びる。**STG/本番で定期的に軽い同一プロンプトを撃つ**か、医事の稼働時間帯にプリウォーム。
4. **キャッシュ率の可視化**：usage の cached tokens を metrics に記録し、ヒット率を監視。

**効果**: 大（TTFT・コスト）。 **コスト**: 小。 **リスク**: 低。

---

## L3. Python算定の接続/スキーマ再利用（既指摘の残り）

**現状**: `api.py` が算定ごとに `connect()`＋`initialize_schema()`＋`close()`。マスタは読み取り専用。

**施策**: worker プロセスで**接続をグローバル保持**し、`initialize_schema` は**起動時1回**。`PRAGMA query_only`/読み取り専用オープンで安全に共有。

**効果**: 中（1算定あたりの固定費削減）。 **コスト**: 中。 **リスク**: 低（読み取り専用）。

---

## L4. shadow計算を hot path から外す

**現状**: `shadowCalculationPreparation` が prepare 段の**同期内**（`server.js:4793`）。影計算は比較/eval用途で、ユーザの算定結果には不要。

**施策**: shadow を**バックグラウンド化**（結果保存は非同期）or **STG限定/サンプリング**。hot path から除外。

**効果**: 中。 **コスト**: 小。 **リスク**: 低（用途が監査/評価）。

---

## L5. split checklist の2コール並列化・条件化

**現状**: split モードは free抽出＋checklist検証を**直列2コール**（`clinical-calculation-input.js:1618-1641`）。

**施策**:
- 2コールは独立なので **`Promise.all` で並列**（レイテンシ≈max）。
- さらに **split はノート複雑度で条件化**（短い/単純なノートは inline 1コール、複雑なノートのみ split）。

**効果**: 中（split運用時に半減）。 **コスト**: 小。 **リスク**: 低。

---

## L6. モデル階層・reasoning effort の動的選択

**現状**: 一律 `gpt-5.4-nano` / effort `low`。

**施策**: **ノート長・複雑度・金額インパクト**で振り分け。短文/低インパクトは最軽量、長文/高額/査定頻発は上位モデル or effort 上げ。既存の env フォールバック機構（`server.js:4767`）を動的化。

**効果**: 中（多くの短ノートで短縮）。 **コスト**: 中（ルーティング設計）。 **リスク**: 中（精度とのトレードオフ→[02]の較正とセット）。

---

## L7. ストリーミングをクライアントへ／ポーリング撤廃

**現状**: サーバ内はストリーミングだが算定は**同期返却**。非同期ジョブ経路は固定ポーリング（`fee-workspace.js` `CALCULATION_POLL_DELAYS_MS=[2500,…]`）で、算定が速くても初回ポーリング2.5秒待ちの体感遅延。

**施策**:
- 対話経路は **同期＋部分結果ストリーム**（抽出済みイベントを逐次表示→算定確定で置換）で体感を短縮。
- 非同期経路は **SSE/WS 通知**へ寄せ、固定ポーリングを縮退（先の総合分析 03-perf 中-2）。

**効果**: 中（体感レイテンシ）。 **コスト**: 中。 **リスク**: 低。

---

## L8. master lookup（現状良好・維持＋微調整）

- `searchMastermany` の `Promise.all` バッチ、`python-calculator.js` の TTL＋LRU＋in-flight 共有キャッシュは good。
- 追加: 変換段の lookup を**イベント単位で重複除去してから**バッチ（同一クエリの多重発行を抑制）。effort小。

---

## レイテンシ施策の優先順位
1. **L1 準備段の並列化**（最大の効き・低リスク）
2. **L2 プロンプトキャッシュ最大化＋ウォームアップ**
3. **L3 Python接続/スキーマ再利用** / **L4 shadow背景化**
4. **L5 split並列/条件化** / **L7 ストリーミング/ポーリング撤廃**
5. **L6 モデル動的選択**（[02]較正とセット）

> 注: 速度施策は必ず [02] の精度ゲート（点検・較正・非対称評価）とセットで。速くして過大算定が増えては本末転倒。
