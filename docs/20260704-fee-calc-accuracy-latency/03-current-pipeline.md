# 03. 現行パイプライン分解（実測ポイント）

改善の前提として、カルテ→算定の処理段とレイテンシ寄与を分解する。

## 処理段（算定1回のフロー）

`POST /v1/fee/sessions/{id}/calculations` → `calculateFeeSessionNow`（`server.js:925` 付近・**同期返却**）。

```
calculatePreparedFeeSessionNow
├─ stage "prepare"         → prepareSessionForCalculation  ← ここが支配的
│    ├ measureStage enrichOrders            (master lookup, 並列度4)
│    ├ measureStage facilityProfile         (TTLキャッシュ有)
│    ├ measureStage feeSettings
│    ├ measureStage patientHistory          (listPriorSessions)
│    ├ measureStage externalBillingHistory
│    ├ measureStage clinicalCalculationPreparation  ← ★LLM抽出＋変換(master lookup)
│    └ measureStage shadowCalculationPreparation     ← 影計算(比較/eval用)
├─ stage "savePreparedSession"
├─ stage "pythonCalculator" → feeCalculator.calculate (Python worker)
├─ (claim_check_indication)  → 適応/禁忌点検(今回追加)
├─ stage "saveCalculation"
└─ stage "audit"
```

各段は `timedCalculationStage`/`measureStage`（`server.js:3750`）で計測され、`calculationProgress.metrics`/`stageTimings` に出る。
LLM側は `openAiProviderDurationMs` と `firstOutputTextMs`（初回スナップショット＝TTFT）を記録（`clinical-calculation-input.js:1459-1483`）。

## レイテンシ寄与（定性）

| 段 | 支配要因 | 現状 | 主な機会 |
|---|---|---|---|
| **clinicalCalculationPreparation** | **LLM抽出**（1〜2コール）＋ master lookup | 長い（秒オーダー） | プロンプトキャッシュ・並列・モデル選択 |
| prepare の DB前処理4段 | Firestore 読み | 短いが**直列** | 並列化＋LLMと重ねる |
| shadowCalculationPreparation | 影計算 | hot path内 | 背景化 |
| pythonCalculator | 決定論算定 | worker常駐（直列） | 接続/スキーマ再利用 |

## LLM抽出の実装事実

- 抽出器: `extractFeeClinicalFactsWithOpenAi`（`packages/medical-core/src/fee/openai-fee-clinical-facts.js`）。
- モデル: 既定 `gpt-5.4-nano` / `reasoningEffort: "low"`（`server.js:4767-4780`）。
- リクエスト: `{ model, store:false, instructions(静的・巨大), input(可変), reasoning:{effort}, stream }`（`responses-structured.js:301-319`）。
- **ストリーミングは有効**（`onOutputTextSnapshot` 指定時）だが、算定は**同期返却**なので**クライアントには部分出力が届かない**（サーバ内でTTFT計測に使うのみ）。
- **checklistモード**（`clinical-calculation-input.js:1458`, `extractClinicalFactsWithChecklistMode`）:
  - `inline`/`checklist_only`/`disabled` → **1コール**（streaming）。
  - `split` → **free抽出 + checklist検証の2コールを直列**（`:1618-1641`）→ 実質2倍のレイテンシ。

## master lookup

- 変換時にイベント→コードの `searchMaster` を発行。`searchMasterMany` で `Promise.all` バッチ（`clinical-calculation-input.js:1723-1725`, `2923`）。
- `python-calculator.js` 側で **TTL＋LRU＋in-flight共有キャッシュ**あり（良実装）。

## 算定エンジン（Python）

- `api.py`：算定ごとに `connect()` → `initialize_schema()` → 計算 → `close()`。**接続とスキーマ初期化が毎回**。マスタは読み取り専用なので使い回せる。
- worker は常駐・直列。タイムアウト巻き添えは対処済み（該当のみreject＋再送）。

## 既にある良い基盤（壊さない）

- stageTimings / metrics / TTFT 計測。
- master search キャッシュ（TTL/LRU/in-flight）。
- facilityProfile TTLキャッシュ。
- LLMは点数を出さない境界。ゴールド391ケース（`data/tests/fee-soap-e2e-v2`）。
