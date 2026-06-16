# 診療報酬算定 API パフォーマンス改善計画（P0-1〜P0-4 / P1-1〜P1-5）

更新日: 2026-06-16  
対象: `services/fee-api` / `apps/fee-web`

## 1) 結論（現状調査の要点）

- 主要ボトルネックは Python 算定エンジンではなく、`カルテ構造化 + マスター照合` 側です。
- 観測: 通常 `8〜13秒`、重いケース `23〜38秒`、最悪 `46秒`。
- 影響が大きい順は `prepare`、`OpenAI provider`、`clinicalFactsConvert`。
- 1〜2件を除き `pythonCalculator` 自体は `4〜40ms` 程度で、コールド時のみ `27秒` 程度の高騰があります。

## 2) 調査済みの主因

- OpenAI 呼び出し: `services/fee-api/src/clinical-calculation-input.js:1401`
- マスターDBコールド: `services/fee-api/src/python-calculator.js:35`
- Cloud Run 設定: `minScale=0` / `maxScale=1` / CPU throttlingあり / `Cloud Tasks` `maxConcurrentDispatches=1`
- Firestore full write: `services/fee-api/src/store/firestore-store.js:196` の update/save の全文更新
- ポーリング時の全文 read: `services/fee-api/src/server.js:286` の getSession 全文取得
- UI 側重複検索: `apps/fee-web/components/fee-workspace.js:490` の master/search 多重呼び出し

## 3) 対象: P0-1〜P0-4

### P0-1
- `FEE_MASTER_DB_PREPARE_ON_START=true` を STG / PROD に適用。
- 目的: コールド時初回遅延の縮小（初回27秒近辺の短縮）。

### P0-2
- `detail-lite` を追加し、`getSession` のポーリング用レスポンスを `status / calculationProgress / calculationSummary / updatedAt` のみに限定。
- 目的: ポーリング時の read コスト/時間を下げる。

### P0-3
- 算定進捗更新でセッション全文更新をやめ、必要 field の patch 更新へ。
- 目的: Firestore 書き込み量と競合帯域の縮小。

### P0-4
- `master/search` クライアント側で同一 `type+query` の重複要求をデバウンス/キャッシュし、未完了リクエストを破棄。
- 目的: UI 経由の過剰ネットワークと待機増幅を抑制。

## 4) 対象: P1-1〜P1-5

### P1-1
- `calculationResult` を軽量化し、実行 trace を分離。
- 目的: detail データサイズと downstream 処理の軽量化。

### P1-2
- `saveCalculation / updateSession` の full set 更新を field patch 更新に寄せる。
- 目的: Firestore 読み書き帯域を継続的に圧縮。

### P1-3
- `Cloud Tasks` `maxConcurrentDispatches` を `2〜3` に拡張。
- 目的: 連続/同時算定時の待ちを低減。

### P1-4
- `clinicalFactsConvert` の同一案件内検索キャッシュを強化。
- 目的: `master/search` の重複参照を抑え、`clinicalFactsConvert` 全体時間を短縮。

### P1-5
- レスポンスを workbench 用（軽量）/ デバッグ用（詳細）に分離。
- 目的: 通常利用で受け渡し対象を最小化。

## 5) 実装順序

1. P0-1
2. P0-2
3. P0-3
4. P0-4
5. P1-1
6. P1-2
7. P1-3
8. P1-4
9. P1-5

## 6) 確認と運用ルール

- P0〜P1 は精度影響の少ない順で段階適用。
- 追加実装は既存の E2E 精度検証と併走。
- スケール関連の最適化はコスト条件とのトレードオフを明確にし、切り戻ししやすい粒度で実装。
