# halunasu fee に活かせるロジック・設計の分析（mediaclAI_recept / recept-checker）

作成日: 2026-07-03
対象: `~/medical-ai/mediaclAI_recept`（設計＋データ）、`~/medical-ai/recept-checker`（実装）を精読し、
halunasu の診療報酬算定ドメイン（`packages/fee-core`, `services/fee-api`, `python/medical_fee_calculation`, `apps/fee-web`）へ**転用できるロジック・設計**を抽出した。

## 詳細ドキュメント

| # | 内容 | ファイル |
|---|------|---------|
| 1 | **recept-checker から移植できる実装済みロジック**（すぐ使える・点検側） | [01-recept-checker-liftables.md](01-recept-checker-liftables.md) |
| 2 | **mediaclAI_recept から採り入れる設計パターン**（構造の指針・生成側） | [02-mediaclai-design-patterns.md](02-mediaclai-design-patterns.md) |
| 3 | **フェーズ1（A/B/C）の具体移植設計**（実装可能な粒度／実装状況つき） | [03-phase1-porting-design.md](03-phase1-porting-design.md) |
| 4 | **レセ点検マスタ取込 Runbook**（実CCデータ＋病名コード化の運用手順） | [04-check-master-runbook.md](04-check-master-runbook.md) |

---

## 3プロジェクトの役割（再掲）

```
カルテ記録 ──[算定を生成]──▶ レセプト ──[点検]──▶ 提出
   halunasu(fee)  ◀── mediaclAI(設計/データ)      recept-checker(実装)
   ＝生成本番              ＝生成側の青写真＋一次資料    ＝点検側の動く実装
```

- **halunasu/fee**: 本番稼働志向。カルテ→算定→月次点検→レセプト。LLM抽出（点数は出さない）＋Python決定論エンジン。
- **mediaclAI_recept**: 動くコードはほぼ無いが、**5層アーキ・算定ルールDSL・評価ハーネス・PostgreSQLスキーマ・R8/静岡公費の一次資料**という「設計と正典データ」が濃い。halunasu の**思想・構造の上位版**。
- **recept-checker**: **9,040行の動くPython**。公的チェックマスタ（約160万行）を使い、UKEを40超ルールで点検。halunasu に**欠けている点検レイヤーそのもの**。

---

## halunasu/fee の現状（転用の受け皿）

**強い**:
- カルテ→臨床イベント抽出（LLM）→ 決定論算定（`python/medical_fee_calculation`）の骨格。
- 「LLMは点数・コードを生成しない」という不可侵原則（mediaclAIのL2境界と同思想）。
- 月次点検 UI、STGの再算定差分診断（`recalculation-diff-diagnosis`）、UKEパース（Python adapter）。
- 患者履歴取得（`listPriorSessionsForPatient`）、施設基準の構造化（`fee-contracts` facilityStandards）。

**弱い（＝両プロジェクトで埋められる）**:
| 弱点 | 埋める材料 |
|------|-----------|
| **点検ルールが少ない**（`claim-risk-knowledge.js` は左右/部位不一致の数本のみ） | recept-checker の40超ルール |
| **公的チェックマスタ未活用**（適応・禁忌・併用・背反・回数） | recept-checker の `masters/official.py` クエリ層 |
| **縦覧（複数月）点検が無い** | recept-checker `r12_longitudinal` |
| **返戻・査定のフィードバックループが無い** | recept-checker `henrei.py` |
| **ルールが手続き的（宣言的DSL・版解決・監査トレースが弱い）** | mediaclAI の DSL / RuleTrace / machine_decidable |
| **改定跨ぎの版解決が場当たり的** | mediaclAI の `effective` / recept-checker の `for_ym` |
| **評価が過大算定に非対称でない・CIゲート無し** | mediaclAI の SafetyRatio / eval harness |

---

## 転用マップ（優先度つき）

深刻度ではなく「**halunasuの価値を上げる度 × 移植コストの軽さ**」で優先度を付けた。

| # | 転用項目 | 出所 | halunasuの現状 | 効果 | コスト | 優先 |
|---|---------|------|--------------|------|--------|------|
| A | **公的チェックマスタのクエリ層**（適応/禁忌/併用/背反/回数/包括） | recept-checker `masters/official.py` | 未活用 | 大（点検の土台） | 中 | 🔴 |
| B | **算定もれ点検**（検査判断料/基本診療料/処方料/施設パターン） | recept-checker `r10_missing` | 断片的 | 大（増収＝顧客価値直結） | 小 | 🔴 |
| C | **適応病名・禁忌・併用禁忌点検** | recept-checker `r04〜r08` | ほぼ無し | 大（A/B査定の最多要因） | 中 | 🔴 |
| D | **縦覧（複数月）点検** | recept-checker `r12` + `store.py` | 無し | 大（縦覧査定対応） | 中 | 🟠 |
| E | **年度版マスタの版解決**（改定跨ぎ） | recept-checker `for_ym` / mediaclAI `effective` | 場当たり的 | 中 | 小 | 🟠 |
| F | **宣言的ルールDSL＋RuleTrace＋machine_decidable昇格** | mediaclAI `04-dsl-spec` | 手続き的 | 大（保守性・監査・拡張） | 大 | 🟠 |
| G | **返戻・査定フィードバック取込＋事由集計** | recept-checker `henrei.py` | 無し | 中（学習信号・優先度付け） | 中 | 🟡 |
| H | **未コード化病名の分解コード化支援** | recept-checker `decompose_uncoded_name` | 無し | 中（病名整備） | 小 | 🟡 |
| I | **評価ハーネス（SafetyRatio非対称＋CIゲート）** | mediaclAI `06-eval-harness` | ゴールドはあるが非対称/ゲート弱 | 中（品質担保） | 中 | 🟡 |
| J | **スキーマ設計の堅牢化**（コード捏造拒否FK/追記専用監査/provenance3値） | mediaclAI `db/schema.sql` | 一部（監査ログはある） | 中（信頼性・監査適合） | 大 | 🟢 |
| K | **静岡公費カスケード・地単マスタ** | mediaclAI `03-shizuoka-kohi` | 総医療費ベースのみ | 中（実額精度） | 大 | 🟢 |

---

## 推奨ロードマップ

### フェーズ1（点検レイヤーの土台づくり・すぐ効く）
**A → B → C**。recept-checker の公的マスタクエリ層と点検ルール（算定もれ・適応・禁忌）を halunasu に取り込む。
これは先の総合分析レポート（`docs/20260702-fable-report-charting-fee/08-saas-benchmark.md`）で「MightyChecker/べてらん君に対して足りない点検網羅性」と指摘した弱点を直接埋める。
halunasu の STG「再算定差分診断」の**説明力（なぜ要確認か）を根拠付きで強化**できる。

### フェーズ2（点検の深さ・改定対応）
**D（縦覧）→ E（版解決）**。月をまたぐ査定と改定跨ぎに対応。halunasu には既に患者履歴（`listPriorSessionsForPatient`）と claimMonth 版の素地があるので接続しやすい。

### フェーズ3（構造の底上げ）
**F（ルールDSL）→ I（評価）→ G（返戻学習）**。点検・算定ルールを宣言的DSL＋RuleTraceに寄せ、mediaclAI の machine_decidable→needs_review 昇格と非対称評価を導入。ルールが増えるほど効く。

### フェーズ4（制度精緻化・長期）
**J（スキーマ堅牢化）→ K（公費）**。監査適合と実額精度。静岡公費は西山病院（浜松）案件と地域が一致するため、地域展開時に価値。

---

## 一言まとめ

- **recept-checker は「halunasu に足りない点検レイヤーの実装済み部品箱」**。すぐ移植して価値が出る（フェーズ1）。
- **mediaclAI_recept は「halunasu の設計思想の完成版の青写真」**。ルールDSL・評価・スキーマ・版解決・公費は、halunasu が規模を増すときの構造指針になる（フェーズ3-4）。
- 両者とも**halunasu の既存原則（LLMは点数を出さない／決定論確定／HITL）と矛盾しない**。思想が同じなので接ぎ木しやすい。
