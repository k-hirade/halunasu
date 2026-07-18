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
- selector contract: `homis-mock-v2`
- host permission: localhost mock、STG platform-api、STG fee-apiのみ
- 永続化: 公開device IDと失効可能grantのみ
- 永続化しない情報: パスワード、MFA、access token、PKCE verifier、カルテ本文
- `packages/`・`services/`へのimport、`sourceUrl`送信、`innerHTML`代入をテストで禁止
- 受診区分は利用者が選択するまで算定不可
- 明細と追加提案をすべて「算定案（承認前）」として表示
- `codeCandidates`は単一コードへ丸めず、「区分選択が必要・点数未確定」と表示

### 抽出の原子性

- 患者ID、immutable record ID、診療日、SOAPを必須化
- 抽出前後の患者ID・record IDを比較
- 抽出中のDOM変更をMutationObserverで検出し、最大3回まで再抽出
- 読み取りプレビューと送信直前の本文fingerprintを比較
- 非HTTPSの院内画面でWeb Cryptoが使えない場合も、ローカル変更検知用FNV-1aへフォールバック
- サーバではselector contract、要素件数、前後ID、DOM変更、preview一致、15分期限を再検証

### mock_homis

- 対象月を2026-06、前月を2026-05へ移送
- `#pdetail_karte[data-record-id]`を患者・診療日・同日連番で一意化
- カルテ切替時にrecord IDも同時更新
- 元ZIPから再現する冪等スクリプト:
  `clients/homis-sidecar/mock/prepare_homis_mock_v2.py`
- 長期の訪看指示期間も同じ17か月分移送し、診療月との不整合を解消

### yamamoto-demo-stg

- `fee`に加えて`homis_sidecar` entitlementをseed対象へ追加
- admin / clerk / doctorへ、それぞれsidecarのadmin / medical_clerk / doctor roleを付与
- sidecar roleを持つメンバーは既存MFAポリシーによりMFA必須

## 自動検証結果

| 対象 | 結果 |
| --- | --- |
| platform-api全テスト | 69/69 pass |
| fee-api全テスト | 211/211 pass |
| firestore-schema | 4/4 pass |
| platform-contracts | 17/17 pass |
| 拡張fixture・依存ガード | 8/8 pass |
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

実行時は資格情報をリポジトリへ保存せず、環境変数から
`npm run test:e2e --prefix clients/homis-sidecar`へ渡す。

## ビルド・デプロイ

本実装中にはNext.js build、Cloud Run deploy、Netlify deployを実施していない。
デプロイ後に上記STG E2Eを実施し、その結果を別の実測記録として残す。
