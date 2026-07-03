# 03. フェーズ1（A/B/C）具体移植設計

> **実装状況（2026-07-03, branch `fix/p1-p4-cross-theme`）**
> フェーズ1（B→A→C）の骨格を実装・テスト済み（fee-core 10 / fee-api 165 / python 9 テスト green）。
> - **B ✅**: engine が明細に検査判断区分を付与（`api.py _fee_line_items` + `_procedure_meta_map`）。fee-core `claim-checks.js` に算定もれ点検（MI-002 判断料 / MI-003 基本料 / MI-004 処方料）＋ `findingToReviewIssue`。算定後の reviewIssues に接続（`server.js` `claimCheckInput`）。**既存マスタのみで稼働**。
> - **A ✅**: `db.py` に支払基金チェックマスタ＋傷病名/修飾語テーブルを追加。`checks_api.py` の `check_lookup`、worker op `check_lookup`、`python-calculator.js checkLookup()`。
>   - **取込 ✅**: `check_masters_import.py`（recept-checker の実績パーサを移植。b_/z_/IY_Tekio/IY_ShobyoKinki/IY_HeiyoKinki/SI_Shobyo をcp932でparse→INSERT）。合成フィクスチャで parse→INSERT→lookup を検証。**実データ取込手順は [04-check-master-runbook.md](04-check-master-runbook.md)**（要ZIPダウンロード）。
>   - **公式ビルド接続 ✅**: `build_fee_master_official.py` に `--check-master-raw`（任意・既定オフ）を追加。指定時は公式マスタビルドで点検マスタを同じDBへ同梱（gzip前）。省略時は従来どおり非同梱。
>   - **候補病名の名称化 ✅（P1-2）**: `check_lookup` の `diseaseNames` を、患者病名だけでなく適応/禁忌マスタ側が参照する病名コードも名称化するよう修正（適応漏れ時の候補病名がコードのまま出る問題を解消）。
> - **C ✅（ロジック＋接続＋病名コード化）**: fee-core `buildIndicationFindings`（IY-001適応/IY-003禁忌/IY-004併用/SI-001診療行為適応、性別年齢・疑い非対称・公的データ無しは無指摘）。算定時に `resolveIndicationReviewIssues` が接続。
>   - **病名コード化 ✅（[01] H）**: `checks_api.resolve_diseases`（recept-checker `search_diseases_by_name`/`decompose_uncoded_name` を移植。名称→傷病名コード＋疑いフラグ＋接頭/接尾分解）、worker op `resolve_diseases`、`python-calculator.js resolveDiseases()`。算定時に `enrichClaimDiseaseCodes` が診断名→コードを解決してから照合。未解決病名は無指摘（安全側）。
>   - **残（データのみ）**: 実効化には [04](04-check-master-runbook.md) の実CCデータ取込が必要（コードは完了）。
> - **未着手**: MI-001 施設パターン（設定化）、baseline-diff への同一 `runClaimChecks` 再利用（[01] の C3）、多版(改定跨ぎ)の check_lookup 版解決。

---


対象: recept-checker の点検レイヤーを halunasu/fee に移植する。
- **A**: 公的チェックマスタのクエリ層
- **B**: 算定もれ点検（検査判断料 / 基本診療料 / 処方料 / 施設パターン）
- **C**: 適応病名 / 禁忌 / 併用禁忌 点検

---

## 0. 最重要の発見 — halunasu に「既にあるもの / ないもの」

移植前に halunasu の Python マスタDB（`python/medical_fee_calculation/db.py`）を精査した結果、**背反・包括・回数・検査判断区分は既に存在**していた。これがフェーズ1の設計を大きく変える（＝ゼロから作らない）。

| 点検に必要なデータ | halunasu の現状 | 対応 |
|---|---|---|
| 診療行為マスタ（区分・検査判断区分・点数） | ✅ `medical_procedures`（`judgement_kind`/`judgement_group`/`chapter`/`section`/`facility_standard_codes`） | **そのまま使う** |
| 医薬品・特定器材・コメント | ✅ `drugs` / `specific_materials` / `comments` / `comment_links` | そのまま |
| 背反（同時算定不可） | ✅ `electronic_exclusions`（base_code/excluded_code/rule_kind） | そのまま |
| 包括 | ✅ `electronic_bundles`（bundle_group_code/procedure_code） | そのまま |
| 算定回数 | △ `electronic_frequency_limits`（limit_code はあるが**上限数値なし**＝raw_row_json） | 数値抽出が要（D縦覧で本格対応） |
| **傷病名マスタ（byomei）** | ❌ 無し | **A で新規取込** |
| **修飾語マスタ（shushokugo）** | ❌ 無し | **A で新規取込** |
| **支払基金チェックマスタ 適応（iy_tekio）** | ❌ 無し | **A で新規取込** |
| **禁忌傷病名（iy_kinki_byomei）** | ❌ 無し | **A で新規取込** |
| **併用禁忌（iy_heiyo_kinki）** | ❌ 無し | **A で新規取込** |
| **診療行為適応（si_shobyo）** | ❌ 無し | **A で新規取込** |

**結論**:
- **B（算定もれ）は halunasu の既存マスタだけで実装できる** → A を待たずに先行リリース可能。
- **C（適応/禁忌/併用）と病名整備だけが新規マスタ取込（A）を要する**。

→ リリース順は **B → A → C** が最適（README のフェーズ1内の順序を精緻化）。

---

## 1. アーキテクチャ全体

```
                        ┌─────────────────────────────────────────┐
                        │  packages/fee-core/src/claim-checks/      │  ← ロジック層(純関数・JSでテスト可)
                        │   missing.js (B) / indication.js (C) …    │
                        │   runClaimChecks({input, lookup}) → Finding[]│
                        └───────────────▲──────────────────────────┘
                                        │ lookup(codes) を注入(DI)
        ┌───────────────────────────────┴───────────────────────┐
        │ services/fee-api/src/server.js                          │
        │   算定後: reviewIssues に Finding をマージ(既存 3402付近) │
        │   月次点検 / baseline-diff からも同じ runClaimChecks を呼ぶ│
        └───────────────▲───────────────────────────────────────┘
                        │ feeCalculator.checkLookup(codes)  (async)
        ┌───────────────┴───────────────────────────────────────┐
        │ services/fee-api/src/python-calculator.js               │
        │   worker op "check_lookup" を追加                        │
        └───────────────▲───────────────────────────────────────┘
                        │ 同一 master DB(worker常駐)
        ┌───────────────┴───────────────────────────────────────┐
        │ python/medical_fee_calculation/                          │  ← データ層
        │   db.py に byomei/shushokugo/iy_tekio/iy_kinki/iy_heiyo/  │
        │           si_shobyo を追加                                │
        │   check_masters_import.py (新規: 支払基金CC取込)          │
        │   checks_api.py (新規: op=check_lookup)                   │
        └─────────────────────────────────────────────────────────┘
```

**設計方針**:
- **ロジックは JS（fee-core）に置く**。理由: (1) 既存の点検（`claim-risk-knowledge.js`）と同じ場所、(2) reviewIssues への接続が同期JS、(3) `lookup` を注入にすればモックで単体テスト可能。
- **データ取得だけ Python worker**（DBが常駐しており高速）。`checkLookup(codes)` は「コード群→該当マスタ行」を返す薄いクエリ。
- **recept-checker の Python ルールは "参照実装" として JS へ移植**（ロジックは同一、言語だけ変える）。B の 判断料ロジック等は数十行。

---

## 2. A — 公的チェックマスタのクエリ層

### 2.1 データ源（すべて公的・無償。recept-checker `download.py` で確認済み）

| データ | URL（R8 = 令和8年度） |
|---|---|
| 傷病名マスタ b | `ssk.or.jp/.../kihonmasta_07.files/b_20260601.zip` |
| 修飾語マスタ z | `ssk.or.jp/.../kihonmasta_08.files/z_20260601.zip` |
| コンピュータチェックマスタ（適応/禁忌/併用/投与量/事例） | `ssk.or.jp/shinryohoshu/ssk_cc/index.files/20251031_CC_JIREI_CHECKMASTA.zip` |

医科診療行為 s / 医薬品 y はhalunasu が既に持つ（`medical_procedures`/`drugs`）ため再取込不要。

### 2.2 新規テーブル（`python/medical_fee_calculation/db.py` に追加）

recept-checker `official_import.py` のスキーマをそのまま踏襲（列名・型とも実績あり）:

```sql
CREATE TABLE IF NOT EXISTS diseases (          -- 傷病名マスタ(byomei相当)
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL, name TEXT, name_kana TEXT,
    exchange_code TEXT, icd10 TEXT, single_flag TEXT,
    start_date TEXT, end_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_diseases_code ON diseases(code);
CREATE INDEX IF NOT EXISTS idx_diseases_name ON diseases(name);

CREATE TABLE IF NOT EXISTS disease_modifiers (  -- 修飾語(shushokugo相当)
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL, name TEXT, kubun TEXT
);

CREATE TABLE IF NOT EXISTS cc_drug_indications (-- iy_tekio(適応+投与量)
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    drug_code TEXT NOT NULL, disease_code TEXT, sex TEXT,
    age_min REAL, age_max REAL, check_kubun TEXT,
    max_dose REAL, max_days INTEGER, tekigi TEXT, ref_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_ind_drug ON cc_drug_indications(drug_code);

CREATE TABLE IF NOT EXISTS cc_drug_contra_disease ( -- iy_kinki_byomei(禁忌傷病名)
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    drug_code TEXT NOT NULL, disease_code TEXT, ref_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_contra_drug ON cc_drug_contra_disease(drug_code);

CREATE TABLE IF NOT EXISTS cc_drug_interactions (   -- iy_heiyo_kinki(併用禁忌)
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    drug_a TEXT NOT NULL, drug_b TEXT NOT NULL, ref_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_inter_a ON cc_drug_interactions(drug_a);
CREATE INDEX IF NOT EXISTS idx_cc_inter_b ON cc_drug_interactions(drug_b);

CREATE TABLE IF NOT EXISTS cc_act_indications (     -- si_shobyo(診療行為適応)
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    act_code TEXT NOT NULL, disease_code TEXT, sex TEXT,
    age_min REAL, age_max REAL, nyugai TEXT, utagai TEXT, ref_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_act_code ON cc_act_indications(act_code);
```

- `master_sources` に紐づけ、halunasu 既存の版管理（source_version / effective 期間）に載せる。→ 改定跨ぎ（E）と整合。
- 取込は新規 `check_masters_import.py`（recept-checker `official_import.py` の CC パース部を移植。ZIP→固定長/CSV→INSERT）。

### 2.3 worker op `check_lookup`（`python/medical_fee_calculation/checks_api.py` + `worker.py`）

recept-checker `OfficialMasters` のクエリ群を、コード群一括の1リクエストにまとめる（round-trip削減）:

```python
# worker.py の operation 分岐に追加
elif operation == "check_lookup":
    result = check_lookup(payload)   # checks_api.py

# checks_api.py
def check_lookup(payload):
    conn = connect(payload["db_path"]); ...
    drug_codes = payload.get("drug_codes", [])
    act_codes  = payload.get("act_codes", [])
    return {
      "drugIndications":   {c: _drug_indications(conn, c) for c in drug_codes},
      "drugContraDisease": {c: _drug_contra(conn, c)      for c in drug_codes},
      "drugInteractions":  _interaction_pairs(conn, drug_codes),   # ペア正規化済み
      "actIndications":    {c: _act_indications(conn, c)  for c in act_codes},
      "diseaseNames":      _disease_names(conn, payload.get("disease_codes", [])),
    }
```

`python-calculator.js` に薄いメソッド:
```js
async checkLookup(payload) {                 // worker or spawn 両対応(既存踏襲)
  return this.workerMode
    ? this.runWorkerJson({ ...payload, db_path: this.masterDbPath, op: "check_lookup" },
                         { requestIdPrefix: "fee_check", timeoutMs: Math.min(this.timeoutMs, 10000) })
    : runPythonJson({ moduleName: "medical_fee_calculation.checks_api", ... });
}
```

**成果物**: A 完了で「コード→適応/禁忌/併用/病名」を fee-api から引ける。C の前提。

---

## 3. B — 算定もれ点検（**既存マスタのみ・先行リリース**）

### 3.1 配置

`packages/fee-core/src/claim-checks/missing.js`（新規）。入力は halunasu の算定結果＋セッション、出力は共通 `Finding`。

```js
// 共通の点検入力(算定結果+セッションから組み立て)
// { serviceDate, isInpatient, sex, ageYears,
//   acts:[{code, shinryoShikibetsu, judgementKind, judgementGroup, kubun, name}],
//   drugs:[{code, shinryoShikibetsu, name}],
//   diseases:[{code, name, suspected}] }
export function checkMissingBilling(input, { facilityPatterns = [] } = {}) { ... }  // Finding[]
```

### 3.2 実装する4ルール（recept-checker `r10_missing.py` の移植）

| ルール | 使う halunasu データ | ロジック |
|---|---|---|
| **検体検査判断料もれ**（MI-002） | `medical_procedures.judgement_kind`/`judgement_group`（＝kensa_hantei/group 相当が既存！） | 実施検査のグループ集計→未算定判断料を検出。**D000（尿一般）のみは不可**の例外も移植 |
| **基本診療料なし**（MI-003） | `chapter`/`section`（A000/A001/A002）＋診療識別11/12 | 外来レセに初再診/外来診療料が無い |
| **処方料・処方箋料もれ**（MI-004） | `kubun`（F100/F400）＋診療識別21/22/23 | 投薬あるのに処方料/処方箋料なし |
| **施設パターン**（MI-001） | 設定（下記） | trigger（act/drug/disease）→ expected の逆引き |

**判断料の判定に必要な前提**: halunasu の `calculationResult.lineItems` に `judgementKind`/`judgementGroup` を露出させる（engine `api.py` の `_fee_line_items` で `medical_procedures` の該当列を付与）。**小さな engine 変更1点**。他ルールは `chapter`/`kubun`/診療識別で判定でき、既存の line 情報で足りる。

### 3.3 施設パターン（MI-001）の設定化

recept-checker は `missing_patterns.csv`。halunasu では**施設設定（`fee-contracts` の facility settings）に構造化**して持つ（dead設定を作らない方針と整合、UIから編集可能に）。
```
{ triggerType: "act"|"drug"|"disease", triggerCodes:[], triggerKeywords:[],
  expectedCodes:[], expectedName, severity, message }
```

### 3.4 接続

`server.js` 算定後の reviewIssues 生成箇所（現状 `buildClaimRiskReviewIssues` を足している 3402付近）に、`checkMissingBilling(input).map(findingToReviewIssue)` を追加。→ 既存の月次点検（`buildReviewItems`→`feeMonthlySessionReadiness`）にそのまま「算定もれ候補」が乗る。

**B は A 不要・engine変更1点・ルール数十行**でリリースできる。

---

## 4. C — 適応 / 禁忌 / 併用禁忌 点検（A 前提）

### 4.1 配置

`packages/fee-core/src/claim-checks/indication.js`（新規）。`lookup` を注入（DI）にして単体テスト可能に:

```js
// lookup: 上記 checkLookup の戻り(コード→行)を渡す。fee-api では feeCalculator.checkLookup で解決。
export function checkDrugIndication(input, lookup) { ... }   // IY-001
export function checkDrugContraindication(input, lookup) {}  // IY-003
export function checkDrugInteraction(input, lookup) {}       // 併用禁忌
export function checkActIndication(input, lookup) {}         // 診療行為適応
```

### 4.2 移植するロジックの肝（recept-checker `r04`/`r05`/`r07` から）

そのまま踏襲すべき「誤検知を抑える良い設計」:
1. **性別・年齢で適応行を先に絞る**（`sex_matches`/`age_matches`。年齢特殊コード B6=6歳到達翌月1日 等）。
2. **疑い病名の非対称**: 適応が「疑い」病名しか無い場合は ERROR ではなく **INFO＋『検査は疑いで可・治療は確定病名』** の案内（`is_suspected` = 修飾語8002）。
3. **公的データが無い薬は指摘しない**（支払基金がチェック対象外の薬）。施設ルールがある場合のみ補完。
4. 禁忌傷病名（IY-003）は **ERROR**、症状詳記での説明を促す。

### 4.3 入力の組み立て

- `acts`/`drugs` のコード = `calculationResult.lineItems`。
- `sex`/`ageYears` = `session.patientSnapshot`（生年月日＋診療年月で満年齢。recept-checker `Receipt.age` の式を流用）。
- `diseases` = `session.diagnoses`（コード＋名称）。**疑い判定**は診断の抽出時 status（halunasu の `suspected`）または修飾語で。

### 4.4 接続

B と同じ reviewIssues 生成箇所。ただし C は `await feeCalculator.checkLookup(codes)` が要るため、**算定関数が async の箇所（`calculateFeeSessionNow`）で lookup を解決 → `runClaimChecks(input, lookup)` を呼ぶ**形にする。

---

## 5. 共通: `Finding` → `reviewIssue` マッピング

fee-core に共通の `Finding` 型（recept-checker `models.Finding` を踏襲）:
```js
// { ruleId, ruleName, category, severity:"error|warning|info",
//   message, target, detail, suggestion, code }
```
halunasu の reviewIssue 形（`claim-risk-knowledge.js` の `claimRiskReviewIssue` と同型）へ変換:
```js
function findingToReviewIssue(f) {
  return {
    id: stableId(f), kind: "claim_check", category: f.category,
    severity: f.severity,                     // error→block寄り / warning→needs_review / info→候補
    title: f.ruleName, messageForStaff: f.message,
    detail: f.detail, suggestion: f.suggestion,
    ruleId: f.ruleId, target: f.target,       // ← RuleTrace の芽([02] F へ発展)
    source: "public_check_master",            // 出典明示(根拠提示)
  };
}
```
- **severity → 月次readiness へのマッピング**: `error`=提出前に要修正（blocked寄り）／`warning`=要確認カウント／`info`=算定もれ候補（`symptomDetailCandidate` と同様の「候補」枠）。既存 `feeMonthlySessionReadiness` の集計に1系統足すだけ。

---

## 6. テスト戦略

- **fee-core（ロジック）**: `lookup` をモックにした純関数テスト（`packages/fee-core/test/`）。recept-checker の `tests/test_rules.py` のケースを移植（判断料の D000例外、疑い病名の非対称、性別年齢不一致 等）。
- **worker（データ）**: 小さな fixture DB（数行のマスタ）で `check_lookup` の SQL を検証。halunasu 既存の `python-calculator.test.js` パターン。
- **import**: 実 ZIP の1件サンプルで固定長パース→行数照合（recept-checker `test_official_e2e.py` 相当）。
- **回帰**: SOAP→算定 E2Eゴールドに「算定もれ/適応」期待を数ケース追加。過剰検知が出ないこと（誤検知は顧客不信に直結）。

---

## 7. リリース順とマイルストーン

| 段階 | 内容 | 依存 | 目安 |
|---|---|---|---|
| **B1** | `medical_procedures` に judgement列を line へ露出（engine小改修） | なし | 小 |
| **B2** | fee-core `missing.js`（判断料/基本料/処方料）＋ reviewIssues 接続＋テスト | B1 | 小〜中 |
| **B3** | 施設パターンの設定化＋UI（後追い可） | B2 | 中 |
| **A1** | db.py にCCテーブル追加＋`check_masters_import.py`＋データ取込（R8） | なし | 中 |
| **A2** | worker `check_lookup` op＋`checkLookup()`＋テスト | A1 | 小 |
| **C1** | fee-core `indication.js`（適応/禁忌/併用）＋テスト（lookupモック） | A2 | 中 |
| **C2** | `calculateFeeSessionNow` で lookup解決→接続、月次readiness反映 | C1 | 小 |
| **C3** | baseline-diff / 月次点検からも `runClaimChecks` を再利用 | C2 | 小 |

**最短で価値が出る道**: B1→B2（既存マスタだけで「算定もれ」が UI に出る）。その後 A→C。

---

## 8. リスク・注意

- **過剰検知**: 点検は「多すぎる指摘」で信頼を失う。recept-checker の抑制設計（公的データ無い薬は指摘しない・疑い非対称・除外/ON-OFF）を**最初から移植**する。halunasu にもルール別 enable/disable と個別除外を用意（recept-checker `CheckEngine(enabled/disabled)` 相当）。
- **版**: CCマスタは半期更新。`master_sources` の effective 期間に載せ、診療年月で版解決（E）。廃止コード提示は0を保証（[02] I / L の G7）。
- **PHI**: 追加処理はすべて院内（Python worker）で完結、外部送信なし。氏名は不要（コード照合のみ）。halunasu の PHI 方針（`07-compliance-phi-ops`）と整合。
- **DBサイズ**: CCマスタは大きい（適応123万行）。halunasu のマスタDB gzip 配布（`FEE_MASTER_DB_GZIP_PATH`）に含めるとサイズ増。**点検用テーブルを別DBに分離**し、worker が2DBを ATTACH する構成も選択肢（算定DBの配布サイズを増やさない）。
- **[02] F への発展**: 上記ルールは最初から `ruleId`/`source`/`category` を持つ＝**宣言的DSL＋RuleTrace への布石**。手続き的に作り込みすぎず、ルール定義とロジックを分離しておく。

---

## 9. この設計の要点（3行）

1. **B は halunasu の既存マスタだけで作れる**（判断区分・区分・背反・回数は既にある）→ 最速リリース。
2. **A は "支払基金チェックマスタ＋病名/修飾語" の取込＋worker `check_lookup` op** の追加に限定される（診療行為・医薬品は既存）。
3. **ロジックは fee-core（JS・純関数・lookup注入）、データは Python worker**。recept-checker の Python ルールを JS へ移植し、reviewIssues の既存接続点に流す。
