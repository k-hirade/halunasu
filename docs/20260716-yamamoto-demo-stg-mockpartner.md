# mock_partner算定評価用STG組織

## 目的

mock_partner由来の合成患者を使う算定評価を、西山病院Demoの患者・算定セッションから分離する。
2026-07-16以降のmock_partner評価は、明示的な比較目的がない限りこの組織を使用する。

## 固定構成

| 項目 | 値 |
| --- | --- |
| 環境 | STGのみ |
| Core Firestore project | `medical-core-stg` |
| Fee Firestore project | `halunasu-fee-stg` |
| 組織コード | `yamamoto-demo-stg` |
| 組織表示名 | `Yamamoto Demo STG` |
| 施設表示名 | `yamamoto-demo-stg` |
| 診療科 | `医事課` |
| 有効製品 | `fee` |
| Core施設の平坦な施設基準キー | 未登録（空） |
| Fee施設設定の有効期間付き施設基準 | 2件（Nishiyama STGと同等） |
| seed時の初期患者 | なし。評価CLIが反復ごとに合成患者を作成する |

アカウントは`yamamoto-admin`、`yamamoto-clerk`、`yamamoto-doctor`を作成する。
パスワード本文はDocsやGitへ保存せず、`.gitignore`対象の
`.secrets/yamamoto-demo-stg-password.txt`だけに保存する。3アカウントは評価用の同じランダムパスワードを使う。

| ログインID | 表示名 | 権限 |
| --- | --- | --- |
| `yamamoto-admin` | Yamamoto Demo 管理者 | 組織管理・請求管理・Fee管理者 |
| `yamamoto-clerk` | Yamamoto Demo 医事課 | Fee医事課 |
| `yamamoto-doctor` | Yamamoto Demo 医師 | Fee医師 |

2026-07-16にSTGへ作成済みのリソースは次のとおり。

| リソース | ID |
| --- | --- |
| 組織 | `org_585656590f4ebb25ecb5702314` |
| 施設 | `fac_9fe275b29feebb03bfeb9410f7` |
| 診療科 | `dep_0a9c99c2dedcf0b6247294ef6a` |

## データ境界

患者・施設・職員はCore側に保存する。

```text
medical-core-stg
└─ organizations/{orgId}
   ├─ patients/{patientId}
   ├─ facilities/{facilityId}
   ├─ departments/{departmentId}
   └─ members/{memberId}
```

算定セッション・算定結果・施設別算定設定はFee側に保存する。

```text
halunasu-fee-stg
└─ organizations/{orgId}
   ├─ fee_sessions/{feeSessionId}
   └─ fee_settings/{facilityId}
```

両プロジェクトは同じ`orgId`と、算定セッションで選択した`facilityId`で対応付ける。

## 施設別算定設定

Nishiyama STGの設定を2026-07-16時点で確認し、患者・セッション・識別子・更新日時を含まない
固定テンプレートとして[samples/yamamoto-demo-stg/fee-settings.json](../samples/yamamoto-demo-stg/fee-settings.json)へ保存した。
seedはテンプレートへYamamotoの`orgId`と`facilityId`を付与してFee側へ保存する。

施設基準は以下の2件。

- `zaitaku_data_teishutsu_kasan`: 在宅データ提出加算、2026-01-01から有効
- `base_up_hyoka_1`: 外来・在宅ベースアップ評価料（1）、2026-01-01から有効

自動算定ルールは以下の3件。

- `home_visit_fee`: 訪問診療料を確認候補化
- `home_visit_baseup`: ベースアップ評価料を確認候補化
- `zaitaku_data_addon`: 在宅データ提出加算を算定候補化

この設定は患者固有ではなく施設共通だが、訪問診療の評価結果には影響する。評価CLIは毎回、
永続化済み設定の有無、施設基準、ルールIDと対象コードを結果JSONの`environment.feeSettings`へ記録する。
Nishiyama側の将来変更は自動同期しない。比較条件を変える場合はテンプレートを意図的に更新し、レポートへ残す。

## 作成・復旧

初回作成は次を実行する。既存の西山Demoとは異なるランダムパスワードファイルを生成する。

```bash
npm run seed:yamamoto-demo-stg -- --apply
```

パスワードを意図的に再発行する場合だけ、次を実行する。

```bash
npm run seed:yamamoto-demo-stg -- --reset-password --apply
```

パスワードファイルを削除しただけでは既存ログイン情報は変更されない。紛失時は必ず
`--reset-password`を付けてFirestore側と新しいファイルを同時に更新する。

## mock_partner評価

`npm run eval:fee-monthly-chart-e2e`の既定値はこの組織・管理者・パスワードファイルを指す。
通常は認証オプションを指定しない。

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/1001 \
  --repeat 3 \
  --seed-known-prior-history \
  --encounter-setting home_visit \
  --output-dir /private/tmp/mockpartner-1001
```

評価CLIは正解コードを算定入力へ渡さず、カルテ、患者属性、診療区分と明示した既往歴だけを送る。
各実行レポートには`environment.organizationCode = yamamoto-demo-stg`を残し、別組織で実行した結果との混同を防ぐ。

## 運用ルール

1. mock_partner由来患者の新規評価は`yamamoto-demo-stg`を使う。
2. 西山病院Demoの画面確認・提供データ検証だけを`nishiyama-demo-stg`で行う。
3. 過去レポートの組織名は再現性のため書き換えない。
4. 施設基準を評価するときは、登録内容と有効期間をレポートへ明記する。通常評価では空のままにする。
5. E2Eが作成した合成患者と算定セッションは実患者データではないが、保存件数と性能測定への影響を定期的に確認する。

## 初回検証結果

2026-07-16に患者1001を1反復（2受診）実行し、以下を確認した。

- `yamamoto-demo-stg`でログイン成功
- 作成した施設・診療科の自動解決成功
- Core側の患者作成とFee側の算定セッション作成成功
- 2受診ともOpenAI抽出と算定APIが完了
- Core施設の平坦な施設基準キーは空
- Fee施設設定は永続化済みで、施設基準2件・自動算定ルール3件を結果JSONへ記録
- 構造化オーダー、`claimContext`、`calculationOptions`、既存レセの正解コードは算定入力へ未送信

スモーク結果は一時ファイル
`/private/tmp/yamamoto-demo-stg-smoke-with-settings-20260716/result.json`へ保存した。恒久評価結果は従来どおり、
患者別ディレクトリを持つ新規Docsへ記録する。
