# HOMIS算定サイドカー PROD展開記録

## 結論

2026-07-31に、`yamamoto-demo`向けHOMIS算定サイドカーをPRODへ展開した。
PROD専用Chrome拡張から、端末コード発行、MFA認証、端末承認、mock HOMISの
患者自動読取、患者自動紐付け、算定案作成まで実接続E2Eで確認済み。

STGの端末grantやAPI URLはPROD拡張から参照されない。Chrome拡張IDは環境間で
同一だが、保存キーは`halunasuSidecar:prod:*`と`halunasuSidecar:stg:*`に分離した。

## PRODリソース

| 項目 | 値 |
| --- | --- |
| 病院コード | `yamamoto-demo` |
| organizationId | `org_7e4f3866f992384e8d3b9c5b11` |
| facilityId | `fac_2bcdca3277860182a6de2a8287` |
| departmentId | `dep_b3ed57f1651792ca3a2b6fc0c7` |
| Platform project | `medical-core-497610` |
| Fee project | `halunasu-fee-prod` |
| platform-api revision | `platform-api-prod-00022-fxj` |
| fee-api revision | `fee-api-prod-00077-bfh` |
| fee-web Netlify deploy | `6a6be0526687c3fae4b42382` |
| Chrome拡張ID | `nhbmaniknlcaaelpaoogepmkhphmmjof` |

`APP_FIELD_ENCRYPTION_KEY`はPROD Secret Managerに作成し、
`halunasu-platform-api@medical-core-497610.iam.gserviceaccount.com`だけに
`roles/secretmanager.secretAccessor`を付与した。

## アカウント

3ユーザーはいずれも次の権限を持つ。

- global roles: `org_admin`, `billing_admin`
- product role: `fee/admin`
- product role: `homis_sidecar/admin`

| 個人ID | パスワードファイル | MFA状態 |
| --- | --- | --- |
| `keishi` | `.secrets/yamamoto-demo-keishi-password.txt` | 初回ログイン時に本人が登録 |
| `goshi` | `.secrets/yamamoto-demo-goshi-password.txt` | 初回ログイン時に本人が登録 |
| `yamamoto` | `.secrets/yamamoto-demo-yamamoto-password.txt` | E2E用に登録・検証済み |

`yamamoto`のE2E用TOTP seedは
`.secrets/yamamoto-demo-yamamoto-totp.txt`に保存した。パスワードとTOTP seedは
すべてmode `0600`で、`.secrets/`はGit管理外である。

`keishi`と`goshi`はログインAPIでHTTP 200、`mfaRequired=true`、
`mfaEnrolled=false`を確認した。これは未設定のMFAを迂回している状態ではなく、
ログイン直後に登録画面へ進めるための初回セッションである。保護APIの利用には
MFA登録・確認が必要。

## PRODランタイム

### platform-api

- `HOMIS_SIDECAR_ENABLED=true`
- 許可拡張IDは上記1件
- selector contractは`homis-mock-v4,v3,v2`
- `APP_FIELD_ENCRYPTION_KEY`をSecret Managerから注入
- `min instances=0`
- `CPU=1`, `memory=512Mi`

### fee-api

- runtime profile: `prod-openai-primary-span-recheck`
- `HOMIS_SIDECAR_ENABLED=true`
- `FEE_CLINICAL_EXTRACTION_STRATEGY=openai_primary`
- `FEE_EXTRACTION_COVERAGE_MODE=verify`
- 対象施設allowlistは`fac_2bcdca3277860182a6de2a8287`
- `FEE_EXTRACTION_MEMO=true`
- `FEE_STANDING_FACTS=true`
- `FEE_EMPTY_EXTRACTION_RETRY=true`
- `FEE_MONTHLY_EXCLUSION_MODE=enforce`
- Span detectorは`wx1-multilingual-minilm-l12-v2`
- linker/context classifierは`off`
- `min instances=0`
- `CPU=2`, `memory=8Gi`

Span成果物は
`gs://halunasu-fee-prod-artifacts/whitebox/fee_span_detector/`
に配置した。PROD readinessでinference、semantic、決定論probeがすべて
`passed`になった。

## Webと拡張成果物

端末承認ページ:

```text
https://fee.halunasu.com/settings/sidecar-approvals
```

2026-07-31の確認ではHTTP 200。以前の404はfee-web PROD反映で解消した。

PROD拡張の生成:

```bash
npm run build:homis-sidecar -- --env prod --zip
```

生成物:

```text
dist/homis-sidecar/prod/extension
dist/homis-sidecar/homis-sidecar-prod.zip
```

Chromeの「パッケージ化されていない拡張機能を読み込む」では、ZIPではなく
`dist/homis-sidecar/prod/extension`を指定する。ソースの
`clients/homis-sidecar/extension`はSTG既定値なので、PROD運用では直接読み込まない。

## 検証結果

ローカル回帰:

- HOMIS sidecar: `23/23`
- fee-core: `75/75`
- fee-api: `447/447`
- platform-api: `76/76`
- fee-web production build: success
- fee-web MFA UI smoke: pass
- `git diff --check`: pass

PROD実接続E2E:

- 対象: mock患者`1006`
- PROD拡張のロード
- PROD platform-apiで端末コード発行
- `yamamoto-demo / yamamoto`でログイン
- 登録済みMFAの6桁確認
- 端末承認とgrant取得
- カルテの自動読取
- 受診区分・同一建物区分の自動判定
- PROD患者の自動紐付け
- PROD fee-apiで算定案作成
- 候補、レセプトコメント、チェックリスト、詳細ログの表示

上記を約55秒で完走し、`1/1 pass`。
このE2Eにより、PRODには合成患者`1006`とsidecar算定ドラフトが作成または更新されている。

## 実HOMISへ展開する際の残条件

今回のPROD拡張は`yamamoto-demo`のmock HOMIS
(`localhost:8899/homic/`)に対して実動確認したもの。実病院のHOMISで使用する前に、
実際のHTTPS originと画面契約を確認し、そのoriginだけをmanifestの
`host_permissions`と`content_scripts.matches`へ追加する必要がある。
origin不明のまま`<all_urls>`を許可する対応は行わない。

## 再実行用コマンド

施設・ユーザー設定は冪等で、既存パスワードを明示的な
`--reset-password`なしに変更しない。

```bash
npm run seed:yamamoto-demo -- --env prod --apply
```

PROD APIの再デプロイ:

```bash
MIN_INSTANCES=0 \
CPU=1 \
TARGET_ENV=prod \
TARGET_SERVICE=platform-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

```bash
MIN_INSTANCES=0 \
RUNTIME_FEATURE_PROFILE=prod-openai-primary-span-recheck \
CPU=2 \
FEE_MEMORY=8Gi \
TARGET_ENV=prod \
TARGET_SERVICE=fee-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

fee-webの再デプロイ:

```bash
npm run deploy:netlify-admin-fee-next -- --env prod --app fee-web --apply
```
