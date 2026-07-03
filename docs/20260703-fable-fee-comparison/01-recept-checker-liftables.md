# 01. recept-checker から移植できる実装済みロジック

recept-checker は**動く Python 実装（9,040行）**。halunasu に不足している「点検レイヤー」の部品がそのまま揃っている。
各項目に **出所 / 何をするか / halunasu への適用 / 効果・コスト** を付す。

halunasu の受け皿になる主なファイル:
- `python/medical_fee_calculation/`（Python算定エンジン＋マスタ。点検マスタの置き場所として自然）
- `packages/fee-core/src/index.js`（`buildMonthlyBaselineDiagnosis` / `buildReviewItems` / `buildCandidateWorkbench`）
- `services/fee-api/src/claim-risk-knowledge.js`（現状の数少ない点検ロジック）
- `apps/fee-web/lib/baseline-diff.js` ＋ STG 再算定差分診断

---

## A. 公的チェックマスタのクエリ層 🔴最優先

**出所**: `receipt_checker/masters/official.py`（`OfficialMasters`）＋ `official_import.py`（公的データ→SQLite）

**何をするか**: 支払基金が公開する機械可読チェックマスタ（無償・約160万行/年度）を SQLite 化し、コード単位で引く読み取り専用APIを提供。

```python
official.drug_indications(drug_code)   # 医薬品→適応傷病名（性別・年齢条件つき）  ~123万行
official.drug_dose_rules(drug_code)    # 1日最大量・最長投与日数
official.drug_kinki_diseases(drug_code)# 禁忌傷病名
official.heiyo_kinki_pairs(codes)      # 併用禁忌ペア（双方向→片方向正規化）  4,208行
official.act_indications(act_code)     # 診療行為→適応傷病名（入外・疑い可否つき）  21.8万行
official.haihan_pairs(codes, span)     # 背反ペア（day/month/simul/week）  77,494行
official.kaisu_limits(code)            # 算定回数上限（unit_code, 上限, 特例フラグ）  5,928行
official.hokatsu_children(group_no)    # 包括される側の診療行為  248,235行
official.cc_jirei_for(code)            # 支払基金コンピュータチェック事例（観点・内容）
```

- スレッドローカル接続＋`lru_cache`＋`mode=ro` の読み取り専用。
- `NON_DISEASE_CODES`（0000000等）除外、`AGE_SPECIAL`（B6=6歳到達翌月1日 等）の年齢コード解釈まで実装済み。

**halunasu への適用**:
- halunasu は `python/medical_fee_calculation` に既に**算定用マスタDB＋Pythonワーカー**を持つ（`python-calculator.js` の worker/master_search）。ここに**点検用テーブル群を同居**させ、`op: "check_lookup"` を worker に追加すれば、fee-api から `feeCalculator` 経由で引ける。
- これが**下記 B/C/D 全ルールの共通データ基盤**。まずこの層を halunasu に敷くのが最優先。

**効果**: 大（点検の土台一式）。 **コスト**: 中（取込スクリプト＋worker op追加。データは公的・無償）。

---

## B. 算定もれ点検（増収チェック） 🔴最優先

**出所**: `receipt_checker/rules/r10_missing.py`

実装済みの4系統（いずれも halunasu の「算定もれ候補」を根拠付きで強化できる）:

1. **検体検査判断料もれ（`KensaHanteiRyoRule` MI-002）**: 実施検査の `kensa_group`/`kensa_hantei` を集計し、判断料（月1回）未算定を検出。**D000（尿一般）のみは判断料不可**という例外まで実装。生活習慣病管理料(I)包括の注記あり。
2. **基本診療料なし（MI-003）**: 外来レセに初再診・外来診療料が無いケース（`kubun` A000/A001/A002 で判定）。
3. **処方料・処方箋料もれ（MI-004）**: 投薬（診療識別21/22/23）があるのに F100/F400 が無い。
4. **施設ルール算定もれ（`MissingBillingRule` MI-001）**: `missing_patterns.csv` の trigger（act/drug/drug_category/disease）→ expected の逆引き。

**halunasu への適用**:
- halunasu の月次点検・候補ワークベンチ（`buildCandidateWorkbench`, `buildMonthlyBaselineDiagnosis`）に「算定もれ候補」を追加。現状の baseline-diff は「当社再算定 vs 既存レセ」の差だが、**MI系は単一レセ内の論理から算定もれを見つける**ので、既存レセ or 当社算定の**両方に対して独立に**効く。
- `MI-002` の判断料ロジックは halunasu の `lab_calculator.py`（検査系）と親和性が高い。

**効果**: 大（"増収"は顧客価値に直結）。 **コスト**: 小（ルールは自己完結、Aの基盤があれば数百行）。

---

## C. 適応病名・禁忌・併用禁忌の点検 🔴最優先

**出所**: `receipt_checker/rules/r04_drug_indication.py`（IY-001/IY-003）, `r05_act_indication`, `r07_contraindication`, `r08_exclusive`

**ロジックの質が高い点**（そのまま設計指針になる）:
- **適応判定は性別・年齢で絞ってから**病名照合（`sex_matches` / `age_matches`）。
- **疑い病名の扱いを分離**: 適応病名が「疑い」しかない場合は ERROR でなく INFO で「検査は疑いで可・治療は確定病名」と案内（`suspected_only_codes`）。過剰検知を避ける良い設計。
- **公的データが無い薬剤は対象外**（＝支払基金がチェック対象にしていない薬は指摘しない）→ 誤検知抑制。無い場合のみ施設ルールCSVで補完。
- 禁忌傷病名（IY-003）は ERROR、症状詳記での説明を促す。

**halunasu への適用**:
- halunasu の `claim-risk-knowledge.js`（現状は左右/部位不一致のみ）を、この適応/禁忌/併用の体系に拡張。LLM抽出済みの病名（`session.diagnoses`）＋算定コードに対して A の公的マスタで照合する。
- **「疑い病名は検査OK・治療NG」の非対称**は、halunasu の needs_review 判定ロジックにそのまま採用価値あり。

**効果**: 大（A/B査定＝突合点検の最多要因）。 **コスト**: 中（Aの基盤前提、性別年齢照合ヘルパ含めて移植）。

---

## D. 縦覧（複数月）点検 🟠

**出所**: `receipt_checker/rules/r12_longitudinal.py` ＋ `receipt_checker/store.py`（`HistoryStore`）

**実装済みルール**:
- **LG-001 複数月回数超過**: `kaisu_limits` の複数月単位（143=2月/146=6月/147=12月…）と患者単位（53=患者当り/135=初回）を、**カレンダー窓（`_window_by_calendar`）で過去月と通算**。件数スライスでなく診療年月で窓を切る（受診月に空きがある患者で遡りすぎない）——地味だが正確性の要。
- **LG-002 短期間の初診料再算定**: 直近3月に初診料があれば警告。前回レセの継続病名（転帰未記録）も提示。
- **LG-003 疑い病名の複数月持ち越し**: 過去月から疑い病名が確定/中止されず持ち越し。

**`HistoryStore`（`store.py`）**: `patient_key`（氏名＋生年月日等）＋診療年月で過去レセを SQLite 蓄積し `past_months()` で参照。

**halunasu への適用**:
- halunasu には既に **`listPriorSessionsForPatient`（患者×過去セッション）** がある。これを"縦覧窓"として使えば、`HistoryStore` 相当を新規に作らずとも LG-001〜003 を実装できる。
- 月次点検（`buildMonthlyClaimSummary`）に「縦覧要確認」を1カテゴリ追加する形が自然。

**効果**: 大（縦覧査定は市販ソフトの主力機能）。 **コスト**: 中（患者履歴の素地があるので接続中心）。

---

## E. 年度版マスタの版解決（改定跨ぎ） 🟠

**出所**: `receipt_checker/masters/official.py`（`MasterVersions.for_ym`）＋ `engine.py`（レセプト単位で版選択）

```python
def for_ym(self, ym):   # effective_from <= 診療年月 のうち最新版
def run(...):           # レセプトごとに ctx_for(ym) で版を切替（月遅れ請求の混在対応）
```

**halunasu への適用**:
- halunasu は claimMonth をセッションに持ち、直近の T1-1 で「診療年月で月クエリ」を整備した。ここに**マスタ版も診療年月で解決**する `for_ym` 相当を足せば、R8二段階施行（本体6/1・薬価4/1・材料6/1）を扱える。
- mediaclAI の `effective.resolve_by`（shinryo_ym / admission_start_date / todokede_nendo）が上位設計（[02](02-mediaclai-design-patterns.md) 参照）。

**効果**: 中（改定期の誤り防止）。 **コスト**: 小（構造は単純）。

---

## G. 返戻・査定フィードバックの取込・集計 🟡

**出所**: `receipt_checker/henrei.py`

**何をするか**: オンライン請求で取得できる返戻ファイル（RECEIPTC.HEN/SAH）と増減点連絡書CSV（RIzogn…）を解析し、**事由記号（A適応外/B過剰/D要件不合致/F固定点数誤り…）別・診療区分別・月別**に集計（`JIYU_LABELS`）。増減点数の「-216（点）/ -¥7000（金額）」両形式パースまで対応。

**halunasu への適用**:
- halunasu の教師信号／点検優先度付けに使える。「どの事由・区分で査定されたか」を蓄積 → 点検ルールの重み・除外設定にフィードバック。
- mediaclAI の eval harness「§5 教師信号（返戻/査定からのラベル化）」と接続すると、点検精度の継続改善ループになる。

**効果**: 中（学習信号）。 **コスト**: 中（パーサ移植＋蓄積スキーマ）。

---

## H. 未コード化病名の分解コード化支援 🟡

**出所**: `receipt_checker/masters/official.py`（`decompose_uncoded_name`）

**何をするか**: 未コード化傷病名（0000999、ワープロ病名）を「接頭語＋基本病名＋接尾語」に貪欲分解し、修飾語マスタ（8xxx=接尾/その他=接頭）＋病名マスタ完全一致でコード化候補を提示。例:「急性気管支炎の疑い」→ 急性(4012)＋気管支炎＋の疑い(8002)。

**halunasu への適用**: halunasu の病名整備／レセ病名対策UIに。カルテ由来の自由文病名を標準コードへ寄せる支援。

**効果**: 中。 **コスト**: 小（自己完結、修飾語マスタがあれば移植容易）。

---

## 移植しやすさの理由（設計面）

recept-checker のルールは **`Rule` 基底クラス＋`CheckContext`＋`Finding`** の綺麗な形（`rules/base.py`, `models.py`）:
- 各ルールは `check(receipt, ctx) -> list[Finding]` の純関数に近い形。
- ルールON/OFF・除外設定（過剰検知対策）が最初から入っている（`CheckEngine(enabled_rule_ids/disabled_rule_ids)`）。
- **UKEデータモデル（`models.py`）が優秀**: `day_counts`（31日算定日情報）、和暦/西暦両対応（`parse_receipt_date`）、`is_suspected`（修飾語8002）、`is_uncoded`、`age`（診療年月初日時点満年齢）。halunasu の UKE パース（Python adapter）を補強する参照実装になる。

→ halunasu は「ルール＝純関数、入力＝正規化済みレセ、出力＝Finding」の型を**そのまま踏襲**でき、[02](02-mediaclai-design-patterns.md) の宣言的DSLへ発展させる土台にもなる。

---

## この文書での優先順位

1. **A（公的マスタ層）** — 全点検の共通基盤。まずここ。
2. **B（算定もれ）＋ C（適応/禁忌）** — 顧客価値（増収・A/B査定回避）が最も直接的。
3. **D（縦覧）＋ E（版解決）** — halunasu の患者履歴・claimMonth 素地を活かせる。
4. **G/H** — 継続改善と病名整備。余力で。
