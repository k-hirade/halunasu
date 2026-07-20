# 作業依頼: サイドカーの同一建物区分対応(DOM判定+施設ルールバリアント) (2026-07-20)

## 背景(実機で確認した誤算定)

拡張の実機確認で、施設入居患者 1002(さくら苑港南・単一建物:4)と 1011(陽だまりホーム戸塚・
単一建物:6)が、個人宅の1001と同じ**969点(同一建物居住者以外890点+ベースアップイ79点)**で
算定された。bomisの行為欄(HOMIS側の実算定)は
**「在宅患者訪問診療料(1)1(同一建物居住者)215点(114030310)+ベースアップロ19点(180726010)」**
であり、正しくは**234点/受診**。1受診あたり**735点の過大算定**になる。

原因は既知のC問題(同一建物区分の入力軸が無い)だが、実機確認で**新事実**が判明した:

- **mockのDOMに判定材料が露出している**。患者ヘッダの「施設入居」バッジと、
  カルテメタの**「単一建物：4」**(=同一日・同一建物の診療患者数。HOMISが算定用に表示している値)。
- つまり同一建物区分は**DOMから決定論的に判定できる**(`encounterTypeSource: "dom"` の初適用例)。

制度上の判定規則(実装前に告示・疑義解釈で確認し出典をコメントへ。推測実装禁止):
同一建物居住者の該当は「同一日に同一建物で複数患者を診療」が軸。DOMの単一建物人数Nと
居住区分を使い、**N>=2 → 同一建物居住者、N=1 → 同一建物居住者以外、明示的な個人宅 →
同一建物居住者以外、それ以外(表示なしを含む) → 未確定**とする。表示が無いことを「以外」の
根拠にはせず、ユーザー上書きを常に可能にする。

根拠:

- 厚生労働省「診療報酬の算定方法」C001 在宅患者訪問診療料(Ⅰ):
  同一建物居住者とは、同一日に同一建物で複数患者を診療した場合の当該患者を指す。
  https://www.mhlw.go.jp/web/t_doc?dataId=84aa9729&dataType=0&pageNo=6
- 令和8年度診療報酬改定資料: 訪問診療時の外来・在宅ベースアップ評価料は
  同一建物居住者以外79点、同一建物居住者19点。
  https://www.mhlw.go.jp/content/12400000/001701063.pdf

## スコープ

H3(encounterDetails)の**同一建物部分の先行実装**。フィールド名はH3本体
(`fee-workorder-frequency-limit-20260716.md` H3)と揃え、後からfee-web/評価CLI経路が
同じ契約に乗れるようにする。電話再診・visitKindは本チケットでは触らない。

## M1: セレクタ契約 v3 (homis-mock-v3)

対象: `clients/homis-sidecar/extension/lib/contract.js` / mock改修スクリプト

1. 抽出項目を追加:
   - `facilityResidence`: 患者ヘッダの「施設入居」バッジ有無(参考表示用)
   - `privateResidence`: 患者ヘッダの「個人宅」バッジ有無(判定材料)
   - `singleBuildingPatientCount`: カルテメタ「単一建物：N」の N(無ければ null)
2. mock側: 「単一建物：N」は既にDOMにある(1002/1011で確認済み)。セレクタが安定して
   取れる位置か確認し、必要なら `prepare_homis_mock_v2.py` を v3 として更新
   (data属性化 `data-single-building-patient-count` を推奨。表示文字列のパースより頑健)。
3. 契約バージョンを `homis-mock-v3` に上げ、STGの
   `HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS_STG` を更新する
   (旧v2は移行期間中のみ併記、切替後に外す)。
4. fixtureユニット: 単一建物あり(1002相当)/個人宅(1001相当)/1人/根拠なし の4ケースを追加。

## M2: サイドカー契約とパネルUI

1. `validateSidecarCalculationInput`(fee-contracts)に追加:
   ```
   sameBuilding: boolean | null           // null=未確定
   sameBuildingSource: "dom" | "user" | null
   singleBuildingPatientCount: number | null   // 参考値(監査・将来の施医総管人数区分用)
   ```
   `sameBuilding` が非nullなら `sameBuildingSource` 必須。
2. パネル: 受診区分の下に同一建物の3値選択(未確認/同一建物/同一建物以外)を追加。
   - DOM判定できた場合: 「同一建物: N名 → 同一建物居住者として算定」を**判定済み表示**
     (ユーザーはワンタップで上書き可能。上書き時は source="user")
   - 判定不能: 未選択(null)のまま算定可能だが、結果に「同一建物区分未確定」警告が出る(M3)。
3. extractionProofの構造は変更しない。ただし判定材料が変わった古い画面で算定しないよう、
   `facilityResidence` / `privateResidence` / `singleBuildingPatientCount` は抽出スナップショットと
   preview指紋の対象に入れる。

## M3: サーバ側(バリアント選択と警告)

1. セッション/ドラフトへ以下を `encounterDetails` として透過(H3と同名。
   fee-contractsのセッション契約に optional で追加)。inputSnapshot/trace/監査ログにも記録する。
   明示的なclaimContextは再現算定用の完全入力として別経路になるため、サイドカーから合成しない。
   - `sameBuilding: boolean | null`
   - `sameBuildingSource: "dom" | "user" | null`
   - `singleBuildingPatientCount: number | null`
2. **施設恒常算定ルールのバリアント選択を実装**(H3チケット既載の `sameBuildingCode` 仕様):
   - `autoBillingRules[].sameBuildingCode`(optional)を契約に追加。
   - 適用時: `sameBuilding === true` なら `sameBuildingCode` を、falseなら従来 `code` を使う。
   - `sameBuilding === null` では両方のコードを候補・合計から外す。未確定を「以外」とみなさない。
   - yamamoto/デモ施設設定を更新:
     `home_visit_fee: code=114001110, sameBuildingCode=114030310` /
     `home_visit_baseup: code=180725910, sameBuildingCode=180726010`。
3. `sameBuilding === null` かつ同一建物バリアントを持つhome_visitルールが適用対象のとき警告を追加:
   「同一建物区分が未確定です。同一日に同一建物で複数患者を診療した場合は
   同一建物居住者の区分になります。区分を選択して再計算してください。」
   (判定不能画面でも黙って以外扱いにせず、対象2明細は合計に含めない)
4. 冪等リビジョン: `sameBuilding`/`singleBuildingPatientCount` を
   `sidecarSourceRevisionHash` の対象に加える(区分を変えて再実行→再計算になる)。

## M4: テストと受け入れ

1. ユニット: 契約(3値バリデーション)/ルールバリアント選択(true/false/null)/
   リビジョンハッシュ変化。
2. サイドカー統合テスト: sameBuilding=true → 候補が114030310(215点)+180726010(19点)=234点、
   false → 969点、null → 対象2明細を合計から除外+未確定警告。
3. 実機受け入れ(⑨シナリオに追加):
   - 1002/1011: DOM判定で自動的に「同一建物」→ **234点**、行為欄と一致
   - 1001(個人宅表示あり): DOM判定で「同一建物以外」→従来どおり969点
   - 居住区分・人数とも根拠なし: 未確認のまま対象2明細を出さず警告
   - 判定の上書き(同一建物→以外)で969点に変わり、sourceRevisionが進む

## ロールアウト

1. mockへ `prepare_homis_mock_v3.py` を適用し、Chrome拡張をv3版へ更新する。
2. STGの許可契約を移行期間だけ `homis-mock-v3,homis-mock-v2` としてfee-apiを更新する。
3. v3拡張で上記4シナリオを確認後、許可契約から `homis-mock-v2` を外す。
4. Firestore rules/indexesの変更はない。施設設定はyamamoto-demo-stgのseedを再適用する。

## 付随の観察(本チケット外・記録のみ)

- 1002の「人工呼吸」曖昧候補(140系=処置の人工呼吸)は、在宅人工呼吸指導管理料の管理下患者には
  ノイズ。機器管理欄(在宅医療機器 管理状況)がDOMにあるため、H4(患者恒常算定プロファイル)の
  入力源として同欄の抽出を検討する(施医総管の単一建物人数区分と併せてH4の主材料)。
- 施医総管(2〜9人)4,485点等の月次系はH4スコープのまま(本チケットでは扱わない)。
