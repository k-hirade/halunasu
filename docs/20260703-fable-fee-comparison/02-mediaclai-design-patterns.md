# 02. mediaclAI_recept から採り入れる設計パターン

mediaclAI_recept は動く製品ではなく**設計仕様＋正典データ**。ただしその設計は halunasu/fee の**思想の完成版**であり、halunasu が規模・信頼性を上げるときの構造指針になる。
halunasu は既に「LLMは点数を出さない／決定論確定／HITL」を実践しているため、**思想は一致**しており接ぎ木しやすい。

各項目に **設計の要点 / halunasu の現状ギャップ / 採り入れ方** を付す。

---

## F. 宣言的ルールDSL ＋ RuleTrace ＋ machine_decidable 昇格 🟠（最重要の設計転用）

**出所**: `docs/04-dsl-spec.md`（DSL文法・評価器擬似実装）, `docs/10-dsl-requirement-rules.md`（代表20本）

**設計の要点**:
1. **ルールは純関数・宣言的**（YAML）。点数・金額・コードを**書き換えない**（判定とアクション付与のみ）。
2. **`machine_decidable: full | partial | none`** を各ルールに必須化。`partial/none` は最終verdictを**強制的に `needs_review` へ昇格**（＝LLM/曖昧判定が自動採用に流れない安全弁）。
3. **`action`**: `warn / block / needs_review / cap / exclude / require_comment` → **3値verdict（AUTO_ADOPT / NEEDS_REVIEW / BLOCK）へ reduce**。AUTO_ADOPTは低impactのみ（cap/exclude=金額影響は保守的にNEEDS_REVIEW）。
4. **`precedence` による上書き**: 包括の例外が静的テーブル判定を復活させる（告示>通知>疑義解釈の建付けと整合）。`_resolve_overrides`。
5. **`fallback_action`＋評価不能の第3状態**: 述語の入力欠落・参照解決失敗は「偽」に倒さず**評価不能**とし fallback（既定needs_review）。`not:` でも評価不能は伝播（否定で真に転じない）。
6. **RuleTrace が監査の核**: 発火ルール・真になった述語・出典ref・（版固定）参照ID・テーブル参照値・上書き関係を全記録。HITLの根拠提示とガード検証の入力。

**halunasu の現状ギャップ**:
- halunasu の点検・リスク判定は手続き的（`claim-risk-knowledge.js`, `clinical-billing-knowledge.js`, `buildReviewItems`）。ルールが増えると保守が難しく、**「なぜ要確認か」の監査トレースが構造化されていない**。
- halunasu は既に review issue に `messageForStaff` 等を持つが、**machine_decidable→needs_review の明示的昇格規則**や**precedence上書き**は無い。

**採り入れ方**:
- [01](01-recept-checker-liftables.md) の点検ルール群を halunasu に入れるとき、**最初から「Rule＝宣言的定義＋評価器」の形**にする。recept-checker の `Rule` クラス（手続き的だが純関数的）を、mediaclAI の DSL（`when`述語＋`action`＋`machine_decidable`＋`source[]`）へ寄せる。
- halunasu の needs_review 判定に **machine_decidable 昇格**を導入。LLM由来の曖昧判定（`session.diagnoses` の抽出確信度など）を `partial` 扱いにして自動採用させない。これは halunasu の既存原則の自然な強化。
- review issue に **RuleTrace 相当（発火ルールID・出典・matched述語）** を付け、月次点検UIの「なぜ要確認か」を根拠付き表示に（先の総合分析レポート `08-saas-benchmark` で指摘した「根拠の即時提示」に直結）。

**効果**: 大（保守性・監査・拡張性）。 **コスト**: 大（評価器＋DSL定義。段階導入可）。

---

## 「値はテーブル、ロジックはDSL」原則 🟠

**出所**: `docs/04-dsl-spec.md §2`（電子点数表テーブルとDSLの責務分担）

**要点**: 点数・回数上限・限度額・コードは**テーブルが唯一の真実源**。DSLは値を持たず `*_ref` 参照のみ。→ **改定はテーブル差し替えで完結**、二段階施行は `applies_to`（main/drug/material）×`effective.resolve_by` で解決。
- 静的判定（包括・背反・回数）はテーブル段階で先に解決、DSLは残りの**文脈依存ルール**のみ（二重判定回避）。

**halunasu の現状ギャップ**: halunasu は円換算・区分ラベル等の請求規則が JS/Python に散在（先の総合分析 `04-logic` 中-1）。**「改定で変わる値」をコード内に埋めがち**。

**採り入れ方**: [01](01-recept-checker-liftables.md) A の公的マスタ（背反/回数/包括/適応）を**テーブル＝真実源**として置き、halunasu のロジックはそれを引くだけにする。recept-checker が既にこの形（`official.py` がテーブル、ルールはロジック）。

---

## E’. `effective` による版解決（二段階施行） 🟠

**出所**: `docs/04-dsl-spec.md`（`effective.valid_from/valid_to/resolve_by`）, `db/schema.sql`（`master.master_edition` の effective_period daterange ＋ `resolve_ref()`）

**要点**: 全ルール・全マスタ参照に「診療年月の有効期間」を持たせ、`resolve_by`（`shinryo_ym` / `admission_start_date` / `todokede_nendo`）で版を解決。入院は起算日、届出単位ルールは届出年度で解決。

**halunasu への採り入れ**: [01](01-recept-checker-liftables.md) E（recept-checker `for_ym`）が実装レベルの最小形。mediaclAI の `resolve_by` 3値が上位。halunasu の claimMonth 版解決（T1-1で整備）を、**入院起算日・届出年度**まで扱えるよう拡張する指針。

---

## I. 評価ハーネス（過大算定に非対称＋CIゲート） 🟡

**出所**: `docs/06-eval-harness.md`

**要点**:
- **SafetyRatio = OverbillingRate / UnderbillingRate ≪ 1**（目標≤0.3）。「誤るなら過小側に倒れているか」を単一指標化。
- **二重コスト関数**で閾値最適化（過大算定は査定・個別指導・返還・信用失墜でコスト高 → 対称な精度最大化でなく非対称期待コスト最小化）。
- **版固定回帰**（廃止コード提示=0を保証）、**診療年月別回帰**（同一症例を版違いで流す）。
- **CIゲート**: SafetyRatio が前回比+10%悪化 or 絶対閾値超で **BLOCK**。AutoAdoptAccuracy < 99.9% で BLOCK。

**halunasu の現状ギャップ**: halunasu は SOAP→算定 E2Eゴールド391ケースを持つ（優秀）が、**「過大/過小の非対称評価」**や **CIゲート**は弱い（先の総合分析 `06-testing-quality` 高-1で「CI不在」を指摘）。

**採り入れ方**: halunasu の既存ゴールドに **Over/Under を分離集計** する採点を足し、SafetyRatio を KPI 化。先に提案した最小CIに **SafetyRatio悪化・廃止コード提示・AutoAdopt精度** のゲートを組む。mediaclAI の `golden_runner.py`（`--self-test` 付き、forbidden採用でBLOCK）が参考実装。

---

## J. スキーマ設計の堅牢化 🟢（長期）

**出所**: `db/schema.sql`（PostgreSQL、1,462行、実行＋テスト済みと明記）

**halunasu が採れる構造的アイデア**:
1. **コード捏造の構造的拒否**: `code_candidates.master_ref_id` を **NOT NULL FK ＋ `verify_code_from_master()` トリガ** で「マスタに無いコードはREJECT」。`billing_candidates.points` は L3確定まで **NULL**。→ halunasu の「LLMは点数を出さない」原則を**DB制約で強制**できる。
2. **追記専用監査**: `audit.rule_trace / evidence_trace / audit_trail` に **UPDATE/DELETE/TRUNCATE禁止トリガ**。→ halunasu の監査ログ（`createAuditEvent`）を改ざん耐性化。
3. **provenance 3値**（`source_verification` enum: verbatim/reached/unverified）: 「引用に使えるのは verbatim のみ」。→ halunasu が告示・通知を根拠提示するなら必須の考え方。
4. **診療年月変更ガード**（`trg_encounter_month_guard`）、**GoldFreeze**（評価セット不変化トリガ）。
5. **PII分離スキーマ**（`pii.*` を最小権限で分離）。→ halunasu の PHI 取り扱い（先の `07-compliance-phi-ops`）強化。

**採り入れ方**: halunasu は Firestore ベースなので DDL はそのまま使えないが、**「コードはマスタ参照必須」「監査は追記専用」「provenanceは3値」**という不変条件をアプリ層/バリデーションで再現する価値が高い。

**効果**: 中（信頼性・監査適合）。 **コスト**: 大。

---

## K. 静岡公費カスケード・地単マスタ 🟢（長期・地域展開時）

**出所**: `docs/03-shizuoka-kohi.md`, `data/municipal_kotan_master.seed.json`, `db/schema.sql`（`master.municipal_kotan_master`, `app.public_expense_coverage`, `app.kohi_route`）

**要点**: 公費の優先順位・カスケード按分（地単83/84/85は最後位）、食事負担の公費算入の**制度別非対称**、端数処理の制度差、静岡県の制度番号（法別番号とは別概念）・市町別負担者番号・給付方式（現物/自動償還/償還）。

**halunasu の現状**: 差分診断は「点数×10円・総医療費ベース、負担按分なし」（意図的に按分していない）。実額の患者負担・公費は未対応。

**採り入れ方**: 実額精度が要る段階（レセ確定・患者負担表示）で、公費カスケードを導入。**西山病院（浜松＝静岡県西部）案件と地域が一致**するため、静岡の地単マスタは地域展開の具体資産になる。DSLの `kohi_cascade` カテゴリ（`04-dsl-spec` ルール10）が判定の枠組み。

**効果**: 中（実額精度・地域適合）。 **コスト**: 大（制度ロジック）。

---

## L. 多重ガード（G0-G9）とコードリンキング 🟢

**出所**: `docs/01-architecture.md §2`, `docs/07-extraction-layer.md`

**要点**: LLM抽出→**辞書→ベクトル→クロスエンコーダ→L3構造検算**でコードを必ずマスタ由来に。多重ガード G0数値剥離／G1根拠span実在／G2 RAG引用実在／G3構造整合／G5 status整合／G6記載コメント必須／G7版整合／G9金額キャップ。

**halunasu の現状**: halunasu の LLM抽出（`openai-fee-clinical-facts`）は既に「点数を出さない・根拠span・status分離」を実装（G1/G5思想は近い）。コードリンキングは Python の master_search がある。

**採り入れ方**: halunasu に**明示的なガードチェーン**（特に **G7版整合＝廃止コード/旧点数の排除**、**G6コメント必須**）を足すと、点検の網羅性と安全性が上がる。G0/G1（数値剥離・span実在）は既存原則の明文化。

---

## 採り入れの順序（設計面）

1. **F（ルールDSL＋RuleTrace＋machine_decidable）** を、[01](01-recept-checker-liftables.md) の点検ルール導入と**同時に**設計する（後から手続き的コードをDSL化するより、最初からこの型にする方が安い）。
2. **「値はテーブル・ロジックはDSL」** と **E’（版解決）** をセットで。改定対応の負債を作らない。
3. **I（非対称評価＋CIゲート）** を既存ゴールドに接続。
4. **J（スキーマ堅牢化）／K（公費）／L（ガード）** は規模・制度精緻化のフェーズで。

## halunasu との思想的整合（重要）

mediaclAI の**レッドライン**（LLM単独で確定しない／病名の後付けで算定を成立させない／PHIを無制限外部AIに送らない／完全自動請求にしない）は、**halunasu が既に守っている原則と完全に一致**する。
つまり mediaclAI の設計は halunasu にとって「別物の導入」ではなく「**今の思想を構造化・強制化する仕組み**」であり、リスクの低い方向の投資になる。
