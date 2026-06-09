# 診療報酬算定 SOAP E2E 網羅性拡張計画

作成日: 2026-06-08

## 目的

診療報酬算定アプリのテストデータを、現在の外来内科中心の300件から、全診療科・主要算定章・未対応領域・安全系に近い網羅性を持つデータセットへ拡張する。

ここでいう「網羅性」は、医科診療報酬マスターの全コードを1件ずつ網羅する意味ではない。  
実際のプロダクト品質を守るため、次の軸を層化して代表ケースを持つことを意味する。

- 診療科
- 外来、入院、在宅、救急
- 診療報酬点数表の主要章
- exact、review_required、safety、unsupported_expected
- 否定文、予定、過去歴、他院実施、家族歴、複数日記録
- 医療事務レビュー前とレビュー後の状態

## Canonical Files

- SOAP E2E正本: `data/tests/fee-soap-e2e/fee-soap-e2e-cases.json`
- 点数Gold正本: `data/tests/fee-gold/cases/seed-300/fee-chart-gold-seed-300.json`
- 網羅性ターゲット: `data/tests/fee-soap-e2e/coverage-targets.json`
- 監査スクリプト: `scripts/audit_fee_soap_e2e_coverage.mjs`

監査は次で実行する。

```bash
npm run audit:fee-soap-coverage
```

レポートは `data/tests/fee-soap-e2e/reports/coverage-latest.md` と `coverage-latest.json` に出る。  
`reports/` は生成物なのでgit管理しない。

## 現状ASIS

現行300件は、診療科と診療領域に大きな偏りがある。

| 観点 | 現状 |
| --- | --- |
| 総件数 | 300 |
| exact | 150 |
| review_required | 96 |
| safety | 19 |
| unsupported_expected | 28 |
| split_required | 3 |
| 外来 | 280 |
| 入院 | 16 |
| 在宅/訪問 | 4 |

診療科別:

| 診療科 | 件数 | 判定 |
| --- | ---: | --- |
| internal_medicine | 232 | 多すぎる。内科サブ領域へ分解したい |
| dermatology | 49 | ある程度あり |
| pediatrics | 13 | 不足 |
| psychiatry | 2 | ほぼ未カバー |
| surgery | 2 | ほぼ未カバー |
| orthopedics | 1 | ほぼ未カバー |
| rehabilitation | 1 | ほぼ未カバー |
| otolaryngology / ophthalmology / obgyn / urology / cardiology / gastroenterology / respiratory / neurology / emergency / nephrology_dialysis / homecare / radiology / pathology | 0 | 未カバー |

現行データで強い領域:

- 初診料、再診料
- 検体検査、D026判断料、採血
- 感染症迅速検査、尿検査、血液検査、CRP、HbA1c
- 一部投薬、外用薬、一般名処方
- 熱傷処置、創傷処置
- CT、単純X線、一部画像加算
- 急性期一般入院料1
- 否定文、予定のみ、過去実施、他院実施、家族歴の一部

現行データで弱い領域:

- 耳鼻科、眼科、整形外科、外科、産婦人科、泌尿器科、精神科、リハビリ、救急、透析、在宅
- 手術、麻酔、病理、内視鏡、放射線治療、特定器材、輸血
- DPC本算定
- 入院料の種類、病棟、転棟、食事、入院中包括
- 小児科の加算、休日/時間外、体重用量、保護者説明
- 施設基準と届出が絡むケース

## TOBE

最初の到達目標は、600件以上。推奨は800件。

| 種別 | 目標 |
| --- | ---: |
| total | 600以上、推奨800 |
| exact | 250以上 |
| review_required | 180以上 |
| safety / unsupported / split | 120以上 |

## 2026-06-08 実装結果

SOAP E2E正本 `data/tests/fee-soap-e2e/fee-soap-e2e-cases.json` は、300件から800件へ拡張済み。

| 種別 | 件数 |
| --- | ---: |
| total | 800 |
| exact | 268 |
| candidate_presence | 4 |
| review_required | 356 |
| safety | 59 |
| unsupported_expected | 100 |
| split_required | 13 |

追加500件は `COV-...` のcaseIdを持つ。全診療科の最低件数、推奨800件、主要算定領域の件数目標は概ね満たした。  
透析/輸血、内視鏡、注射、特定器材/材料、病理、救急、脳神経、放射線、在宅、精神、リハビリなど、旧300件で薄かった領域を重点的に補った。

2026-06-08の追加修正で、次のデータ品質問題を解消した。

- DPC名義のexactケースで急性期一般入院料1を出来高確定する自己矛盾を撤去。
- COV-L1-416〜418は `dpc_inpatient` ではなく `inpatient_basic` とし、DPCレビューとは分離。
- 旧形式のカテゴリ語の禁止候補を `条件未確認の処置` などの正規化ラベルへ変更。
- `forbiddenCandidates` から raw status phrase を排除し、禁止理由は `requiredReviewTopics` に寄せた。
- exactケースの請求対象と禁止候補が衝突しないことをバリデータで確認するようにした。

この修正により、監査上のexactギャップは一部増えた。これは手術、麻酔、病理、リハビリ、精神科専門療法、在宅、材料、透析/輸血、内視鏡などを無理にexact化しないためで、現時点では正しい制約として扱う。

検証結果:

```bash
npm run test:fee-soap-e2e
# ok: true, cases: 800, minChars: 637

npm run eval:fee-soap-e2e -- --assertion exact --use-expected-claim-context --output-prefix local-exact-claim-context-after-forbidden-normalization
# selected: 268, passed: 268, failed: 0, passRate: 100%
```

生成レポート:

- `data/tests/fee-soap-e2e/reports/coverage-latest.md`
- `data/tests/fee-soap-e2e/reports/local-exact-claim-context-after-forbidden-normalization.md`

残る監査ギャップは、件数不足ではなく品質ステージの不足が中心。特に手術、麻酔、病理、リハビリ、精神科専門療法、在宅、材料、透析/輸血、内視鏡などは、現時点では `review_required` / `unsupported_expected` / `safety` として持ち、医療事務レビューやエンジン対応が進んだ段階で `exact` に昇格する。

診療科別の最低目標:

| department | label | min |
| --- | --- | ---: |
| internal_medicine | 総合内科・一般内科 | 80 |
| pediatrics | 小児科 | 30 |
| dermatology | 皮膚科 | 30 |
| otolaryngology | 耳鼻咽喉科 | 20 |
| ophthalmology | 眼科 | 20 |
| orthopedics | 整形外科 | 25 |
| surgery | 外科 | 25 |
| psychiatry | 精神科 | 20 |
| rehabilitation | リハビリテーション科 | 15 |
| obgyn | 産婦人科 | 20 |
| urology | 泌尿器科 | 20 |
| cardiology | 循環器内科 | 20 |
| gastroenterology | 消化器内科 | 20 |
| respiratory | 呼吸器内科 | 20 |
| neurology | 脳神経内科・脳神経外科 | 15 |
| emergency | 救急 | 15 |
| nephrology_dialysis | 腎臓内科・透析 | 15 |
| homecare | 在宅医療 | 15 |
| radiology | 放射線科 | 10 |
| pathology | 病理診断 | 10 |

算定領域別の最低目標:

| domain | 内容 | min |
| --- | --- | ---: |
| basic | 基本診療料 | 120 |
| medical_management | 医学管理等 | 60 |
| homecare | 在宅医療 | 25 |
| lab | 検査 | 120 |
| imaging | 画像診断 | 60 |
| medication | 投薬 | 80 |
| injection | 注射 | 25 |
| rehab | リハビリ | 20 |
| psychiatry | 精神科専門療法 | 20 |
| procedure | 処置 | 60 |
| surgery | 手術 | 30 |
| anesthesia | 麻酔 | 15 |
| radiation_therapy | 放射線治療 | 10 |
| pathology | 病理診断 | 20 |
| dpc_inpatient | 入院・DPC | 20 |
| emergency_time_addons | 救急・時間外・休日・深夜 | 20 |
| pediatric_addons | 小児加算・小児特有 | 20 |
| facility_standards | 施設基準・届出 | 40 |
| safety_negation | 否定文・予定・過去歴・他院実施 | 40 |
| split_multi_day | 複数日記録・月内履歴・分割 | 15 |
| materials | 特定器材・材料 | 15 |
| dialysis_transfusion | 透析・輸血 | 20 |
| endoscopy | 内視鏡 | 15 |

## 作成ルール

### 1. 全部を exact にしない

現時点で未対応の領域は、無理に点数化しない。  
手術、麻酔、病理、リハビリ、精神科専門療法、在宅、DPC本算定は、最初は `unsupported_expected` または `review_required` でよい。

目的は「できないことをできると言わない」ことも含む。

### 2. 診療科ごとに最低4種類を持つ

各診療科は最低限、次を持つ。

- exact
- review_required
- safety
- unsupported_expected または split_required

例: 耳鼻科なら、外耳道処置、溶連菌/インフル検査、抗菌薬不要の否定文、鼓膜切開などの未対応/要レビューを持つ。

### 3. 算定章ごとに安全ケースを持つ

算定できるケースだけでなく、拾ってはいけないケースを必ず持つ。

- 予定のみ
- 前回実施
- 他院実施
- 家族歴
- 説明だけ
- 未実施
- 矛盾記載
- DPCと出来高の混在

### 4. 医療事務レビュー前は production gold にしない

追加データは最初は `draft` または `master_verified` にする。  
医療事務レビュー後に `office_reviewed`、CI固定後に `ci_enabled` へ上げる。

## 追加作成の優先順

### Batch A: 診療科の空白を埋める 150件

最優先は診療科の偏りをなくすこと。

| department | 追加目安 |
| --- | ---: |
| otolaryngology | 20 |
| ophthalmology | 20 |
| orthopedics | 24 |
| surgery | 23 |
| psychiatry | 18 |
| rehabilitation | 14 |
| obgyn | 20 |
| urology | 20 |

### Batch B: 算定章の空白を埋める 150件

| domain | 追加目安 |
| --- | ---: |
| injection | 20 |
| homecare | 20 |
| rehab | 15 |
| psychiatry | 18 |
| surgery | 25 |
| anesthesia | 12 |
| pathology | 17 |
| radiation_therapy | 10 |
| materials | 15 |
| dialysis_transfusion | 18 |
| endoscopy | 15 |

### Batch C: 安全・境界・複数日 100件

- 否定文/予定/過去歴/他院実施: +25
- 施設基準/届出不足: +20
- 月内履歴/同月算定: +15
- DPC/入院出来高混在: +12
- 小児/時間外/休日/深夜: +15
- 複数日SOAP/同一カルテに複数診療日: +13

### Batch D: exact昇格 100件

医療事務レビューまたは明示 claimContext で点数を確定できるものを exact にする。

優先:

- 検査
- 画像
- 投薬
- 処置
- 初再診/加算
- 一部医学管理

## 監査の読み方

`npm run audit:fee-soap-coverage` は次を出す。

- 診療科ごとの不足
- 算定領域ごとの不足
- 診療科 x 算定領域の空白セル
- exact不足
- safety/unsupported不足

例:

```text
Top department gaps:
- ophthalmology: cases 0/20, exact 0/8, safety 0/4

Top domain gaps:
- radiation_therapy: cases 0/10, exact 0/2, safety 0/6

Top department-domain gaps:
- ophthalmology x imaging: 0/8
```

新規ケース作成後は、必ず次を通す。

```bash
npm run test:fee-gold
npm run test:fee-soap-e2e
npm run audit:fee-soap-coverage
```

必要に応じて次も使う。

```bash
npm run eval:fee-soap-e2e -- --assertion exact --use-expected-claim-context
npm run eval:fee-soap-e2e -- --assertion safety
npm run eval:fee-soap-e2e -- --assertion unsupported_expected
```

## 注意点

- 現在の300件は医療事務レビュー前。実運用の正解データとして扱わない。
- 生成ケースは合成データに限る。実患者カルテや書籍本文を転載しない。
- 未対応領域は「候補化しない/レビューへ送る」ことを正解にする。
- `expectedExtraction.forbiddenCandidates` は、危険な候補が出ないことを確認するための重要フィールドとして必ず入れる。
- exactを増やすときは、`expectedClaimContext` と `expectedCalculation` の再現性を先に確認する。
