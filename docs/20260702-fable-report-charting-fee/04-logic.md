# 04. ロジックの改善

対象: 算定エンジン（Python `medical_fee_calculation` ＋ JS `fee-core`）、月次集計、再算定差分診断、赤文字アノテーション、charting の finalize/SOAP。

---

## 総評

診療報酬という「間違えると請求誤り＝返戻/査定/自主返還」に直結する領域で、**決定的（deterministic）な算定を Python の正典エンジンに置き、LLM は臨床イベント抽出という前処理に限定する**という切り分けは正しい。差分診断が「baselineを正解と見なさず全件を要確認扱い」する姿勢も、医事の実務感覚に合っている。

改善点は「エンジンの二重実装の整合」「請求月・数量・按分の境界処理」「LLM前処理の再現性」に集約される。

---

## 中-1: 算定ロジックの JS/Python 二重実装のドリフトリスク

**場所**: Python `packages`（正典・約26,700行）と JS `packages/fee-core/src/index.js`（2,708行）の両方に算定関連ロジックがある。

- 対話算定・バッチは Python エンジン（`api.py` → `claim_batch`）。
- 月次差分診断の JS 経路（`engineClaimFromSessions`, `buildBaselineDiagnosis`）は、**保存済みセッションの `calculationResult.lineItems`（Python由来）を再集計**しているので、算定そのものを再実装しているわけではない。ここは良い設計。

ただし `estimateReceiptYen = points * 10`（`fee-core:2462`）のような「点数→円」換算や、`aggregateBaselineLines` の数量計算が JS 側にあり、Python 側の集計規則と**別実装**になっている。将来どちらかだけ改定対応すると齟齬が出る。

**推奨**: 「点数→円」「明細集計」「区分ラベル」など請求に直結する規則は**単一の正典（Python or 共有スキーマ）に定義**し、JS はその出力を表示するだけに留める。差分診断のカテゴリ判定ロジック（`buildBaselineDiagnosis`）にはユニットテストがある（`fee-core/test`）ので、改定時の回帰は取りやすい。

---

## 中-2: `engineClaimFromSessions` の同一コード複数受診での点数集約

**場所**: `packages/fee-core/src/index.js:2496-2529`

```js
const entry = aggregated.get(code) || { code, name: line.name || "", points: Number(line.points || 0) || 0, count: 0 };
entry.count += Number(line.quantity || 1) || 0;   // count は加算
// ただし entry.points は最初の line の値のまま（更新しない）
```

同一 code が月内の複数受診に現れると、`count` は加算されるが `points`（単価）は最初の受診の値で固定される。後段の `aggregateBaselineLines` が `points * count` で総点数を出すため、**受診ごとに単価が異なるコード**（逓減・時間帯加算差など）では総点数がずれる可能性がある。

**なぜ問題か**: 差分診断は「概算影響額」を出す。ここがズレると医事の意思決定材料が微妙に狂う。多くのコードでは単価一定なので実害は限定的だが、月次集計の正確性としては穴。

**推奨**: セッション単位の `totalPoints`（Python が算出済み）を直接合算する集約に変更する。単価×数量の再計算を JS 側でやり直さない。

---

## 中-3: 請求月フォールバックの曖昧さ

**場所**: `services/fee-api/src/server.js:3548`

```js
const sessionMonthOf = (session) => String(session.claimMonth || String(session.serviceDate || "").slice(0, 7));
```

`claimMonth` が無ければ `serviceDate` の年月を請求月とみなす。通常は妥当だが、以下で破綻する:

- **月遅れ請求**（診療は先月だが今月請求）: `claimMonth` が正しくセットされていないと、診療月に集計され当月レセから漏れる。
- **返戻・月遅れ再請求**: 同一診療が別請求月に載るケースで、`serviceDate` 基準だと元の月に固定される。

**推奨**: `claimMonth` を算定確定時に必ず明示セットするフロー（欠損時は警告）。差分診断・月次集計の対象は「請求月」を単一の真実として扱い、`serviceDate` フォールバックは「未設定データの暫定表示」であることをUI/データ両方で明確化する。

---

## 中-4: LLM 臨床イベント抽出の再現性・プロンプトドリフト

**場所**: `packages/medical-core/src/fee/openai-fee-clinical-facts.js:344-420`

プロンプトは非常に精緻（時制・実施主体・当院/他院・結果否定の分離、検査の分解ルール等）で、医事ドメインの理解が深い。良い。ただし:

- モデルは `gpt-5.4-nano` 既定、`reasoningEffort: low`。抽出の**再現性（同一入力→同一出力）は保証されない**。算定候補の入り口がブレると、下流の決定的算定も結果的にブレる。
- プロンプトは巨大な自然言語ルールの集合体で、1文の追記が既存ケースに副作用を与えうる。`FEE_CLINICAL_FACTS_PROMPT_VERSION` でバージョン管理している点は good。

**推奨**:
- SOAP→算定 E2E ゴールドデータセット（391ケース、`data/tests/fee-soap-e2e-v2`）を**プロンプト変更のたびに回すゲート**として CI 化（[06](06-testing-quality.md)）。
- 抽出の temperature/seed 固定や、確信度しきい値での「要確認」振り分けを明示。低確信イベントを差分診断側で `consider` に落とす既存設計（`fee-core:2559`）は正しい方向。

---

## 低-1: 赤文字アノテーションのテキストマッチングの脆さ

**場所**: `apps/fee-web/components/fee-workspace.js:2151-2520`（`sameDayWoundTreatmentInlineText`, `woundDetailCandidatesFromSentence`, `normalizedIndexOf` ほか）

創部処置などの詳記候補を、カルテ本文への正規表現＋正規化インデックスで差し込む処理がクライアント側に大量にある。日本語の表記ゆれ（全角半角・送り仮名）を吸収する `normalizeSearchText` 等は丁寧だが:

- ロジックがクライアントに閉じており、テストで固定しにくい（UIスモークはあるが文字列マッチの網羅は薄い）。
- 本文編集と同時にアノテーション位置がずれる系のバグを生みやすい構造。

**推奨**: アノテーション算出はサーバ（fee-api）または fee-core の純関数へ移し、入力文→期待アノテーションのテーブルテストを整備。クライアントは描画に専念（パフォーマンス面 [03](03-performance.md) 中-1 とも一致）。

---

## 低-2: 差分診断の「概算影響額」の位置づけ

**場所**: `packages/fee-core/src/index.js:2462`, `apps/fee-web/lib/baseline-diff.js:223`

`estimatedYen = points * 10`（総医療費ベース、負担按分なし）で、UIにも「概算・負担按分なし」と明記されている。設計として誠実。ただし利用者（医事）は「実際いくら変わるか」を期待しがちなので、**7割/3割等の患者負担や公費の存在で実額は変わる**旨を、数字の近くに常時表示すると誤解を防げる。

---

## 良い点

- **決定的算定を正典に集約**し、LLM を前処理に限定した切り分け。
- **差分診断が baseline を「正解」と扱わない**（全件要確認、over は二義的に既存過剰/当社未対応へ分岐、`fee-core:2564`）。医事の現実に即している。
- **`known_unsupported_codes` / `codeMap`** による正規化フックで、レセコン差異を運用で吸収できる。
- **Shift_JIS/cp932 の UKE を base64＋サーバ判定**で扱う設計（実レセの文字コード現実に対応）。

---

## 対応の優先順位（ロジック）

1. **中-3**: 請求月を単一の真実に（月遅れ・返戻での取りこぼし防止）
2. **中-2**: 月次集約をセッション `totalPoints` 合算へ（概算影響額の正確性）
3. **中-4**: E2E ゴールドをプロンプト変更ゲートに（抽出ドリフトの検知）
4. **中-1**: 円換算・集計規則の正典一元化
