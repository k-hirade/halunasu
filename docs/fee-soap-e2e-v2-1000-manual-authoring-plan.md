# Fee SOAP E2E v2 1000ケース手書き拡張計画

## 目的

v2の50件を、実カルテに近いSOAP文体を維持したまま1000種類へ拡張する。

ここでの「1000種類」は、caseIdや日付だけが違うケースではない。診療科、請求ドメイン、算定状態、施設fixture、時制/帰属/否定/予定、不足情報、ディストラクタが異なる独立シナリオを指す。

## Claudeがv2で置いた意図

- 採点用メタ文をカルテ本文から排除する。
- 点数表の正式名称をカルテ本文に埋め込まない。
- 施設基準、CT機器区分、電子画像管理などはfacility fixtureに分離する。
- exactケースでは、期待コードの根拠になる臨床アンカーを自然な文章で書く。
- review/safety/unsupportedケースでは、確認すべき理由を本文から自然に読めるようにする。
- 過去、他院、予定、否定、見送り、市販薬、家族情報などを混ぜ、単語反応では通らないケースにする。
- 医療事務レビュー前のsynthetic goldであるため、`productionGoldAllowed=false` を維持する。

## 作成方針

SOAP本文はアルゴリズムで生成しない。`sources/batch-xxx-*.mjs` に1件ずつ手書きする。

許容する自動処理は以下に限る。

- source batchの統合
- `caseTypeSignature` の計算
- chart.standardの組み立て
- validatorによる品質チェック

禁止すること。

- 既存SOAPの語句差し替えだけで新ケースにする。
- caseId、日付、患者属性だけを変えて新ケースにする。
- 正式マスター名や期待トピック名をカルテ本文に答えとして書く。
- 施設属性をカルテ本文に書く。

## バッチ計画

既存51件を土台に、残り949件を20〜25バッチで追加する。

| 範囲 | 目的 | 件数目安 |
|---|---|---:|
| batch-005〜008 | 内科系・小児・感染症・検査/投薬/基本料 | 160 |
| batch-009〜012 | 皮膚科・耳鼻科・眼科・泌尿器・婦人科 | 160 |
| batch-013〜016 | 整形・外科・救急・処置・材料・注射 | 160 |
| batch-017〜020 | 画像・放射線・消化器・内視鏡・病理 | 160 |
| batch-021〜024 | 呼吸器・循環器・神経・腎/透析/輸血 | 160 |
| batch-025〜028 | 精神科・在宅・リハ・管理料・施設基準 | 160 |
| batch-029〜030 | split/mutation/表現揺れ補強 | 89 |

## 配分目標

`coverage-matrix-v2.json` を正とする。大枠は以下。

- exact: 360
- review_required: 390
- safety: 90
- unsupported_expected: 120
- split_required: 40

## 品質ゲート

各バッチ追加後に必ず実行する。

```bash
npm run generate:fee-soap-e2e-v2
npm run test:fee-soap-e2e-v2
```

必要に応じてSTGのランダム評価を実行する。

```bash
npm run eval:fee-soap-e2e-v2:stg:random -- --count 20 --include-previous
```

## 進捗ルール

- 1バッチで品質が落ちる場合は件数を増やさない。
- exactケースはclaim contextで点数再現できるものを優先する。
- review/safety/unsupportedは、確認トピックが自然な臨床文から導けることを優先する。
- 1000件到達より、1000種類として意味があることを優先する。
