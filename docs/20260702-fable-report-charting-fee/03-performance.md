# 03. パフォーマンス

対象: fee-api の月次集計、Python 算定ブリッジ、fee-web / charting-web のクライアントバンドル、gateway のリアルタイム処理。

---

## 総評

「正しく動く」実装は揃っているが、**データ量とユーザ数がスケールした瞬間に線形〜二乗で悪化する箇所**がいくつかある。特に月次サマリのフルスキャンと Python 算定の直列単一ワーカーは、実データ規模（1医療機関でも月数千レセ）で体感を大きく損なう。

---

## 高-1: 月次サマリが全セッション・全期間フルスキャン

**場所**: `services/fee-api/src/server.js:343-347`

```js
if (method === "GET" && matches(parts, ["v1", "fee", "monthly-summary"])) {
  const claimMonth = url.searchParams.get("claimMonth") || "";
  const sessions = await feeStore.listSessions(context.session.orgId);   // ← 全件
  const sessionList = Array.isArray(sessions) ? sessions : (sessions.feeSessions || []);
  return ok(buildMonthlyClaimSummary(sessionList, { claimMonth }));
}
```

`listSessions(orgId)` を **オプションなしで呼ぶと全ドキュメントを取得**する（`firestore-store.js:83-87`: `snapshot = await baseQuery.get()`）。そのうえで `buildMonthlyClaimSummary` が JS 側で claimMonth に一致しないものを捨てている（`server.js:3563`）。

しかも **月絞り込み用の専用クエリ `listSessionsForClaimMonth`（`firestore-store.js:111`）が既に実装済みなのに使われていない**。`.where("claimMonth","==",month).limit(...)` があるのに、全件取得→JSフィルタしている。

**影響**: 組織のセッションが積み上がるほど、毎回の月次画面表示で全期間分のドキュメント読み取り＋転送＋逐次 readiness 計算が走る。Firestore の読み取り課金・レイテンシ・メモリすべてに効く。数万セッションで秒単位の遅延と課金増。

**推奨**: `monthly-summary` を `listSessionsForClaimMonth(orgId, claimMonth, {limit})` に切り替える。claimMonth 未指定時のみ従来経路を残す。`buildMonthlyClaimSummary` 側の月フィルタは二重防御として維持。

---

## 高-2: Python 算定が単一プロセス直列＋算定毎に SQLite 接続/スキーマ初期化

**場所**: `python/medical_fee_calculation/api.py:23-31`, `worker.py`, `services/fee-api/src/python-calculator.js:273-286`

```python
# api.py — 1リクエストごとに
conn = connect(Path(str(db_path)))
try:
    initialize_schema(conn)      # ← 毎回スキーマ初期化
    result = run_outpatient_lab_claim_payload(conn, claim_payload, ...)
finally:
    conn.close()                 # ← 毎回クローズ
```

```js
// python-calculator.js — ワーカーは1本、リクエストは直列
child.stdin.write(`${JSON.stringify({ id: requestId, payload })}\n`);
```

問題が3つ重なっている:

1. **直列処理**: 永続ワーカー(`workerMode`)は1プロセスで、stdin/stdout に1行ずつ。並行算定はキューイングされ待つ。
2. **タイムアウトの巻き添え**: `runWorkerJson` はタイムアウトすると `stopWorker()` でワーカーごと kill する（`python-calculator.js:274-277`）。**待機中の他リクエストも道連れ**で `close` ハンドラが全 pending を reject（`:397-403`）。1件の重い算定が全体を落とす。
3. **接続/スキーマの再作成**: 算定のたびに SQLite 接続を開き `initialize_schema` を呼ぶ。マスタDBは読み取り専用のはずで、接続とスキーマ確認は使い回せる。

**影響**: 同時に複数医事課ユーザが算定すると詰まる。1つのエッジケース算定が長引くと全ユーザがエラーになる。

**推奨**:
- ワーカーを複数プロセス化（プール）＋ラウンドロビン。少なくとも「1リクエストのタイムアウトで他を巻き込まない」よう、タイムアウト時は該当リクエストのみ reject しワーカー再起動は分離。
- Python 側でグローバルに接続を保持し `initialize_schema` は起動時1回に。マスタDBは `PRAGMA query_only` / 読み取り専用オープンで安全に共有。
- 重い算定はPub/Sub非同期経路（既に `calculation-job` worker の骨格あり、`server.js:5997` 周辺）へ寄せ、対話経路の詰まりを回避。

---

## 中-1: fee-web が全ルート単一クライアントコンポーネント、コード分割ゼロ

**場所**: `apps/fee-web/app/{page,sessions/page,monthly/page,sessions/[sessionId]/page}.js` すべてが `FeeWorkspace` を import。`components/fee-workspace.js` は **6,348行・useState 64個・useEffect 19個**。

- `next/dynamic` / `React.lazy` の使用: **0**（grep 一致なし）。
- 月次ダッシュボード・セッション一覧・算定詳細・レセプト・赤文字NLP（`woundDetailCandidatesFromSentence` など正規表現多数）が**すべて同一バンドル**に入り、どのページでも全部ロードされる。
- クライアント側に日本語臨床テキストの正規表現処理（`clinical-billing-knowledge` 由来の重い処理）まで同梱。

**影響**: 初期JSが肥大化し、`/monthly` を見たいだけのユーザも算定詳細＋NLP一式をDL。低速回線・院内端末で TTI が伸びる。

**推奨**:
- ルート単位でコンポーネントを分割（`MonthlyClaimDashboard` / `FeeSessionListView` / `FeeSessionDetailView` を別モジュール＋`next/dynamic`）。
- 赤文字アノテーションの重いテキスト処理はサーバ（fee-api）へ寄せるか、詳細画面でのみ動的ロード。
- 6,348行ファイルの分割は保守性（[05](05-architecture.md)）とパフォーマンスの両取り。

---

## 中-2: 算定結果のポーリング間隔

**場所**: `apps/fee-web/components/fee-workspace.js:11-12, 962-990`

```js
const CALCULATION_POLL_DELAYS_MS = [2500, 3500, 5000, 8000, 12000];
const CALCULATION_POLL_TIMEOUT_MS = 90000;
```

指数的バックオフ＋90秒上限で、設計自体は妥当。ただし算定は同期API経路（`calculateFeeSessionNow`）も持つため、ポーリングと同期のどちらが正なのかが実装から追いにくい。charting 側も `FINALIZING_SESSION_POLL_INTERVAL_MS` の固定間隔ポーリング（`encounter-workspace.js:997`）があり、WS があるのにポーリング併用で経路が二重。

**推奨**: 「算定完了通知」を可能なら WS/SSE に寄せてポーリングを縮退。少なくともバックオフ上限・可視のタイムアウトUXを一貫させる。

---

## 中-3: charting gateway のリアルタイム負荷

**場所**: `services/charting-gateway/src/server.js` 全体（7,977行の単一プロセスに、WSハブ・逐語化・SOAP生成プレビュー・レート制限・pairing・監査が同居）

- 録音セグメントを逐次 OpenAI 再逐語化（`transcribeFinalTranscriptSegment:537`）。CPU/ネットワークとレイテンシがユーザ数×録音長に比例。
- SOAPプレビューを WS でストリーム配信しつつ Firestore へ永続（`publishSoapGenerationPreview:904`）。永続チェーン（`persistChain`）で直列化しており、多セッション同時進行時に書き込み待ちが伸びうる。

**推奨**: 逐語化/SOAP生成は gateway から finalize サービス（既存 `charting-finalize`）へ完全分離し、gateway は WS ファンアウトに専念。永続はデバウンス済み（実装あり）だが、per-session の直列化がボトルネックにならないか負荷試験を推奨。

---

## 低: その他

- **`master search` キャッシュは良実装**（`python-calculator.js:311-367`: TTL＋LRU＋in-flight 共有）。この設計思想を算定本体にも広げたい。
- **`facilityProfileCache`（`server.js:52`）** も TTL キャッシュあり。良い。
- **`SESSION_SUMMARY_FIELDS` の `.select()`**（`firestore-store.js` 一覧経路）で転送量を絞っているのは good。だが 高-1 の monthly 経路はこの恩恵を受けていない。
- **`countQuery` + `.offset()` ページング**（`firestore-store.js:94-96`）: Firestore の `offset` は読み飛ばした分も課金対象。深いページで割高。カーソル（`startAfter`）ベースが望ましい。

---

## 対応の優先順位（パフォーマンス）

1. **高-1**: monthly-summary を月絞り込みクエリへ（実装済み関数を使うだけ。コスト小・効果大）
2. **高-2**: Python 算定のタイムアウト巻き添え解消＋接続/スキーマ使い回し
3. **中-1**: fee-web のルート単位コード分割
4. **中-3**: gateway の逐語化/SOAP を finalize へ分離（スケール前提）
