# 節分割契約 v2 統一ワークオーダー(V1〜V6) — 白箱訓練/推論乖離の1段階解消

- 作成日: 2026-07-30
- status: implemented-local-and-artifact-uploaded(STG deploy・新基線計測待ち)
- 対象: packages/fee-contracts、scripts/whitebox_training_common.py、python/medical_fee_calculation/whitebox_context.py、services/fee-api/src/whitebox-extraction.js、WX3 artifact再製造、STG shadow新基線
- 関連: fee-universal-act-coverage-workorder-20260729.md G1(共有節スコープ解析器)、fee-whitebox-shadow-measurement-analysis-20260728.md T1(WX3強化)

## 1. 背景: 何が起きているか(2026-07-30レビューで検出)

G1で導入した共有節分割 `splitClinicalEvidenceClauses`(全読点・括弧独立節・小数点ガード・governing prefixマージ)にJSランタイムの `splitWhiteboxEvidenceClauses` が移行した一方、python訓練側 `split_context_clauses` / `CONTEXT_CLAUSE_BOUNDARY_PATTERN`(`scripts/whitebox_training_common.py:34-37, 389-414`)は旧規則(文末記号+cue直前の読点のみ)のまま。両側とも `clauseSegmentationVersion: "fee-evidence-clause-v1"` を宣言し続けている(`whitebox-extraction.js:17` / `whitebox_context.py:45,53,61`)。

- **現行artifactの契約(2026-07-30訂正・実物確認済み)**: STGで使用中の `context-wx3-multilingual-minilm-l12-v3` は **input contract 1**(`manifest.json:62`、`inputSemantics` なし)。契約1の分類器入力は**行本文+前後行**であり節を使わない(`whitebox_context.py:508-512`)。したがって現時点の乖離の実害は「分類器入力の分布ずれ」ではなく、**節単位のcue・predicate合意・consensus・maskingというWX3ゲートの決定論側**の挙動がshadow計測の前提から黙ってずれること(+契約3以上のartifactを使う場合の入力ずれ)。「テスト緑のまま精度だけ崩壊」クラスの**4例目**であることは変わらない。
- **既存ゲートが検出できなかった理由**: R2等価ゲートは行テキスト(`_classifier_text`)のみを比較。R3の意味契約(`inputSemantics`)は**宣言文字列の照合**であり、JS側の宣言(v1)が挙動変更に追随せず据え置かれたため、両側の宣言が一致したまま挙動だけずれた。
- **封じ込め**: 白箱はoff/shadow(戦略はopenai_primary)のためPROD実害なし。壊れているのは計測の解釈可能性のみ。

## 2. 決定: 1段階で統一する(2026-07-30 ユーザー決定)

2段階案(白箱だけ旧splitterへ一時復帰→T1で移行)は棄却。理由:

1. **WX3の再製造は研究ではなくスクリプト実行**(`scripts/build_wx3_context_artifact.py`、今月複数回実施済み)。移行を待つ理由がない
2. 旧shadow基線(00196〜00198)はR系・T系適用前の値であり、どのみち再基線が必要。数値連続性を守る価値が実質ない
3. v2再製造後のshadow計測がT1(WX3強化)の新基線になる

**複合移行であることの明示(2026-07-30 外部レビュー反映)**: 現行artifactが契約1である以上、今回の移行は「節分割の差し替えだけ」ではなく、次の**3変更の複合**である:

- input contract **1 → 4**
- 分類器入力: **行+前後行 → 構造化メタデータ+親行+governing節**
- 節分割: **旧規則 → v2共有規則**

したがって「差分が節分割のみ」「節スコープ改善の寄与を直接測る」は**成立しない**。v2基線は複合移行後の新基線であり、旧基線とは**完全に非比較**。寄与分解が必要になった場合のみ「契約4+旧splitter」の中間製造で分解可能だが、本ワークオーダーでは行わない(計画外)。

**受け入れるトレードオフ**: 00196〜00198との数値比較は打ち切り(historical扱い)。旧基線に接続する唯一の方法は「戻す」だったが、それは選ばない。

## 3. チケット

### V1: python側を共有節分割規則へ移植

- **意図**: 訓練側(governing節選択を含む分類器入力の製造)とJSランタイムの節割りを同一規則にする。
- **具体実装**:
  - 新モジュール `python/medical_fee_calculation/clause_segmentation.py` に、JS `splitClinicalEvidenceClauses`(`packages/fee-contracts/src/clinical-predicates.js`)の**忠実な移植**を実装する。一致させる仕様(全項目):
    - 文境界: `[。．.!！?？；;\n\r]`、ただし**数字に挟まれた `.` / `．` は小数点として分割しない**(`isDecimalPoint` 相当。「複管8.0mm」を割らない)
    - 節境界: すべての読点 `[、，,]`
    - 括弧 `（(【［[` / `）)】］]` は**開閉とも境界**とし、括弧内は `parentheticalDepth` を+1した**独立節**
    - 空白trim、句読点のみの断片は捨てる
    - **governing prefixマージ**: prefix語だけの節は同一文・同一深度の次節と結合。**prefix語はJS実装(`clinical-predicates.js` の `CLINICAL_GOVERNING_PREFIX_ONLY_PATTERN`)の全件**: 本日|今回|当日|前回|先月|以前|過去|**他院|前医|他科|紹介元|持参|健診|検診|外部資料**|次回|後日|今後(+は/も/で/では/について+読点)。時制系だけでなく**所有・出所系(他院/持参/外部資料等)は安全上重要**(past/external文脈の継承)であり、欠落させない(2026-07-30 外部レビュー反映)
    - 出力フィールド: `text` / `charStart` / `charEnd`(**unicode code point基準**。JSの `charStart/charEnd` と同義。UTF-16オフセットはJS内部用でありpythonは持たない) / `sentenceIndex` / `parentheticalDepth` / `separatorAfter` / `clauseId`(`{lineId}:C{連番3桁}`)
  - `scripts/whitebox_training_common.py` の `split_context_clauses`(:389-)と `CONTEXT_CLAUSE_BOUNDARY_PATTERN`(:34-37)を削除し、新モジュールへの委譲に置き換える(:355 の呼び出し点はシグネチャ互換を保つ)。
  - **WX1/WX2の非依存を確認**: span(トークン分類)・linker(埋め込み照合)の訓練/推論経路に節分割の利用がないことをgrepで確認し、結果を本書の実装状況欄に記録する(依存があれば本書のスコープを再判断)。
- **受入条件**: V2のパリティfixtureが緑(これが等価性の定義)。既存python訓練テスト(`test_whitebox_training_common`)が新規則の期待値へ更新されて緑。WX1/WX2非依存の確認記録。

### V2: 言語間パリティfixture+挙動フィンガープリント

- **意図**: 「JSとpythonの節割りが同一」を宣言ではなく**継続検証**にする。R2(train/serve等価)の言語間版。
- **具体実装**:
  - `data/tests/fee-clause-segmentation/parity-cases.json` を新設: `[{ name, lineId, text, expectedClauses: [{text, charStart, charEnd, sentenceIndex, parentheticalDepth, separatorAfter}] }]`。
  - 収録ケース(最低限): 括弧入り実施+結果予定(1005の「静脈採血を施行（HbA1c・腎機能・電解質を確認予定）」)/小数点(「複管8.0mm、カフ圧確認」)/governing prefix時制系(「本日、採血を実施」「前回、X線撮影」)/**governing prefix所有・出所系(「他院、CT施行」「持参、健診結果」「外部資料、心電図所見」)**/バイタル列挙(「BP 120/74、P 78 整、SpO2 98%、体温 36.5℃」)/入れ子括弧/全角半角混在/CRLF・改行/空文字・句読点のみ/文末記号連続(「!?」)/括弧内に文末記号。
  - **JSテスト**(`packages/fee-contracts/test/`)と**pythonテスト**(`python/tests/`)の両方が**同じJSONファイル**を読み、全フィールド一致をassertする。
  - **挙動フィンガープリント**: 全ケースの分割結果を正規化JSON化してsha256を計算し、`fee-evidence-clause-v2` に対応する期待hashを**fixture内に固定**する。両言語のテストが「(自分の実装の出力hash)==(fixtureの期待hash)」をassert——**将来どちらかの実装だけを変えると、バージョン文字列を上げてhashを更新しない限り両言語のテストが落ちる**。
- **受入条件**: 両言語のテストが同一fixtureで緑。片側の分割規則を故意に1文字変えると両言語で検出される(開発時確認)。

### V3: `fee-evidence-clause-v2` への昇格(履歴を書き換えない)

- **意図**: 挙動が変わったのだから宣言を上げる。ただし**既存artifactの意味記録は改変しない**。
- **具体実装**:
  - `whitebox_context.py` に **`CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION = 4`** を新設し、`CONTEXT_INPUT_SEMANTICS[4]` を `textScope: line_with_governing_clause` / `clauseSegmentationVersion: "fee-evidence-clause-v2"` で定義。**既存エントリ1〜3(v1宣言)は歴史的記録としてそのまま残す**(旧artifactのmanifestが参照するため)。`RUNTIME_CONTEXT_INPUT_SEMANTICS` は4を指す。
  - JS側 `WHITEBOX_CONTEXT_INPUT_SEMANTICS`(`whitebox-extraction.js:11-18`)の `clauseSegmentationVersion` を v2 へ。
  - **バージョン定数の単一ソース化**: v2文字列は共有splitterモジュール(JS: `clinical-predicates.js`、python: `clause_segmentation.py`)が `CLAUSE_SEGMENTATION_VERSION` としてexportし、宣言側はそれを参照する(splitterと宣言が別ファイルで乖離する余地を消す)。
  - 訓練側(`build_wx3_context_artifact.py` / `whitebox_training_common.py`)は新規製造のmanifestに input contract 4 を記録する。
- **受入条件**: JS/python両方の宣言が共有定数由来であることのテスト。既存v3 artifactのmanifest(**契約1・`inputSemantics`なし**)が無改変。

### V4: 照合ゲートのreadiness昇格(不一致=レーンdegrade)

- **意図**: 既存の `_validate_item_input_semantics`(`whitebox_context.py:291-294`)は項目単位の照合で、不一致は実行時エラーになる。これを**レーン有効化前のreadinessチェック**に昇格し、不一致時は例外ではなく「そのレーンをoff+理由コード」に落とす(shadow計測の他レーンを巻き込まない)。
- **具体実装**:
  - JSランタイム(whitebox-extraction.js のモード解決)で、ロードしたcontext artifactのmanifestとランタイム自身の契約を照合。不一致なら contextレーンを `off` に降格し、**理由コードを3種に区別**して `whiteboxRuntimeModes` 診断・readyz・shadow行列レポートに出す(2026-07-30 外部レビュー反映):
    - `context_input_contract_version_mismatch` — `inputContractVersion` がランタイム要求(4)と不一致
    - `clause_segmentation_version_missing` — manifestに `inputSemantics`(節分割宣言)が存在しない(**既存v3 artifactはこのケース**。契約1・宣言なし)
    - `clause_segmentation_version_mismatch` — 宣言は存在するがバージョン不一致
  - python側artifactローダ(`whitebox_artifacts.py` / `whitebox_context.py:106-`)にも同一照合・同一理由コードを実装(製造・評価ハーネスが旧artifactをv2ランタイムで誤使用することを防ぐ)。
  - 既存の項目単位検証は防御の最終層として残す。
- **受入条件**: **実物の既存v3 artifact(契約1・`inputSemantics`なし)**+v2ランタイムのfixtureで、例外ではなくレーンdegrade+`clause_segmentation_version_missing`(契約照合を先に評価する実装なら `context_input_contract_version_mismatch`。どちらを先に出すかを実装で確定しテストで固定)になる。契約4・v2宣言のartifactでは従来どおり動作。宣言ありバージョン違いのfixtureで `clause_segmentation_version_mismatch`。readyzに理由が出る。

### V5: WX3 artifactのv2再製造

- **意図**: v2節割りで分類器入力を作り直し、訓練/推論を同一分布に戻す。
- **前提(2026-07-30 外部レビュー反映)**: 現行ビルダーの `--input-contract-version` はchoices=(1,2,3)・**既定値=契約1**(`build_wx3_context_artifact.py:804-812`)。**choicesに4を追加する**(V3の `CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION` を参照)。**既定値は後方互換のため契約1のまま**とし、暗黙に4へ変えない——契約4は必ず明示指定。
- **具体実装**(コマンド列。license系引数は直近v3製造時と同一値を使う——値は前回製造レポート `python/data/whitebox/context-wx3-multilingual-minilm-l12-v3/` のmanifest参照):
  1. `python3 scripts/build_wx3_context_artifact.py --base-model <v3製造時と同一> --model-revision <同> --license <同> --license-source-url <同> --license-verified-at <同> --artifact-version context-wx3-multilingual-minilm-l12-v4 --input-contract-version 4 --output-dir python/data/whitebox/context-wx3-multilingual-minilm-l12-v4`(dataset/counterexamplesは既定値=現行E2系列。**epochs等のハイパラはv3と同一に固定**。ただし2節のとおり本移行は複合(契約1→4+入力表現+節分割)であり、ハイパラ固定は「訓練条件を無用に増やさない」ためであって「差分が節分割のみ」を意味しない)
  2. 決定論プローブ(2回実行バイト一致)と較正レポート(max-risk 0.05 / dangerous FP 0.01)の合格を確認
  3. GCSへimmutable upload(sha256検証、artifactVersion=v4)
  4. STGのruntime featureプロファイル(`configs/runtime-feature-profiles/stg-whitebox-*.env`)のcontext artifact versionをv4へ更新(**profileの明示変更として行う**。フラグ落ち事故の轍を踏まない)
- **受入条件**: manifestが input contract 4 / v2宣言を持つ。決定論プローブ合格。v4 artifact+v2ランタイムでV4の照合ゲートを通過。

### V6: ゲート一式+v2新基線

- **意図**: 統一後の状態を全ゲートで確定し、以後の白箱計測の基準点を張り直す。
- **具体実装**:
  1. ローカル: V2パリティ・白箱ランタイムテスト・R2等価ゲート・`test_whitebox_runtime`・fee-api全テスト
  2. gold gate 2系統(seed-300 / v2 exact 138)+抽出安定性ゲート(共有述語・節分割はエンジン挙動に触るため必須)
  3. STG shadowスモーク(3レーン)を実施し、`docs/2026MMDD-whitebox-clause-v2-baseline/` に**v2基線**として記録。レポート冒頭に「00196〜00198とは**複合移行(input contract 1→4+入力表現+節分割v2)**のため数値比較不可(historical)」を明記
  4. v2基線のWX3層別(abstain/unresolved件数)を新基準点として記録する。**旧基線との差を節スコープ改善の寄与として解釈しない**(複合移行のため寄与分解不可。2節参照)。以後のT系改善はこのv2基線からの差分で測る
- **受入条件**: 全ゲート緑。v2基線docsが作成され、旧計測のhistorical扱いが明記されている。

## 4. 再発防止の要約(このワークオーダーが構造的に閉じるもの)

| 層 | 機構 | 効果 |
| --- | --- | --- |
| 実装 | バージョン定数を共有splitterモジュールが単一ソースでexport(V3) | 宣言とsplitter実装の乖離余地を消す |
| テスト | 言語間パリティfixture+挙動フィンガープリント(V2) | どちらかの実装だけ変えると両言語で即fail |
| ランタイム | artifact vs ランタイムの節分割バージョン照合→degrade+理由コード(V4) | 旧artifactの誤使用・片側変更のデプロイを構造的に遮断 |

これで「テスト緑のまま精度だけ崩壊」クラス(4連発)のうち、節分割起因のものは宣言・検証・実行の3層で再発不能になる。

## 5. 非対象

- WX1(span)・WX2(linker)の再製造(節分割非依存をV1で確認。依存が見つかった場合のみ再判断)
- 白箱モードの昇格判断(route/assist化はT系・holdout三重解錠の条件のまま)
- 主経路(OpenAI主経路)の変更(G1は本ワークオーダーと独立に完結済み)

## 6. 実装状況(2026-07-30)

### 完了

- **V1/V2**:
  - JSの共有定数 `CLAUSE_SEGMENTATION_VERSION` とPython移植
    `python/medical_fee_calculation/clause_segmentation.py` を実装。
  - 17ケースの共通fixtureと挙動fingerprint
    `4ea93917ccc63d68e98c360267f2bdf0e28428dc7d48fbe2584ef16d6a935018`
    をJS/Python両方で検証。
  - 契約3を明示して歴史的artifactを再製造する場合だけ旧v1 splitterを選び、
    契約4では共有v2 splitterを選ぶ。これにより既存契約1〜3の意味記録を
    書き換えない。
  - WX1/WX2の製造・推論経路を
    `splitClinicalEvidenceClauses|split_context_clauses|clause_segmentation`
    で検索し、参照0件を確認。WX1/WX2の再製造は不要。
- **V3/V4**:
  - input contract 4と`fee-evidence-clause-v2`を追加し、runtime要求を4へ昇格。
  - JS/Python双方でartifact互換性を有効化前に検査する。理由コードの優先順位は
    contract version mismatchを先に固定したため、既存v3 artifact
    (contract 1・semanticsなし)は
    `context_input_contract_version_mismatch`となる。
  - 不一致時はAPI全体を落とさずcontextレーンだけを`off`にし、
    `readyz`・performance trace・STG shadow集計へ理由コードを出す。
  - 項目単位の`inputSemantics`検証も最終防御として維持。
- **V5**:
  - `wx3-multilingual-minilm-l12-v4`をcontract 4で再製造。
  - v3と同じモデルrevision、epochs=6、batch=8、learning rate=2e-5、
    pooling=mean、seed=17を固定。
  - semantic probe合格。ONNX決定論100回合格:
    `871faf328d01c4a13044302c8cb103ddcb0f36e097562d5770af2447b7addd56`。
  - artifact verify合格。manifest SHA-256:
    `0f093802472d6c36dfc3c38f8d088fe31b72f4314737430d205a85e4e34ce623`。
  - 全5軸がrisk 0.05以下、dangerous false positive rate 0.01以下。
    詳細は
    `docs/whitebox-artifact-builds/wx3/wx3-multilingual-minilm-l12-v4/`。
  - GCSへimmutable upload済み:
    `gs://halunasu-fee-stg-artifacts/whitebox/fee_context_classifier/wx3-multilingual-minilm-l12-v4/manifest.json`。
  - contextを有効化する`stg-whitebox-three-lane-shadow`と
    `stg-full-validation`の両profileをv4へ更新。

### ローカル検証結果

- fee-contracts: 32/32
- fee-api: 416/416
- fee-api server: 155/155
- whitebox builders: 46/46
- whitebox runtime: Node 59/59、言語間input contract 20ケース/68 item、
  Python 40件(ONNX依存7件skip)
- whitebox ops: Node 24/24、Python 36/36
- seed-300 engine gold: exact 150/150
- fee-soap-e2e-v2 engine gold: exact 138/138
- extraction stabilityロジック: 5/5
- runtime readiness(v4実artifact): available、semantic probe、決定論2回すべて合格

### 未完了

- 更新profileでのSTG Cloud Runデプロイ。
- STGの抽出安定性実測(MFAが必要)。
- 3レーンshadowのSTG新基線取得と
  `docs/2026MMDD-whitebox-clause-v2-baseline/`への記録。
- 旧00196〜00198との数値比較は行わない。新基線には
  「contract 1→4、入力表現、節分割v2の複合移行で比較不可」と明記する。
