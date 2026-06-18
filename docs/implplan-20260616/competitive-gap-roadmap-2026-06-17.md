# 競合(ML-A Plus)ギャップ対応 実装方針・全体像 (2026-06-17)

競合レセコン「ML-A Plus」(株式会社ナイス)調査で洗い出した機能ギャップのうち、
優先着手すると決めた **P0/P1 の6項目** の具体実装方針と全体像をまとめる。

- 調査レポート出典: [ML-A Plus 公式](https://www.naiscorp.co.jp/medical-system/ml-a-plus/) / [ICS](https://www.ics.co.jp/service/medical-info/mla_plus) / [USK](https://www.usk-i.com/product/nais/featuse.html)
- 製品前提: **外来クリニック向けの「SOAPからの算定補助ツール」**。入院・大病院機能(DPC等)は相対的に低優先。

---

## 0. 全体像 — ML-A Plus とのギャップ全件(P0〜P3)

ML-A Plus との差が大きいのは **「請求・会計の出口」** と **「査定対策の網羅性」**。
我々の強みは上流(SOAP→自動抽出→決定論算定)で、下流(会計・レセプト請求・全面点検)が薄い。
以下はギャップ全件。**「今回」列が ✅ の6項目を本ロードマップで着手**し、それ以外(P2/P3)は将来対応として全体像に残す。

優先度の定義(製品前提=外来クリニック向けの算定補助ツール):
- **P0** = 会計・請求が成立しない / 必須の出口
- **P1** = 査定対策・運用効率で実務インパクト大、差別化の核
- **P2** = あると価値が増す拡張・運用基盤
- **P3** = 範囲外寄り / 小UX / 別製品でも代替可

| # | 機能 | 優先 | 規模 | 今回 | 根拠・補足 |
|---|---|---|---|:--:|---|
| 5 | 会計・窓口一部負担金計算 | **P0** | 小〜中 | ✅ | 会計が成立しない。決定論で計算可。#2に依存 |
| 1 | レセプト電算/CSV出力 | **P0** | 中〜大 | ✅ | 請求の出口。MVPはレセコン取込CSVから。オンライン請求接続は→P1 |
| 6 | 査定防止の全面チェック(併算定/回数) | **P1** | 中 | ✅ | エンジン(check_electronic_rules)は実装済、検査以外へ配線 |
| 8 | 算定期間・初回算定日・同月制限の自動判定 | **P1** | 中 | ✅ | 履歴は取得済。review止まりを判定に繋ぐ |
| 7 | レセプトコメント自動付与(必須/症状詳記) | **P1** | 中 | ✅ | コメント欠落は返戻/査定の主因。#6に相乗り |
| 4 | 月次レセプト処理・点検 | **P1** | 大 | ✅ | 請求は月次。claim_batch基盤あり。段階的 |
| 2 | オンライン資格確認 | P1 | 中〜大 | — | 会計精度の前提。外部接続・認証が重く #5 の後 |
| 9 | 医療機関独自ルールの設定UI | P2 | 中 | — | 施設基準UIと統合。レビュー負荷削減 |
| 11 | 統計・分析・帳票・CSV・監査資料 | P2 | 中〜大 | — | 月次(#4)基盤の上で。まずCSV→BI |
| 12 | マスタ世代管理の運用UI | P2 | 中 | — | 有効期間付きマスタは保持済。運用UI整備 |
| 13 | レセプトイメージ直接編集 | P2 | 中 | — | #1のレセプト構造が固まった後のUX強化 |
| 18 | 改定対応保守 / WEBサポート / Q&A | P2 | — | — | 運用・事業面。改定はマスタ更新で一部対応済 |
| 10 | 労災・自賠責対応 | P2→P3 | 大 | — | 健保完成が先。対応保険の拡大フェーズ |
| 3 | DPC(包括評価)対応 | P3 | 大 | — | 入院・大病院向け。外来中心なら当面範囲外(review縮退) |
| 17 | 診察券発行・予約/受付連携 | P3 | 大 | — | 算定の範囲外。別製品/charting連携 |
| 14 | 包括/自動算定項目の色分け表示 | P3 | 小 | — | 小UX。表示モデルに種別あり低コストで部分対応可 |
| 15 | マイメニュー / ヘルプ(F1) | P3 | 小 | — | 操作性の小改善 |
| 16 | フルHD・画面拡大対応 | P3 | 小 | — | Web UIのブラウザ拡大で代替 |

将来対応(P2/P3)の補足:
- **#2 オンライン資格確認**は P1 だが、外部接続・認証・運用が重いため今回の6項目の後に回す(#5会計の精度を上げる位置づけ)。
- **#9/#12** は施設基準UI・マスタ運用と一体で設計するのが効率的。
- **#11/#13** は #4(月次)・#1(レセプト構造)が固まってから着手する依存関係。
- **#3 DPC / #17 予約・診察券**は製品ターゲット次第。外来クリニック中心なら当面範囲外。
- **#14 色分け**だけは P3 だが、表示モデルに `feeCategory`/`orderType` があり低コストなので、余力時に先取り可能。

依存(今回分): **#2 保険・公費入力(P0前提)** → #5 → #1。#6/#7/#8 は共通基盤(履歴・電算ルール)。#4 は #6〜#8 の上に乗る。

---

# 今回の実装対象(P0/P1 の6項目 + 前提 #2)

以下が本ロードマップで着手する範囲。各機能の現状(コード根拠)・方針・テスト・規模を示す。

## 実装状況 (2026-06-18 時点)

| 項目 | 状態 | 実装内容 |
|---|---|---|
| #2 保険・公費スキーマ | ✅ 完了 | `platform-contracts` に `validateInsurance`/`validatePublicInsurance`/`insuranceSnapshot`。`fee-contracts` 患者入力に insurance 追加。`fee-api` セッション作成/更新で `insuranceSnapshot` を固定、detail応答で返却。`fee-core` が保持。後方互換あり。テスト+3 |
| #5 会計・一部負担金 | ✅ 完了 | `fee-core` `buildBillingSummary`(年齢/保険/公費→負担割合、10円四捨五入)。`buildReceiptDraft` に `billing` 同梱。fee-web に会計サマリ表示。テスト+5 |
| #1段階A レセCSV | ✅ 完了 | `fee-core` `buildReceiptCsv`(BOM/CRLF/区分別明細+サマリ)。`fee-api` `GET …/receipt.csv`(raw応答対応)。fee-web に「CSV出力」ボタン。テスト+2 |
| #6 査定チェック横断 | ✅ 完了 | Python `_claim_level_electronic_messages` で全ラインのコードに `check_electronic_rules` を横断適用(検査以外の併算定不可・回数制限を検知)。テスト+3 |
| #8 同月制限・履歴判定 | ✅ 完了 | `fee-api` `buildPriorHistoryOptions`/`mergePriorHistoryIntoOptions` で priorSessions→`calculationOptions.history`(same_month/same_day/procedure_history_events)を自動注入。claimContext時は注入しない。テスト+3 |
| #7 必須コメント | ✅ 完了 | 上記 claim 横断パスに `required_comments` を相乗りし、入力済みコメントで満たされない必須コメントのみ要確認に。テスト+2 |
| #4段階A 月次名寄せ | ✅ 完了(API) | `fee-api` `GET /v1/fee/monthly-summary?claimMonth=` + `buildMonthlyClaimSummary`(患者×月で名寄せ、合計点数・受診一覧)。テスト+3。※fee-web の月次ビューUIは後続 |

テスト: platform-contracts 16 / fee-contracts 8 / fee-core 19 / fee-api 113 / python 7 すべてパス。

残課題(段階B以降): #1段階B レセ電(UKE)本対応、#4段階B 月内横断点検・段階C 月次一括出力、#2 fee-web 保険入力UI、#4 fee-web 月次ビューUI。

---

### 重要な調査事実(着手前提)
- **査定対策エンジンは既存**: `python/medical_fee_calculation/electronic_rules.py` の `check_electronic_rules()` が
  併算定(bundles/exclusions)・回数制限(frequency_limits)・**必須コメント(RequiredCommentHit)**・
  **履歴照合(FrequencyLimitBreach / ProcedureHistoryEvent)** を一括判定する。
  ただし呼び出しは **`lab_calculator.py:511` の検査計算のみ**。→ #6/#7/#8 は「配線拡大」が主。
- **履歴は取得済み・未活用**: `services/fee-api/src/server.js:1472` で `priorSessions` を取得しているが、
  同月判定は `clinical-calculation-input.js` の `same_month_check` トピックで **review に出すだけ**で、
  エンジンの `procedure_history_events` には渡していない。
- **バッチ基盤あり**: `python/medical_fee_calculation/claim_batch.py` に `run_outpatient_lab_claim_batch` 等。
  `ProcedureHistoryEvent` の組み立て(2283行)もここにある。→ #4 はこれを土台にできる。
- **保険フィールドは存在・未構造化**: `packages/platform-contracts/src/index.js` の患者バリデータに
  `insurance` / `publicInsurance` があるが自由形式・未検証・未使用。`patientSnapshot` は `birthDate`/`sex` を保持。
- **レセプト下書きは出力器なし**: `packages/fee-core/src/index.js:256` `buildReceiptDraft` は
  `lineGroups`/`totalPoints` まで作るが `exportStatus:"draft"` のみ。

---

## 共通の設計原則
1. **会計・請求・点検は完全に決定論**。計算ロジックは `packages/fee-core`(JS純関数)または
   `python/medical_fee_calculation`(算定エンジン)に置き、API/画面に依存させない(spec→test→implement)。
2. **既存資産を再利用**。エンジンの `check_electronic_rules`・`claim_batch`・有効期間付きマスタを使い、新規実装を最小化。
3. **判定できない所は確定せず review**。過小・過大請求を断定しない安全縮退を維持。
4. **受診時点でスナップショット**。保険・負担割合・施設基準は受診日時点で固定し、後のマスタ変更で過去がぶれないように。

---

## P0-A. #2 保険・公費情報の入力と算定反映(#5 の前提)【中】

### 現状(コード根拠)
- `platform-contracts` の `validateCreate/PatchPatientInput` に `insurance:{}` / `publicInsurance:{}`(自由形式・未検証)。
- `patientSnapshot()`(`platform-contracts/src/index.js:384`)は `birthDate`/`sex` を写すが保険は写さない。
- `fee-api` セッション detail は `insurance: session.insurance || null`(`server.js:2215`)を返すだけ。

### 方針
1. `validateInsurance(input)` を新設し患者バリデータで通す。最小項目:
   `insurerType`(社保/国保/後期/自費)・`insurerNumber`・`insuredSymbol`・`insuredNumber`・`branchNumber`・
   `burdenRatio`(任意明示)・`validFrom`/`validTo`。`publicInsurance` は併用ありで配列化
   (`{payerNumber, recipientNumber, burdenRatioOverride, priority}`)。既存自由形式とは後方互換(必須化しない)。
2. `insuranceSnapshot(patient, serviceDate)` を新設し、セッション作成/再計算時
   (`server.js:1368` の `patientSnapshot(patient, now)` の隣)で `patch.insuranceSnapshot` を設定。
3. detail応答を「snapshot優先 → session.insurance フォールバック」に変更。
4. fee-web に保険情報セクション(患者プリフィル+手入力、負担割合は自動/手動トグル)。

### テスト / 規模
`validateInsurance` 正常異常、受診日適用、空 `{}` 後方互換。規模: 中。

---

## P0-B. #5 会計・窓口一部負担金計算【小〜中】

### 現状
完全未実装。`buildReceiptDraft` は `totalPoints` まで。金額・負担金なし。

### 方針(`fee-core` 純関数)
`buildBillingSummary(session, options)` を新設(または `buildReceiptDraft` 返り値に `billing` を追加)。
1. `resolveBurdenRatio({birthDate, serviceDate, insurance, publicInsurance})`:
   明示 `burdenRatio` 最優先 → 無ければ年齢区分(就学前0.2 / 6〜69歳0.3 / 70〜74歳0.2 / 75歳〜0.1、
   現役並み・所得区分不明は既定+review)→ 公費上書きを適用。**所得区分が不明なら確定せず review**。
2. 金額(決定論・現物給付の端数処理):
   ```
   totalFee   = totalPoints * 10
   copay      = Math.round(totalFee * burdenRatio / 10) * 10   // 10円未満四捨五入
   insurerPay = totalFee - copay
   ```
   返り値 `{ totalPoints, totalFee, burdenRatio, burdenRatioSource, copay, insurerPay, publicApplied, notes }`。
   高額療養費の限度額は範囲外(notesに明記)。
3. workbench/receipt応答に `billing` 同梱 → fee-web の会計エリアに「総医療費 / 負担割合 / 窓口負担(¥)」表示。

### テスト / 規模
端数境界、年齢帯既定割合、明示上書き、公費適用、totalPoints=0、保険未設定の縮退。規模: 小〜中。

---

## P0-C. #1 レセプト電算/CSV出力【中(MVP)〜大(本対応)】

### 現状
`buildReceiptDraft` が `lineGroups`(区分別)/`totalPoints` を構築。出力器なし、fee-webはコピーのみ。

### 方針(2段)
**段階A(MVP・即効): レセコン取込用CSV**
- `fee-core` に `buildReceiptCsv(receiptDraft, {insuranceSnapshot, patientSnapshot, facilitySnapshot, billing})`。
  1行=1明細(UTF-8/BOM, ヘッダ付): `claimMonth, patientId, serviceDate, insurerNumber, insuredSymbol,
  insuredNumber, burdenRatio, receiptCategory(区分), code, name, points, quantity, totalPoints` +
  フッタに `totalPoints/totalFee/copay`。
- `fee-api` に `GET /v1/fee/sessions/:id/receipt.csv`(`text/csv`)→ fee-web に「CSVダウンロード」。

**段階B(本対応): レセプト電算(UKE/固定長)**
- IR/RE/HO/KO/SI/IY/TO/CO/MF 等レコード型ごとのビルダー `buildReceiptDenshin(...)`。
  区分(`lineGroups`)→ SI/IY/TO、コメントは CO(#7と連動)。
- **要・正式仕様確認**(支払基金「電算処理システム 記録条件仕様」)。規模大、段階Aの後。

### テスト / 規模
段階A: CSVスナップショット、保険欠落の空欄許容、区分マッピング、明細合計=totalPoints。規模: 中〜大。

---

## P1-A. #6 査定防止の全面チェック(併算定不可・回数制限)【中】

### 現状(コード根拠)
- `check_electronic_rules()`(`electronic_rules.py:144`)は bundles/exclusions/frequency/required_comments/
  history breaches を一括判定可能。**呼び出しは `lab_calculator.py:511` の検査のみ**。
- 処置・画像・処方・手技には未適用。

### 方針
1. 各計算器(処置/画像/処方/手技)、または **集計後のクレーム単位**で `check_electronic_rules` を呼ぶ共通フックを追加。
   - 推奨: 計算器ごとに散らさず、`worker.py` の算定結果(全 lineItems)を集約してから**クレーム横断で一括判定**する層を新設(同月・併算定は領域横断のため)。
2. ヒット(exclusion/frequency)は「算定不可」か「review」かを区別:
   - 機械的に確定できる併算定不可 → ラインを落とす/警告。
   - 判断材料不足 → review(既存トピック分類 `reviewTopicCode` を活用)。
3. fee-web では算定不可の根拠(どのコードと競合か)を要確認カードに表示。

### テスト / 規模
exclusion/frequency の代表ケース、検査以外(処置×画像 等)の併算定不可、判定 vs review の振り分け。規模: 中。

---

## P1-B. #8 算定期間・初回算定日・同月制限の自動判定【中】

### 現状(コード根拠)
- `priorSessions` は `server.js:1472` で取得済み。だが同月判定は `same_month_check` トピックで **review 止まり**。
- エンジン側に `FrequencyLimitBreach`/`ProcedureHistoryEvent`/`_find_frequency_limit_breaches`/`_add_months`(月スコープ)あり。
- `claim_batch.py:2283` で `ProcedureHistoryEvent` を組み立てる実装あり。

### 方針
1. `fee-api` で `priorSessions` から **当月(および直近)の確定ラインを `procedure_history_events` 形に整形**して
   算定リクエスト(claim_context)に載せる。
2. `check_electronic_rules` に履歴を渡し、月1回制限(管理料等)・同月検査重複を **判定で落とす/警告**に昇格。
3. 初回算定日・算定期間制御は、履歴から `firstClaimDate` を算出し、期間制御マスタと突合して自動判断。
4. 確定できないものは従来どおり review(`same_month_check`)に残す。

### テスト / 規模
同月重複の検出、月1回管理料の2回目落とし、月跨ぎ(`_add_months`)、履歴空時の縮退。規模: 中。

---

## P1-C. #7 レセプトコメント自動付与(必須コメント・症状詳記)【中】

### 現状(コード根拠)
- エンジンに `RequiredCommentHit` / `_find_required_comments`(`electronic_rules.py:338`)あり。検査経由のみ。
- マスタに comment_master/comment_links 相当あり。付与が弱い。

### 方針
1. #6 の全面チェック配線に相乗りし、`required_comments` を全領域で取得。
2. 算定ラインに**必須コメントの欠落**を検出 → コメントコード候補を提示(review)or 自動付与(確実なもの)。
3. レセプト出力(#1段階B)では CO レコードへ反映。段階Aの CSV にもコメント列を追加。
4. 症状詳記が要る項目は review に「症状詳記が必要」を出す(本文生成はしない=過剰生成を避ける)。

### テスト / 規模
必須コメント欠落検出、コメントコード解決、出力への反映。規模: 中。

---

## P1-D. #4 月次レセプト処理・点検【大・段階的】

### 現状(コード根拠)
- セッション(1受診)単位のみ。`claim_batch.py` にバッチ実行基盤(`run_outpatient_lab_claim_batch` 等)はある。
- 患者×月の名寄せ・月次レセプト・提出前一括点検は無い。

### 方針(段階的)
**段階A**: 患者×月の名寄せビュー(`claimMonth` + `patientId` で fee-session を束ねる)を fee-api に追加。
   月内の合計点数・受診一覧を表示(集計のみ)。
**段階B**: 月内の整合点検(#6/#8 を**月単位で横断適用**:同月回数・併算定を月全体で検査)。提出前チェックリスト。
**段階C**: 月次レセプト一括出力(#1 を月分まとめて)。`claim_batch.py` を月次集計に拡張。

### テスト / 規模
名寄せ正しさ、月内横断チェック、月境界。規模: 大(段階Aから着手)。

---

## 実装シーケンス(推奨)
1. **#2 保険・公費**(土台) → **#5 会計**(純関数・テスト先行) → **#1 段階A CSV**(出口MVP)
2. **#6 全面チェック配線**(クレーム横断フック) → **#8 履歴判定**(priorSessions→engine) → **#7 必須コメント**(相乗り)
3. **#4 段階A 名寄せ** → 段階B 月内横断点検 → 段階C 月次出力 / **#1 段階B レセ電本対応**

各ステップは `fee-core`(JS純関数)/ `electronic_rules`・`claim_batch`(Python)から着手すれば、
API・画面なしで単体検証できる。

## 依存関係
```
#2 保険公費 ──▶ #5 会計 ──▶ #1 レセ出力(A:CSV → B:レセ電)
                                  ▲
#6 全面チェック ─┐                │(コメントはCOレコードへ)
#8 履歴判定 ─────┼─▶ 共通: check_electronic_rules をクレーム横断で適用
#7 必須コメント ─┘                │
                                  ▼
                          #4 月次(名寄せ→月内横断点検→月次出力)
```
