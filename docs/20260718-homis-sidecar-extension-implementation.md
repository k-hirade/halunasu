# HOMISサイドカー拡張 実装記録（2026-07-18）

対象作業票: `docs/implplan/homis-sidecar-extension-build-workorder-20260718.md`

## 結論

ローカルで実装・自動検証できる範囲は完了した。拡張はHOMIS画面から表示中カルテだけを読み取り、
STGの統合APIへ候補作成を依頼する。確定算定、月次レセプトへの混入、拡張へのパスワード入力は行わない。

STGデプロイ後に実施する患者1006の実環境スモークは未実施であり、本記録では完了扱いにしていない。

## 実装した境界

### デバイス認可

- 10分有効の8文字コードを発行するデバイス認可API
- fee-webの既存ログイン・MFAセッションを使う承認／拒否画面
- 組織管理者またはfee管理者だけが承認可能
- `homis_sidecar` entitlement、現在のメンバー状態、MFA登録をトークン発行ごとに再確認
- 5分のスコープトークンと、30日を既定値とする失効可能なdevice grant
- grantのサーバ保存値はSHA-256ハッシュのみ。raw grantは拡張へ一度だけ返す
- grant一覧、組織境界付き失効、監査イベント、Firestore TTL

未承認ポーリングは5秒間隔を維持できる別枠の上限とし、実際のトークン発行・grant更新には
合算10回/5分を適用した。これにより作業票の「10分間ポーリング」と「発行上限」の双方を満たす。

### Chrome拡張

- 配置: `clients/homis-sidecar/`（root workspaceには含めない独立package）
- 固定拡張ID: `nhbmaniknlcaaelpaoogepmkhphmmjof`
- 自動読み取り対応版: `0.2.0`
- selector contract: `homis-mock-v3`（移行中のみサーバ側でv2も許可）
- host permission: localhost mock、STG platform-api、STG fee-apiのみ
- 永続化: 公開device IDと失効可能grantのみ
- 永続化しない情報: パスワード、MFA、access token、PKCE verifier、カルテ本文
- `packages/`・`services/`へのimport、`sourceUrl`送信、`innerHTML`代入をテストで禁止
- 受診区分をDOMから判定できない場合は、利用者が選択するまで算定不可
- 表示中カルテの初期表示、前後移動、日付移動、患者・ブラウザタブ切替を検知してプレビューを自動更新
- 自動化対象はDOM読み取りまでとし、算定API・DB保存は「算定案を作成」の明示操作時だけ実行
- カルテヘッダーの明示ラベル（定期／定期訪問／訪問診療、往診／臨時往診、外来／外来診療）だけを
  受診区分へ自動対応し、電話再診・未知ラベル・SOAP本文からは推測しない
- 単一建物人数または個人宅表示から同一建物区分を3状態で判定し、利用者が上書き可能
- 同一建物区分が未確定の場合、区分依存明細を合計へ含めず警告する
- 明細と追加提案をすべて「算定案（承認前）」として表示
- `codeCandidates`は単一コードへ丸めず、「区分選択が必要・点数未確定」と表示

### 抽出の原子性

- 患者ID、immutable record ID、診療日、SOAPを必須化
- 抽出前後の患者ID・record IDを比較
- 抽出中のDOM変更をMutationObserverで検出し、最大3回まで再抽出
- 読み取りプレビューと送信直前の本文fingerprintを比較
- fingerprintに受診区分と同一建物判定材料を含め、切替後に旧カルテの算定結果を表示しない
- DOM変更通知はデバウンスし、同じfingerprintの再描画では利用者の手動選択と算定結果を維持
- 非HTTPSの院内画面でWeb Cryptoが使えない場合も、ローカル変更検知用FNV-1aへフォールバック
- サーバではselector contract、要素件数、前後ID、DOM変更、preview一致、15分期限を再検証

### mock_homis

- 対象月を2026-06、前月を2026-05へ移送
- `#pdetail_karte[data-record-id]`を患者・診療日・同日連番で一意化
- カルテ切替時にrecord IDも同時更新
- 元ZIPから再現する冪等スクリプト:
  `clients/homis-sidecar/mock/prepare_homis_mock_v3.py`（v2変換を内包）
- 長期の訪看指示期間も同じ17か月分移送し、診療月との不整合を解消
- カルテ切替時も `data-single-building-patient-count` を対象カルテの値へ更新

### yamamoto-demo-stg

- `fee`に加えて`homis_sidecar` entitlementをseed対象へ追加
- admin / clerk / doctorへ、それぞれsidecarのadmin / medical_clerk / doctor roleを付与
- sidecar roleを持つメンバーは既存MFAポリシーによりMFA必須

## 自動検証結果

| 対象 | 結果 |
| --- | --- |
| platform-api全テスト | 69/69 pass |
| fee-api全テスト | 212/212 pass |
| firestore-schema | 4/4 pass |
| platform-contracts | 17/17 pass |
| 拡張fixture・自動読取・依存ガード | 15/15 pass |
| fee-web認証・承認UIスモーク | pass |
| 元mock ZIPからの変換・再変換check | pass（13患者） |
| gold seed-300 engine | exact 150/150 pass（errors 0） |
| gold SOAP v2 engine純度 | exact 138/138 pass（failed 0） |
| 拡張STG E2E | 資格情報未指定のためskip |

fee-apiテストでは、candidate-onlyの維持、月次セッションへの非混入、同じsource recordの再計算、
施設基準の継承、抽出競合時のfail closed、曖昧な`codeCandidates`保持を確認した。

## STGデプロイ後の未完了ゲート

作業票④の9シナリオを実施する。特に以下を実測する。

1. 患者1006・定期訪問で訪問診療、がん性疼痛、在宅酸素の曖昧候補が表示される
2. 同一record IDの再実行が201ではなく200となり、ドラフト件数を増やさない
3. 外来再診で明細書発行体制等加算が候補になる
4. カルテ切替後の古いプレビューを送信しない
5. 15分超過時に再読み取りを促す
6. 受診区分未選択では算定ボタンが無効
7. sidecar draftが月次レセプトへ混入しない
8. 承認・拒否・失効が拡張へ即時反映される
9. トークン発行／更新の10回/5分超過で429となる

同一建物区分の追加受け入れとして、1001は969点、1002/1011は234点、判定根拠がない画面は
区分依存明細0点と未確定警告になることも確認する。STGのselector許可値は移行中のみ
`homis-mock-v3,homis-mock-v2` とし、v3拡張への切替確認後にv2を外す。

実行時は資格情報をリポジトリへ保存せず、環境変数から
`npm run test:e2e --prefix clients/homis-sidecar`へ渡す。

## ビルド・デプロイ

本実装中にはNext.js build、Cloud Run deploy、Netlify deployを実施していない。
デプロイ後に上記STG E2Eを実施し、その結果を別の実測記録として残す。

同一建物v3のSTG更新では、現在のv2拡張を止めないよう次の順で実施する。

```bash
python3 clients/homis-sidecar/mock/prepare_homis_mock_v3.py tmp/mock_homis --apply
python3 clients/homis-sidecar/mock/prepare_homis_mock_v3.py tmp/mock_homis --check

HOMIS_SIDECAR_ENABLED_STG=true \
HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS_STG=nhbmaniknlcaaelpaoogepmkhphmmjof \
HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS_STG=homis-mock-v3,homis-mock-v2 \
TARGET_ENV=stg TARGET_SERVICE=fee-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply

npm run seed:yamamoto-demo-stg -- --apply
```

拡張を再読み込みして1001/1002/1011を確認した後、同じデプロイコマンドの許可値を
`homis-mock-v3` のみにしてv2を終了する。Firestore rules/indexesとNetlifyの更新は不要。
