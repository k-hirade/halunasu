# 診療報酬算定アプリ 現状チェック & 改善提案

作成日: 2026-06-02 JST

対象:

- `apps/fee-web`
- `services/fee-api`
- `packages/fee-contracts`
- `packages/fee-core`
- `python/medical_fee_calculation`
- `docs/migration-parity/2026-05-30-fee-production-coverage-audit.md`
- `docs/migration-parity/2026-06-01-fee-complete-migration-plan.md`

## 結論

現状の診療報酬算定アプリは、患者・施設・診療科を選び、診療オーダーから算定候補を作成し、レビュー理由とレセプト案を確認する「算定候補・レビュー支援ツール」としては動作する。

ただし、これは「確定請求」や「医科診療報酬点数表の全章を自動算定するツール」ではない。実装の中心は外来検体検査であり、初再診、投薬、注射、処置、画像、入院基本料などは一部ロジックがあるものの、通常UIでは十分に露出していない。DPC、医学管理、在宅、リハビリ、精神科専門療法、手術、麻酔、放射線治療、病理診断は未対応またはマスター参照のみであり、要レビュー前提で扱う必要がある。

UX改善では、Charting/SOAP/オーダーからの下書き取り込み、マスター検索付きオーダー入力、算定根拠の可視化が最も効く。精度改善では、マスター鮮度管理、未接続/未露出ロジックの段階的なUI接続、最小の適応病名チェックが優先である。

プロダクトとしては、当面「全自動の診療報酬請求」ではなく、「カルテ/オーダーから算定候補を作り、算定漏れ・査定リスク・要確認理由を出す支援ツール」として育てる方が価値が出やすい。レセ電提出、ORCA連携、DPC本実装、全章自動算定は別製品級の責任とコストを伴うため、現時点では中核スコープに入れない。

## 重要な補正

提供メモでは「入院、DPC、画像、注射、投薬、処置、初再診基本のモジュールがアプリ算定フローに未接続」と整理されている。

コード上の実態は次の通り。

- `fee-api` はセッションに保存された `claimContext` / `calculationOptions` を Python worker に渡せる。
- Python 側の `build_claim_payload` は `calculationOptions` から `outpatient_basic`、`medication`、`injection`、`inpatient_basic`、`dpc`、`medication_orders`、`injection_orders`、`treatment_orders`、`imaging_orders` を claim payload に載せる。
- `calculate_lab_claim_standardized` は、外来検査ロジックを主軸にしつつ、投薬、注射、処置、画像、入院基本料の候補化関数も呼んでいる。

したがって、正確には「完全未接続」ではなく、「通常UIからは精度に必要な詳細入力がフォーム化されておらず、JSONを直接入力しないと到達しにくい」である。ユーザー体験としては未接続に近いが、内部的な到達経路は存在する。

## A. いま実装済みのこと

| 領域 | 現状 |
| --- | --- |
| 認証 | 病院コード、個人ID、パスワード、MFA による共通 platform-api ログインを利用する。Fee product entitlement がないユーザーは拒否される。 |
| 患者・施設 | Platform 患者の選択、検索、新規作成、施設選択、診療科選択ができる。 |
| 算定セッション | 作成、一覧、ページング、ステータス絞り込み、詳細、更新ができる。診療日、請求月、区分、患者、施設、診療科、診療テキスト、オーダーを保存できる。 |
| オーダー入力 | `type|name|standardCode|quantity` 形式で簡易入力できる。`procedure`、`drug`、`injection`、`material`、`treatment`、`imaging` などを契約上扱える。 |
| 詳細入力 | `claimContext JSON` と `calculationOptions JSON` を保存できる。旧 engine 相当の詳細 payload、履歴、施設基準、コメント、投薬/注射/処置/画像/入院/DPCレビュー用 option を渡せる。 |
| 算定実行 | Python engine で算定し、line items、合計点数、警告、messages、input codes、candidate codes、coverage、support level、review required を返す。 |
| 算定ルールチェック | `electronic_rules` による併算定、包括、除外、頻度制限、必須コメント系の advisory/warning を扱う。 |
| レビュー | review item の一覧取得、承認、却下、修正済み扱いができる。判定時に audit event を記録する。 |
| レセプト案 | 算定結果から receipt draft を構築し、画面上に表示できる。 |
| 監査 | 患者作成、セッション作成/更新、算定実行、レビュー判定で audit event を記録する。 |
| テスト | fee-contracts、fee-core、fee-api、fee-web、Python legacy tests が存在し、2026-06-02時点の確認では通過している。 |

## B. いまできていないこと・限界

### 1. 本番確定請求ではない

現行アプリは「算定候補・レビュー支援」として設計されている。Python API の coverage description も、結果を finalized claim calculation ではない billing candidate として扱う。

確定請求、レセ電提出、ORCA連携、最終請求承認、請求ファイル生成までは未実装である。

### 2. 算定範囲は外来検体検査が中心

主な算定入口は `run_outpatient_lab_claim_payload` から `calculate_lab_claim_standardized` である。

実装上は次のように評価できる。

| 区分 | 現状 |
| --- | --- |
| D 検査 | D026判断料、検体検査管理加算、採取料、外来迅速検体検査加算、頻度制限 warning などがあり、最も厚い。 |
| A 初再診 | 一部候補化あり。ただし通常UIでは詳細条件を十分に入力できない。 |
| F 投薬 | 外来中心に一部候補化あり。入院投薬は限定的。 |
| G 注射 | 一部経路と加算のみ候補化。 |
| E 画像 | 一部モダリティ、画像診断管理加算、遠隔画像診断を候補化。 |
| J 処置 | 一部処置のみ候補化。 |
| A 入院基本料 | 明示入力された入院基本料コードを候補化する範囲。 |
| DPC | DPCテーブルは未投入で、本実装ではなくレビュー扱い。 |
| B 医学管理、C 在宅、H リハ、I 精神科、K 手術、L 麻酔、M 放射線治療、N 病理 | 専用ロジックなし。コードを入れてもマスター参照/要レビュー扱いに留まる。 |

UIで「入院」を選べるため、ユーザーは入院算定まで対応していると期待しやすい。しかし実際は入院基本料候補やDPCレビューに限定される。UI上で「入院は限定対応/要レビュー」と明示する必要がある。

### 3. 詳細条件がJSON入力に寄っている

`claimContext JSON` / `calculationOptions JSON` は移行上は有効だが、通常ユーザー向けUIではない。

特に次の入力は精度に直結するが、画面上の通常フォームとしては弱い。

- 病名/ICD-10
- 保険/公費
- 月内/同日/同週履歴
- 施設基準
- コメントコード/コメント本文
- 投薬の用法、日数、院内/院外、後発名処方
- 注射の経路、薬剤、手技
- 画像のモダリティ、部位、造影、遠隔画像診断
- 入院の入院日、病棟、入院基本料、DPC関連情報

### 4. 適応病名チェックがない

査定減点に直結する「病名と診療行為/薬剤/検査の保険適応マッチング」は確認できない。

現在の warning/review は、算定ルール、履歴不足、施設基準、コメント不足、マスター参照のレビューに寄っている。病名妥当性、疑い病名、禁忌、適応外、コメント/症状詳記の必要性まで構造化する必要がある。

### 5. 施設基準・加算の自動適用が限定的

地方厚生局データは取り込まれているが、算定ロジックが解釈できる施設基準辞書は限定的である。

既存監査では、施設基準辞書は検体検査管理加算、画像診断管理/遠隔画像診断、入院基本料系の18ルール程度に限定される。医学管理、在宅、手術、麻酔、リハ、精神科などの施設基準は自動判定対象外である。

### 6. オーダー入力がコード直打ち

現行UIはテキストエリアに `procedure|血液検査|160000410|1` のように入力する形式である。

これは開発/検証には簡潔だが、実運用では次の問題がある。

- コードを知っている前提になる。
- マスター名称検索がない。
- 数量、単位、日数、部位、用法、モダリティなどを型付きで入力できない。
- 入力ミスの事前検知が弱い。
- 候補コードと実施オーダーの対応関係が見えにくい。

### 7. Charting連携がない

Charting/SOAP/確定オーダーから Fee へ自動で流す導線がない。

同じユーザーがカルテ作成アプリと診療報酬アプリを使う場合、現状は診療内容やオーダーを二重入力する必要がある。UX上の最大ボトルネックであり、入力漏れによる精度低下にもつながる。

### 8. レセプト出力・確定フローがない

レセプト案は画面表示できるが、現時点では以下がない。

- レセ電ファイル出力
- CSV export
- PDF/印刷向け整形
- 請求確定ステータス
- 最終承認ワークフロー
- 提出前チェックリスト
- ORCA/電子カルテ/会計システム連携

### 9. マスター鮮度にリスクがある

2026-05-30の監査では、実行DBと公式最新マスターの間に差分が確認されている。

主なリスク:

- 医科診療行為、医薬品、特定器材、コメント、コメント関連テーブルに差分がある。
- DPC系テーブルは定義があるが実行DB内が0件。
- 固定 catalog が古い公式URLを参照している可能性がある。

精度改善の前提として、公式マスター更新と差分検知を運用化する必要がある。

### 10. UXの細部が運用向けに足りない

改善余地:

- 英語エラーの日本語化
- ローディング状態
- 空状態
- 入力バリデーション
- 保存済み/未保存の状態表示
- 算定中/再計算中の状態表示
- review required の理由の見やすさ
- 点数内訳と根拠ルールの可視化
- 一括承認/却下
- キーボード操作
- 差分表示

## C. 精度を上げる提案

### C0. 実装判断

### 今やる

| 施策 | 判断理由 |
| --- | --- |
| 未対応範囲の明示 | 「入院」や未対応章を選べるのに非対応範囲が見えない状態は事故源になる。 |
| マスター検索付きオーダー入力 | コード直打ちは実運用に弱く、入力ミスと二重確認を増やす。 |
| 算定根拠・review理由の可視化 | レビュー支援ツールとしての信頼性に直結する。 |
| Chartingからの下書き取り込み | ハルナス全体のUX価値が高く、二重入力を減らせる。自動確定ではなくpreview前提にする。 |
| マスター鮮度管理 | 点数/薬価/器材価格の誤差を防ぐ土台になる。 |
| 最小の適応病名チェック | 病名不足や代表的な高頻度項目のwarningから始める。 |

### 後でやる

| 施策 | 判断理由 |
| --- | --- |
| レビュー一括承認/キーボード操作/差分表示 | 候補数が増え、実利用でレビュー量が見えてからでよい。 |
| `calculationOptions` 全項目のフォーム化 | 全部をUI化すると重い。高頻度項目だけ先にフォーム化し、詳細JSONは検証/管理用に残す。 |
| 章別ロジック拡張 | 対象顧客がクリニック中心か病院中心かを決めてから優先章を選ぶ。 |
| CSV/PDF/印刷出力 | 「レビュー支援」の業務成果物としては有効だが、検索入力/根拠表示の後でよい。 |
| Gold dataset本格運用 | 精度改善が増えた段階で回帰防止として強化する。 |

### 今はやらない

| 施策 | 判断理由 |
| --- | --- |
| レセ電ファイル提出 | プロダクト責任が一段重くなる。候補/レビュー支援の精度と運用が固まってから判断する。 |
| ORCA/会計システム連携 | 外部連携コストが大きく、現時点の中核価値ではない。 |
| DPC本実装 | 別製品級のデータ、ロジック、検証が必要。今は未対応/レビュー対象として明示する。 |
| 全章自動算定 | 開発範囲が広すぎる。対象顧客と診療領域を絞って進める。 |

### P0: マスター鮮度と差分検知をCI/運用に組み込む

最初にやるべきことは、公式マスターと実行DBの差分を継続的に検出すること。ただし、DPCを当面の提供価値にしない場合、DPCテーブル0件を無条件にCI失敗扱いにはしない。DPC機能フラグが有効な環境だけ失敗扱いにし、それ以外は「DPC未対応モード」としてUI/APIで明示する。

実施内容:

- 公式SSKマスターの取得 catalog を最新化する。
- 医科診療行為、医薬品、特定器材、コメント、コメント関連テーブルの差分をCIで監視する。
- DPC系テーブル0件は、DPC機能フラグが有効な場合だけ失敗扱いにする。
- DPC機能フラグが無効な環境では、DPC未対応モードとしてUI/APIへ反映する。
- master version、取得日、反映日を UI に表示する。

期待効果:

- 古い点数/薬価/器材価格による誤算定を減らせる。
- 「なぜ点数が違うか」の調査時間を減らせる。

### P0: 最小の適応病名チェックを導入する

病名と診療行為/薬剤/検査の保険適応マッチングは、査定減点を減らす上で重要である。ただし、本格的な適応チェックを最初から網羅実装するのは重い。まずは「病名入力欄」「病名不足warning」「代表的な高頻度項目だけの適応チェック」に絞る。

実施内容:

- 診断名/ICD-10/疑い病名/主病名を Fee session に構造化して保存する。
- 病名が未入力の算定候補に warning を出す。
- 代表的な高頻度検査/薬剤/処置から適応チェックを始める。
- 不一致、病名不足、コメント/症状詳記不足を warning/review item にする。
- 根拠資料、通知、ルールIDの網羅表示は後続フェーズにする。

期待効果:

- 単純な点数計算よりも実務上の価値が高い。
- レビュー担当者が「何を直せばよいか」を判断しやすくなる。

### P1: 未露出ロジックを通常UIに接続する

現在、詳細JSON経由で届く入力を通常UIへ引き上げる。ただし、`calculationOptions` の全項目を一気にフォーム化する必要はない。利用頻度が高く、精度への影響が大きい項目から進める。

優先順:

1. 初再診/外来基本
2. 投薬
3. 注射
4. 処置
5. 画像
6. 入院基本料
7. DPCレビュー

実施内容:

- 高頻度の `calculationOptions` をフォーム化する。
- オーダー種別ごとに必要フィールドを出す。
- 入力内容を保存済み session に永続化し、再計算時にそのまま使う。
- 入院を選んだ場合は、入院算定の限定対応範囲を明示する。

期待効果:

- 既存エンジン資産をユーザーが使える状態にできる。
- JSON手入力をなくし、入力漏れを減らせる。

### P1: 算定ルールを構造化して拡張する

`electronic_rules` の warning/blocked を、UIで扱いやすい構造にする。

実施内容:

- 併算定不可、包括、除外、月内回数、上限、必須コメントを rule type 別に返す。
- warning/blocked の理由、対象コード、関連コード、対応方法を構造化する。
- review item に自動変換し、解消済み判定を持たせる。

期待効果:

- レビュー効率が上がる。
- 根拠と修正先が明確になる。

### P1: 施設基準を施設プロファイルから自動候補化する

施設基準があるかないかで加算候補が変わるため、施設プロファイルを算定に直結させる。ただし、全領域に一気に広げる必要はない。現エンジンが候補化できる検査、画像、入院基本料系から始める。

実施内容:

- hospital registry / facility standards から施設基準キーを自動解決する。
- UIで「この施設に適用される施設基準」を表示する。
- 不確実な施設基準は warning としてレビュー対象にする。
- 検査、画像、入院基本料系を先に拡張する。
- 医学管理、在宅、リハ、精神科、手術、麻酔は、対象顧客と章別ロジック拡張が決まってから扱う。

期待効果:

- 加算漏れと過剰算定を減らせる。
- ユーザーが施設基準を毎回手入力する必要がなくなる。

### P2: 章別ロジックを対象ユーザーに合わせて拡張する

対象市場によって優先章を分ける。現時点で全章自動算定を目指すべきではない。

クリニック中心:

- B 医学管理
- C 在宅
- D 検査
- F 投薬
- G 注射
- E 画像の一部
- J 処置の一部

病院中心:

- A 入院基本料
- DPC
- K 手術
- L 麻酔
- N 病理
- E 画像

期待効果:

- 限られた実装工数で、利用頻度の高い算定に集中できる。

### P2: Gold dataset を運用に組み込む

既存の migration-parity / gold 評価資産を本番品質の回帰テストにする。

実施内容:

- 実ケースを domain 別に gold 化する。
- 期待点数、期待候補コード、期待warning、期待review itemを保存する。
- master更新時、エンジン変更時、UI入力変更時に必ず評価する。

期待効果:

- 精度改善と回帰防止を両立できる。

## D. UXを上げる提案

### P0: Charting連携

最大の体感改善は、ChartingのSOAP/確定オーダーから Fee に下書き取り込みすること。自動確定ではなく、preview と修正を必須にする。

実施内容:

- Charting session から Fee session の下書きを作成する導線を追加する。
- SOAP本文、診療日、患者、施設、診療科、確定オーダーを Fee の `clinicalText` / `orders` / `claimContext` に変換する。
- 取り込み前に preview を出し、ユーザーが修正できるようにする。
- 取り込み元 charting session ID を Fee session に保存する。

期待効果:

- 二重入力をなくせる。
- 入力漏れが減り、精度も上がる。
- 両アプリを使うユーザーの体感価値が最も上がる。

### P0: マスター検索付きオーダー入力

コード直打ちをやめ、名称/コード検索で入力できるようにする。

実施内容:

- 診療行為、薬剤、特定器材、コメントの検索APIを作る。
- 入力行ごとに type、code、name、quantity、unit、days、route、body part、modality を持たせる。
- コード未選択、数量不正、日付不整合を保存前に警告する。
- 候補検索結果に master version と有効期間を表示する。

期待効果:

- 入力ミスを減らせる。
- ユーザーがコードを知らなくても使える。
- 算定候補と入力オーダーの対応が見やすくなる。

### P0: 算定根拠の可視化

各候補について「なぜ出たか」「なぜ要レビューか」を見せる。

実施内容:

- line item ごとに rule id、source、master version、点数内訳、入力フィールド、review reason を表示する。
- review reason から修正すべき入力欄へジャンプできるようにする。
- `master_lookup_only`、`deterministic_rule`、`candidate_rule`、`review_required` をバッジ表示する。

期待効果:

- レビュー担当者が判断しやすい。
- ユーザーの信頼感が上がる。
- 問い合わせ/調査時間が減る。

### P2: レビュー効率化

実施内容:

- 一括承認/却下
- 差分表示
- キーボード操作
- ステータスフィルタ
- レビューコメント
- 修正済みの自動判定

期待効果:

- 複数候補が出るケースで作業時間を短縮できる。

### P2: レビュー支援成果物の出力

実施内容:

- CSV export
- 印刷/PDF
- 提出前チェックリスト
- レセ電ファイル出力、請求確定ステータス、ORCA連携は現時点では対象外にする。

期待効果:

- 「候補を見る」から「レビュー結果を共有/保存する」へ近づく。

### P1: 基盤UXを整える

実施内容:

- エラーの日本語化
- loading/skeleton
- empty state
- 保存済み/未保存表示
- 算定中の進捗表示
- 初回worker起動中の表示
- master DB 初回展開中の表示
- デザイン統一

期待効果:

- 遅延や失敗をユーザーが理解できる。
- 運用現場での不安が減る。

## E. 推奨ロードマップ

### Phase 1: 使える範囲を明確にしてUXを底上げ

- 入院/DPC/未対応章の表示を「限定対応/要レビュー」にする。
- マスター検索付きオーダー入力を追加する。
- 算定根拠と review reason を見やすくする。
- 本番 readyz に worker/master 状態を出し、初回算定時のUI表示に反映する。

### Phase 2: 精度の土台を固める

- 公式マスター更新 pipeline を整備する。
- master diff を CI gate 化する。
- DPC 空テーブルは機能フラグ付きで検出する。
- 適応病名チェックの最小版を導入する。
- 施設基準辞書を検査、画像、入院基本料系から拡張する。

### Phase 3: Charting連携と実務フロー化

- Charting SOAP/オーダーから Fee session の下書きを作る。
- 取り込み preview と修正UIを作る。
- CSV/PDF export を追加する。
- Gold dataset を本番回帰テストに組み込む。
- レビュー一括操作は実利用で候補量が増えてから判断する。

### Phase 4: 対象診療領域ごとの精度拡張

- クリニック向けなら医学管理、在宅、投薬、注射を優先する。
- 病院向けなら入院、DPC、手術、麻酔を別トラックとして扱う。
- 章別ロジックが未実装の領域は、マスター参照のみで確定扱いしない。

## F. 検証スナップショット

2026-06-02 JST に確認した結果:

- `https://fee.halunasu.com/api/fee/readyz`: OK
- `feeCalculator.provider`: `python.medical_fee_calculation`
- `feeCalculator.workerMode`: `persistent`
- `feeCalculator.workerRunning`: `false`
- `feeCalculator.masterDbGzipPathExists`: `true`

ローカルテスト:

- `npm run test --workspace @halunasu/fee-contracts`: 5 passed
- `npm run test --workspace @halunasu/fee-core`: 4 passed
- `npm run test --workspace @halunasu/fee-api`: 11 passed
- `npm run test --workspace @halunasu/fee-web`: passed
- `PYTHONPATH=python python3 -m unittest discover -s python/tests/legacy_medical_fee_calculation -p '*.py'`: 126 passed

## G. 参照コード

- `apps/fee-web/index.html`: Fee browser UI
- `services/fee-api/src/server.js`: Fee API routes, session persistence, calculation execution, review/receipt endpoints
- `packages/fee-contracts/src/index.js`: Fee session/order/calculation input contracts
- `packages/fee-core/src/index.js`: Fee session, calculation result, receipt draft, review item builders
- `python/medical_fee_calculation/api.py`: Fee API to Python engine bridge
- `python/medical_fee_calculation/claim_batch.py`: claim payload execution entry
- `python/medical_fee_calculation/lab_calculator.py`: standardized calculation aggregation and lab MVP logic
- `python/medical_fee_calculation/procedure_resolver.py`: master lookup and review-required handling
- `python/medical_fee_calculation/electronic_rules.py`: electronic fee table advisory checks
- `docs/migration-parity/2026-05-30-fee-production-coverage-audit.md`: coverage/master freshness audit
- `docs/migration-parity/2026-06-01-fee-complete-migration-plan.md`: complete migration plan
