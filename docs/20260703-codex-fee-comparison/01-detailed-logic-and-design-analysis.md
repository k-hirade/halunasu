# Detailed Logic And Design Analysis

作成日: 2026-07-03

## 1. 現行 halunasu fee の位置付け

halunasu fee は、すでに「カルテから算定候補を作る」アプリとして実装が進んでいる。外部2リポジトリを読むと、halunasuが置き換えるべき部分と、追加すべき部分が明確に分かれる。

現行の主要責務:

| 領域 | 主な実装 | 状態 |
|---|---|---|
| UI | `apps/fee-web/components/fee-workspace.js`, `fee-admin-console.js` | 算定セッション、月次、再算定差分診断、管理画面がある |
| セッションAPI | `services/fee-api/src/server.js` | Platform認証/権限/保存/算定APIがある |
| LLM抽出入力 | `services/fee-api/src/clinical-calculation-input.js` | カルテ/病名/オーダーを構造化する入口 |
| 算定パイプライン | `services/fee-api/src/clinical-calculation-pipeline.js` | clinical facts -> billing intents -> calculation events |
| OpenAI facts schema | `packages/medical-core/src/fee/openai-fee-clinical-facts.js` | status/source/evidence/actionを構造化 |
| Python算定 | `python/medical_fee_calculation/api.py` ほか | 基本料、検査、投薬、注射、処置、画像、入院、DPCなどの土台 |
| レセプト案 | `packages/fee-core/src/index.js` | `receiptDraft`, `buildReceiptDenshin`, `buildReceiptCsv`, `reviewItems` |
| 月次 | `packages/fee-core/src/index.js`, `fee-workspace.js` | 月次サマリと患者別点検がある |
| 再算定差分診断 | `baseline_adapter.py`, `baseline_pipeline.py`, `baseline_report.py`, `baseline_api.py`, UI | 既存レセ/再算定元データ/当社再算定結果の比較へ拡張中 |

このため、外部リポジトリから「カルテ入力UI」や「セッション保存」を持ち込む必要はない。必要なのは、以下の3点。

1. 算定後のレセプト検証を強くする。
2. 算定ロジックの評価基盤を強くする。
3. マスター/ルール/改定追従の出典管理を強くする。

## 2. mediaclAI_recept の詳細評価

### 2.1 何のリポジトリか

`mediaclAI_recept` は、実行可能なSaaS実装というより、診療報酬算定支援AIの設計・仕様・一次情報・評価資産をまとめたリポジトリである。

特徴:

- 令和8年度改定を前提にした設計。
- 医科、DPC、歯科、調剤、訪問看護、施設基準、公費、ORCAまで広く扱う。
- LLMと決定論算定の責務分離が明確。
- 出典/provenance/未確認事項の扱いが強い。
- ゴールデンケースと評価ランナーがある。

### 2.2 活かせる設計

#### 5層アーキテクチャ

確認ファイル:

- `/Users/hiradekeishi/medical-ai/mediaclAI_recept/docs/00-EXECUTIVE-SUMMARY.md`
- `/Users/hiradekeishi/medical-ai/mediaclAI_recept/docs/01-architecture.md`

構成:

1. L1: 取込/脱識別
2. L2: LLM抽出
3. L3: 決定論算定
4. L4: ガード/較正
5. L5: 人間確認

halunasuへの適用:

- ほぼ現行設計と一致している。
- halunasuで足りないのは、L4の「評価指標としての安全側ガード」と「L3算定結果のRuleTrace」。
- UI上はすでに人間確認があるため、DB/APIで「なぜ候補になったか」「なぜ除外されたか」を追跡しやすくするのが次の改善。

#### LLMのレッドライン

確認ファイル:

- `docs/00-EXECUTIVE-SUMMARY.md`
- `docs/07-extraction-layer.md`

原則:

- LLMはコード/点数を確定しない。
- LLMは事実抽出、根拠span、不足情報、候補説明に限定する。
- 決定論層が公式マスター/電子点数表でコード/点数を確定する。

halunasuへの適用:

- 現行の `clinical-calculation-pipeline.js` と `python-calculator.js` の方向性は正しい。
- 今後の赤字追記や症状詳記生成も「算定確定」ではなく「追記候補/確認候補」に限定する。
- UI文言は「算定できます」より「要件・実施事実・病名を確認できれば算定候補」とする方が安全。

#### source provenance

確認ファイル:

- `docs/09-gaps-sources-provenance.md`
- `tools/watch_sources.py`
- `data/rag/registry.json`

活かせる点:

- ルールやマスターの出典を追跡する。
- 取得済み/未確認/要再確認を状態として持つ。
- 改定追従時に影響範囲を検知する。

halunasuへの適用:

- `python/medical_fee_calculation/importers.py` や `standard_build.py` の出力に source manifest を付ける。
- `masterCode`, `ruleId`, `commentRequirement` に `sourceId`, `edition`, `validFrom`, `validTo`, `verifiedAt` を付ける。
- 管理画面のマスター表示に「版」「出典」「最終取り込み日」を出す。

#### ゴールデン評価

確認ファイル:

- `docs/06-eval-harness.md`
- `eval/golden_runner.py`
- `data/golden/cases/*.json`

活かせる点:

- 行単位のコード/点数誤差だけでなく、過大算定を重く罰する。
- required warning、forbidden candidate、status mistake を評価する。
- 診療年月別の回帰テストを前提にしている。

halunasuへの適用:

- `python/medical_fee_calculation` の回帰テストに取り込む。
- `services/fee-api` の structured facts 変換後のテストに取り込む。
- LLMを使うテストと使わないテストを分ける。

推奨する評価分類:

| 分類 | 内容 |
|---|---|
| exact_match | コード/点数/回数が一致 |
| review_expected | 自動算定せずレビューに出すべき |
| forbidden | 算定してはいけない |
| missing_warning | 必要な警告が出ていない |
| overbilling_risk | 過大算定につながる誤り |

#### DSL / RuleTrace

確認ファイル:

- `docs/04-dsl-spec.md`
- `docs/10-dsl-requirement-rules.md`

活かせる点:

- 併算定、回数、年齢、必須コメント、施設基準などを宣言的に表す設計。
- 1ルール1発火の `RuleTrace` を残す思想。

halunasuへの適用:

- すぐDSL化しない。
- まず Python算定関数が `trace` を返せるようにする。
- `trace` を `reviewIssues` の根拠にする。
- 将来、電子点数表で表現できないルールだけYAML化する。

#### 施設基準の時点管理

確認ファイル:

- `docs/11-shisetsu-kijun.md`
- `db/schema.sql`

活かせる点:

- 施設基準は「登録済み/未登録」だけでは不十分。
- 届出日、受理日、算定開始日、有効期間、要件維持が必要。

halunasuへの適用:

- 既存の施設設定画面に effective-dated な施設基準を入れる。
- 算定エンジンは診療日と施設基準の有効期間で判定する。
- 届出チェックリストは「提出書類作成」より「届出漏れ自己点検」として扱う。

### 2.3 そのまま採用しないもの

#### PostgreSQL schema全体

`db/schema.sql` はよく設計されているが、halunasuの既存保存基盤を置き換える必要はない。

取り込むべき概念:

- PII分離
- append-only audit
- master edition
- source verification status
- claim state machine

取り込まないもの:

- DBスキーマ丸ごとの移植
- app/pii/master/audit/eval schema構造の全面採用

#### ORCA連携

`docs/12-orca-integration.md` は有用だが、現在の優先は再算定差分診断と月次点検である。ORCA連携は後回しでよい。

#### 全診療領域を一気に広げること

医科/DPC/歯科/調剤/訪看まで一気に対象にすると、現行feeの品質が落ちる。halunasuでは外来医科と現在の対象領域から段階的に広げるべき。

## 3. recept-checker の詳細評価

### 3.1 何のリポジトリか

`recept-checker` は、既存UKE/レセプトを読み込んで点検するPython実装である。

特徴:

- UKE parser がある。
- Receipt/ServiceItem/Disease/Comment/SymptomDetail のモデルがある。
- 12カテゴリ以上のルールがある。
- 履歴DBによる縦覧チェックがある。
- HEN/SAH/増減点の分析思想がある。
- CLI/Web UI/CSV/Excel出力がある。

halunasuの「カルテから算定候補を作る」流れとは入口が違うが、算定後のレセプト点検にはかなり使える。

### 3.2 UKE parser

確認ファイル:

- `/Users/hiradekeishi/medical-ai/recept-checker/receipt_checker/parser/uke_parser.py`
- `/Users/hiradekeishi/medical-ai/recept-checker/receipt_checker/models.py`

活かせる点:

- Shift_JIS/cp932/utf-8の読み込み。
- `IR`, `RE`, `HO`, `KO`, `SN`, `SY`, `SI`, `IY`, `TO`, `CO`, `SJ`, `GO` のレコード概念。
- 患者、保険、公費、病名、診療行為、薬剤、特定器材、コメント、症状詳記を同じ `Receipt` に集約。

halunasuへの適用:

- `python/medical_fee_calculation/baseline_adapter.py` を強化する。
- 既存レセの解析だけでなく、halunasu出力UKEの自己検証にも使う。
- 再算定差分診断で「既存のみ」「当社のみ」「一致」「差分あり」「再現失敗」をより正確に分類する。

注意点:

- このcloneにはREADMEで触れられている `receipt_checker/masters/data/*.csv` が見当たらない。
- 公式マスターDBがない状態では、名前解決やルールの一部は完全には動かない。
- コードを直接移植する前にライセンス確認が必要。ローカル確認範囲では `LICENSE` ファイルは見当たらなかった。

### 3.3 Rule engine

確認ファイル:

- `receipt_checker/engine.py`
- `receipt_checker/rules/__init__.py`
- `receipt_checker/rules/*.py`

エンジンの流れ:

1. ClaimFile/Receipt を受け取る。
2. 診療年月からマスター版を選ぶ。
3. `all_rules()` を順に適用する。
4. settings/exclusions で施設ごとの抑制を適用する。
5. `Finding` の配列を返す。

halunasuへの適用:

- Python算定結果を `Receipt` 相当の中間表現に変換する。
- `ReceiptCheckFinding` を作り、`reviewIssues` へ変換する。
- 施設設定は「表示抑制/重要度変更」から始め、自動算定には使わない。

### 3.4 ルール分類と halunasu 対応状況

| recept-checker分類 | 内容 | halunasu現状 | 採用方針 |
|---|---|---|---|
| r01 format | 必須項目、日付、未知コード、実日数、固定点数、合計点 | UKE出力validationは一部あり | P0で提出前点検に追加 |
| r02 patient | 性別/年齢制限 | 一部の患者情報は持つが汎用制限は弱い | P1で公式マスター連動 |
| r03 disease | 疑い病名、重複、主病、病名なし、未コード、転帰 | 病名不足確認はある | P0/P1で病名点検を強化 |
| r04 drug indication | 薬剤適応病名、禁忌病名 | 現状は薬剤量不足中心 | P1以降、公式データが必要 |
| r05 act indication | 診療行為の適応病名 | 管理料候補など一部あり | P1で対象を拡張 |
| r06 dosage | 用量、日数、グループ投与量、湿布制限 | 赤字追記で用量不足は扱う | P0で不足情報、P1で制限 |
| r07 contraindication | 禁忌 | ほぼ未実装 | P2。安全だがデータ整備が必要 |
| r08 exclusive | 併算定、包括、親項目なし、ローカル排他 | 同日複数処置など一部 | P0で低リスク排他、P1で公式化 |
| r09 frequency | 月/日/期間の算定回数 | 一部領域ごとに実装 | P1で縦覧履歴と統合 |
| r10 missing | 検査判断料、基本診療料、処方料、算定漏れ | 候補生成はある | P0でレセ単位点検へ接続 |
| r11 comment | 必須コメント、ワープロコメント、未知コメント | コメント確認/赤字追記はある | P0で提出前点検と統合 |
| r12 longitudinal | 縦覧、再初診、疑い病名持越し | 月次はあるが縦覧ルールは限定的 | P1 |
| r13 seiri | 未使用病名整理 | 未実装または弱い | P2。医療安全/運用設計が必要 |

### 3.5 Missing billing rule

確認ファイル:

- `receipt_checker/rules/r10_missing.py`

活かせる点:

- レセプト全体を見て「本来あるべき算定がない」ことを検出する。
- 検査判断料、基本診療料、処方料など、現場でROIが高い。

halunasuへの適用:

- すでに `clinical-billing-knowledge.js` に疾患/管理料系候補がある。
- これを「候補生成」だけでなく「月次/提出前点検の漏れ検知」として再利用する。
- 結果は自動算定ではなく `reviewIssue` として出す。

### 3.6 Comment rule

確認ファイル:

- `receipt_checker/rules/r11_comment.py`

活かせる点:

- 必須コメントの有無をレセプト単位で確認する。
- コメントコード不明やワープロコメントも扱う。

halunasuへの適用:

- 現行の赤字カルテ追記候補とレセプト案のコメント欄をつなぐ。
- 「カルテに追記すべき文」と「レセプトコメントに入れる文」を分ける。
- UIはタブを増やさず、右側レセプト案の該当明細にコメント不足を出す。

### 3.7 Longitudinal check

確認ファイル:

- `receipt_checker/history.py`
- `receipt_checker/rules/r12_longitudinal.py`

活かせる点:

- 前月/過去レセの履歴を使って回数制限や持越し病名をチェックする。
- 現場の「月末月初のレセ点検」に近い。

halunasuへの適用:

- 現在の月次ページと相性が良い。
- 患者単位の算定履歴/既存レセ取り込み結果を保存し、診療年月で問い合わせる。
- 初期実装では「同月内」だけでも効果がある。

## 4. halunasuに足りないもの

### 4.1 レセプト案の自己点検

halunasuは `buildReceiptDenshin` でUKE相当を生成できるが、生成したものを再パースして構造検証する仕組みは弱い。

追加すべき:

- 生成UKEの再パース
- 合計点突合
- レコード必須項目
- コメント/症状詳記の整合
- line item と UKE行の対応trace

### 4.2 UKEアップロードの厳密なモデル化

再算定差分診断では、病院からもらった既存レセと再算定元データを比較する。ここでUKE解析が弱いと、差分分類が誤る。

追加すべき:

- UKE record typeごとのモデル
- 患者/診療月/診療科/病名/行為/薬剤/コメントの正規化
- 未対応行は推測せず `unknowns` に出す
- 解析できた行とできなかった行の件数をUIに出す

### 4.3 レセプト点検ルールの統一スキーマ

現在は算定エンジン、LLM warning、review issue、UI annotation が分散しやすい。

追加すべき `ReceiptCheckFinding`:

```json
{
  "findingId": "receipt_check_comment_missing_xxx",
  "category": "comment",
  "severity": "review",
  "patientId": "pat_...",
  "claimMonth": "2026-06",
  "lineCode": "120001210",
  "lineName": "処方料（その他）",
  "messageForStaff": "処方料のレセプトコメントを確認してください。",
  "chartInsertionText": "ドンペリドン XXmg 1日X回 X日分。",
  "receiptCommentDraft": "必要な理由を記載...",
  "source": {
    "ruleId": "comment_required",
    "edition": "R08",
    "validOn": "2026-06-28"
  },
  "autoBillable": false
}
```

ポイント:

- UI表示用文言と内部コードを分ける。
- カルテ赤字に出すのは `chartInsertionText` のみ。
- レセプトコメント案は `receiptCommentDraft` に分ける。
- 自動算定可否を明示する。

### 4.4 ルール出典と版の管理

現状のマスター管理はあるが、ルール単位の出典と版がUI/監査に十分出ていない。

追加すべき:

- `sourceId`
- `sourceTitle`
- `sourceUrl` またはローカルマスター参照
- `edition`
- `validFrom`
- `validTo`
- `verifiedAt`
- `verificationStatus`

### 4.5 返戻/査定/再審査の実装

現場ヒアリングでは、査定理由が分かりづらいこと、再審査につなげたいことが重要だった。`recept-checker` も返戻・査定分析を持つ。

追加すべき:

- HEN/SAH/増減点データ取込
- 査定理由の分類
- 再審査候補抽出
- 症状詳記/再審査理由ドラフト
- 過去査定と今回レセの類似検出

## 5. 推奨実装方針

### Phase A: 評価基盤

目的:

- `mediaclAI_recept` のゴールデンケースをhalunasuの回帰テストに変換する。

実装案:

- `scripts/import_mediaclai_golden_cases.py` または `python/medical_fee_calculation/golden_importer.py` を作る。
- 出力先は `python/data/golden/mediaclai_recept/`。
- 1ケースを以下へ変換する。
  - clinical facts
  - expected claim lines
  - expected review issues
  - forbidden lines
  - source/provenance

成功条件:

- LLMなしで deterministic calculation の回帰が走る。
- 過大算定が発生したらテストが落ちる。
- 「レビューに出すべき」を「算定しない」と区別して評価できる。

### Phase B: UKE parser / receipt model

目的:

- 再算定差分診断と提出前点検の土台を強くする。

実装案:

- `python/medical_fee_calculation/receipt_uke_parser.py` を追加する。
- `baseline_adapter.py` は互換維持しつつ、内部で新parserを使う。
- 出力モデル:
  - `ParsedClaimFile`
  - `ParsedReceipt`
  - `ParsedReceiptLine`
  - `ParsedDisease`
  - `ParsedComment`
  - `ParsedSymptomDetail`
  - `UnknownReceiptRecord`

成功条件:

- 既存レセUKEを患者/月/コード単位で正規化できる。
- halunasu出力UKEを再パースできる。
- unknownsを推測せずUI/CSVに出せる。

### Phase C: receipt check layer

目的:

- 算定後に、提出前のレセ点検を行う。

実装案:

- `python/medical_fee_calculation/receipt_checks.py` を作る。
- 最初は低リスクルールだけ。
  - unknown code
  - fixed points mismatch
  - total points mismatch
  - missing base visit fee
  - missing prescription fee
  - missing comment
  - duplicate/exclusive simple pairs
  - same-day first/revisit conflict
- Node側は `python-calculator.js` 経由で `receipt_check` op を追加する。
- `packages/fee-core` は `receiptCheckFindings` を `reviewItems` に変換する。

成功条件:

- セッション画面で候補作成後に点検Findingが出る。
- 月次画面で患者別に点検Findingが集約される。
- 再算定差分診断で、差分の理由に点検Findingを添えられる。

### Phase D: facility settings / exclusions

目的:

- 施設ごとの運用差を安全に反映する。

実装案:

- 既存の「算定設定」に `receiptCheckPolicy` を追加する。
- ルール単位で severity を変更できる。
- 除外は「UI表示抑制」に限定し、自動算定ロジックには使わない。
- 変更は監査ログに残す。

成功条件:

- 現場ノイズを減らせる。
- ただし危険な自動算定抑制や過剰請求誘導にならない。

### Phase E: longitudinal / assessment

目的:

- 月次レセ点検と再審査支援へつなげる。

実装案:

- 患者/月/コード/回数/点数の履歴を保存する。
- 既存レセ取り込み結果も履歴に入れる。
- HEN/SAH/増減点を取り込む。
- 「過去査定と似ている」「再審査対象になり得る」を出す。

成功条件:

- 月次画面で「次にやること」が返戻/査定/再審査までつながる。
- 査定理由の蓄積から、次回候補生成やコメント不足検出が改善する。

## 6. UIへの反映方針

### セッション画面

外部ロジックを入れても、UIは複雑にしない。

方針:

- 算定候補リストに混ぜるのは「実際に採用/不採用判断が必要なもの」だけ。
- カルテ赤字に出すのは「カルテ本文に追記できる文」だけ。
- 施設基準未登録や内部警告は右リストに出しすぎない。
- レセプト案側に「提出前点検」セクションを置く。

### 月次画面

月次画面の本質は「月末月初に、どの患者を先に確認し、何を直すか」を出すこと。

方針:

- 右ペインは「患者サマリ」「要対応の優先順位」「代表的な修正候補」に絞る。
- 全Findingを羅列しない。
- 詳細は展開/CSV/HTML出力に逃がす。

### 再算定差分診断

方針:

- 患者ごとのZIPを扱えるようにする。
- 分類は最低限以下。
  - 一致
  - 既存のみ
  - 当社のみ
  - 両方差分あり
  - 再現失敗
  - unknown
- 差分はすべて要確認で、自動的に「改善余地」と言い切らない。

## 7. 実装時の注意

### ライセンス

ローカル確認範囲では、両リポジトリに `LICENSE` ファイルは見当たらなかった。

そのため、コードを直接コピーするのではなく、まずは設計・分類・テスト観点として取り込む。コード流用が必要な場合は、リポジトリ所有者/ライセンスを確認してから行う。

### 公的マスター

`recept-checker` READMEには公式マスターDB/CSVが前提として書かれているが、今回のローカルcloneでは `receipt_checker/masters/data/*.csv` は確認できなかった。

そのため、ルールを移植してもマスターがないと完全には動かない。halunasu側の既存 `python/medical_fee_calculation` マスター基盤へ寄せるべき。

### 推測禁止

再算定差分診断やモックHOMISデータセットと同じく、取れない情報は推測しない。

- 解決できないコード
- 用量/日数不明
- 病名不明
- コメント要否不明
- UKEレコード未対応

これらは `unknowns` / `needs_review` に出す。

### 過大算定の扱い

評価では、過小算定より過大算定を重く罰する。これは `mediaclAI_recept` の評価思想とも一致する。

UIでも以下を守る。

- 「実施事実がある候補」だけを出す。
- 「自動算定」ではなく「候補/要確認」として出す。
- 金額訴求だけを前面に出さない。

## 8. 最終判断

### 取り込むべきもの

- `mediaclAI_recept` の5層設計、安全思想、provenance、ゴールデンケース、評価指標。
- `recept-checker` のUKE parser、Receiptモデル、Findingモデル、ルールカテゴリ、縦覧、返戻/査定分析。

### 取り込まないもの

- 外部リポジトリ丸ごとの依存化。
- DBスキーマ丸ごとの置換。
- FastAPI/CLI/Web UIの丸ごと移植。
- DSL全面化。
- LLMによるコード/点数確定。

### halunasu fee での最適な使い方

halunasu fee は、今の「カルテから算定候補を作る」強みを維持しつつ、外部2件を次の3つの補助レイヤとして使うのが最適。

1. 評価レイヤ: ゴールデンケースと安全指標。
2. レセ点検レイヤ: UKE/receipt check/縦覧/コメント/病名/点数検証。
3. 運用レイヤ: provenance/改定追従/返戻・査定・再審査。

