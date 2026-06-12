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

- `coverage-matrix-v2.json` — 1000種類の診療科×ドメイン×算定状態×施設fixture×文脈罠の配分。文体バリアントは補助であり、主たる種類数は独立シナリオで担保する。
- `facility-fixtures.json` — ケースが参照する施設プロファイル。
- `gold-blueprints.json` — SOAP本文を作る前に固定する1000件の算定ゴールドblueprint。期待コード/点数、レビューtopic、禁止候補、施設fixture、必要な臨床アンカーを持つ。
- `style-spec.md` — 実カルテ文体の仕様とリント規則。
- `fee-soap-e2e-v2-cases.json` — ケース本体。
- blueprint生成: `npm run generate:fee-soap-e2e-v2:blueprints`。既存手書きケースとcoverage matrixから1000件の算定blueprintを固定する。SOAP本文は生成しない。
- blueprint検証: `npm run test:fee-soap-e2e-v2:blueprints`。1000件数、assertion mix、一意性、exact点数、review topic、施設fixture参照を確認する。
- SOAPケース生成: `npm run generate:fee-soap-e2e-v2`。sources/配下の手書きケース定義を統合する。SOAP本文そのものをアルゴリズム生成しない。
- 検証: `npm run test:fee-soap-e2e-v2`。メタ文禁止、施設属性分離、正式名称禁止、exactアンカー、一意性を確認する。

## blueprint first の作成順序

1000ケース拡張では、SOAP本文を先に量産しない。まず `gold-blueprints.json` で算定ゴールドを1000件固定し、その後で各blueprintに対してSOAP本文を手書きする。

1. `expectedCalculation` で exact の候補コード・合計点、review/safety/unsupported/split の期待状態を固定する。
2. `expectedExtraction` で必要なbilling signal、review topic、forbidden candidateを固定する。
3. `requiredClinicalAnchors` に、SOAP本文へ自然に書くべき根拠を列挙する。
4. 手書きSOAPを追加したら、blueprintの `blueprintId` または `caseTypeKey` と対応させる。
5. exactはカルテ本文と期待点数が1:1になるまで採用しない。review/safetyは期待topic/禁止候補が本文から自然に導けるまで採用しない。

## 1000ケース化の意図

v2の1000件は、既存50件の単純な言い換えではない。Claudeがv2で置いた品質基準を維持しつつ、以下を満たす評価母集団にする。

- すべての主要診療科と、クリニック/病院で頻出する請求ドメインを含める。
- exact / review_required / safety / unsupported_expected / split_required を混在させる。
- 当日実施、予定、過去、他院、持参、否定、数量不足、施設条件不足を分けて記録する。
- `caseTypeKey` を使い、caseIdだけの差分を「種類」として数えない。
- `variantOf` は既存の表現揺れ確認用途に限定し、1000件の主成分には使わない。
- 追加分のSOAP本文は1ケースずつ手書きし、機械的なテンプレ展開や語句差し替えで作らない。
- すべて synthetic_v2 とし、医療事務レビュー完了までは `productionGoldAllowed=false` を維持する。

## 現在の進捗の読み方

- `gold-blueprints.json` が1000件の算定設計母集団。
- `fee-soap-e2e-v2-cases.json` がSOAP本文まで手書き済みの実行用データ。
- `status=chart_authored` のblueprintはSOAP作成済み。`blueprint_ready_chart_pending` はSOAP本文の手書き待ち。
- 1000件すべてが医療事務レビュー済み本番goldになった、という意味ではない。

## 評価

```bash
node scripts/evaluate_fee_soap_e2e_dataset.mjs --dataset data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json --use-expected-claim-context
```

## 品質ステータス

全ケース synthetic。`productionGoldAllowed` は医療事務レビュー完了まで false。exact層はレビュー必須、review/safety層はサンプルレビュー。
