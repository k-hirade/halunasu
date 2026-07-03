# Codex Fee Comparison Report

作成日: 2026-07-03

## 目的

`/Users/hiradekeishi/medical-ai/mediaclAI_recept` と `/Users/hiradekeishi/medical-ai/recept-checker` を読み、現在の halunasu `fee` に活かせるロジック・設計・データ資産を整理した。

結論として、2つのリポジトリはそのまま統合する対象ではなく、役割を分けて取り込むのが良い。

- `mediaclAI_recept`: 設計思想、一次情報管理、評価データ、マスター/改定追従の参考資産として使う。
- `recept-checker`: UKE/レセプト単位の点検レイヤ、ルール分類、縦覧、返戻・査定分析の実装参考として使う。
- halunasu `fee`: すでにカルテ/病名/オーダーから算定候補を作るプロダクト実装があるため、外部2件は「前処理を置き換える」のではなく「算定後・提出前・月次点検・評価基盤」を強化する方向で使う。

## 調査対象

### mediaclAI_recept

ローカルパス: `/Users/hiradekeishi/medical-ai/mediaclAI_recept`

確認した主なファイル:

- `README.md`
- `docs/00-EXECUTIVE-SUMMARY.md`
- `docs/01-architecture.md`
- `docs/02-medical-fee-engine-R8.md`
- `docs/04-dsl-spec.md`
- `docs/05-api-fastapi.md`
- `docs/06-eval-harness.md`
- `docs/07-extraction-layer.md`
- `docs/09-gaps-sources-provenance.md`
- `docs/10-dsl-requirement-rules.md`
- `docs/11-shisetsu-kijun.md`
- `docs/12-orca-integration.md`
- `db/schema.sql`
- `eval/golden_runner.py`
- `tools/watch_sources.py`
- `data/golden/cases/*.json`
- `data/masters/*`
- `data/sources/*`
- `data/extracted/*`

性質:

- アプリというより「診療報酬算定支援AIの設計・仕様・一次情報・評価資産」リポジトリ。
- 令和8年度改定、静岡県、公費、DPC、施設基準、ORCA連携、DSL、評価、安全設計まで広く扱う。
- LLMは事実抽出・不足情報・候補説明まで、コード/点数は決定論層が担うというレッドラインが明確。

### recept-checker

ローカルパス: `/Users/hiradekeishi/medical-ai/recept-checker`

確認した主なファイル:

- `README.md`
- `check_cli.py`
- `run.py`
- `receipt_checker/models.py`
- `receipt_checker/engine.py`
- `receipt_checker/parser/uke_parser.py`
- `receipt_checker/rules/*.py`
- `receipt_checker/history.py`
- `receipt_checker/hen_sah.py`
- `receipt_checker/settings.py`
- `receipt_checker/report.py`
- `tests/*`
- `sample_data/*`

性質:

- 病院向けレセプトチェッカーのPython実装。
- UKEを読み、患者/病名/診療行為/薬剤/コメント/縦覧/返戻・査定などを点検する。
- カルテから算定候補を作る仕組みではなく、既存レセプトを点検する仕組みに近い。

### halunasu fee

確認した主なファイル:

- `apps/fee-web/components/fee-workspace.js`
- `apps/fee-web/components/fee-admin-console.js`
- `services/fee-api/src/server.js`
- `services/fee-api/src/clinical-calculation-pipeline.js`
- `services/fee-api/src/clinical-calculation-input.js`
- `services/fee-api/src/python-calculator.js`
- `services/fee-api/src/clinical-billing-knowledge.js`
- `services/fee-api/src/claim-risk-knowledge.js`
- `packages/fee-core/src/index.js`
- `packages/medical-core/src/fee/openai-fee-clinical-facts.js`
- `python/medical_fee_calculation/*.py`

現状の強み:

- カルテ/病名/オーダーから structured facts を作り、算定候補・不足情報・赤字追記候補・レセプト案に変換する流れがある。
- Python算定エンジン、マスター検索、施設設定、月次点検、再算定差分診断、UKE/CSV出力の土台がある。
- `candidate` / `review` / `receiptDraft` / `monthly` / `baseline diff` のプロダクト画面がすでに存在する。

## 全体結論

halunasu fee に一番効くのは、外部2件から以下を取り込むこと。

1. `recept-checker` のUKE解析・点検ルール分類を、halunasuの「レセプト案/提出前点検/月次点検/再算定差分診断」に接続する。
2. `mediaclAI_recept` のゴールデンケースと評価思想を、halunasuの算定ロジック回帰テストに変換する。
3. `mediaclAI_recept` の source provenance と版管理を、マスター/ルール/コメント/施設基準の信頼性管理に入れる。
4. `recept-checker` の縦覧・返戻/査定分析を、Phase 10相当の査定/再審査支援に使う。
5. `mediaclAI_recept` のDSLはすぐ実装せず、まずは「ルールの表現形式」と「RuleTrace」の考え方だけ取り込む。

## 採用優先度

### P0: すぐ価値が出る

#### 1. UKEパーサ/レセプト点検レイヤ

`recept-checker/receipt_checker/parser/uke_parser.py` と `receipt_checker/models.py` の考え方を、halunasuの既存 `baseline_adapter.py` より厳密なUKE読込・検証に使う。

使いどころ:

- 再算定差分診断のアップロードUKE解析
- halunasuが出力した `buildReceiptDenshin` の自己検証
- 月次レセ点検の「提出前チェック」
- 「一致 / 既存のみ / 当社のみ / 両方差分あり / 再現失敗」の分類精度向上

現状のhalunasuにも `python/medical_fee_calculation/baseline_adapter.py` はあるが、UKEの構造表現・レコード型・コメント・症状詳記・薬剤/処置モデルは `recept-checker` の方が実務寄り。

#### 2. ゴールデンケースの回帰テスト化

`mediaclAI_recept/data/golden/cases/*.json` は、halunasuの算定エンジン評価にそのまま近い。

使いどころ:

- `python/medical_fee_calculation` のゴールデンテスト
- `services/fee-api` の clinical facts -> calculation pipeline テスト
- LLM抽出を含めない deterministic regression
- 過大算定を重く罰する safety regression

既存のhalunasuはテストはあるが、診療報酬ドメインのゴールデンセットとして外部のケースを取り込む価値が高い。

#### 3. 点検Findingの共通スキーマ

`recept-checker` の `Finding` は、halunasuの `reviewIssues` / `reviewItems` と対応しやすい。

取り込み方:

- `receipt_check_findings` を計算結果に追加する。
- `review_issue` へ変換して既存UIに出す。
- 種別は `format`, `patient`, `disease`, `drug_indication`, `act_indication`, `dosage`, `exclusive`, `frequency`, `missing`, `comment`, `longitudinal`, `claim_history` のように分類する。

#### 4. レセプトコメント・症状詳記・必要情報の分類精度向上

halunasuはすでにコメント確認や赤字追記候補を持つが、`recept-checker` の `r11_comment.py` のような「コメント不足」をレセプト単位で点検する視点を入れると、カルテ側の赤字補助とレセプト案側の提出前チェックがつながる。

### P1: 次に入れるべき

#### 1. 縦覧チェック

`recept-checker/history.py` と `r12_longitudinal.py` の思想を使う。

使いどころ:

- 月1回/週1回/前回算定から何日などの制限
- 初診/再診の再初診判定
- 疑い病名の持ち越し
- 同月複数受診の重複・包括

halunasuには患者セッション/月次集計があるため、DB側に「過去レセ/過去算定履歴」を持たせると自然に実装できる。

#### 2. 返戻・査定データ取り込み

`recept-checker/hen_sah.py` の発想を、以前議論した「再審査請求支援」とつなげる。

使いどころ:

- 査定理由の蓄積
- 再審査候補抽出
- 再審査請求書ドラフト
- 施設別・診療科別の査定傾向

#### 3. 施設ルール・除外設定

`recept-checker/settings.py` のように、施設ごとに警告の無効化/強弱/ローカルルールを設定できる仕組みは、halunasuの「算定設定」画面と相性が良い。

ただし、過剰に自由にすると危険なので、最初は以下に限定する。

- 表示だけ抑制
- 自動算定には影響させない
- 監査ログに残す
- 施設管理者のみ変更可能

#### 4. source watch / provenance

`mediaclAI_recept/tools/watch_sources.py` と `data/rag/registry.json` の思想を採用する。

使いどころ:

- 令和8/令和10の改定追従
- マスター/通知/疑義解釈の更新検知
- 「このルールはどの版のどの出典から来たか」の追跡

### P2: 将来検討

#### 1. DSL化

`mediaclAI_recept/docs/04-dsl-spec.md` と `docs/10-dsl-requirement-rules.md` は良いが、今すぐ全面DSL化すると既存のPython算定ロジックが複雑化する。

採用するなら順序は以下。

1. まず既存Python関数に `RuleTrace` を返す。
2. 次に一部の低リスクルールだけYAML化する。
3. 最後に電子点数表で表現できない要件だけDSLに移す。

#### 2. ORCA / WebORCA 連携

`mediaclAI_recept/docs/12-orca-integration.md` は中長期のレセコン接続設計として価値がある。

今すぐの再算定差分診断や月次点検には不要。

#### 3. DB全面設計

`mediaclAI_recept/db/schema.sql` は監査・PII分離・マスター版管理の参考になるが、halunasuの既存Firestore/Cloud Run構成をそのままPostgreSQLへ置き換える必要はない。

採用するなら概念だけでよい。

- PII分離
- audit append-only
- master edition/effective period
- source verification status
- claim state machine

## 採用しない方がよいもの

### 1. 外部リポジトリを丸ごと依存にする

理由:

- halunasuの責務境界と合わない。
- ライセンスファイルがローカル確認範囲で見当たらなかった。
- `mediaclAI_recept` は仕様/データ資産中心で、実行アプリとして直接統合する形ではない。
- `recept-checker` はPython単体Web/CLIで、halunasuのNext.js/Node/Python worker構成とそのまま合わない。

コードを流用する場合は、ライセンス・著作権・出典を必ず確認する。

### 2. LLMにコード/点数を決めさせる設計

`mediaclAI_recept` もこの点は明確に否定している。halunasuも同じ方向でよい。

LLMの責務:

- カルテ事実の抽出
- 実施/否定/予定/他院/過去の区別
- 不足情報の提示
- 赤字追記候補の作成
- 理由説明

決定論層の責務:

- コード確定
- 点数計算
- 併算定/包括/回数/施設基準/コメント要件
- レセプト出力

### 3. 評価前の「増収」訴求

どちらの外部リポジトリにも安全側設計がある。halunasuでも「算定もれ候補」は実施事実・要件・病名・施設基準を確認してから表示すべきで、金額だけを前面に出す設計は避ける。

## halunasu fee への推奨アーキテクチャ

既存の流れを壊さず、以下のレイヤを追加するのがよい。

```text
カルテ/病名/オーダー
  -> 既存 LLM/structured facts
  -> 既存 Python 算定エンジン
  -> 既存 receiptDraft / reviewItems
  -> 追加: receipt check layer
       - UKE構造検証
       - コメント/症状詳記
       - 病名/適応
       - 併算定/包括/回数
       - 縦覧
       - 施設ローカルルール
  -> 月次点検 / 再算定差分診断 / 提出前レビュー
  -> 返戻・査定・再審査支援
```

## 具体的な導入ロードマップ

### Step 1: 評価資産を取り込む

- `mediaclAI_recept/data/golden/cases/*.json` をhalunasu用のゴールデンケースに変換する。
- 期待値は「完全自動算定できる行」「レビューに残す行」「絶対に算定してはいけない行」に分ける。
- CIでは、過大算定を最重要失敗として扱う。

### Step 2: UKE解析と提出前点検を追加する

- `recept-checker` のUKEレコードモデルを参考に、halunasu側の `baseline_adapter.py` を強化する。
- `buildReceiptDenshin` の出力を自分で再パースして、構造・合計点・コメント・患者属性を検証する。
- 既存UIでは新しいタブを増やさず、`reviewIssues` と月次点検の右ペインに集約する。

### Step 3: 低リスク点検ルールから実装する

最初に入れるべきルール:

- 不明コード
- 固定点数不一致
- 合計点不一致
- コメント不足
- 症状詳記不足
- 基本診療料なし
- 処方料/薬剤料の整合
- 同日初診/再診の矛盾
- 同日複数処置の部位根拠確認

### Step 4: 縦覧・返戻/査定・再審査へ拡張する

- 患者/月単位の履歴DBを使う。
- 返戻/査定ファイルを取り込む。
- 再審査対象を抽出し、症状詳記/再審査理由のドラフトを生成する。

### Step 5: provenance と改定追従を運用化する

- マスター/ルール/通知の出典をmanifest化する。
- 版と診療年月を必ず紐づける。
- 更新検知時に「影響するルール/コード/画面」を出す。

## 詳細分析

詳細なファイル単位の比較、ルール対応表、実装方針は [01-detailed-logic-and-design-analysis.md](./01-detailed-logic-and-design-analysis.md) に記載した。

より具体的な差し込み先、データ契約、最初に作るべきファイル単位の実装計画は [02-concrete-integration-plan.md](./02-concrete-integration-plan.md) に記載した。
