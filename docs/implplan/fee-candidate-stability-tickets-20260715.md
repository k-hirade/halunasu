# 候補安定化・作業チケット (2026-07-15)

STG再計測 `docs/20260715_mockpartner_reforms123_stg_remeasurement_20260715_194856/` の分析結果に基づく修正チケット。
設計原則は改革1〜3と同じ: **LLM抽出への依存を候補生成から排除し、マスタ駆動の決定論に置換する。曖昧なものは1件の確認候補に畳み、未確定の点数は表示しない。**

実測で確認済みの根拠:

- 候補揺れの正体は「特定疾患療養管理料225点＋外来管理加算52点」の出没(1006: 200/477/477、1007: 2,742/2,465/2,742)。**診断リストは3反復で安定**しており、揺れているのはLLMイベント抽出(1006の6/17受診で2/5/5件)。
- 1007で同一コード集合 `{114003710, 114004110}` の曖昧候補が**2グループ併存**(知識ルール2,400点表示 + 辞書スキャン0点表示)。
- `cc_act_indications`(21.8万行)は行為↔対象病名コードを機械可読で保持。113001810(特定疾患療養管理料・診療所)の適応4,003病名に膵癌系・慢性閉塞性肺疾患が**実在することを確認済み**。
- COPD(8840399)→113/114系の逆引きは6件で、全て特定疾患療養管理料の施設区分バリアント(診療所/100床未満/…/情報通信機器)。

---

## T1. [P1・小] 月次集計: コード未確定の曖昧候補グループを codeCandidates 集合キーで統合する

### 現状

`packages/fee-core/src/index.js` の `aggregateMonthlyCandidateLines`(453行〜)の畳みキーが

```js
const key = code
  || (proposal.ruleId ? `rule:${proposal.ruleId}` : `proposal:${proposal.proposalId || proposal.title || ""}`);
```

のため、同一 `codeCandidates` 集合でもレーンが違うと別行になる。1007では
`rule:C103_home_oxygen_signal`(2,400点)と `proposal:dict_scan_choice_…`(0点)が併存した。

### 変更仕様

1. キー決定を次の優先順に変更する:
   - `code` があれば `code`(従来どおり)
   - `code` が無く `codeCandidates` が非空なら `choice:${[...new Set(codeCandidates)].sort().join("/")}`
   - どちらも無ければ従来の `rule:` / `proposal:` フォールバック
2. `choice:` キーで統合された行の表示仕様:
   - `code: null`、`codeCandidates`: 両提案の和集合(既存の uniqueSortedStrings 処理を流用)
   - `points: 0`、`totalPoints: 0`(**コード未確定の候補は点数を表示しない**。区分により2,400点/520点等と幅があるため、恣意的な1点数を出さない)
   - `name`/`title`/`reason`: 先に来た提案のものを採用し、`proposalIds` に両方を残す(監査用)
   - `quantity`/`occurrenceCount`/`suppressedOccurrenceCount` の畳み方は従来どおり(monthlyLimit フォールバックも従来どおり)
3. `conflicts` 注釈は `line.code` 基準のため choice 行では従来どおりスキップされる(変更不要)。
4. `codeCandidates` 集合が部分一致(片方が上位集合)のケースは**今回は統合しない**(完全一致キーのみ)。コメントで明記する。

### 影響範囲・テスト

- `packages/fee-core/test/index.test.js`(または `src/index.test.js`): 「レーン違い・同一codeCandidates集合の2提案 → candidateLines 1行・totalPoints 0・proposalIds 2件」を追加。既存の月次候補テストで candidateTotalPoints を検算している箇所は 0点化に合わせて更新。
- `scripts/evaluate_fee_monthly_chart_e2e.mjs` の sanitizeMonthlyReceipt は codeCandidates を既に記録しているため変更不要(検知一致は codeCandidates 経由で従来どおり成立する)。
- **候補点数KPIの意味が変わる**(1007の候補点数は約2,742→約342点に低下する)。docs比較時はこの仕様変更を明記すること。

### 受け入れ条件

- 1007相当の入力で曖昧グループが1行になり、totalPoints 0 で表示される。
- fee-core 全テストパス。

---

## T2. [P1・小] 知識ルールのハードコード点数を廃止する(未確定候補は0点表示)

### 現状

`services/fee-api/src/clinical-billing-knowledge.js` 319行付近:

```js
const potentialPoints = Number(masterItem?.points || masterItem?.totalPoints || rule.potentialPoints || 0);
```

マスタ照合が曖昧(codeCandidates)・失敗のとき、`management-signal-rules.json` にハードコードされた点数
(C103=2400 等)がそのまま候補点数として表示・月次合計に加算される。これは外部レビュー指摘
「52点固定値は改定後に古くなるため表示点数0の確認候補にする方が安全」と同型の問題。

### 変更仕様

1. `potentialPoints = masterItem?.code ? Number(masterItem.points || masterItem.totalPoints || 0) : 0;`
   に変更する(**マスタで単一コードに解決できたときだけ点数を表示**)。
2. `services/fee-api/src/clinical-billing-knowledge-data/management-signal-rules.json` の各ルールから
   `potentialPoints` フィールドを削除する(ロジックから参照しなくなるため。残すと再び参照される事故の温床)。
3. ルールの `reason`/`conditionText` 文言に点数を埋め込んでいる箇所があれば点数表記を外す(存在しなければ不要)。

### 影響範囲・テスト

- `services/fee-api/test/` の知識レーンテストで rule.potentialPoints 前提の期待値(2400/470等)を更新。
- 「マスタ解決成功 → マスタ点数」「曖昧(codeCandidates) → 0点」「検索失敗 → 0点」の3分岐をユニットテストで固定する。

### 受け入れ条件

- 曖昧解決の知識候補が0点表示になり、マスタ改定時に古い点数が表示される経路が存在しない(`potentialPoints` を rules JSON から grep しても0件)。

---

## T3. [P1・中] 外来管理加算候補を決定論化する(LLM根拠ゲートの撤廃)

### 現状

`services/fee-api/src/clinical-calculation-input.js` 775〜785行付近。候補提示の条件に
`outpatientManagementEvidence`(LLM抽出イベントから導出、2415行 `currentSpecificDiseaseManagementEvidence`)
が必須のため、**LLMが管理・説明の記載を拾えた反復だけ候補が出る**。STGで52点の出没として観測された
(改革1で確定は安定化したが、候補の存在自体がまだLLM依存)。

あわせて `outpatientManagementAddonProposal`(833行付近)のマスタ検索失敗時フォールバック
`{ code: "112011010", points: 52 }` はハードコード点数(T2と同型)。

### 変更仕様

1. 候補提示の条件から `outpatientManagementEvidence` を外し、次の決定論条件のみにする:
   - `!hasOwn(manualOptions, "outpatient_basic")`(手動指定時は従来どおり触らない)
   - 履歴上書き後の `normalizedInferred.outpatient_basic?.fee_kind === "revisit"`
   - 在宅区分(home_visit/house_call)・入院でない
   - つまり**「外来再診なら必ず承認待ち候補として出す」**。実施可否(同日の処置・生体検査・リハ・精神科専門療法が無いこと)は人の採用時確認とし、conditionText で明示する(現行文言を維持)。
2. `outpatientManagementEvidence` は**ゲートではなく注釈**に格下げする: 根拠が取れた場合のみ proposal の `evidence` に載せる。取れない場合は evidence 空で提示する(reason は「再診です。同日に併算定不可の行為が無い場合に算定できます。」等の一般文言)。
3. マスタ検索失敗時のフォールバック点数を `points: 52` → `points: 0` に変更する(T2の方針と統一)。コード `112011010` の仮置きは維持してよい(コード自体は安定)。
4. proposalId は既存の固定値 `outpatient_management_addon` を維持(月次畳みは code=112011010 で受診回数分カウントされ、電子点数表の頻度上限・背反注釈は既存機構がそのまま効く)。

### 設計上の判断(チケットに含める理由)

毎再診で候補が出るためノイズ増に見えるが、これは「迷ったらコメント付きで候補に出す」方針の適用。
出没する52点よりも、**常に出て条件文で判断を促す方が月次レビューの手数は少ない**。
併算定不可の決定論プレチェック(確定明細との突合)は算定エンジン実行後でないと判定できないため、
本チケットでは行わない(月次 conflicts 注釈が既にその役割を部分的に担う)。

### 影響範囲・テスト

- `services/fee-api/test/server.test.js` の管理説明→候補系テスト: 「根拠なし再診でも候補が出る」「初診では出ない」「home_visitでは出ない」に期待値を更新・追加。
- `services/fee-api/test/clinical-candidate-proposals.test.js`: フォールバック0点のテスト追加。
- 反復安定性がこのチケットの主目的なので、受け入れにSTG再計測(下記T6)の「候補点数3回同一」を含める。

### 受け入れ条件

- 同一カルテ3回で外来管理加算候補の有無が揺れない(STGで確認)。
- 52点ハードコードが残っていない。

---

## T4. [P1・大] 病名駆動の決定論候補レーン(cc_act_indications 逆引き)を新設する

### 目的

管理料系候補(特定疾患療養管理料等)の生成をLLMイベントから切り離す。診断リストは反復間で安定している
ことを実測確認済みのため、**病名→適応行為の逆引きで候補を出せば反復安定になる**。これは手書き知識ルール
10件(列挙式=特定カルテ対応の残滓)をマスタ駆動へ置換する第一歩でもある。

### Python側の仕様

1. `python/medical_fee_calculation/checks_api.py` に新関数 `disease_act_candidates(payload)` を追加し、
   `worker.py` に op `disease_act_candidates` として配線、`services/fee-api/src/python-calculator.js` に
   デリゲート `diseaseActCandidates()` を追加する(既存 `check_lookup` の配線を踏襲)。
2. 入力:
   ```json
   {
     "db_path": "...",
     "diagnoses": [{"name": "慢性閉塞性肺疾患", "suspected": false}],
     "setting": "outpatient",
     "patient_age": 76,
     "patient_sex": "female",
     "act_code_prefixes": ["113", "114"],
     "limit": 12
   }
   ```
3. 処理:
   - 病名コード化は既存 `resolve_diseases` / `_resolve_one_disease`(修飾語分解つき)を**再利用**する。
     解決できない病名はスキップし、結果に `unresolvedNames` として返す。
   - 逆引きクエリ:
     ```sql
     SELECT DISTINCT i.act_code, i.disease_code, i.sex, i.age_min, i.age_max, i.nyugai, i.utagai
     FROM cc_act_indications i
     WHERE i.disease_code IN (...解決済みコード...)
       AND (i.act_code LIKE '113%' OR i.act_code LIKE '114%')   -- act_code_prefixes から動的生成
     ```
   - **インデックス追加が必須**: `python/medical_fee_calculation/db.py` のスキーマに
     `CREATE INDEX IF NOT EXISTS idx_cc_act_indications_disease ON cc_act_indications(disease_code);`
     を追加する(initialize_schema は毎回走るので既存DBにも自動適用される)。
   - フィルタ(既存 `_act_indications` の列semanticsに従う):
     - `disease_code` のワイルドカード `0000000`〜`0000003` は既存実装同様に除外
     - `sex`: 指定あり(非0)かつ患者性別不一致なら除外
     - `age_min`/`age_max`: patient_age があれば範囲外を除外
     - `nyugai`(実データは 0/1): 0=制限なしとして扱い、非0は setting と突合。**値の意味は
       チェックマスタ仕様書で必ず確認し、docstring に出典を書くこと**(推測実装禁止)
     - `utagai`(実データは 0/2): 疑い病名(`suspected: true` または名称末尾「の疑い」)は
       utagai が許可値のときのみ採用。**同じく仕様書で値の意味を確認すること**
   - `medical_procedures` と JOIN して名称・点数・有効期間(サービス日が範囲内)を取得。
     `short_name` に「加算」を含む行為(role=addon相当)は除外(親項目前提のため単独候補にしない)。
4. **施設区分バリアントの畳み**: COPD→6件は全て特定疾患療養管理料の区分違い(診療所/100床未満/…/
   情報通信機器)。`name_scan.py` の `_strip_parens` と同じ要領で括弧修飾を除いた核名称でグループ化し、
   1ファミリ=1エントリで返す:
   ```json
   {
     "candidates": [
       {
         "familyName": "特定疾患療養管理料",
         "codes": [{"code": "113001810", "name": "特定疾患療養管理料（診療所）", "points": 225}, ...],
         "matchedDiseases": ["慢性閉塞性肺疾患"]
       }
     ],
     "unresolvedNames": []
   }
   ```
   codes は点数降順・最大8件、ファミリ数の上限は `limit`(既定12)。
5. 決定論性: 同一入力→同一出力(ソート順を明示: familyName 昇順、codes は点数降順→コード昇順)。

### Node側の仕様

1. `services/fee-api/src/clinical-calculation-input.js` の辞書スキャン呼び出し(715行付近)の直後に
   病名駆動レーンを追加する。入力の診断は **session.diagnoses + LLM抽出診断の和集合**(名称正規化・重複排除)。
   LLM診断が揺れても session.diagnoses が安定soleを保証し、LLM側は追加検出のみに寄与する。
2. 候補生成:
   - ファミリの codes が1件 → 通常の点数付き候補
     `proposalId: disease_link_${code}`、`basis: "disease_indication_candidate"`、
     `actionType: "confirm_required"`(管理料は実施事実が要件のため adoptable にしない)、
     `potentialPoints: マスタ点数`
   - codes が複数(施設区分バリアント等) → **コード未確定の曖昧候補1件**
     `proposalId: disease_link_choice_${candidateIdPart(familyName)}`、`code: ""`、
     `codeCandidates: codes[].code`、`potentialPoints: 0`(T1/T2の方針と統一)。
     施設プロファイル(診療所/病床数)が feeSettings 等から決定論的に判定できる場合は
     該当区分1コードに解決してよい(第2段として任意)。
   - `reason`: 「病名「{matchedDiseases}」は{familyName}の対象疾患です。管理・指導の実施記録がある
     場合に算定できます。」/ `conditionText`: 実施事実・記録・同月算定履歴・施設基準の確認を明記。
3. 重複排除(順序が重要):
   - 確定明細・既存候補(knownCodes: 辞書スキャンと同じ集合)に含まれるコードは出さない
   - 既出候補の codeCandidates 集合と同一のファミリは出さない(T1の choice キーと同じ正規化で比較)
   - 知識ルール(management-signal)と同一コードはどちらか一方に畳まれる(月次はT1のキーで統合されるが、
     セッション内でも disease_link を優先し knowledge 側をスキップしてよい。実装しやすい方でよいが
     二重表示にならないことをテストで固定する)
4. 上限: 1セッションあたり最大8提案。トレース(`clinicalTraceEvent`)に stage `disease_indication_scan`、
   解決病名数・候補数・unresolvedNames を記録する。
5. フェイルソフト: python呼び出し失敗時は候補なしで継続(辞書スキャンと同じ方針)。

### 知識ルール10件の扱い

本チケットでは**削除しない**(eventTerms による文脈検出・monthlyLimit 等の付加情報があるため)。
STGで disease_link レーンが安定稼働を確認した後、コードが重複するルール
(C103_home_oxygen 等)から段階的に削除する(別チケット)。

### テスト

- Python: seeded fixture(diseases + cc_act_indications + medical_procedures)で
  「病名解決→逆引き→ファミリ畳み→sex/age/疑いフィルタ」をユニットテスト。
  実DBがある環境では 慢性閉塞性肺疾患→特定疾患療養管理料ファミリ(6コード)を検証する統合テスト
  (実DB無しでは skip、`counterexamples.test.js` の方式を踏襲)。
- Node: モック calculator で「単一コード候補」「曖昧ファミリ候補」「knownCodes除外」「knowledge併存時の一本化」。
- 反例コーパス `data/tests/counterexamples/counterexample-cases.json` に
  「診断: 膵臓癌末期+がん性疼痛 → 特定疾患療養管理料ファミリが候補に出る」を追加
  (expectedCandidateCodes は codeCandidates 経由の判定に対応済み)。

### 受け入れ条件

- 1006/1007相当のカルテ3反復で、特定疾患療養管理料候補が毎回同一に出る(STG T6で確認)。
- 算定APIレイテンシの中央値悪化が +5% 以内(逆引きは1回のworker呼び出し+インデックス付きIN検索)。

---

## T5. [P2・小] 月次集計/差分診断エンドポイントにステージ計測を追加する

### 現状

STGで月次集計 2,946→4,246ms(+44%)、差分診断 2,970→4,244ms(+43%)。コード上は
`monthlyCandidateConstraints`(server.js 2733行)が単一バッチ `checkLookup` でN+1は無く、
測定環境も未統制のため**原因を断定できない**。

### 変更仕様

- 月次集計・差分診断のレスポンス(またはログ)に区間計測を追加する:
  `listSessionsForMonthlyView`(Firestore)、`monthlyCandidateConstraints`(python checkLookup)、
  `buildMonthlyReceiptDraft`(集計)、差分診断側は再計算・マスタ照合の各区間。
  既存の `calculationMetrics` の形式に合わせ、`monthlyMetrics: { stageDurationsMs: {...} }` として返す。
- 評価スクリプト(`evaluate_fee_monthly_chart_e2e.mjs`)がこの内訳を記録するようにする。

### 受け入れ条件

- 次回STG計測で +44% の内訳(Firestore / python / 集計)が特定できる。

---

## T6. [計測・コード変更なし] 入力契約を揃えたSTG再計測

T1〜T4 デプロイ後、次の条件で5患者(1001/1004/1006/1007/1012)×3反復を再計測する:

1. **在宅患者(1007/1012等)は `setting: home_visit`** で実行(前回までの outpatient 固定は
   在宅系UKE 6コード/患者1012の不一致の主因)
2. **既知受診歴を seed** する(初診/再診の構造差を除去)
3. **施設基準キーを投入** する(明細書発行体制等加算等の施設依存コードを算定可能にする)
4. 評価指標(前回と同一定義):
   - 確定点数が3回同一(前回 5/5 → 維持)
   - **候補点数が3回同一(前回 3/5 → 5/5 が目標)** ← T1〜T4 の主目的
   - 候補込み検知率(前回 6.25% → 上昇を確認。特に 1006 の 113001810/113001810系、1007 の 113001810)
   - 確認事項集合の安定性(前回 0/5 → 改善傾向を確認)
- 注意: T1/T2 により候補点数の絶対値は下がる(曖昧候補が0点になるため)。前回値と比較する際は
  仕様変更として README に明記する。

---

## 共通の完了ゲート(全チケット)

1. `services/fee-api` / `packages/fee-core` / `packages/fee-contracts` / `packages/medical-core` の
   node --test 全パス、`PYTHONPATH=python python3 -m unittest discover -s python/tests` 全パス。
2. **goldゲートは2系統とも実行する**:
   - `npm run test:fee-gold:engine`(seed-300、exact 150件)
   - `node scripts/evaluate_fee_soap_e2e_dataset.mjs --dataset data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json --use-expected-claim-context --assertion exact`(v2 exact 138件)
   - T3/T4 は候補レーンのみの変更なので確定点数(エンジン純度)は不変のはず。変わったら設計違反。
3. 反例コーパス(`services/fee-api/test/counterexamples.test.js`)パス。
4. コミット粒度は T1+T2(小・同方針)/ T3 / T4 / T5 を分けることを推奨。

---

## 実装・検証状況 (2026-07-15)

- T1/T2: 実装済み。同一 `codeCandidates` 集合を月次で1行へ統合し、コード未確定候補は生成元にかかわらず0点とした。知識ルールJSONの固定点数も削除済み。
- T3: 実装済み。外来再診ではLLMの管理説明抽出に依存せず、外来管理加算を常に確認候補として提示する。マスタ検索失敗時は0点。
- T4: 実装済み。`cc_act_indications(disease_code)` のインデックス、Python逆引きAPI、Node候補レーンを追加した。実施イベント・辞書照合由来の強い既存候補は保持し、LLM依存の知識候補だけを病名駆動候補へ置換する。
- T5: 実装済み。月次レセプト、既存レセ差分診断、再算定差分診断に段階別時間を追加し、構造化ログと評価JSONへ記録する。
- T6: 2026-07-16に指定5患者×3反復を試行したが、STG応答にT1/T2/T4/T5未反映の証拠があり、
  デプロイ後の受け入れ測定としては無効。結果は
  `docs/20260716_fee_candidate_stability_t6_stg_remeasurement_20260716_022220/`に保存した。
  その後revision `fee-api-stg-00159-qzl`で3患者を再測定し、T1/T2/T5の反映を確認した。
  ただしCloud Run同梱の`standard-master.sqlite.gz`で`diseases`、`disease_modifiers`、
  `cc_act_indications`が0件だったため、T4は全24算定で候補0件となった。結果は
  `docs/20260716_fee_candidate_stability_t6_postdeploy_stg_20260716_025709/`に保存した。
  完全DBからgzipを再生成して再測定するため、T6は未完了のままとする。

ローカル完了ゲート:

- fee-api: 176/176、fee-core: 53/53、fee-contracts: 10/10、medical-core: 78/78、Python: 44/44。
- seed-300 engine gold: exact 150/150。
- fee-soap-e2e-v2 engine gold: exact 138/138。
- 反例コーパス: pass。膵臓癌・がん性疼痛の病名駆動候補を実マスタで確認済み。
