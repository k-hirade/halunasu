# 作業依頼: 汎用精度改善 — 恒常算定レーン・意味分離・受診バリアント・安定性ゲート(W1〜W4) (2026-07-23)

背景Run: `docs/20260722-longitudinal-l7-rerun-20260722_202259/`(Phase 1クローズ済み)。
関連: 親plan `fee-longitudinal-context-plan-20260722.md`(Phase 3=恒常事実)、
H3(電話再診)、`fee-candidate-stability-tickets-20260715.md`(抽出揺れ)。

## 目的と共通原則

L7クローズ後に残った3つのギャップ(①UKE残ギャップの9割=月次管理料系、②全文抽出の
反復揺れ、③電話再診未対応)は、いずれも**受診単位のLLM抽出に判断を負わせすぎている**
ことに起因する。本作業の方針は一貫して「決定論レーンを増やし、LLMの役割を
『当日の新規事実の検出』だけに縮める」こと。

**汎用性の必須原則**(全ワークアイテム共通・レビューで機械的に確認する):

1. 特定の患者・カルテ・施設にだけ効くロジックを書かない。対象コード集合は
   **マスタの属性**(点数表区分・頻度制限属性)、**確定履歴**、**施設設定**から導出し、
   コード列挙のハードコードをしない。
2. 語彙判定(継続/中止等)は一般的な臨床日本語の語彙として設計し、必ず**反例テスト**
   (誤爆してはいけない文)を同時に追加する。
3. 制度要件は実装前に告示・一次資料で確認し、出典をコードコメントに残す(推測実装禁止)。
4. UKEは比較対象であり正解ではない。UKE一致のためだけの分岐を作らない。
5. すべての新候補はcandidateOnly。確定は人の承認のみ。
6. エンジン変更後はgold 2系統(`npm run test:fee-gold:engine` と
   fee-soap-e2e-v2 exact)+反例コーパスを必ず両方回す。

---

## W1. [P1] 恒常算定レーン(患者恒常算定プロファイル)

### 意図

在宅人工呼吸指導管理料(2,800点)+人工呼吸器加算(7,480点)のような月次管理料は、
カルテ本文に「管理継続」としか書かれず、受診単位の抽出では原理的に検出できない。
これは受診の事実ではなく**患者の恒常状態**である。1002の残ギャップ11,313点中
10,532点がこの領域で、他患者の在医総管系も同型。データモデルを状態に合わせる。

### データモデル

**スコープ分離(重要)**: 「臨床的な恒常状態」(人工呼吸器使用中等)は患者に属するが、
「算定ファミリ・確定履歴・提案状態」は**施設に依存する**(施設基準・自動ルールが
施設単位のため)。同一組織内で患者が施設Aから施設Bへ移った場合に、施設Aの確定履歴を
根拠に施設Bで提案してはならない。本作業(factType=monthly_management_fee)は
**施設×患者スコープ**で実装し、患者スコープの臨床恒常状態(将来のfactType)は
別レコード種として扱う。

新collection `fee_standing_billing_profiles`(キー: orgId + facilityId +
canonicalPatientId。Phase 0の正規患者キー解決を前提とし、`canonicalPatientId` が
解決できない患者にはこのレーンを適用しない=fail-closed):

```
{
  standingFactId,          // 決定論的docID = sha256(orgId, facilityId, canonicalPatientId, feeFamily)
                           //   月次確定フックと履歴取込フックが二重実行しても同一docに冪等更新
  orgId, facilityId, canonicalPatientId,
  factType,                // "monthly_management_fee"(本作業ではこれのみ)
  feeFamily,               // マスタの管理料ファミリ識別子。特定コードではなくファミリで持つ
  lastConfirmedCodes: [{code, name, claimMonth}],  // 直近確定の実コード(参考情報)
  confirmedOccurrences: [{claimMonth, codes, evidenceKey}],
                           // ローリング上限判定用の期間内実績。保持期間=対象規則の最大期間
                           //   (履歴lookbackの12ヶ月キャップに依存しないため自前で保持する)
  evidence: [{evidenceKey, // 冪等キー = sha256(type, ref, claimMonth)。同一証拠の重複追加を防ぐ
              type: "confirmed_claim" | "patient_master" | "chart_mention",
              ref, claimMonth?, observedAt}],
  firstConfirmedAt, lastConfirmedClaimMonth,
  status: "active" | "suspended" | "ended",
  statusReason,            // 中止語彙検知・鮮度切れ・manual_stop 等
  manualStop: {stopped: boolean, byMemberId, at, note},
  createdAt, updatedAt
}
```

**状態遷移表**(実装とテストはこの表を正とする):

| 現在 | イベント | 遷移先 |
| --- | --- | --- |
| (なし) | 対象コードの確定(月次確定/履歴取込) | active |
| active | 中止語彙検知 / 鮮度切れ | suspended(+確認事項) |
| suspended | 新たな確定(人の承認) | active |
| active/suspended | 人が明示停止(manualStop) | ended |
| ended | いかなる自動イベント | **遷移しない**(人の明示再開のみ) |

manual stopは常に自動遷移より優先する。新しい確定履歴が来てもendedを自動で
activeに戻さない(人が止めたものを機械が蒸し返さない)。

**ファミリで持つ(重要)**: 在医総管系のように、同じ管理料でも当月の訪問回数・
単一建物人数・重症度で**コード自体が変わる**ものがある。standing factに先月の
コードを固定すると、条件が変わった月に誤バリアントを提案してしまう。
そのためstanding factは「料金ファミリ」(マスタの区分・告示項目単位で導出)で保持し、
**当月の実コードはエンジンが当月の決定論入力**(当月セッション数=訪問回数、
`encounterDetails`の単一建物人数、施設基準)**から選択**する。選択に必要な入力が
未確定なら、同一建物と同じ保留+確認事項の型に落とす。

保存は`services/fee-api/src/store/firestore-store.js`にsnapshot系と同様のCRUDを追加。
TTLは付けない(恒常事実は長期)が、`status`と鮮度で失効させる。監査ログ必須。

### 導出(すべて決定論)

1. **対象コード集合の導出**: マスタから「頻度制限が月次周期」のコードを機械的に
   列挙するアーティファクトを生成する(G1マスタアーティファクトと同じ生成・検証方式)。
   頻度属性は `python/medical_fee_calculation/electronic_rules.py:314-352` が読む
   `raw[5]` limit_count と `:111-124` の期間マッピングを使い、**「同一月1回」だけでなく
   「2月に2回」「3月に3回」等の期間上限系も含める**(在宅療養指導管理材料加算・
   機器加算には期間上限系のものがあり、月1回限定だと人工呼吸器加算等が漏れる)。
   対象の点数表区分(在宅療養指導管理料等)もマスタの区分属性から導出し、
   個別コードのリテラル列挙は禁止。
   **提案可否の判定(重要)**: 「2月に2回」は「2ヶ月ごとに提案」ではなく
   **対象期間内の上限回数**である(現実装 `:394-` も期間内実績件数とlimit_countを
   比較している)。提案可否は「ローリング期間内の確定回数 < limit_count」で判定し、
   期間を提案間隔として使ってはならない。期間内実績はstanding fact側の
   `confirmedOccurrences` から数える——履歴取得は
   `services/fee-api/src/server.js:5602` で12ヶ月にハードキャップされており、
   12ヶ月超の期間規則を履歴の再クエリで判定してはならない(自前保持が正)。
2. **確定履歴からの登録**: 患者の確定明細(自社確定+外部請求履歴
   `billingHistoryEventsAsPriorSessions` `services/fee-api/src/server.js:5590`)に
   対象コードがあれば、standing factを `evidence: confirmed_claim` で登録/更新する。
   登録は月次集計確定時と履歴取込時の2フックだが、決定論的docIDと
   evidenceの冪等キーにより**二重実行しても結果が同一**であることをテストで固定する。
   フックの施設スコープは確定が行われた施設に限定する。
3. **提案**: 対象月のセッション計算時、`active`なstanding factの対象コードを
   「恒常算定候補」としてcandidateOnly提案する。根拠文は
   「YYYY-MM月に確定済みの月次管理料です。今月も算定対象か確認してください」。
   既存のH1頻度制限が同月重複を止めるので、当月確定済みなら提案しない。
4. **初回は人が作る**: 履歴のない患者への新規standing factの**自動生成**はしない。
   初回確定(人の承認)が最初のevidenceになる。初月の**検出**はW1b(下記)が担う。

### W1b. 初月検出: 恒常記載→管理料ファミリの確認候補

W1の履歴駆動だけでは、履歴のない患者(新規導入顧客・新規患者)ではレーンが永久に
発火しない。初月の検出手段を追加する:

1. **入力**: W2の `standing_mentions`(「人工呼吸器管理継続」等の管理方針記載)と、
   患者マスタの常態テキスト(fixtureでは `patients.csv` の care_text /
   visiting_nurse_text 相当。本番では患者プロフィール項目)。
2. **マッピング**: 機器・療法の一般語彙(人工呼吸器/在宅酸素/胃瘻・経管栄養/
   自己注射/腹膜灌流 等)→在宅療養指導管理料**ファミリ**への対応表を、
   マスタの告示項目名から機械生成する(名称の正規化一致。個別ハードコード禁止)。
3. **出力は確認候補のみ**: 「〜の管理記載があります。在宅◯◯指導管理料の算定対象か
   確認してください」。**点数を確定に入れない・standing factも作らない**。
   人が承認して初めて確定になり、その確定がW1のevidenceとしてstanding factを生む
   (以後は履歴駆動レーンに引き継がれる)。
4. **既知の誤提案の是正**: 現在は辞書スキャンが「人工呼吸」の記載から処置の
   人工呼吸(140009310)を候補化しており、L7初回Runの候補点数揺れ(302/604/906点)の
   原因になった。W2で当該行が `management_continuation` に分類された場合、
   処置系コードの辞書スキャン候補は抑制し、W1bの管理料ファミリ確認候補へ
   置き換える(当日実施の記載がある行は従来どおり処置候補のまま)。

### 停止条件(安全側)

- **矛盾記載**: 当月カルテの該当行に中止語彙(中止/終了/離脱/抜去/退院/死亡 等、
  W2の`standing_management` status='stopped' も入力になる)があれば `suspended` +
  確認事項「〜の中止記載があります。恒常算定を停止しました」。反例テスト必須
  (「中止も検討したが継続」で止めない、など)。
- **鮮度**: `lastConfirmedClaimMonth` からNヶ月(feeSettingsの
  `standingFactsPolicy.stalenessMonths`、既定3、上限6)確定がなければ自動提案を
  止めて確認事項に降格。factType別に上書き可能な構造にする。
- 履歴completeness=`unavailable` の月は提案せず、既存の「履歴に依存する判定は未確定」
  警告に載せる(Phase 0の規約どおり)。

### 観測・統合

- metrics `standingFacts: {activeCount, proposedCount, suspendedCount, reasons}` /
  trace stage `standing_fact_lane`。
- **恒常算定レーンは抽出結果と独立に発火する**(standing factと当月入力だけで
  提案が決まる)。したがって空抽出ガードのトリガーには**追加しない**——
  「管理継続の記載だけの受診」は抽出0イベントが正しい状態であり、そこでOpenAIを
  再実行してもレーンの出力は変わらず、コストだけ増える。抽出が空でも
  恒常算定候補が出ることをテストで固定する。

### テスト

- 先月確定→今月候補提案(根拠つき)/当月確定済み→提案なし(頻度制限)。
- 期間上限系(2月に2回等): ローリング期間内の確定回数が上限未満→提案、
  上限到達→提案なし。「期間ごとに1回だけ提案」になっていないことを明示的に確認。
- 施設スコープ: 同一組織の別施設の確定履歴からは提案されない。
- 冪等性: 月次確定フックと履歴取込フックを同一証拠で二重実行しても
  doc・evidence・confirmedOccurrencesが重複しない。
- manual stop優先: ended後に新しい確定履歴が来ても自動でactiveに戻らない。
- 抽出0イベントの受診でも恒常算定候補が出る(レーンの抽出独立性)。
- ファミリのバリアント: 訪問回数・単一建物人数が先月と異なる月に、先月のコードではなく
  当月入力から選んだコードが提案される/入力未確定なら保留+確認事項。
- W1b: 管理記載のみ→ファミリ確認候補(点数確定なし・standing fact生成なし)。
  当日実施記載あり→従来の処置候補が残る。管理記載への処置系辞書候補が抑制される。
- 中止語彙→suspended+確認事項。反例(継続文脈の「中止」)→停止しない。
- 鮮度切れ→提案停止+確認事項。
- canonicalPatientId未解決→レーン不適用。
- gold 2系統・反例コーパス不変(このレーンは履歴のあるSTG患者のみで発火するため
  goldには影響しないはずだが、必ず両方回して確認する)。

## W2. [P1] 「実施」と「管理方針」の意味分離(抽出契約v15+決定論降格)

### 意図

1010の6/7のイベント0/3/14、1002の喀痰吸引出没、M3の「吸引管理を継続」は同一現象:
管理継続記載をイベント化するかどうかがLLMのサンプリング運に任されている。
分類の軸を契約に明示し、揺れても点数が動かない構造にする。

### 仕様

対象: `packages/medical-core/src/fee/openai-fee-clinical-facts.js`。

1. `FEE_CLINICAL_FACTS_PROMPT_VERSION` を `fee-clinical-events-v15` へ(`:14`)。
2. **`line_role` を正規値にする**: `line_review` エントリ(`:217-227`)を
   `{line_id, line_role}` とし、`line_role: "performed" | "management_continuation"
   | "plan" | "none"` を必須にする。`has_billable_act` は
   **`line_role === "performed"` からの導出値**とし、LLMの独立出力にはしない。

   理由: 現契約は「has_billable_act=true の行は必ずclinical_eventから参照される」
   ことを要求し(`:452-453`)、照合もそれを前提にする——billableなのにイベントが
   ない行はカバレッジ漏れとして再抽出対象
   (`services/fee-api/src/clinical-calculation-input.js:3799`)、メモ側も
   requiresReextract(`services/fee-api/src/longitudinal-context.js:131`)。
   management_continuationをbillable=trueかつイベントなしにすると、
   **正しい出力が恒久的にリトライ・再抽出ループを起こす**。line_roleを正とし
   performedのみbillable=イベント必須とすれば、既存の全行カバレッジ契約・
   照合リトライ・メモ判定はそのまま成立する。
3. **移行対象経路の列挙**(has_billable_act参照箇所を全てline_role導出へ切替):
   - プロンプト規則・スキーマ(`openai-fee-clinical-facts.js:217-227, 452-453`)
   - line_review完全照合と欠落行リトライ(`clinical-calculation-input.js` 照合層)
   - 抽出結果のmerge(行スコープ抽出結果と継続行の統合規約)
   - スナップショット保存(`longitudinal-context.js` buildExtractionSnapshotCore:
     line_roleを保存し、requiresReextractは `line_role === "performed"` かつ
     イベント無しの行に限定。schema versionを上げ旧snapshotは自動失効)
   - メモ復元(`clinicalFactsFromMemo`: line_roleを復元し、management_continuation行は
     standing_mentionsとして再生成)
   - line_subsetモード(`:449` の指示文とサブセットスキーマ)
4. ルール文: 「実施・処方・施行の記録がある行のみ performed。
   『〜管理を継続』『〜継続中』のような方針記載は management_continuation とし、
   clinical_events を作らない。performed の行は必ずclinical_eventから参照する」。
5. 新フィールド `standing_mentions: [{line_id, target, status: "continued"|"changed"|"stopped"}]`
   を追加し、management_continuation 行から生成させる。これはW1の恒常事実の
   裏付け・停止入力になり、**当日候補にはしない**。
6. **決定論の降格フィルタ**(LLM分類ミスへの安全網。
   `services/fee-api/src/clinical-calculation-input.js` のline_review照合と同じ層):
   clinical_eventの根拠行が継続語彙(継続/管理中/変わらず/引き続き 等)のみで
   実施語彙(施行/実施/本日/した 等)を欠く場合、イベントを候補から確認事項
   「〜は継続方針の記載です。当日実施した場合のみ算定してください」へ降格する。
   語彙は `clinical-predicates.js` の正規化を通し、反例テストを同時に追加する
   (「吸引を実施し、管理を継続」→ 降格しない)。

### 移行の注意

promptVersion更新により既存の抽出スナップショットは全て無効化される
(`planExtractionMemo` のpromptVersion検証)。デプロイ直後は各患者1回全文抽出に
戻るのは仕様どおり。デプロイ手順に明記する。

### テスト

- v15スキーマの必須/任意フィールド検証(line_role必須、has_billable_actは導出)。
- **契約整合(最重要)**: management_continuation行がline_reviewカバレッジ照合の
  リトライ対象にならない・スナップショットでrequiresReextractにならない・
  メモ復元でstanding_mentionsとして再生成される(リトライループの回帰テスト)。
- 降格フィルタ: 継続のみ→降格、実施+継続→非降格、否定文→既存の反例規則維持。
- gold 2系統+反例コーパス: **差分が出た場合は自動で受け入れず**、当該ケースを
  一次資料と突き合わせて「元々過抽出だった」ことを個別に確認してからgoldを更新する。
- 安定性(W4)で効果を測る: 揺れ実例の確定点数反復分散が0になること。

## W3. [P1・独立] 受診バリアント軸の一般化(電話再診=H3の実装)

### 意図

電話再診を単発対応にせず、同一建物で作ったバリアント機構
(`services/fee-api/src/server.js:7424-7448` のsameBuilding分岐、未確定時保留)と
同じ「受診属性→コード切替」の汎用軸として実装する。将来の情報通信機器再診等も
同じ入力経路に乗る。

### 仕様

1. **契約**: `normalizeFeeEncounterDetails`(`packages/fee-contracts/src/index.js:479`)に
   `visitKind: "telephone_revisit" | null`(enum、拡張可能)と `visitKindSource:
   "dom" | "user"` を追加。sameBuildingと同じ「既知ならsource必須」規則。
2. **入力経路**(3つとも既存インフラの延長):
   - sidecar: mock DOMの `.rec-status` に「電話再診」ラベルが既にある。
     `clients/homis-sidecar/contract.js` のENCOUNTER_TYPESに追加し、
     `setting=outpatient` + `visitKind=telephone_revisit` を送る。
     previewFingerprintの決定要素にも含める。
   - 月次ハーネス: `visit_type=電話` → `outpatient` + `visitKind=telephone_revisit`
     (M1のマッピング表を1行更新)。
   - fee-web / sidecarパネル: 区分選択に「電話再診」を追加(根拠文表示は同一建物と同様)。
3. **算定要件はvisitKindだけでは足りない(重要)**: 令和8年度留意事項
   (厚労省 https://www.mhlw.go.jp/content/12400000/001707506.pdf)により、
   電話等再診には少なくとも「当該医療機関で初診済み」「患者等から治療上の意見を
   求められた(相談起点)」「必要な指示をした」「定期的な医学管理を目的としない」
   等の条件がある。したがって `visitKind=telephone_revisit` は**電話であった事実**の
   入力にとどめ、算定要件は `telephoneEligibility` として分離する:
   - `establishedPatient`: 当該施設での既診関係。**確定履歴・セッション履歴から
     決定論導出**(completeness=unavailableなら不明扱い)
   - `patientInitiated`: 相談起点(患者・家族側から求められたか)
   - `instructionGiven`: 必要な指示をしたか
   - `scheduledManagement`: 定期的な医学管理に該当するか
     (mockの`visit_type=定期`との整合もここで判定)
   これらが**全て充足と確定できる場合のみ** `112007950` を確定候補にし、
   1つでも不明なら確定せず確認候補
   「電話等再診の算定要件(相談起点・指示・非定期管理)を確認してください」へ落とす。
   patientInitiated / instructionGiven は本文からのLLM抽出を参考情報にできるが、
   確定入力は人の確認とする(candidateOnly原則)。
4. **エンジン**: `python/medical_fee_calculation/outpatient_basic.py` の
   基本料選択(`OUTPATIENT_BASIC_FEE_CODES` `:37-` のタプル軸)に電話再診の次元を追加し、
   `telephoneEligibility` 充足時のみ `112007950` を選択する。上記留意事項PDFを
   一次資料として、外来管理加算・時間外等加算・ベースアップ評価料
   (再診時等 `180725810` が1002のUKEにある)の各扱いを出典コメント付きで実装する。
   ここは推測禁止の最重要ポイント。
5. **visitKind未確定時の挙動**: sameBuildingと同様、電話再診の可能性を示す記載
   (本文に電話語彙)があるのに `visitKind` が未入力の場合は、コードを断定せず
   確認事項「電話等再診の可能性があります。受診方法を選択してください」。
   本文語彙だけで自動確定しない(HOMIS行為欄を算定入力にしない原則と同型)。

### テスト

- 契約validation(enum・source規則・telephoneEligibilityの構造)。
- エンジン: eligibility全充足→112007950選択+(一次資料確認後の)加算抑制/許可。
  1項目でも不明→確認候補に降格し通常再診料も断定しない。
- 既診関係の決定論導出: 履歴あり→established、completeness=unavailable→不明扱い。
- sidecar contractテスト+dependency-guard不変。
- 受入基準: L7再走で1002の電話等再診料が**候補込み検知**に加わる。確定一致への加算は
  eligibility入力(fixture拡張または承認操作)を与えた場合に確認する——要件不明のまま
  自動確定しないこと自体が合格条件。

## W4. [P2] 抽出安定性の常設ゲート

### 意図

L7反復計測で初めて揺れが定量化された(イベント一致1/20受診、確認事項一致0/5患者)。
W1/W2の効果を測り、以後の回帰を検出する常設の「安定性ゲート」を作る。
gold 2系統が「正しさ」のゲートであるのに対し、これは「再現性」のゲート。

### 仕様

1. 揺れ実例コーパス `data/tests/fee-stability/` を新設。初期ケースは今回の実測から
   **合成再現**する(1010の6/7型=管理記載過多で0/3/14に揺れた本文構造、
   1002の喀痰吸引型=管理継続記載、M3の吸引管理継続型)。特定患者の本文コピーではなく、
   揺れを再現する一般的なカルテ構造として書き、以後の揺れ事例も同じ形式で追加する。
2. `scripts/evaluate_fee_extraction_stability.mjs`: 各ケースを同一入力でN=3回
   計算し(STGまたはローカル+OpenAI)、
   - **確定点数の反復分散 = 0**(必須。決定論レーンが吸収している証明)
   - 候補集合のJaccard一致率(閾値は初回計測で基線化)
   - イベント数の最大差(記録のみ)
   を判定する。実行コマンドと頻度(エンジン/プロンプト変更時に必ず、それ以外は週次目安)を
   README化し、gold 2系統と並ぶ第3のゲートとして位置づける。
3. 判定規約は縦断計測と同じ帰属ルールを使う(対照揺れ・メモ不使用の扱い)。

### 受入基準

- W1+W2実装後にこのゲートを回し、揺れ実例コーパスで確定点数分散0を確認。
- その後L7再走プロトコル(5患者×3反復)で「月次確定点数の反復一致5/5患者」
  (前回4/5)を確認する。

## 実施順と全体の受入

```
W2(契約v15+降格フィルタ) → W1(恒常算定レーン)   ← 同じ契約変更に乗るため直列
W3(受診バリアント)                              ← 独立。並行可
W4(安定性ゲート)                                ← W1+W2の効果測定を兼ねて最後に基線化
```

全体の受入(STG、L7再走プロトコルを流用):

- **計測の前提(重要)**: 現mockデータには前月確定履歴がないため、そのまま再走しても
  W1の履歴駆動レーンは発火しない。計測fixtureに**前月分の確定セッション**
  (対象管理料を人承認相当で確定させた月)を仕込む拡張が必要
  (`fee-workorder-l7-monthly-harness-20260722.md` M8のcopy-forwardタイムラインと
  統合して1つのfixture拡張にする)。履歴なし状態ではW1bの確認候補のみが
  出ることを別途確認する(これ自体が初月挙動のテストになる)。
- 2026-07-23のM8事前STG計測では、LLMが明確な管理継続文の
  `standing_mentions`を返さずW1bが出ない実欠落を検出した。患者・コード別の例外ではなく、
  否定・不存在・予定・過去/他院・当日実施を安全側に除外する決定論的な継続mention復元を
  実装した。W1b候補化、人承認、翌月W1、月次明細までの本計測はfee-apiデプロイ後に行う。
- 確定一致: 1002が3→大幅増(初月: W1bの管理料ファミリ確認候補→人承認、
  翌月: W1の履歴駆動提案→人承認)、電話等再診料が一致に追加。
  **ただしUKE一致の増分は「人が承認した後」の値であり、自動確定は一切増えない**
  ことを同時に確認する。
- カバレッジの限界も明記する: 一時的な加算(例: 特別訪問看護指示加算)は恒常ではなく
  当日の文書発行・指示イベントの検出(W2のperformed側)の領域であり、
  本作業のスコープ外として残る。恒常レーンに混ぜない。
- 確定点数の反復一致 5/5患者、確認事項集合の一致率が前回(0/5)から改善。
- gold 2系統+反例コーパス green(W2で差分が出た場合は一次資料照合の上で個別更新)。
- PRODゲートは不変: `FEE_EXTRACTION_MEMO` および本作業の新機能は
  実顧客カルテでの計測まで STG限定(standing laneは新規flagで独立ゲート
  `FEE_STANDING_FACTS`、既定off)。

---

## 実装レビュー追記 (2026-07-23)

全テスト(fee-api 278 / packages / python 63 / sidecar / stability)と
gold 2系統(seed-300 exact 150/150、v2 exact 138/138)green。W1〜W4の実装は
レビュー4指摘の修正を含め仕様どおりであることを確認した。

### F1. [P2・対応済み] 電話語彙検知に過去・外部文脈の除外がない

`services/fee-api/src/encounter-variants.js` の `TELEPHONE_VISIT_PATTERN` は
時制・文脈を見ないため、実測で以下が発火する:

- 「先週電話で相談があった。本日対面で再診し血圧安定。」→ 発火
- 「前回は電話再診だった。本日は来院。」→ 発火

この場合、対面再診の基本料が保留され確認事項が出る。誤算定は起きない(安全側)が、
過去の電話言及を含む通常の対面再診カルテすべてにノイズが乗る。

対応: `isPastOrExternalClinicalServiceContext` をfee-contractsの共通述語へ切り出し、
`hasTelephoneVisitWording` でも同じ正規化・除外規約を利用するようにした。カルテ全文を
一括除外せず、電話語彙を含む文・節ごとに時制を判定するため、
「前回は対面、本日は電話再診」の現在受診は維持する。「先週・先日・昨日」は
電話判定固有の過去手掛かりとして追加した。上記2文、他院言及、同一文中の時制切替を
反例テストに固定し、「本日電話等再診」「家族から電話相談あり電話にて指示」の発火も
維持している。

### W1受入fixture / M8統合 (2026-07-23 ローカル完了)

`data/tests/fee-standing-monthly-e2e/1002/`と
`scripts/evaluate_fee_monthly_chart_e2e.mjs --seed-standing-prior-month`を追加した。
同一合成患者について、前月W1b候補を既存レビューAPIで承認し、standing profile登録を
APIで確認した後、翌月のW1候補・承認後月次明細・copy-forwardメモを測る。
Firestore直接投入や期待コードの算定入力への混入は行わない。

合否は各反復で以下を全て要求する。

- 前月W1b候補を検知し、承認後profileへ対象月・対象コードが記録された。
- 翌月W1候補を検知し、承認後profileと患者×月明細へ対象コードが記録された。
- copy-forward対象受診でメモが実際に使われ、`memoHitLineRatio > 0`だった。

fixture helperテスト6/6、UKE解析を含むdry-runはpass。STG smokeはMFA必須アカウントの
認証前に停止したため、6桁コードを付けた本計測は未実施。実行手順と判定表は
`docs/20260723-standing-monthly-e2e/README.md`に固定した。

### F2. [P1] 月次集計層で同一月背反(exclusions_month)を最終明細集合に適用する

**実装仕様は `fee-workorder-monthly-exclusion-enforcement-20260724.md`(X1〜X5)へ分離した。**

standing lane STG計測(`docs/20260723-standing-monthly-e2e/20260723_205224/`)で発見。
standingの受入は全合格したが、確定点数が反復2だけ+48点(喀痰吸引140003810が
管理料と同月確定)、候補が反復3だけ+302点(人工呼吸140009310)になった。

これはLLM揺れ対策(W2/W4)の問題ではない。電子点数表マスタの `electronic_exclusions`
(exclusions_month) に **114005410(在宅人工呼吸指導管理料)×140003810(喀痰吸引)** と
**114005410×140009310(人工呼吸)** の同一月背反ペアが2010-04-01から収載済みであり、
本来この2件は決定論で抑止できる。現状は、standing laneが確定させた管理料と
各セッションの処置候補・確定行の突合が月次の最終明細集合に対して行われていない
(`monthlyCandidateConstraints` `services/fee-api/src/server.js:3688` は
actExclusionsを取得するが、最終集合への強制がない)。

修正(マスタ駆動・コード列挙禁止):

1. 月次集計の最終明細集合(全セッション確定行+standing由来行+候補行)に対し、
   `exclusions_month`(および同週・同日スコープ)の背反チェックを適用する。
   優先方向はマスタのrule_kindに従う(管理料優先なら処置側を落とす)。
2. 確定済み行が背反する場合は自動削除せず **blocked+確認事項**
   「〜は同一月の〜と併算定できません(電子点数表背反)」。候補行は抑止する。
3. セッション計算時にも、同月履歴(standing確定を含む)との背反を既存の
   check_electronic_rules 経路で確実に評価する(standing確定行が履歴に
   反映される順序を含めてテストで固定)。
4. 効果: 「吸引で対応」型の曖昧記載をLLMがどう分類しても**点数が動かなくなる**
   (管理料算定月は処置側が背反で止まるため)。本fixtureのW4分散=0はこの修正で達成する。
