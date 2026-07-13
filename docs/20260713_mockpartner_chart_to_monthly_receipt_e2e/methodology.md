# 測定方法

## 目的

確定コード付きordersを使わず、患者1001のカルテ本文を通常のSTG算定セッションへ投入し、算定候補、患者×月の月次集計、既存UKE比較までを一つの経路として検証する。

## 入力

入力元は次の患者別データである。

`tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/1001/`

| 入力 | 用途 |
| --- | --- |
| `patients.csv` | 性別、生年月日、外部患者ID。氏名などの直接識別子は評価結果へ保存しない |
| `charts.jsonl` | 2026-06-11、2026-06-25のカルテ本文2件 |
| `RECEIPTC.UKE` | 算定完了後の比較対象。算定入力には使わない |
| `manifest.json` | 請求月 `2026-06` とファイル対応 |

データはmock HOMIS由来の合成データである。カルテ本文は結果ファイルへ保存せず、SHA-256だけを記録した。

## 情報漏洩を避けた評価条件

各算定リクエストのbodyは空オブジェクト `{}` とし、セッション作成時にカルテ本文、患者属性、受診日だけを渡した。次の情報は算定完了まで非公開にした。

- `orders.csv`
- UKEのコード、回数、点数
- `expectedClaimContext`
- テスト専用の`calculationOptions`

これにより、既存レセのコードを当社結果へそのまま再入力する循環評価を避けた。

セッションの`setting`は現行契約で許可される外来区分 `outpatient` とした。契約上の選択肢は `outpatient / inpatient` のみで、訪問診療・往診を表す値は存在しない。この制約自体を今回の評価対象に含めている。

## 実行経路

1. STG組織 `nishiyama-demo-stg` へログインする。
2. 評価実行ごとに新しい合成患者を作る。
3. カルテ2件を `POST /v1/fee/sessions` で別セッションとして作る。
4. 各セッションを `POST /v1/fee/sessions/:id/calculate` で算定する。
5. `GET /v1/fee/sessions/:id/detail` から算定候補と確認事項を取得する。
6. `GET /v1/fee/monthly-receipt` で患者×2026-06の月次明細を作る。
7. UKEをPythonの既存parserで解析し、患者IDだけ新規内部IDへ対応付ける。
8. `POST /v1/fee/baseline-diagnosis` で既存UKEと月次結果を比較する。
9. 評価スクリプト自身でもコード、回数、月合計点数を独立比較し、API結果と一致することを確認する。

## 実行条件

| 項目 | 主試験 | 既往開始日を追加した対照試験 |
| --- | --- | --- |
| Run ID | `monthly-chart-e2e-20260713052611917-f5c6e2` | `monthly-chart-e2e-20260713053611339-5592aa` |
| 実行時刻 | 2026-07-13 14:26〜14:27 JST | 2026-07-13 14:36〜14:37 JST |
| 反復 | 3 | 3 |
| STG project | `halunasu-fee-stg` | 同左 |
| Cloud Run revision | `fee-api-stg-00151-mm6` | 同左 |
| リポジトリcommit | `6c8094ad4e653077e454d9f57a84a64217fc4ed0` | 同左 |
| OpenAI model | `gpt-5.4-nano` | 同左 |
| prompt | `fee-clinical-events-v13` | 同左 |
| rules | `fee-clinical-rules-v10` | 同左 |
| master | `runtime-master-current` | 同左 |
| 施設基準キー | 0件 | 0件 |

主試験は次の評価スクリプトで再実行できる。

```bash
npm run eval:fee-monthly-chart-e2e -- --repeat 3
```

入力確認だけを行い、STGへ送信しない場合は次を使う。

```bash
npm run eval:fee-monthly-chart-e2e -- --dry-run
```

評価スクリプトはSTGホストと末尾が `-stg` の組織だけを許可する。PRODへは実行できない。

## 対照試験

`--seed-known-prior-history` では、推測した日付やコードを作らず、`patients.csv.start_date` の `2019-04-20` だけを未算定の既往セッションとして追加した。

```bash
npm run eval:fee-monthly-chart-e2e -- --repeat 3 --seed-known-prior-history
```

結果は主試験と同じ371点だった。履歴検索は最大12か月で、算定判断用履歴は過去セッションの確定明細から構築される。そのため、7年以上前の開始日だけを追加しても初診・再診判定や在宅算定の根拠にはならない。

## 品質判定

患者・請求月・診療行為コード単位で次を比較した。

1. コードの有無
2. コードごとの算定回数
3. コードごとの月合計点数
4. 患者の月合計点数
5. 3回の候補明細、月次明細、確認事項の安定性

全UKEコード再現率に加え、「実際に渡したカルテ・患者・施設情報だけで算定要件を満たせる項目」の分母を別に評価した。後者は今回0件であり、精度はN/Aとした。

## 性能測定

クライアント時間はNode.js `fetch` の開始からレスポンス本文読込完了までを計測した。Cloud Run時間は同じeval run IDを持つ `fee.calculate.performance` ログ6件と突合した。

算定時間の中央値は偶数件の中央2値の平均で算出した。Cloud Runの初回Python算定6,560msは残し、定常時比較用に初回除外値も併記した。

## 制約

1. 合成患者1人、2受診の試験であり、全診療領域の精度を示さない。
2. 既存UKEが医学的・請求上の最終正解であることを保証する試験ではない。
3. 現在の受診区分、同一建物区分、施設基準、直近の外部請求履歴が入力にない。
4. 確認事項の件数はOpenAI抽出により揺れた。
5. 評価で作成した患者・セッションはSTGに残る。PRODデータは作成していない。
