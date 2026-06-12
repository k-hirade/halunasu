# Fee SOAP E2E Dataset v2

実カルテに近い文体で全診療科・全請求ドメインをカバーする、診療報酬算定E2Eの第2世代ゴールドデータセット。

## v1からの設計変更(ゴールド契約)

v1で確認された構造問題(テンプレ文への根拠依存、説明調の不自然な文体、claim context再利用によるカルテ不整合)を仕様レベルで排除する。

1. **検証が先、生成が後**: すべてのケースは出荷前に (a) ゴールド契約バリデータ、(b) claim-context再生検証(エンジンが期待点数を再現)、(c) ケース型一意性、の3ゲートを通過する。
2. **テンプレ/メタ文の禁止**: 「当日確認した主な診療内容は…」「確認すべき論点は…」のような採点情報をカルテ本文に書かない。期待コード・期待トピックの根拠は自然な臨床文にのみ置く。
3. **事実と答えの分離**:
   - `encounter` と `facilityFixtureKey` = 入力事実(受診事実・施設属性)。評価ハーネスがセッション/施設としてseedしてよい。
   - `expectedClaimContext` / `expectedCalculation` = 答え。ハーネスから製品に渡してはならない。
4. **施設属性はカルテに書かない**: CT機器区分・電子画像管理体制・施設基準届出は `facility-fixtures.json` の施設プロファイルが持つ。カルテは「頭部CT施行」のように現実の記載のみ。
   - 注: 現行製品は施設プロファイルから facility_standard_keys のみ読む。機器区分・電子画像管理の施設プロファイル化は本データセットが駆動する製品側ギャップであり、抽出経路のexactがこの分だけ落ちるのは「正しい計測」である。
5. **正式名称への依存禁止**: 点数表の正式名称(「ＣＴ撮影（１６列以上６４列未満マルチスライス型機器）」等)をカルテに書かない。実カルテの語彙(頭部CT、インフル迅速、尿定性)で書く。
6. **根拠文言は共通述語に準拠**: 実施は「実施/施行/行った」系(「確認した」は実施根拠にしない)、採血は実施文言、面積は数値付き。validator/generator/runtimeで同一述語を使う。

## 構成

- `coverage-matrix-v2.json` — 500件の診療科×ドメイン配分(第1波)。第2波500件は文体バリアント。
- `facility-fixtures.json` — ケースが参照する施設プロファイル。
- `style-spec.md` — 実カルテ文体の仕様とリント規則。
- `fee-soap-e2e-v2-cases.json` — ケース本体。
- 生成: `scripts/generate_fee_soap_e2e_v2_pilot.mjs`(パイロット)。スケール時はケース仕様(セル)→claim context確定→カルテ生成→3ゲート、の順。

## 評価

```bash
node scripts/evaluate_fee_soap_e2e_dataset.mjs --dataset data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json --use-expected-claim-context
```

## 品質ステータス

全ケース synthetic。`productionGoldAllowed` は医療事務レビュー完了まで false。exact層はレビュー必須、review/safety層はサンプルレビュー。
