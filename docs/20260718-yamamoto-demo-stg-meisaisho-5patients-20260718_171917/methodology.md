# 測定方法

## 対象

- 最終実行日時: 2026-07-18 17:40-17:44 JST
- Platform API / Fee API: STG
- 組織: `yamamoto-demo-stg`
- ログイン: `yamamoto-clerk`
- 対象患者: `1001 / 1004 / 1006 / 1007 / 1012`
- 請求月: 2026-06
- 反復: 各患者1回
- 合計受診: 15件

`yamamoto-admin`はMFA設定済みで評価CLIにTOTP入力機能がないため、最初の1012実行は認証時点で
HTTP 401 `MFA code is required`となった。この失敗では患者・セッション・算定結果を作成していない。
本計測はFee医事課権限の`yamamoto-clerk`で実施した。

## 入力と設定

各患者の`charts.jsonl`、`patients.csv`、`diagnoses.csv`を入力した。既存UKEは算定後の比較にだけ使い、
既存レセコード、`orders.csv`、構造化claim contextは算定入力へ渡していない。

共通オプションは次のとおり。

```text
--repeat 1
--seed-known-prior-history
--encounter-setting home_visit
--approve-calculated-lines
--login-id yamamoto-clerk
```

5患者すべての結果JSONで、次の永続化済み施設基準を確認した。

- `zaitaku_data_teishutsu_kasan`
- `base_up_hyoka_1`
- `meisaisho_hakko_taisei`（2026-06-01から有効）

## 実行コマンド

患者IDと出力先を変えて、次を5回直列実行した。

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/1001 \
  --repeat 1 \
  --seed-known-prior-history \
  --encounter-setting home_visit \
  --approve-calculated-lines \
  --login-id yamamoto-clerk \
  --output-dir docs/20260718-yamamoto-demo-stg-meisaisho-5patients-20260718_171917/approved/1001/raw
```

外来技術スモークは患者1001に`--encounter-setting outpatient`を指定して別枠で実行した。
これは施設設定とA001再診料の接続確認用であり、患者1001の実際の診療区分を表すものではない。

## 承認方針

`--approve-calculated-lines`は、算定後に`GET /review-items`を取得し、非blocked・非excludedの
line itemだけを`PATCH /review-items`でapprovedにしてから月次を取得する。candidate proposal、
review issue、warningは承認しない。

これは評価データ上の「算定候補を採用して保存」を再現するための明示オプションであり、
通常UIの自動算定や本番データの自動承認を追加するものではない。

## 比較指標

- 当社月次: 承認保存後の`/monthly-receipt`にある`receiptDraft.lines`。
- 完全一致: コード、回数、合計点数が既存UKEと一致したコード。
- 候補込み検知: 月次確定明細と未承認candidate lineを合わせたコード検知。
- 既存のみ / 当社のみ / 両方差分: 月次確定明細と既存UKEの分類。
- 算定API時間: 各`POST /calculate`のクライアント観測時間。承認API時間は含めない。

## 制約

- 1反復のため抽出安定性は評価していない。
- 5患者は全受診へ同じ`home_visit`を指定しており、定期訪問、往診、同一建物区分を完全には表現しない。
- 外来技術スモークは実カルテと診療区分が一致しないため、精度評価へ含めない。
- 既存UKEは比較基準であり、算定要件を人が監査したgoldではない。
- 生結果はカルテ本文、患者名、認証情報を含まない匿名化済みレポートである。
