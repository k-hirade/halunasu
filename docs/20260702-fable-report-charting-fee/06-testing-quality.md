# 06. テスト・品質保証（追加テーマ）

---

## 総評

**テストの素地はスタートアップとしてかなり良い**。特に fee ドメインの回帰資産（ゴールドデータセット、カバレッジ閾値、E2E）は、同規模では珍しいレベル。弱いのは「CIでの自動実行の担保」と「LLM前処理・フロント巨大コンポーネントの品質ゲート」。

---

## 現状の資産（良い点）

- **fee-api テスト 8,852行**（`services/fee-api/test/server.test.js`）＋ store/pipeline/python-bridge/monthly-summary 個別テスト。
- **SOAP→算定 E2E ゴールド**: `data/tests/fee-soap-e2e-v2` に **391ケース**。生成・評価・厳格モード・STGランダムのスクリプトが `package.json` に整備。
- **カバレッジ閾値**: `test:coverage`（lines/functions 80%, branches 68%）、`test:coverage:target`（90/90/85）。
- **Python テスト**: baseline adapter/diagnosis/engine/report、claim-level electronic rules、bridge、import。`npm run test:python`。
- **fee-web UIスモーク**: Playwright（`scripts/next-ui-smoke.mjs`）。月次〜受診カードの主要導線を検証。
- **移行パリティ**: `audit:migration-parity` / `test:migration-parity`（レガシーとの整合）。
- **チェックリスト再現率監査**: `audit:fee-checklist-recall`。

---

## 高-1: CI ワークフローが見当たらない

**確認**: `.github/workflows` が存在しない（`.github` ディレクトリなし）。デプロイは `cloudbuild.*.yaml` と手動スクリプト（`scripts/p13_*`, `p16_*`, `p18_*`）ベース。

**なぜ問題か**: これだけ豊富なテスト・監査資産があっても、**PR/pushで自動実行されなければ「回す人依存」**になり、劣化を止められない。特に LLM プロンプト変更・算定改定は、人手だと回し忘れる。

**推奨**:
- 最低限の CI（GitHub Actions か Cloud Build トリガ）で、push時に `npm test`（workspace）＋`test:python`＋`test:coverage`＋`next-ui-smoke` を実行。
- OpenAI 実呼び出しが要るテスト（`check:openai-*`, `eval:fee-soap-e2e:stg`）はモック/ニッチ扱いにし、コアの決定的テストだけを必須ゲートに。
- カバレッジ閾値を CI で強制（既に閾値スクリプトがあるので繋ぐだけ）。

---

## 中-1: LLM 前処理の回帰ゲートが自動化されていない

[04](04-logic.md) 中-4 と対。ゴールド391ケースは資産だが、**プロンプト変更時に必ず回る仕組み**がないと抽出ドリフトを見逃す。

**推奨**: `FEE_CLINICAL_FACTS_PROMPT_VERSION` が変わるPRでは、ゴールド評価（`eval:fee-soap-e2e`）のスコア差分をPRコメントに出す。閾値割れでブロック。実LLMを使う部分は nightly/手動、決定的な下流（イベント→算定）は毎PR。

---

## 中-2: フロント巨大コンポーネントのテスト容易性

`fee-workspace.js` / `encounter-workspace.js` は巨大で、純ロジック（赤文字マッチ・状態カード判定）が UI に埋もれテスト困難。UIスモークはあるが、文字列マッチや状態機械の網羅は薄い。

**推奨**: [05](05-architecture.md) 高-1 の純関数抽出とセットで、抽出した関数にテーブルテストを付ける。状態カード（`getTranscriptStateCard`）は入力→期待表示のテストが書きやすい形。

---

## 低: `node --check` が JSX で誤検知する運用メモ

JSXファイルへの `node --check` は `Unexpected token '<'` を出すが、これは Node が JSX を解釈できないための偽陽性。実コンパイル検証は Next のビルド/スモークで行う——という運用は既に確立している。新規参加者向けに CONTRIBUTING 等へ明文化推奨。

---

## 対応の優先順位（テスト）

1. **高-1**: 最小 CI を立て、決定的テスト群を push ゲートに。
2. **中-1**: プロンプトバージョン変更時のゴールド評価ゲート。
3. **中-2**: 純関数抽出＋テーブルテスト。
