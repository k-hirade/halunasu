# P-1〜P-4 実装計画（西山病院PoC：導入前 売上改善診断ツールキット）

- 作成日: 2026-07-04
- 親計画: [20260704-consulting-sales-plan.md](20260704-consulting-sales-plan.md)
- 目的: 「匿名化で全量をもらう → 断片データを取り込む → 決定論点検 → 売上改善レポート」を、**閉域網でオフライン実行できるツールキット**として用意する。当日デモまで通す。

---

> **実装状況（2026-07-04, branch `fix/p1-p4-cross-theme`）— P-1〜P-4 実装・検証済み**
> - **P-1 ✅**: `python/medical_fee_calculation/deidentify.py`（脱識別＋HMAC擬似ID＋生年月日→年齢＋残存識別子スキャン＋dry-run）。テスト3件。
> - **P-2 ✅**: `python/medical_fee_calculation/clinic_intake.py`（列マップ駆動で断片CSV→患者×月の正規化claim JSONL）。テスト2件。
> - **P-3 ✅**: fee-core `clinic-diagnosis.js`（`buildClinicDiagnosisReport`/HTML/CSV、純関数）＋ CLI `scripts/build_clinic_diagnosis_report.mjs`（Pythonの check_lookup/resolve_diseases をオフライン解決）。`check_lookup` に判断区分メタ（procedureMeta）を追加。テスト3件。
> - **P-4 ✅**: 匿名サンプル `samples/nishiyama-demo/`＋デモ点検マスタ `scripts/seed_clinic_demo_master.py`＋ワンコマンド `scripts/run_clinic_demo.mjs`（E2Eスモーク兼用）。**判断料もれ/処方料もれ/適応なし/禁忌/併用禁忌 を検出**を確認。
> - デモが**併用禁忌の実バグ（claim横断lookupで片方の薬しか無くても指摘）を検出→修正**（`checkDrugInteraction` が両薬の存在を確認）。回帰テスト追加。
> - 全テスト green（Python 17 / JS 169 / fee-core 13）。使い方は `samples/nishiyama-demo/README.md`。
> - 残: 当日サンプルでの deid-config/intake-map 実列名合わせ、施設基準の取得余地(P-6)。
>
> **追補（2026-07-05）— Web版（STG限定）＋実マスタ投入 完了**
> - **実CCマスタ投入 ✅**: SSK公開データ（傷病名b/修飾語z/CCマスタ）をDL・展開し、ローカルマスタDBへ取込完了。**計1,487,034件**（適応1,234,290／行為適応218,375／併用禁忌4,208／傷病名27,684——公表値と完全一致でパーサ検証も兼ねた）。`resolve_diseases` 実データ動作確認済（「急性気管支炎の疑い」→4660009＋疑い）。STG/本番は [Runbook](../20260703-fable-fee-comparison/04-check-master-runbook.md) の `--check-master-raw` でビルド。
> - **UKE直結 ✅**: `baseline_adapter` に **SY（傷病名・修飾語8002疑い判定・主傷病・転帰）と RE（性別・生年月日）** のパースを追加（layout上書き可・自社出力既定）。`baseline_api` がclaimに diseases/sex/birthDate を返す。
> - **STG限定Webルート ✅**: `POST /v1/fee/clinic-diagnosis`（STGゲート/ロール/CSRF/監査safePayload=件数のみ）。UKE/CSV取込→和暦生年月日→年齢→病名コード化→check_lookup→**fee-core決定論点検**→レポートJSON。
> - **コンソールUI ✅**: 再算定差分診断コンソールに「**売上改善診断を実行（既存レセのみでOK）**」ボタン＋結果セクション（サマリカード/所見テーブル/CSV・HTML出力/匿名化注意書き）を追加。
> - テスト: JS 216 / Python 28 green、UIスモーク passed。
> - **当日フロー確定**: 匿名化（院内・ローカル）→ 匿名UKEをSTGコンソールへ → 差分診断＋売上改善診断を画面で提示 → レポートDL。CLI版はオフライン時の保険として維持。
>
> **レビュー修正（2026-07-05）**
> - **入院/DPC対応 ✅**: REレセプト種別（4桁・index2）を取込（UKE/CSV両対応）。**入院（4桁目=1）は isInpatient:true**（外来前提のMI-003/MI-004は発火しない）、**DPC（1桁目=3）は対象外スキップ**して取込サマリに件数表示（対象0件時は明示エラー）。
> - **UIレイアウト補正 ✅**: UKE詳細設定に RE種別/男女/生年月日・SY全6位置 を追加（ベンダーUKEの位置ズレをWebから補正可能に）。CSV列マッピングに 性別/生年月日/レセプト種別（任意）を追加。
> - **CSV制約の明示 ✅**: UIに「SY付きUKE推奨。CSVで属性列マッピングが無い場合は算定もれ中心の診断」と注記。CSVパーサも sex/birth_date/receipt_type 任意列を取り込む。
> - テスト: JS 207 / Python 21+8 green、UIスモーク passed。

## 0. 全体アーキテクチャ（オフライン・パイプライン）

```
[先方の生CSV(患者/病名/処方/検体/処置/リハビリ, +レセUKE/CSV)]
        │ P-1 匿名化(院内・オフライン): 直接識別子除去 + 患者ID擬似化 + 生年月日→年齢 + 日付→月/相対日
        ▼
[匿名化済みCSV群]  ── 対応表は先方だけが保持(我々は再識別不能)
        │ P-2 取込+列マッピング: 断片CSV → 患者×月の正規化claim(items/diseases/sex/age)
        ▼
[正規化claim(JSONL)]
        │ P-3 診断: fee-core点検(算定もれ/適応/禁忌/併用) + baseline-diff(既存レセ突合)
        ▼                                    └ check_lookup/resolve_diseases(点検マスタ, オフライン)
[Findings 集約] → 売上改善診断レポート(HTML/PDF + Excel/CSV)
        ▲
     P-4 匿名サンプル + ワンコマンド実行 = 当日デモ
```

- **全処理オフライン・外部送信なし・外部AI不使用**（決定論のみ）。halunasu既存原則と一致。
- 言語分担: **匿名化/取込/マスタ参照=Python**、**点検/レポート=fee-core(JS)再利用**。CLIから両者を叩く。
- 配置: `python/medical_fee_calculation/` に Python、`packages/fee-core/` は既存点検を再利用、CLIは `scripts/` or 専用 `tools/`。

---

## P-1: 院内匿名化ツール 🔴

### 目的
生PHIを外に出さず全量をもらう。**直接識別子を除去しつつ、患者ID擬似化でファイル横断の紐付けを保持**。

### 成果物
- `python/medical_fee_calculation/deidentify.py`（新規）＋ CLI `python -m medical_fee_calculation.deidentify`
- 匿名化設定（列ロール定義）: `configs/nishiyama/deid-config.json`（サンプル形式が来たら確定）

### インターフェース
- 入力: 生CSV群 ＋ deid-config（ファイルごとに各列のロール）＋ salt鍵ファイル（先方がローカル生成・保持）
- 列ロール: `patient_key`(擬似ID化) / `drop`(削除) / `birthdate`(→年齢) / `service_date`(→YYYY-MM＋初診相対日) / `keep`(コード・点数等そのまま) / `keep_scrub`(自由文, 氏名らしき語をマスク)
- 擬似ID: `HMAC-SHA256(salt, 患者ID)` の先頭16hex。**全ファイルで一貫**（同一患者は同一擬似ID）。
- 出力: 匿名化済みCSV群（我々に渡す） ＋ 監査サマリ（件数・除去列・警告）。**対応表は出力しない**（＝我々は再識別不能）。

### 追加機能（信頼の担保）
- **残存識別子スキャン**: 出力を走査し、長桁数字列（保険者番号様）・カナ氏名様・メール等を検出して**警告**（漏れ0を目標）。
- **ドライラン**: 変換前後の列マッピングと件数だけ表示（実データを出さず設定確認）。

### 依存/リスク
- 具体CSV列は当日確定 → **config駆動**で吸収（コード変更不要）。
- 生年月日→年齢は「診療月時点」。日付→相対日は縦覧点検に必要な範囲だけ保持。

### テスト
- フィクスチャCSV（氏名/患者ID/生年月日入り）→ 識別子除去・擬似ID一貫性（別ファイルで同一患者が同一擬似ID）・年齢化・日付→月 を検証。
- 残存識別子スキャンが埋め込んだダミー氏名/番号を検出すること。

**規模: M**

---

## P-2: 断片データ取込 + 列マッピング 🔴

### 目的
患者/病名/処方/検体/処置/リハビリの**別ファイル**を、点検が食える**患者×月の正規化claim**へ束ねる。

### 成果物
- `python/medical_fee_calculation/clinic_intake.py`（新規）＋ CLI
- 列マッピング設定: `configs/nishiyama/intake-map.json`（当日サンプルで確定）

### 正規化claim（出力・JSONL）
```json
{ "patientKey": "ab12…", "claimMonth": "2026-09", "sex": "1", "ageYears": 68,
  "isInpatient": false,
  "items": [ { "code": "160008010", "name": "末梢血液一般", "recType": "SI", "date": "2026-09-03", "count": 1 } ],
  "diseases": [ { "code": "8830592", "name": "高血圧症", "suspected": false,
                  "startDate": "2026-01-10", "tenki": "1", "isMain": true } ] }
```
- 2つの下流に供給: (a) **fee-core決定論点検**（適応/禁忌/併用/算定もれ）、(b) **baseline-diff**（レセがあれば既存レセ vs 当社再算定）。

### 再利用
- CSVパース: `baseline_adapter.py` / `order_csv_adapter.py` のcp932・列抽出パターン。
- 既存 recalc-diff 取込（server.js の `parseRecalculationDiffDatasetFromBody` / `buildCalculationPayloadsFromRecalculationDiffDataset`）の**患者/カルテ/オーダ/病名ファイル→payload**の考え方をPythonオフライン版へ移す。
- 患者×月の名寄せ: fee-api `buildMonthlyClaimSummary` と同じ「patientId+claimMonth」束ね。

### 列マッピング（形式不明を吸収）
```json
{ "diagnosis": { "path": "byomei.csv", "columns": {
    "patientKey": "擬似患者ID", "code": "傷病名コード", "name": "傷病名",
    "startDate": "診療開始日", "tenki": "転帰", "isMain": "主傷病" } }, … }
```
- コード体系が自院ローカルなら**対応表**（local→レセ電コード）も適用。

### テスト
- フィクスチャ断片CSV → 正規化claim（患者×月で束ね・items/diseases整形・疑い判定）を検証。

**規模: M〜L**（ファイル種別×マッピングの網羅）

---

## P-3: 売上改善診断レポート 🔴

### 目的
正規化claimに決定論点検を回し、**コンサル成果物**（現在地＋増収/査定リスクの糸口＋概算影響額）を出す。

### 成果物
- レポート生成CLI（Node）: `scripts/build_clinic_diagnosis_report.mjs`（新規）
- 出力: **HTML（印刷/PDF）** ＋ **Excel/CSV（医事課作業用）**

### ロジック（既存再利用）
- 算定もれ: fee-core `buildMissingBillingFindings`
- 適応/禁忌/併用: fee-core `buildIndicationFindings`（`checks_api.check_lookup`/`resolve_diseases` をCLIから spawn で解決）
- 既存レセ突合: `buildMonthlyBaselineDiagnosis`（レセがある場合）
- 概算影響額: `estimateReceiptYen`（点数×10円・**按分なしと明記**）
- 出力整形: `apps/fee-web/lib/baseline-diff.js` の `baselineDiffToHtml` / `baselineDiffToCsv` を土台に拡張。

### レポート構成
1. サマリ（対象レセ数・期間・算定もれ ◯件/概算◯円・査定リスク ◯件・施設基準余地 ◯件）
2. 算定もれ候補（根拠＝マスタ/告示つき）
3. 査定・返戻リスク（適応なし/禁忌/併用/疑い放置）
4. 施設基準の取得余地（P-6と連携。初期は算定済み加算の状況提示まで）
5. 次の一手（優先度・概算効果）

> **誠実表現**: 「増収」断定を避け「**確認対象点数・概算影響額（按分なし）**」で出す（自社既定方針・過去フィードバックと一致）。

### テスト
- 既知findings入りの正規化claim → レポートに件数・概算額・根拠が正しく出ることを検証（HTML/CSVのスナップショット的アサート）。

**規模: M**

---

## P-4: 匿名サンプルでのデモ 🟠

### 目的
当日に「点検が実際に指摘を出す」ところを1コマンドで見せる。

### 成果物
- 匿名サンプル断片CSV: `samples/nishiyama-demo/`（患者/病名/処方/検体/処置/リハビリ）。**指摘が出るよう作為**（判断料もれ・適応なし・禁忌・併用・疑い放置・処方料もれ を各1件）。
- デモ用点検マスタ小DB: 数十行の `diseases/cc_*`（実123万行は不要。`check_masters_import` のフィクスチャ生成を流用）。
- ワンコマンド実行: `scripts/run_clinic_demo.sh`（deid→intake→report→HTMLを開く）。

### 効果
- P-1〜P-3の**通し確認**＝回帰の砦にもなる。
- 「御院のデータでも同じことができます」を実物で示す営業資産。

### テスト
- CIで `run_clinic_demo` が最後まで通り、レポートに期待findings（6種）が出ることを検証。

**規模: S〜M**

---

## 依存関係・着手順

```
P-1(匿名化) ──┐
              ├─→ P-2(取込) ──→ P-3(レポート) ──→ P-4(デモ/通し)
              │        ▲
点検マスタ(P-7)┘        └ check_lookup/resolve_diseases(既存)
```

1. **P-2 と P-1 を並行着手可**（P-2はまず「匿名化済み前提の正規化」を作り、P-1は独立に脱識別を作る）。
2. P-3 は P-2 の正規化claimが出たら着手。
3. P-4 は P-1〜P-3が乗ったら通しで組む。
4. 実データの点検マスタ投入（P-7）は P-4 のデモ用小DBで代替でき、本番は別途 [Runbook](../20260703-fable-fee-comparison/04-check-master-runbook.md)。

### マイルストーン
| M | 内容 | 完了条件 |
|---|------|---------|
| M1 | P-2 正規化claim（フィクスチャ） | 断片CSV→患者×月claim、テストgreen |
| M2 | P-1 匿名化（フィクスチャ） | 脱識別・擬似ID一貫・残存スキャン、テストgreen |
| M3 | P-3 レポート | claim→HTML/CSV、findings/概算額、テストgreen |
| M4 | P-4 デモ | 1コマンドで6種findings出るHTML、CI通し |

---

## 当日サンプルが来たら確定する項目（設計は先行、値は後）

- ML-A の UKE/レセCSV・返戻/増減点連絡書の**実フォーマット**（列位置）。
- PrimeKarte 各データ（患者/病名/処方/検体/処置/リハビリ）の**列名・コード体系**（標準レセ電コード or 自院ローカル→対応表要否）。
- 病名が**コード化済みか名称のみか**（名称のみなら `resolve_diseases` で吸収）。
- これらは **deid-config / intake-map の設定値**として反映（コード改修は最小）。

---

## リスクと対策

| リスク | 対策 |
|--------|------|
| CSV形式が想定外 | 全て**config(列マップ)駆動**。コード変更せず設定で吸収 |
| 匿名化の漏れ | **残存識別子スキャン**＋ドライラン＋監査サマリ。契約で削除規定 |
| 点検の過剰検知 | fee-core既存の抑制設計（疑い非対称・公的データ無しは無指摘・ルールON/OFF） |
| 概算額の過大主張 | 「確認対象・按分なし」で誠実表現（既定方針） |
| 入院/DPCの深追い | スコープ外（外来レセ点検・算定漏れ・査定・施設基準に集中） |
