# 作業依頼: 明細書発行体制等加算(112015770)の施設設定駆動の自動算定 (2026-07-18)

yamamoto実測で既存UKEにあり当社が常に落としているコード(1012/1002/1003で各1点)。
施設基準の逆算分析(2026-07-18)で「マスタの施設基準コード列に載らない型のため逆算不能・
手動設定が必要」と特定済み。本チケットで施設設定→エンジン自動算定→サイドカー経由まで通す。

## 0. 制度前提と質問への回答

- **「この施設のみに適用」の想定は正しい**。feeSettings は facilityId スコープ
  (`PATCH /v1/fee/settings/{facilityId}`)で保存・参照されるため、施設基準キーを
  yamamoto施設の設定に入れれば他施設には一切影響しない。
- 算定要件(2026-07-18外部レビューで一次資料により確定。出典をルール定義のコメントに転記すること):
  - **A001再診料の注11の1点加算。A002外来診療料には付かない**
    (令和8年度医科点数表 https://www.mhlw.go.jp/content/12400000/001686842.pdf)。
  - **同一日複数科受診の2科目再診料には注10〜20の加算が算定不可** → 2科目コードは対象外。
  - **届出は不要(確定)**。ただし診療所・電子請求・明細書無償交付・院内掲示等の基準適合が必要
    (令和8年度施設基準通知 https://www.mhlw.go.jp/content/12400000/001686836.pdf)。
    実装上は「施設設定のキー保有=基準充足の宣言」として扱い、充足判断は施設の責任。
  - **電子的診療情報連携体制整備加算(111704070/111704170/111704270/112709570)を届け出た施設は
    本加算を算定できない**(同点数表)。マスタの `exclusions_month` に排他ペアが実在することを
    確認済みだが、現エンジンは同月背反を警告に留め自動除外しない(claim_adjustments.py)ため、
    ルール側の否定条件が必要(M1-2)。
  - 電話等再診(112007950)への適用はH3(電話再診区分)実装時に判断・追加する。本チケットでは対象外。

## 1. 実現可能性(調査済み)

**可能・小規模**。エンジンには基本料派生加算の宣言的フレームワークが既にあり
(`python/medical_fee_calculation/outpatient_basic.py` の `BasicFeeDerivedAddOnRule`、
物価対応料・乳幼児加算が使用中)、**`required_facility_standard_key` フィールドと
その判定ロジック(269行〜)も実装済み(現在未使用)**。設定キーの伝搬経路
(feeSettings.facilityStandards → `activeFacilityStandardKeysFromFeeSettings` →
claimContext.facility_standard_keys → エンジン)も稼働済み。
サイドカー経路もドラフトstoreシムが `getFeeSettings` を委譲しているため同じ設定が効く。

## 2. M1: エンジンルール追加

対象: `python/medical_fee_calculation/outpatient_basic.py`

1. **専用トリガー集合を新設**(2026-07-18レビュー反映):
   `OUTPATIENT_REVISIT_OR_CLINIC_BASIC_FEE_CODES` は**使わない**。同集合には
   A002外来診療料(対象外)・同一日複数科の2科目(注加算算定不可)・特定妥結率系が混在し、
   トリガーが広すぎる。当面は次の4コードに限定した専用集合を定義する:
   ```python
   MEISAISHO_HAKKO_TRIGGER_CODES = frozenset({
       "112007410",  # 再診料
       "112008350",  # 同日再診料
       "112024210",  # 再診料（情報通信機器）
       "112024950",  # 同日再診料（情報通信機器）
   })
   ```
   (4コードの実在・名称はマスタで確認済み。電話等再診はH3で追加、2科目系は恒久的に除外)
2. `OUTPATIENT_BASIC_DERIVED_ADD_ON_RULES` に追加:
   ```python
   BasicFeeDerivedAddOnRule(
       rule_id="outpatient_meisaisho_hakko_revisit",
       add_on_code="112015770",  # 明細書発行体制等加算 1点 (A001再診料 注11)
       trigger_codes=MEISAISHO_HAKKO_TRIGGER_CODES,
       source="outpatient_meisaisho_hakko_add_on",
       effective_from=date(...),  # 告示確認のうえ設定(マスタ有効期間とも整合させる)
       reason="Meisaisho issuance add-on derived from a revisit basic fee (facility standard required)",
       required_facility_standard_key="meisaisho_hakko_taisei",
       prohibited_facility_standard_keys=frozenset({
           "denshiteki_shinryo_joho_renkei_taisei"
       }),
   )
   ```
   `prohibited_facility_standard_keys` はルールdataclassへの**新規フィールド**(既定 `frozenset()`)。
   評価ループで「1つでも保有していたらスキップ(無言)」を実装する。
   根拠: 電子的診療情報連携体制整備加算の届出施設は本加算を算定できない。
   エンジンの同月背反(exclusions_month に排他ペア実在)は警告止まりのため、
   自動追加側で先に止める必要がある。
2. **【重要・gold回帰の罠】キー未保有時のスキップメッセージを出さない**:
   既存の `required_facility_standard_key` 判定は、キー未保有だと
   `NEEDS_REVIEW` メッセージを出してスキップする(outpatient_basic.py 281行付近)。
   この経路は今まで未使用(全ルールがkey=None)で、そのまま使うと
   **全国のすべての再診クレームに「施設基準がないため加算しません」の
   needs_reviewメッセージが付き、goldのengineStatusがok→needs_reviewへ倒れて
   seed-300が大量に落ちる**。届出が無いのは正常状態であり確認事項ではない。
   → ルールに `silent_when_missing_standard: bool = False` を追加し、本ルールは
   `True` にしてキー未保有時は**無言でスキップ**する(既存の他用途の挙動は変えない)。
3. テスト(python/tests):
   - キー保有+再診(112007410) → 112015770(1点)が付く。
   - キー保有+初診のみ → 付かない。
   - キー保有+**外来診療料**のみ → 付かない(トリガー限定の回帰)。
   - キー保有+**2科目再診料(112015810)**のみ → 付かない。
   - キー未保有+再診 → 付かず、**メッセージも出ない**。
   - キー保有+**禁止キー(denshiteki_shinryo_joho_renkei_taisei)も保有**+再診 → 付かない(無言)。
   - キー保有+電話等再診(H3実装後の将来ケースとしてTODOコメント)。
4. ゲート: **gold 2系統**(seed-300 exact 150 / v2 exact 138)が不変であること。
   goldのclaimContextGoldは本キーを持たないため「無言スキップ」なら不変のはず。
   変わったら2の実装が漏れているサイン。

## 3. M2: yamamoto施設設定への投入

1. `samples/yamamoto-demo-stg/fee-settings.json` の `facilityStandards` に追加:
   ```json
   {
     "key": "meisaisho_hakko_taisei",
     "name": "明細書発行体制等加算（デモ: 基準充足開始日は推定値）",
     "status": "active",
     "claimStartDate": "2026-06-01",
     "effectiveTo": "",
     "acceptanceNumber": ""
   }
   ```
   - `claimStartDate` の意味は「UKEに出現した月」ではなく**「全基準を満たし始めた日」**。
     デモでは実データが無いため推定値であることを name に明記して残す(上記例)。
     実顧客では施設への確認値を使う。
   - 届出不要型のため acceptanceNumber は空でよい。
2. **設定バリデーション追加**(fee-contracts `validateUpdateFeeSettingsInput`):
   `meisaisho_hakko_taisei` と `denshiteki_shinryo_joho_renkei_taisei` の**両方を
   activeにできない**(validationError)。ルール側の否定条件(M1)と二重の防御にする。
3. **施設種別の検証**: platform facility の `facilityType`(契約に存在)を設定PATCH時に参照し、
   `facilityType === "hospital"` 等の明示的な病院なら**エラー**、未設定なら
   「診療所であることを確認してください」の**警告+監査記録**で通す
   (未設定施設で運用を止めない。キーだけでは病院への誤登録を防げないため)。
   `facilityId=default` または実在施設を取得できない場合は、個別設定のない病院への継承を
   防ぐため**エラー**とし、実在施設だが種別だけ未設定の場合とは区別する。
4. STGのyamamoto組織へ `PATCH /v1/fee/settings/{facilityId}` で反映。
   **注意: `scripts/p15_seed_core_account.mjs` の `ensureFeeSettings` はfee settings全体を
   テンプレートで置換する**。seed経由で流す場合は、実行前にSTG現在値をGETして差分を確認し、
   STG側にしかない設定(手動投入分)を失わないこと。
5. **逆算で特定した残り3基準(803/721/4102)は facilityStandards に登録しない**
   (2026-07-18レビュー反映)。`activeFacilityStandardKeysFromFeeSettings` は name の
   「要確認」表記を解釈せず、status=active のキーを算定根拠としてエンジンへ渡すため、
   未確認情報のactive登録は誤算定の根拠になる。未確認の逆算結果は
   **設定とは別のフィールド(例 `inferredFacilityStandards`、エンジン非参照)または
   診断レポートのみに保持**し、施設への確認が取れたものだけを facilityStandards へ昇格する。

## 4. M3: サイドカー経由の動作(拡張で使えるようにする)

追加実装は**不要のはず**(検証のみ):

- サイドカーのドラフト算定はドラフトstoreシム経由で `feeStore.getFeeSettings` を読む
  (server.jsのシム定義で委譲済み)ため、M1+M2が入れば同じ設定・同じエンジンで
  112015770が導出される。
- サイドカー応答では他の明細と同様 `candidateOnly / needs_review / estimatedTotalPoints`
  として提示される(確定はfee-web採用後)。
- テスト(services/fee-api/test): sidecar calculate で
  「yamamoto相当のfeeSettings(キー保有)+外来再診ドラフト」→ 候補一覧に112015770(1点)が
  含まれる/キー未保有の施設では含まれない、の2ケースを追加。
- 注意: 在宅区分(home_visit)のドラフトでは外来基本料が抑制されるため本加算も付かない(正しい)。
  効くのは外来再診の受診(1012の3回目相当)のみ。

## 5. M4: STG検証

1. M2投入後、患者1012を再計測 → 確定明細に 112015770×1(1点)が入り、既存UKEと一致すること
   (1002/1003は電話再診の受診に紐づくためH3実装後に一致する。ここで一致しなくても正常)。
2. 他患者(1001等、再診の無い訪問のみ)で誤って付いていないこと。

## 完了ゲート

- Python全スイート+fee-api/fee-core/contracts/medical-core全パス。
- gold 2系統不変(M1-4)。
- **経路別の受け入れ**(サイドカーのcandidate-only方針と区別する):
  - fee-web/評価ハーネス経路(通常セッション): 1012の確定明細に112015770×1が入り既存UKEと一致。
  - サイドカー経路(ドラフト): **候補として1点で出る**(candidateOnly。確定はfee-webでの採用後に
    通常セッション側で成立)。ドラフトから確定明細が生えないことはサイドカー側の既存不変条件。

## 規模

小〜中(エンジン: 専用トリガー集合+宣言ルール1件+silent/prohibitedフィールド+テスト7本 /
契約: 排他バリデーション+施設種別検証 / 設定: JSON+PATCH(seed全置換への差分確認手順込み) /
サイドカー: テストのみ)。
