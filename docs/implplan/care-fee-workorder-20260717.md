# 作業依頼: 介護報酬点検(緊急時治療管理)の実装 C0〜C3 (2026-07-17)

根拠docs:

- 制度調査(現行518単位・制度差・実装状況監査): `docs/20260716-emergency-treatment-management-current-fee-audit.md`
- アプリ構想(境界・画面・データモデル・フェーズ): `docs/20260713-care-emergency-treatment-management-app-plan.md`

本チケットは上記2docsを実装指示書へ落としたもの。設計原則は医科feeで確立済みのものを移植する:

1. **マスタ駆動・推測実装禁止**: 単位・コード・要件は effective-dated マスタから解決し、518等をコードへ埋めない。
2. **L1/L2/L3**: 事実の構造化(入力/抽出) → 決定論判定 → 人の確認で確定。自動確定はしない。
3. **静かな縮退の禁止**: マスタはG1の manifest+行数検証ゲートに組み込む。
4. **gold回帰を初日から**: 受入ケースを機械実行可能なデータセットにしてから判定エンジンを書く。

検証済みの前提(2026-07-16確認):

- 医科マスタに `180709110 緊急時施設治療管理料 500点` 収載。介護518単位の実装は一切存在しない。
- 介護用語「緊急時治療管理」は医科辞書スキャンに**誤マッチしない**(別名核「緊急時施設治療」と不一致)。
  病名レーンも対象外(cc適応行0件)。→ 医科側の防御は C0 の2点で足りる。

---

## C0. [小・即実施可] 医科側の制度混同防御(介護実装を待たない)

### C0-1. 180709110 の専用条件文

医科の候補レーン(masterLink/曖昧検索経由)で `180709110 緊急時施設治療管理料` が候補化された場合、
汎用条件文ではなく専用の conditionText を出す:

> 緊急時施設治療管理料は、転換型老健に併設される保険医療機関の医師が**夜間又は休日に緊急往診**した
> 場合の項目です(1日1回・月4回まで)。介護報酬の「緊急時治療管理(518単位)」とは別制度です。
> 対象施設・時間帯・往診事実を確認してから採用してください。

実装: `services/fee-api/src/clinical-calculation-input.js` の候補生成共通部に、コード別の
条件文上書きテーブル(`CODE_SPECIFIC_CONDITION_TEXT: Map<code, text>`)を追加し、
`candidateProposalFromProcedureItem` で code 一致時に conditionText を差し替える。
初期エントリは 180709110 の1件のみ(将来の同種ガードの受け皿として汎用機構にする)。

### C0-2. 介護請求語彙の検出警告

カルテ本文に介護の緊急時治療管理を示す語彙が含まれる場合、決定論で警告を1本出す:

- 検出語(狭く保つ。誤検出防止のため単語単位): 「緊急時治療管理」「緊急時施設療養費」「緊急時施設診療費」
- 警告文: 「介護報酬の記録の可能性: 本文に『{検出語}』があります。介護報酬(緊急時治療管理等)は
  現在の医科算定の対象外です。医科レセプトへ含めないでください。」
- 実装位置: `buildClinicalCalculationPreparation` の決定論警告群(receptionTime警告等)と同じ場所。
  warningのdedupキーは既存の `extraction_contract` 方式に倣い専用プレフィックスで衝突を避ける。

### C0-3. テスト

- 180709110 候補化時に専用conditionTextになるユニットテスト。
- 「緊急時治療管理を実施」を含む本文で警告が出る/含まない本文で出ない。
- 回帰: 医科全スイート+gold 2系統に影響なし。

---

## C1. [P0] 制度分離の基盤: 介護サービスコードマスタと billingScheme 境界

### C1-1. マスタテーブル `care_service_codes`

`python/medical_fee_calculation/db.py` のスキーマに追加(**standard-master.sqlite に同居**。
別DBは作らない — G1の成果物・manifest・検証ゲートへ相乗りするため):

```sql
CREATE TABLE IF NOT EXISTS care_service_codes (
    source_id INTEGER NOT NULL,
    service_code TEXT NOT NULL,        -- 例 529000
    service_code_name TEXT NOT NULL,   -- 例 保健施設緊急時治療管理1
    item_name TEXT NOT NULL,           -- 例 緊急時治療管理
    care_service_type TEXT NOT NULL,   -- roken / care_medical_clinic / short_stay_roken / short_stay_care_medical / preventive_short_stay_*
    unit_score REAL NOT NULL,          -- 例 518
    unit_kind TEXT NOT NULL,           -- 例 per_day
    effective_from TEXT NOT NULL,      -- 例 2026-06-01
    effective_to TEXT NOT NULL,        -- 例 9999-12-31
    raw_row_json TEXT NOT NULL         -- 出典行(下記シードでは出典メタ)
);
CREATE INDEX IF NOT EXISTS idx_care_service_codes_item
    ON care_service_codes(item_name, care_service_type, effective_from);
```

### C1-2. 取込

- 本則: WAM NET の介護サービスコード表(CSV)からのimporter
  (`python/medical_fee_calculation/care_importers.py`)。
- **MVP**: 監査docで確認済みの6行(529000/526000/556000/229000/226000/2A6000、いずれも518、
  適用 2026-06-01)+旧単位の履歴行(511: 〜2019-09-30、518: 2019-10-01〜 ※少なくとも現行行は必須、
  履歴行は取れる範囲で)をレビュー済みシードJSON
  (`python/data/master/seed/care-service-codes-20260601.json`)から投入する。
  シードJSONには出典URL・確認日・確認者を必ず含め、raw_row_jsonへ転記する。
- `master_sources` に `source_type = 'care_service_code_master'` として世代を記録する。
- **G1 manifest**: `scripts/build_fee_master_artifact.sh` の必須テーブルに
  `care_service_codes >= 6` を追加(静かな縮退防止)。

### C1-3. 解決API(読み取りのみ)

- python worker に op `care_service_lookup` を追加:
  入力 `{item_name, care_service_type, service_date}` →
  出力 `{serviceCode, serviceCodeName, unitScore, unitKind, effectiveFrom, effectiveTo}` または null。
- `python-calculator.js` にデリゲート `careServiceLookup()` を追加(既存opの配線を踏襲)。
- **禁止事項をテストで固定**: `unit_score` はこの経路以外から取得しない
  (JS/TS内の `518` リテラル検索が0件であることをテストで grep 検証する)。

### C1-4. billingScheme 境界

- 介護のエピソード・請求は医科 feeSessions と**別コレクション**(C2-2)で持ち、医科の
  totalPoints/candidateProposals へ介護単位を一切入れない。構造分離が原則で、
  変換コードを書かないことが最大の防御。
- 追加の防御テスト: 医科セッションの計算経路に `care_service_codes` 参照が無いこと、
  介護コード(529000等)が医科候補に決して現れないこと(反例コーパスに1ケース追加)。

---

## C2. [P1] 緊急時治療管理の点検アプリ本体

### C2-0. gold回帰(最初に作る)

- `data/tests/care-fee-gold/emergency-treatment-cases.json` を新設し、構想doc §8 の8ケースを
  機械可読化する(入力=エピソード、期待=判定status/対象日数/単位合計/不足情報/競合)。
- 判定エンジン(C2-1)のユニットテストはこのデータセットを直接回す
  (`packages/care-fee-core/test/`)。以後の改定・修正の回帰基盤。

### C2-1. 判定エンジン `packages/care-fee-core`(TypeScript/JS、決定論)

新パッケージ。**医科Pythonエンジンには入れない**(制度が違うものを同一エンジンに混ぜない)。
マスタ読取(C1-3)以外の外部依存なし・純関数で実装する。

```js
evaluateEmergencyTreatmentEpisode(episode, {
  unitMaster,          // care_service_lookup の結果
  monthlyPriorEpisodes // 同一入所者×当月の既存エピソード(確定/候補)
}) => {
  status: "要確認" | "算定候補" | "対象外",
  eligibleDays: [{ date, judgment: "対象"|"要確認"|"上限超過"|"対象外", reason }],
  totalUnits, unitScore, serviceCode,
  missing: [...],      // 不足情報(具体的に)
  conflicts: [...]     // 併算定競合
}
```

判定ゲート(構想doc §6.2 の8条件を決定論化):

1. `careServiceType` が対象サービスで、算定日に有効なマスタ行が解決できる。
2. 6区分の重篤状態(enum: `consciousness_disorder / acute_respiratory_failure /
   acute_heart_failure / shock / severe_metabolic_disorder / other_severe_poisoning`)の
   1つ以上が選択されている。事象名(発熱・転倒等)だけでは不可。
3. `emergencyCareRequired === true` と判断根拠テキストがある。
4. 日ごとに投薬/検査/注射/処置のいずれかの実施記録がある
   (実施が無い日は「経過観察のみ」として要確認。goldケース7/12参照)。
5. 月1回: 同一入所者の当月(**治療開始日の属する月**)に確定/候補の別エピソードが
   あれば2回目は「要確認」(自動対象外にはしない。返戻運用の余地を人が判断)。
6. 連続3日: エピソード開始日から**暦日連続**の3日まで対象、4日目以降は「上限超過」。
   非連続日は同一エピソードの対象日にしない。
   **月跨ぎの連続3日(例: 7/31開始)の扱いは告示・Q&Aで確認し、確認までは「要確認」に落とす**
   (推測実装禁止。確認結果と出典をコードコメントへ)。
7. 併算定: エピソード入力の `concurrentBillings`(特定治療 / 所定疾患施設療養費 /
   総合医学管理加算(短期入所のみ))のいずれかが同日にあれば conflict を表示し「確定不可」。
   初期版は自己申告チェックボックス(他システム請求実績との自動突合はC3)。
8. すべて満たしても status は最大「算定候補」。確定(C2-3)は人の操作のみ。

すべての判定は同一入力→同一出力(決定論テストをgoldに含める)。

### C2-2. データモデル(Firestore、医科と分離)

構想docの4コレクションを orgId 配下に新設(firestore-schema へ追加):

- `careFeeEpisodes`: `{ episodeId, orgId, facilityId, careServiceType, patientId(共通患者),
  onsetAt, treatmentDays: [{date, treatments:[{kind: medication|test|injection|procedure,
  label, detail}], note}], severeConditions: [enum...], emergencyCareRequired, emergencyCareRationale,
  acuteDiagnosisText, concurrentBillings: [...], physicianConfirmed: {by, at} | null,
  status: draft|要確認|算定候補|確定|対象外, evaluation: <C2-1の結果スナップショット>,
  createdBy/updatedBy/timestamps }`
- `careFeeMonthlyClaims`: 入所者×月の確定集計(確定エピソードの単位合計。金額はC3まで出さない)
- `careFeeFacilitySettings`: `{ facilityId, careServiceTypes: [...], regionCategory: null(C3),
  careOfficeNumber: null(C3), effectiveFrom/To, confirmRoles }`
- `careFeeAuditLogs`: 既存監査イベントの形式を踏襲(確定・対象外化・設定変更を記録)

store実装: firestore-store / memory-store / Lazy delegate。
**store delegate完全性テストの対象に含める**(医科で二度踏んだ轍)。

### C2-3. API(`services/fee-api/src/care-fee/` に新モジュール)

`/v1/care-fee/` 配下。認証・組織・監査は既存基盤を再利用。`CARE_FEE_ENABLED`(env)で
ルート全体をフラグ制御し、STGから開放する。

- `POST /v1/care-fee/episodes` 作成(下書き) / `PATCH …/{id}` 更新
- `POST …/{id}/evaluate` 判定実行(C2-1呼び出し。保存はevaluationスナップショット)
- `POST …/{id}/confirm` 算定候補→確定(権限: careFeeFacilitySettings.confirmRoles、監査ログ必須)
- `POST …/{id}/exclude` 対象外化(理由必須)
- `GET /v1/care-fee/episodes?claimMonth&facilityId&status` 月次一覧
- `GET /v1/care-fee/monthly-claims?claimMonth` 確定集計
- 施設設定 GET/PATCH

evaluate は保存済みエピソードに対する再実行が冪等であること(決定論)をテストで固定。

### C2-4. UI(`apps/fee-web/app/care-fee/`)

構想doc §5 のモック準拠。医科画面とはナビゲーション階層から分離(「介護報酬点検」)。

1. 月次点検一覧(第一画面): 請求月/施設/状態フィルタ、状態バッジ(要確認/算定候補/確定/対象外)、
   単位列はマスタ解決値。**一括操作はCSV出力のみ**(一括確定は作らない)。
2. 急変記録・判定画面: 左=構造化入力(6状態チェック、日別実施記録、併算定チェック、医師確認)、
   右=判定結果(状態・不足情報・条件チェックリスト・単位見込)。evaluateはフォーム変更時に
   クライアント再計算ではなく**API判定結果のみを表示**(判定ロジックの二重実装禁止)。
3. 日別管理テーブル(対象/要確認/上限超過)。
4. 施設設定画面(careServiceTypes、確定権限)。
5. 印刷: 西山確認票相当のレイアウトは**様式の運用確認(下記ブロッカー)後**に着手。
   それまでは判定画面の印刷用CSSのみ。

### C2-5. 入力経路の段階実装

- C2-a(本チケット): 手入力+CSV取込(複数エピソード)。
- C2-b(別スライス・承認後): カルテ貼り付けのLLM抽出。医科v14と同じ原則
  (スキーマ強制・行根拠・全行契約・事実の創作禁止。重篤性/救命救急判断はAIで確定しない=
  抽出値は常に人の確認欄に入るだけ)。

### C2-6. テスト

- care-fee-core: goldデータセット全ケース+決定論テスト+月跨ぎ/月1回/上限超過の境界。
- fee-api: ルートのCRUD/権限/監査/フラグOFF時404。store delegate完全性。
- 反例1件(C1-4): 介護コードが医科候補に出ない。
- 医科側全スイート+gold 2系統が不変であること。

---

## C3. [P2・別チケットで詳細化] 介護請求への拡張(今回は着手しない)

- WAM NET改定CSVのimporter本実装と世代間回帰テスト
- 地域区分×サービス別1単位単価の金額計算(それまでUIは単位数のみ表示)
- 介護給付費請求データ(CSV)の作成・検証
- 他システム請求実績との併算定自動突合

---

## ブロッカーと並行确认(実装を止めない設計)

構想doc §9 の西山確認7問+1問(月あたりの急変記録件数=UI/CSV優先度の判断材料)は**並行して確認**する。
ただし実装は次の理由で先行できる:

- サービスコード6行を全て effective-dated で持ち、施設設定 `careServiceTypes` で選ぶ設計のため、
  「どの施設がどのサービスか」の回答は**設定値**であってコードを変えない。
- 地域区分・事業所番号・請求データ形式は C3 スコープ。
- 唯一実装に響くのは印刷様式(C2-4の5)のみ → そこだけ回答待ちにする。

## 実装順序と完了ゲート

1. **C0**(即・医科リリースに同乗可) → 2. **C1** → 3. **C2-0(gold)** → 4. **C2-1(エンジン)** →
   5. C2-2/C2-3 → 6. C2-4 → 7. C2-a取込 → (承認後 C2-b)
2. コミット粒度: C0 / C1 / C2-0+C2-1 / C2-2+C2-3 / C2-4 / C2-a を分ける。
3. 共通ゲート:
   - 介護: care-fee-core goldが全ケース緑。
   - 医科への無影響: fee-api/fee-core/contracts/medical-core/Python全スイート、
     医科gold 2系統(seed-300 exact 150 / v2 exact 138)、反例コーパスが全て不変で緑。
   - G1ゲート: manifest に care_service_codes を追加した新gzで readyz の
     masterContent.ok === true。
   - `518` リテラルgrepが実装コードで0件(シードJSONとテスト期待値を除く)。
4. STG受け入れ: goldの8ケースをSTG UIで手動再現し、確定→月次集計→監査ログまで通ること。
