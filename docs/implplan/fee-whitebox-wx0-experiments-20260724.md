# WX0: 実証実験と評価マトリクス (2026-07-24)

親: [白箱抽出エンジン計画](./fee-whitebox-extraction-plan-20260724.md)

## 意図

実装前に「この路線で何%取れるか」の地図を作る。以降のWX1〜WX4の全判断
(モデル選定・FT要否・ルーティング閾値)はこの地図を物差しにする。
逆に言えば、WX0の数字なしにエンコーダ路線へ投資しない。

## 実装状況 (2026-07-24)

WX0の**測定基盤**まで実装済み。モデル精度の実測とWX0完了判定は未実施。

- 完了:
  - JavaScript実行契約から5軸enumを
    `packages/medical-core/generated/clinical-axes.schema.json`へ決定論生成。
    Pythonは`medical_fee_calculation.clinical_axes`からこの生成物だけを読む。
  - `data/tests/fee-specialty-matrix/`へ8科 x 4区分、各10件・holdout 2件以上の
    matrix v3契約を追加。
  - Unicodeコードポイントoffset、5軸、category、template split、
    holdout provenance、合成データ限定を検証するバリデータを追加。
  - 通常検証は構造不正を止め、`--strict`はセル不足も止める。現時点は
    **0/320件・0/32セル**なのでstrict失敗が正しい。
  - 既存v2合成カルテから人手annotation queueを作る補助ツールを追加。
    現在のv2では349件を初期8科・対象settingのannotation候補へ変換できるが、
    suggestionはgoldへ自動昇格しない。
  - span IoU、precision/recall/F1、linking Recall@1/5・MRR、
    軸別macro-F1・abstain coverage-risk・危険方向FP、ECE、
    p50/p95を共通計算する評価器を追加。
  - マスタの点数表区分からGLiNERの閉集合entity type artifactを生成。
  - GLiNER、Ruri/exact-alias、5軸決定論ベースライン、1/10/40/80並行HTTP負荷の
    実験ランナーを追加。モデルID・immutable revision・ライセンスを結果に固定する。
- 未完了:
  - 320症例の本文作成とexpected spanの人手確認。
  - GLiNER/Ruri/ModernBERT-Jaの実モデル実測。
  - E6の構成(a)〜(d)比較とCloud Run上の常駐メモリ実測。
  - 実測に基づく分岐決定。したがってWX2以降の製品経路はまだ開始しない。

主なコマンド:

```bash
npm run build:fee-clinical-axes
npm run build:fee-whitebox-entity-types
npm run test:fee-specialty-matrix
npm run test:fee-specialty-matrix:strict
npm run prepare:fee-specialty-matrix -- --output /private/tmp/fee-specialty-annotations.json
```

## E1. ライセンス・利用可否の確認(最初に。推測禁止)

以下を一次情報(モデルカード・LICENSE・利用規約)で確認し、結果を本ページに
出典付きで追記してから実験を始める:

- GLiNER系(urchade/gliner_multi 等)と派生モデルのライセンス(Apache-2.0系が多いが個別確認)
- cl-nagoya/ruri-v3 系(モデルカードのライセンス欄)
- sbintuitions/modernbert-ja 系
- MedNER-CR-JA / MedTxt系コーパス(**研究利用限定の可能性が高い**。商用不可なら
  評価参考のみに留め、訓練には使わない)
- UTH-BERT(利用許諾条件)

商用利用不可のものは代替(自社合成データでのFT)へ切り替える。判断は表にして残す。

### E1確認結果 (2026-07-24)

| 候補 | 一次情報上の条件 | 製品・商用評価での扱い |
| --- | --- | --- |
| `urchade/gliner_multi` | CC BY-NC 4.0 | **不採用**。非商用条件のため製品評価にも使わない |
| `urchade/gliner_multi-v2.1` | Apache 2.0 | **採用候補**。multilingualの主比較対象 |
| `Ihor/gliner-biomed-small-v1.0` / `base-v1.0` | Apache 2.0 | **採用候補**。ただし英語中心のため日本語性能はE3でのみ判断 |
| `cl-nagoya/ruri-v3-{30m,70m,130m,310m}` | Apache 2.0 | **採用候補**。E4では30mから実測し、サイズを段階比較 |
| `cl-nagoya/ruri-reranker-base` / `ruri-v3-reranker-310m` | Apache 2.0 | **採用候補**。E4のtop-k再順位付け有無を比較 |
| `sbintuitions/modernbert-ja-*` | MIT | **採用候補**。WX3のベースモデル候補 |
| `sociocom/MedNER-CR-JA` | CC BY 4.0 | モデル比較には利用可能。帰属表示をアーティファクトmanifestへ残す |
| MedTxt-CR / MedTxt-RRコーパス | 配布元への申請が必要。J-Stage利用規約・著作権上、公開配布されていない | **訓練不採用**。個別許諾を得るまで評価・訓練データへ取り込まない |
| UTH-BERT | 公開ページ上の配布リンクとCC BY-NC-SA 4.0記載が取り消し線・deprecated | **不採用**。現時点で利用可能な許諾済みアーティファクトを確認できない |

一次情報:

- GLiNER v2.1モデルカード: https://huggingface.co/urchade/gliner_multi-v2.1
- GLiNER-BioMedモデルカード: https://huggingface.co/Ihor/gliner-biomed-small-v1.0
- Ruri v3モデルカード: https://huggingface.co/cl-nagoya/ruri-v3-30m
- Ruri rerankerモデルカード: https://huggingface.co/cl-nagoya/ruri-v3-reranker-310m
- ModernBERT-Jaライセンス: https://huggingface.co/sbintuitions/modernbert-ja-130m/blob/main/LICENSE
- MedNER-CR-JAモデルカード: https://huggingface.co/sociocom/MedNER-CR-JA
- MedTxt-CR配布条件: https://sociocom.naist.jp/medtxt-en/cr/
- UTH-BERT公式ページ: https://ai-health.m.u-tokyo.ac.jp/home/research/uth-bert

判断はモデルIDとrevisionをmanifestへ固定した時点で再確認する。モデルカードの
ライセンス表示だけで、学習元データの追加条件まで自動的に安全とはみなさない。

## E2. 評価コーパス: 診療科×受診区分マトリクス

既存資産を拡張する。ゼロから作らない:

- 基盤: `data/tests/fee-soap-e2e-v2/`(gold-blueprints.json / coverage-matrix-v2.json /
  style-spec.md、生成は `scripts/generate_fee_soap_e2e_v2_blueprints.mjs`)
- 拡張仕様:
  1. blueprintの軸に `specialty`(内科/皮膚科/整形外科/小児科/耳鼻咽喉科/眼科/
     精神科/外科 の初期8科)と `encounterSetting`(outpatient/home_visit/
     house_call/telephone)を追加し、`coverage-matrix-v2` を科×区分の
     セル充足率で管理する(既存matrixの拡張。v3として別ファイル)。
  2. 各セル最低10ケース・期待claimContext付き。科別の記載習慣
     (皮膚科の部位・処置面積、整形の部位・左右、小児の年齢文脈、
     耳鼻の処置名略記等)は `style-spec.md` に科別セクションとして追記し、
     生成プロンプトに反映する。
  3. **span/リンク正解の付与**: blueprintは期待コードを持っているので、
     生成時に「期待コードに対応する本文中の表現(スパン文字列)」も同時に
     出力させ、ケースに保存する。ラベル軸は**既存契約のenumをそのまま使う**
     (WX3と同一。共有定数から生成し、文書内で軸を再発明しない):
     ```
     expectedSpans: [{text, code, category,
       actionStatus,       // ACTION_STATUSES (performed/prescribed/.../not_performed/unknown)
       temporalRelation,   // TEMPORAL_RELATIONS (current_visit/same_day_but_unknown/past/future/unknown)
       sourceOrigin,       // SOURCE_ORIGINS (own_clinic_record/patient_reported/...)
       providerOwnership,  // PROVIDER_OWNERSHIPS (own_clinic/other_provider/...)
       standingStatus}]    // standing_mentions.status (continued/changed/stopped) | none
     ```
     enumの正は `packages/medical-core/src/fee/openai-fee-clinical-facts.js` を
     エクスポート+JSON生成物化し(WX3参照)、blueprint生成・検証は
     その生成物を読む(値の重複定義禁止)。
- 全て合成データ。実カルテは使わない。
- **評価リーク対策(P2指摘反映)**: 本文と正解spanを同じ生成処理で作ると
  評価が自己充足的に簡単になる。対策を必須にする:
  1. expectedSpansの文字オフセットを機械検証(本文に実在し境界が語単位)。
  2. splitは**テンプレート単位**(同一テンプレート由来のケースが訓練と評価に
     跨らない)。
  3. holdoutは**別の生成系**(別モデルまたは別プロンプト系統)で作るか、
     人手確認済みケースに限定する。holdout成績を主指標にする。

成果物: `data/tests/fee-specialty-matrix/`(ケース+matrix+README)。
生成・検証スクリプトはe2e-v2と同型(`generate_*` / `validate_*`)。

## E3. 実験1: ゼロショットspan検出の実測

- 対象モデル(各々同条件で):
  1. GLiNER multilingual系(小型/中型)
  2. GLiNER-BioMed(英語系だが多言語転移の確認として)
  3. 参考ベースライン: 現行LLM(v15)のline_review/イベントspan
- エンティティタイプはマスタから機械生成: `medical_procedures.judgement_kind` と
  点数表区分から「処置/手術/検査/画像/注射/投薬/リハビリ/精神療法/管理料/文書/
  機器・材料」等の閉集合(日本語ラベル+短い定義文。GLiNER2のdef形式)。
- 指標(E2コーパスのexpectedSpansに対し、科×区分セル別):
  - span recall(部分一致=文字オフセット重なりで判定。閾値0.5)
  - span precision
  - **決定論性: 同一入力20回で出力完全一致率(100%が要件。エンコーダなら自明だが
    ランタイム設定の検証を兼ねる)**
  - 推論時間/カルテ
- 実装: `python/experiments/wx0_span_zeroshot.py`(実験コードはexperiments配下、
  製品コードに混ぜない)。結果は `docs/202607xx-wx0-span-zeroshot/README.md` に
  セル別ヒートマップ(md表)で保存。

## E4. 実験2: マスタ照合(リンキング)の実測

- 照合対象: `standard-master.sqlite` の `medical_procedures`(11,746件)、
  `drugs`(18,495件)、`diseases`(27,684件)。
- インデックス構築: 各コードの正式名称・短縮名・かな・既存name_scanの
  alias展開(`python/medical_fee_calculation/name_scan.py:156- _scan_aliases`)を
  文書として埋め込む。
- 対象モデル:
  1. cl-nagoya/ruri-v3(30m/130m/310mの3サイズ)
  2. ベースライン: 現行name_scan(完全一致+alias)
  3. リランカー(ruri-reranker)の有無での比較
- Ruri v3の入力prefixはモデルカードどおり`検索クエリ: ` /
  `検索文書: `を使用する(旧Ruriの`クエリ: ` / `文章: `と混同しない)。
- クエリ: E2コーパスのexpectedSpans本文表現(+実測で集めた表記揺れ:
  略語「胃カメラ」「エコー」「サチュレーション」、カナ、送り仮名違い等を
  評価用に合成)。
- 指標: recall@1 / recall@5 / MRR、コード種別(行為/薬剤/病名)別、
  現行name_scanが取れない表現での改善幅(ここが本命の数字)。
- 実装: `python/experiments/wx0_linking.py`。

## E5. 実験3: 文脈判定のベースライン(第2改訂: 多軸へ統一)

- **WX3と同一の多軸**(actionStatus / temporalRelation / sourceOrigin /
  providerOwnership / standingStatus。既存契約enumそのまま)で評価する。
  旧5値は廃止。
- 比較対象: 既存の決定論述語(`clinical-predicates.js` 相当の正規表現群)、
  ゼロショットLLM、小型エンコーダ(ModernBERT-Ja、E2の多軸正解でFTした場合)。
- 指標: **軸別**のF1と、abstain率×残り誤り率(abstainを増やすと誤りが
  どこまで下がるかの曲線。WX1ルーティングの閾値設計に直結)。
- 正解はE2のexpectedSpans(多軸)。既存の反例テスト文
  (「中止も検討したが継続」等)を必ず評価集合に含める。

## E6. 実験4: 推論の負荷・レイテンシ特性(P1指摘反映)

現行構成は**単一常駐pythonワーカーへの直列リクエスト**
(`services/fee-api/src/python-calculator.js` ensureWorker)であり、
L1/L2/L3モデル+全探索を同期で載せると並行要求が直列待ちになる。
500ms目標は無負荷値では意味がないため、以下を実測する:

1. cold / warm 別の p50 / p95(モデルロード時間を分離計測)
2. 並行度 1 / 10 / 40 / **80**(現行Cloud Run既定 `CONCURRENCY=80`、
   `scripts/p10_deploy_runtime_services_low_cost.sh:21`)での待ち時間分布
   (Cloud Run 1インスタンス内)
3. モデル常駐メモリ(現行の`p10_deploy`のメモリ設定に収まるか)
4. 構成比較: (a)現行worker同居 (b)worker pool(N常駐) (c)リクエストバッチ化
   (d)専用推論サービス分離(同一イメージ別Cloud Run)
   — それぞれのp95と運用複雑性を表にし、親ページ決定事項5の分離判断の
   材料にする。

## 判定基準(次フェーズへの分岐)

| 結果 | 次の一手 |
| --- | --- |
| ゼロショットspan recall ≥ 70%(主要セル) | WX1をゼロショット+閾値ルーティングで開始 |
| 40〜70% | WX1はE2合成データでのFT前提に変更(GLiNER形式の訓練データをblueprintから生成) |
| < 40% | L1は保留。WX2(照合)とWX3(文脈)だけ先行し、L1はFTデータ蓄積後に再評価 |
| linking recall@5がname_scan比で+10pt以上 | WX2を即着手(どの分岐でも価値がある見込み) |

## 完了条件

- 科×区分マトリクスのセル別 span/linking/文脈 の実測地図(README)
- モデル・ライセンス判断表
- 上記分岐の決定記録(親ページの表を更新)
