# 医療系セキュリティ Gap Analysis

作成日: 2026-04-19
対象: Medical realtime outpatient scribe app

## 目的

この文書は、現行実装を「医療情報を扱うSaaS」として見た場合に、理想的なセキュリティ水準との差分を洗い出すための調査メモです。

対象はコードだけでなく、運用、契約、監査、バックアップ、インシデント対応を含みます。法務判断そのものではなく、プロダクト/インフラ/運用設計に落とすための技術的ギャップ分析です。

## 参照した外部基準

- 厚生労働省: 医療情報システムの安全管理に関するガイドライン 第6.0版
  - https://www.mhlw.go.jp/stf/shingi/0000516275_00006.html
- 厚生労働省: 医療機関等におけるサイバーセキュリティ対策チェックリストマニュアル 令和7年5月
  - https://www.mhlw.go.jp/content/10808000/001490741.pdf
- 経済産業省/総務省: 医療情報を取り扱う情報システム・サービスの提供事業者における安全管理ガイドライン 第2.0版 令和7年3月28日
  - https://www.meti.go.jp/policy/mono_info_service/healthcare/teikyoujigyousyagl.html
  - https://www.meti.go.jp/policy/mono_info_service/healthcare/01gl_20250328_rev1.pdf
- 個人情報保護委員会/厚生労働省: 医療・介護関係事業者における個人情報の適切な取扱いのためのガイダンス
  - https://www.ppc.go.jp/personalinfo/legal/iryoukaigo_guidance/
- 個人情報保護委員会 FAQ: 医療・介護関係事業者が扱う要配慮個人情報
  - https://www.ppc.go.jp/all_faq_index/faq3-q2-4/
- OpenAI: Data controls in the OpenAI platform
  - https://developers.openai.com/api/docs/guides/your-data#data-retention-controls-for-abuse-monitoring
- OWASP GenAI Security Project: LLM01 Prompt Injection
  - https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- medimo の比較材料
  - ユーザー提示URLは直接取得できなかったため、同内容と見られるPR TIMES記事とISMS登録情報を確認した。
  - https://prtimes.jp/main/html/rd/p/000000024.000124331.html
  - https://isms.jp/lst/ind/CR_JUSE-IR-575.html

## 基準から見た前提

### 医療情報の扱い

このアプリは、患者名、主訴、会話音声、逐次文字起こし、最終文字起こし、SOAP下書き、確定済み診療記録を扱う。個人情報保護委員会の医療・介護FAQでは、診療録等に記載された病歴、診療過程で医療従事者が知り得た身体状況、病状、治療等の診療情報が要配慮個人情報として例示されている。したがって、本アプリの中核データは要配慮個人情報として扱うべき。

### 医療機関向けチェックリストで特に効く項目

厚労省チェックリストマニュアルは、以下を優先項目として扱っている。

- 医療情報システム安全管理責任者の設置
- サーバ、端末、ネットワーク機器の台帳
- サービス事業者の開示書、責任分界、SLA
- 職種/担当業務別のアクセス権限設定
- 不要アカウントの削除または無効化
- セキュリティパッチ適用
- パスワード要件と使い回し禁止
- 二要素認証の実装、または令和9年度までの実装予定
- アクセスログ管理
- BCP、連絡体制、バックアップ、規程類

コードだけでなく、医療機関が立入検査や内部監査で確認できる「現物」が必要になる項目が多い。

### サービス提供事業者としての基準

経産省/総務省ガイドライン第2.0版は、一律のチェックリストではなく、リスクベースのリスクマネジメント、医療機関との責任分界、サービス仕様/SLA/安全管理情報の提供、第三者認証や監査報告の活用を重視している。

medimoの公開情報では、AI自動カルテ作成サービスの提供範囲で ISO/IEC 27001 認証を取得している。競合比較としては、単発の機能セキュリティよりも、ISMS、3省ガイドラインへの説明責任、第三者評価が信頼材料になっている。

## 現行実装で確認できた強い点

### Firestoreクライアント直アクセス禁止

`firestore.rules` は全ドキュメントの read/write を拒否しており、PHIアクセスはgateway経由に集約されている。

- `firestore.rules`

### RBACと組織境界

職種/役割ベースの権限定義がある。`platform_admin`, `org_owner`, `org_admin`, `it_admin`, `clinical_admin`, `doctor`, `nurse`, `medical_scribe`, `auditor` などが定義され、担当診療と組織単位の閲覧権限が分かれている。

- `packages/contracts/src/index.js`
- `services/gateway/src/server.js`

### パスワードハッシュ

PBKDF2 SHA-256、210,000 iterations、ランダムsalt、`timingSafeEqual` による比較が実装されている。

- `packages/core/src/lib/password.js`

### トークン

モバイル接続やoperator sessionはHMAC署名トークンで、有効期限チェックとタイミングセーフ比較がある。ペアリングURLはhash fragmentを使っており、URL tokenがHTTP request path/queryへ乗りにくい設計になっている。

- `packages/core/src/lib/pairing-token.js`
- `services/gateway/src/server.js`

### CORSとログ

gatewayは許可originのみcredentialed requestを許可している。productionではエラーメッセージの詳細を標準ログに出さない作りになっている。監査イベントも本文ではなく byte length, duration, hash, text length などのsafe payload中心。

- `services/gateway/src/server.js`

### 外部AI APIの保存抑制

OpenAI Responses API呼び出しでは `store: false` が指定されている。

- `packages/core/src/openai/responses-structured.js`

ただし、OpenAI側のabuse monitoringやZDR/MAM契約の扱いはコードでは保証できないため、後述の契約/設定確認が必要。

## 重要ギャップ一覧

優先度の意味:

- P0: 実患者データでの本格運用前に必須
- P1: pilotからproductionへ広げる前に必須
- P2: 信頼性、監査、エンタープライズ販売のために必要

| ID | 優先度 | 領域 | 現行 | 理想 | 差分 |
|---|---:|---|---|---|---|
| SEC-01 | P0 | MFA | 2026-04-19にprivileged role向けTOTP、QR登録、管理者MFA reset、reset/failure auditを実装 | 全operator MFA、recovery code/passkey、break-glass訓練 | 一般operator必須化とrecovery code/passkeyが残る |
| SEC-02 | P0 | アカウント無効化 | 2026-04-19に管理UI/APIとsession revocationを実装 | 退職/異動/休眠アカウントの無効化、定期棚卸し | 定期棚卸しレポートと運用証跡が不足 |
| SEC-03 | P0 | バックアップ/BCP | Firestore/Cloud Run利用方針はあるが、復旧手順と演習証跡がない | RPO/RTO、バックアップ、復元演習、連絡体制、ランサム対応 | 医療機関チェックリスト/立入検査で求められる現物が不足 |
| SEC-04 | P0 | データ保持/削除 | 2026-04-19にretention cleanup scriptを追加 | Cloud Scheduler化、GCS lifecycle、削除実績レポート | 定期実行インフラと実績監査が残る |
| SEC-05 | P0 | 生音声PHI | 2026-04-19にgateway memory TTL、GCS raw audio buffer、finalize worker読込、Cloud Tasks enqueue pathを実装 | 本番GCS bucket/lifecycle + private finalize + Cloud Tasks queue | 本番インフラ作成と権限付与が残る |
| SEC-06 | P0 | 外部AI委託 | OpenAI/Deepgramに音声/テキストを送る | DPA/BAA相当、ZDR/MAM、リージョン/保持/サブプロセッサ説明 | 医療機関への説明責任と委託管理がコード外で未確定 |
| SEC-07 | P1 | ログ監査 | アプリ内audit_events中心 | Cloud Logging sink、改ざん耐性、保管年限、アラート | アクセスログ管理と追跡性が運用面で不足 |
| SEC-08 | P1 | レート制限 | 2026-04-19にleftmost XFF採用を廃止し、Firestore backendでは共有rate limitへ移行 | Cloud Armor/外部rate limit、入口WAF | Cloud Armorは本番前に別途必要 |
| SEC-09 | P1 | セッション/CSRF | 2026-04-19にcookie-only/CSRFを実装 | same-origin BFFまたは厳格CORS、`__Host-` cookie検討 | cross-site cookie運用の複雑さが残る |
| SEC-10 | P1 | Security headers | 2026-04-19にgateway基本headersとNetlify CSP/HSTSを実装 | nonce-based CSP、独自ドメインHSTS確認 | Next runtime config都合で`unsafe-inline`が残る |
| SEC-11 | P1 | パスワードポリシー | 2026-04-19に12文字+英数字記号+lockoutを実装 | 使い回し禁止、漏えいパスワード検査、履歴 | パスワード履歴/漏えい検査が残る |
| SEC-12 | P1 | デバイス管理 | 2026-04-19にFirestore trusted recorder registry、管理UI、revocation auditを実装 | MDM/画面ロック/OS要件/紛失時運用 | 端末MDMと院内規程が残る |
| SEC-13 | P1 | Cloud Run/IAM | gatewayはpublic Cloud Run、app-level auth | public面のWAF/rate limit、finalizeはprivate IAM/OIDC | gateway公開前提の防御がアプリに寄りすぎ |
| SEC-14 | P1 | 依存関係/コンテナ | npm test/build中心、SCA/secret scan/CodeQL等なし | Dependabot/SCA/container scan/SBOM/secret scan | 継続的な脆弱性管理が不足 |
| SEC-15 | P1 | LLM安全性 | SOAP生成promptに保守的指示あり | prompt injection threat model、adversarial test、出力検証 | 診療会話自体が未信頼入力である前提が不足 |
| SEC-16 | P2 | サービス開示 | docsはあるがMDS/SDS/SLA形式ではない | 医療機関へ渡せる開示書、責任分界、SLA | 経産省/総務省ガイドライン対応の営業/監査資料が不足 |
| SEC-17 | P2 | ISMS | コード/設計レビュー中心 | ISO/IEC 27001または同等の統制運用 | medimo相当の第三者評価に未達 |
| SEC-18 | P2 | 秘密鍵運用 | Secret Manager利用あり | rotation runbook、最小権限、アクセス監査、KMS/CMEK検討 | 鍵/secret lifecycleの証跡が不足 |

## 詳細所見

### SEC-01 MFA未実装

2026-04-19の修正で、privileged role向けTOTP MFAを追加した。初回は認証アプリ登録、以後は6桁コード確認後にsessionを発行する。追加修正で、登録画面のQRコード、管理者によるMFA登録リセット、`member.mfa_reset` audit、`auth.mfa_failed` auditを追加した。一般operatorへの必須化、recovery code/passkey、break-glass訓練は未対応。

該当:

- `packages/contracts/src/index.js`
- `services/gateway/src/server.js`
- `apps/web/lib/operator-access.js`

医療情報システムのログインとしては、管理者と臨床ユーザーにMFAが必要。厚労省チェックリストでも二要素認証は明示項目になっている。

推奨:

1. Phase 1: 管理者ロールだけTOTP必須。
2. Phase 2: 全operatorへTOTPまたはWebAuthn/passkeyを必須化。
3. Recovery code、MFA reset audit、break-glass adminを実装。
4. `member.mfaRequired`, `member.mfaEnrolledAt`, `member.mfaMethods[]` を追加。
5. loginを `password verified -> mfa challenge -> session issue` の2段階に分ける。

2026-04-19追加実装:

- 管理UIからMFA登録をリセットし、次回ログインで再登録させる。
- MFA登録QRコードを表示する。
- MFA確認失敗、MFA secret復号失敗、MFA未登録状態での確認をPHIなしで監査ログに残す。
- break-glass手順を `docs/runbooks/mfa-break-glass.md` に追加した。

### SEC-02 アカウント無効化/棚卸し不足

2026-04-19の修正で、管理UI/APIからmemberを停止/再開できる導線を追加した。status変更時はtokenVersionを進め、既存sessionを失効する。月次/四半期のアカウント棚卸しレポートは未対応。

該当:

- `packages/core/src/store/firestore-store.js`
- `apps/web/components/admin-console.js`

推奨:

1. `PATCH /api/v1/admin/members/:memberId/status` を追加。
2. statusを `active`, `disabled`, `locked`, `pending_mfa` に整理。
3. disabled時に既存session tokenを失効できるよう、token versionまたはsession revocation timestampを持つ。
4. 月次/四半期のアカウント棚卸しレポートを出す。
5. 異動時のrole変更、退職時disable、長期未使用disableをauditに残す。

### SEC-03 BCP/バックアップ/復旧演習の不足

docsにはCloud Run/Firestore/GCS構成やstandby案があるが、現行リポジトリでは復旧演習、バックアップ設定、RPO/RTO、連絡体制、ランサムウェア時の運用手順が確認できない。

該当:

- `docs/core/07-gcp-deployment.md`
- `docs/core/03-system-architecture.md`

推奨:

1. Firestore PITR/バックアップの有効化と復元手順。
2. GCS audio/artifact bucketのversioning/lifecycle/retention lock方針。
3. RPO/RTO定義。
4. 医療機関向けの障害時業務継続手順。
5. 年1回以上の復元演習ログ。
6. インシデント時の連絡先、判断者、通知テンプレート。

### SEC-04/05 生音声と保持期限の扱い

録音停止時に `liveStt.exportArchivedAudio(sessionId)` の結果を `pendingFinalizeAudio` Mapへ保持している。2026-04-19の修正でTTL sweeper、完了/破棄/録音再開時の削除、TTL expiry auditを追加した。追加修正で、`RAW_AUDIO_GCS_BUCKET` 設定時にraw audio PCMをCloud Storageへ保存し、`services/finalize` が `rawAudioPath` から読み戻してfinal repassできるようにした。`FINALIZE_TASKS_QUEUE` 設定時はgatewayがCloud Tasksへfinalize taskをenqueueする。

該当:

- `services/gateway/src/server.js`
- `docs/core/03-system-architecture.md`

リスク:

- process memory上のPHI保持が長引く。
- finalize失敗が続くとメモリ圧迫とPHI滞留が起きる。
- Cloud Run再起動でraw audioが消え、監査/復旧ができない。
- `LIVE_STT_ARCHIVE_MAX_BYTES` 分だけセッションごとに保持されるため、DoS面でも重い。

推奨:

1. inline finalizeはstaging限定にし、本番はGCS + Cloud Tasks + private finalize workerへ移行。
2. GCS bucketに短期lifecycleを設定する。
3. Cloud Tasks queue、`medical-finalize`、service account権限を本番前に作成する。
4. `scripts/run_retention_cleanup.mjs` をCloud Schedulerで日次実行する。
5. GCS lifecycleとFirestore cleanupの実行結果を月次で監査する。

### SEC-06 外部AI委託とデータ保持

OpenAIにはRealtime/Audio Transcriptions/Responsesで音声・文字起こし・SOAP生成入力が送信される。Deepgramにもfallback STTで音声が送られる。

該当:

- `packages/core/src/stt/openai-live-stt.js`
- `packages/core/src/stt/openai-final-transcribe.js`
- `packages/core/src/stt/deepgram-live-stt.js`
- `packages/core/src/openai/responses-structured.js`

OpenAI Responses APIでは `store: false` が使われているが、OpenAI docs上、APIのabuse monitoring logはendpointによって最大30日保持される場合があり、Zero Data RetentionやModified Abuse Monitoringは別途承認と設定が必要。医療機関向けには、API provider側の学習利用、保持、国外移転、サブプロセッサ、障害時対応を契約/開示で説明する必要がある。

推奨:

1. OpenAI/DeepgramのDPA、医療情報取扱い、保持期間、サブプロセッサを確認。
2. OpenAIはZDRまたはMAMの対象projectを使う。
3. `/v1/responses` は引き続き `store:false` を必須にし、web search等のHIPAA/医療非適格機能を使わない。
4. provider障害時のfallbackと停止判断を運用手順にする。
5. 医療機関向けに「外部送信される情報」「送信先」「保持」「削除」「問い合わせ先」を開示する。

### SEC-07 監査ログの改ざん耐性とアラート不足

アプリ内audit_eventsはあるが、Cloud Logging sink、WORM/append-only保管、SIEM連携、管理者操作アラート、監査ログ保持年限がまだ明確ではない。

推奨:

1. 認証成功/失敗、MFA失敗、password reset、role変更、account disable、SOAP approve/export、recording start/stopを監査イベントとして整理。
2. Cloud Logging sinkを専用project/bucketへ出す。
3. 管理者操作と大量失敗ログインをアラート化。
4. org単位でaudit exportを可能にする。
5. audit logにPHI本文を入れない方針は維持する。

### SEC-08 レート制限の回避余地

2026-04-19の修正で、app内のIP識別は `x-forwarded-for` の先頭を直接採用せず `req.ip` を使う形へ変更した。追加修正で、Firestore backendでは `rate_limits` collectionを使う共有rate limitへ移行した。memory backendはlocal開発用のprocess memory制限として残る。

該当:

- `services/gateway/src/server.js`

推奨:

1. Cloud Armor rate limitingを入口に置く。
2. 本番は `STORE_BACKEND=firestore` を必須にする。
3. XFFは信頼proxy数を前提に右側から解析するか、Cloud Runが提供する信頼済みclient情報だけ使う。
4. loginはIP単位、account単位、org単位の3軸で制限。

### SEC-09 token/localStorage/CSRF

2026-04-19の修正で、frontendのlocalStorage bearer token fallbackは廃止した。operator sessionはHttpOnly cookieを基本にし、state-changing APIにはdouble-submit CSRF cookie/headerを要求する。productionではoperator bearer authはdefault disabled。production cookieは `SameSite=None; Secure` なので、別origin Netlify -> Cloud Run のcredentialed requestに対応する前提は残る。

該当:

- `services/gateway/src/server.js`
- `apps/web/lib/operator-access.js`

推奨:

1. 本番はcookie-onlyに寄せ、localStorage bearer token fallbackを廃止する。
2. 可能ならNetlify/APIを同一siteに寄せて `SameSite=Lax` または `Strict` にする。
3. cross-site cookieを維持する場合はCSRF token/double-submit tokenを入れる。
4. session tokenに `sid` と `tokenVersion` を持たせ、強制失効できるようにする。
5. cookie名は `__Host-` prefixを検討する。ただしDomainなし、Path=/、Secureが必要。

### SEC-10 Security headers不足

2026-04-19の修正で、gateway/API側には基本security headersを追加した。追加修正で、Netlifyの `Content-Security-Policy`, HSTS, Referrer-Policy, Permissions-Policy, frame制御を `netlify.toml` に追加した。

推奨:

1. Next runtime configをnonce方式に変え、`script-src 'unsafe-inline'` を外す。
2. 本番gateway URL/独自ドメインが確定したら `connect-src` の `https://*.run.app` を狭める。
3. HSTSは独自ドメインで問題ないことを確認する。
4. microphone permissionは必要画面だけで要求し、Permissions-Policyで範囲を限定する。

### SEC-11 パスワードポリシー不足

2026-04-19の修正で、新規/リセットのpassword schemaは12文字以上128文字以下へ強化し、server側で英字・数字・記号を必須化した。ログイン失敗10回で10分lockする。使い回し禁止、漏えいpassword検査、初回変更、履歴管理は未対応。

該当:

- `packages/contracts/src/index.js`
- `packages/core/src/lib/password.js`

推奨:

1. 8文字以上かつ英数字記号混在、またはより強い長さベースのpolicyを明文化。
2. 過去N世代のpassword hash reuse禁止。
3. Have I Been Pwned k-anonymity等で漏えいpassword拒否。
4. temporary passwordは初回ログインで変更必須。
5. login失敗回数に応じたaccount lockと管理者解除。

### SEC-12 スマホ/録音端末の統制

モバイルは短期stream tokenで接続する設計で、ペアリングURLの扱いも良い。追加修正で、trusted recorder registryをFirestoreに永続化し、管理UIから登録端末を閲覧/失効できるようにした。登録/再確認/失効はorganization auditに残る。医療現場の端末統制としては、MDM、画面ロック、OS version、root/jailbreak検出、院内端末規程が残る。

推奨:

1. MDM/画面ロック/OS version要件を医療機関向け運用規程に入れる。
2. 紛失時は管理UIで該当端末を失効し、必要に応じて該当メンバーのセッションも失効する。
3. PWA/ブラウザ利用の場合、端末側にPHIを永続保存しない方針を明記。

### SEC-13 Cloud Run/IAM

deploy scriptではgatewayの `ALLOW_UNAUTH=true` がデフォルト。gatewayはブラウザから直接アクセスするためpublic自体は設計上あり得るが、医療PHI入口としてはCloud Armor、WAF、rate limit、bot対策、最小権限サービスアカウント、ログ監視が必要。

finalize serviceはHMAC secret認証が実装されている。追加修正で、`scripts/deploy_finalize_cloud_run.sh`、`cloudbuild.finalize.yaml`、gatewayからCloud Tasksへenqueueする経路を追加した。実際の本番運用には、Cloud Tasks queue、private `medical-finalize`、service account権限、GCS bucket lifecycleの作成が必要。

該当:

- `scripts/deploy_cloud_run_zero_fixed.sh`
- `services/finalize/src/server.js`

推奨:

1. gateway publicの場合はCloud Armorを前段に置く。
2. finalizeは `--no-allow-unauthenticated` + Cloud Tasks OIDC/IAMにする。
3. HMAC secretは補助防御として残す。
4. service accountをgateway/finalizeで分け、Storage/Firestore/Secret権限を最小化。
5. Docker imageはnon-root実行、distrolessまたはslim hardening、container scanを追加。

本番前に必須:

- `RAW_AUDIO_GCS_BUCKET` を作成し、lifecycleでraw audioの短期削除を設定する。
- `medical-finalize` を `--no-allow-unauthenticated` でdeployする。
- `FINALIZE_TASKS_QUEUE` を作成し、gateway service accountへ `cloudtasks.tasks.create` を付与する。
- Cloud Tasks OIDC用service accountへ `medical-finalize` のinvokerを付与する。

### SEC-14 依存関係/CI security

root scriptsはbuild/test/manual中心。Dependabot、npm audit CI、CodeQL、secret scanning、container scanning、SBOM生成が見えない。

2026-04-19追加修正で、`next` を `15.5.15` へ更新し、`protobufjs` を `7.5.5` へ解決して、`npm audit --audit-level=high` は成功する状態にした。残るauditは `firebase-admin -> @google-cloud/storage` のtransitive low severityで、npmの自動修正は `firebase-admin@10.3.0` への破壊的ダウングレードを提示するため今回は見送る。

推奨:

1. DependabotまたはRenovate。
2. `npm audit --audit-level=high` またはaudit-ci。
3. CodeQL/Semgrep。
4. Gitleaks等のsecret scan。
5. Trivy/Grypeでcontainer image scan。
6. CycloneDX SBOMをartifactとして保存。
7. Production deploy前にsecurity gateを置く。

### SEC-15 LLM固有リスク

診療会話は「患者や周囲の発話」という未信頼入力であり、SOAP生成promptに混入する。OWASP LLM01では、直接/間接prompt injectionによりモデル挙動が変わり、機密情報開示、出力操作、権限外機能呼び出しなどが起き得ると整理されている。

現行のSOAP promptは「transcriptに基づく」「推測しない」など臨床安全寄りの指示がある。これは良いが、セキュリティテストとしてprompt injection耐性を継続検証する仕組みは見えない。

推奨:

1. transcriptを未信頼入力としてprompt内で明確に区切る。
2. system/developer instructionをtranscriptより上位に置く。
3. Structured Outputsのschema validationを継続し、自由文出力を直接HTML挿入しない。
4. prompt injection adversarial testsを追加。
5. LLMが外部ツールや管理APIを呼べる設計にしない。
6. SOAPは医師承認前提をUI/API両方で維持する。

### SEC-16 malformed token時の堅牢性

2026-04-19の修正で、`verifyToken` は形式数、最大長、JSON parse例外を検証し、malformed tokenはnullへ正規化するようにした。

該当:

- `packages/core/src/lib/pairing-token.js`

推奨:

1. `JSON.parse` をtry/catchし、nullを返す。
2. token length上限を設ける。
3. auth middlewareの例外を401に正規化する。

## 実装ロードマップ

### まずP0

1. 完了: 管理者MFAを実装し、privileged roleへ必須化。
2. 完了: メンバー無効化API/UIとsession revocationを実装。
3. 完了: raw audioのgateway memory保持にTTL/削除/auditを追加。
4. 次バッチ: org retention policyを実際の削除ジョブに接続。
5. 本番前必須: Firestore/GCSバックアップ、復元手順、BCP、連絡体制を文書化して演習。
6. 本番前必須: OpenAI/Deepgramの契約、ZDR/MAM、保持、サブプロセッサ、外部送信説明を確定。

### 次にP1

1. Cloud Armorまたは共有store rate limit。
2. 完了: cookie-only auth + CSRF対策。
3. 一部完了: gateway security headers。web CSP/HSTSは次バッチ。
4. Cloud Logging sink、監査ログ保管、アラート。
5. finalize workerをprivate Cloud Run + Cloud Tasks/OIDCへ。
6. Dependabot/SCA/secret scan/container scan/SBOM。
7. LLM prompt injection test suite。
8. device revocationと端末台帳。

### P2

1. 医療機関向けMDS/SDS/SLA/責任分界表。
2. ISMSまたはISO/IEC 27001取得に向けた統制台帳。
3. 年次ペンテスト、脆弱性診断、リスクアセスメント。
4. SIEM/EDR/MDM連携。
5. セキュリティ教育、権限棚卸し、委託先評価の定期運用。

## 具体的な修正方針

この章は、そのままIssue化できる粒度で実装方針を整理する。基本方針は以下。

- PHI本文は標準ログ、localStorage、永続しない一時領域へ残さない。
- 認証・認可・監査は「コードで強制」し、運用だけに依存しない。
- 医療機関に説明できる証跡を残す。設定値、監査ログ、runbook、チェックリストをセットで管理する。
- いきなり全面移行せず、feature flagでstaging検証してからproductionへ段階導入する。

### 今回の修正範囲: 追加費用なしから少額まで

今回の実装対象は、追加固定費がないもの、またはGCP利用量が小さい限り少額に収まるものに限定する。高額化しやすいCloud Armor Enterprise、SIEM、MDM、ISMS審査、長期ログ保管、長期音声保管は対象外にする。

#### 対象にする

| 領域 | 費用影響 | 今回の修正範囲 |
|---|---:|---|
| token堅牢化 | なし | malformed tokenを401に正規化、token長上限、auth例外の握りつぶし |
| raw audio TTL | なし | gateway memory上のraw audioへTTL、失敗経路の削除/短期retry、pending byte数の可視化 |
| MFA/TOTP | なしから少額 | SMSは使わずTOTP。secret暗号化用keyをSecret Managerで管理する場合のみ少額 |
| account disable/revocation | ほぼなし | member status変更、session revocation、tokenVersion検証 |
| password/account policy | ほぼなし | password policy、失敗回数、account lock、password reset時のsession revoke |
| cookie/CSRF | なし | 本番はcookie-onlyへ寄せ、CSRF tokenを追加。localStorage token fallbackを廃止 |
| security headers | なし | API/webへCSP, Referrer-Policy, Permissions-Policy, frame制御等を追加 |
| app-level audit | ほぼなし | Firestore audit event schema整理。Cloud Logging長期保管はまだやらない |
| LLM安全テスト | なし | APIを叩かないmock/adversarial testを追加 |
| device registry | ほぼなし | trusted recorderを永続化し、device revoke UI/APIを追加 |
| retention cleanup | 少額 | Cloud Scheduler 1 job + cleanup処理。3 jobs/月までは無料枠内 |
| GCS短期audio buffer | 少額 | raw audioを短期GCS保存へ移す。保持は24時間以内を初期値にする |
| Cloud Tasks finalize | 少額 | Cloud Tasks + Cloud Run min instances 0。月100万operationまでは無料枠内 |
| runbook/docs | なし | BCP、backup restore、外部AI送信説明、責任分界の初版 |

#### 今回は対象外にする

| 領域 | 理由 | 本番前の扱い |
|---|---|---|
| Cloud Armor / Load Balancer | 固定費と構成変更が増える | 公開production前には再評価。closed pilotならapp-level rate limitで一旦開始可能 |
| Cloud Logging専用長期保管 | ログ量と保持期間で費用が変動 | app auditを先に整備し、本番前にsink/retentionを決める |
| Firestore PITR / scheduled backup | DBサイズ比例で無料枠なし | 実患者PHIのproduction前には必須 |
| KMS/CMEK | key費用と運用が増える | 初期はSecret Manager keyで暗号化。enterprise要求時にKMS/CMEKへ移行 |
| SIEM/EDR/MDM | SaaS費用/運用費が大きい | 医療機関導入規模が増えた段階で導入 |
| ISMS/ISO 27001審査 | 審査・運用コストが大きい | 販売/信頼獲得フェーズでは必要。初期実装のblockerにはしない |
| 年次ペンテスト | 外部委託費が大きい | 本番公開前または大型導入前に実施 |
| OpenAI/Deepgramの有償契約強化 | 契約条件次第で費用不明 | 実患者PHIを送るなら契約/保持/ZDR/MAM確認は必須 |

### 少額以上でも本番前に必須のもの

次は「今回の低コスト実装」には含めないが、実患者PHIを本番運用するなら避けられない。

1. Firestore backupまたはPITR
   - 理由: 誤削除、障害、攻撃時に復旧できない医療システムは本番運用できない。
   - 最小案: scheduled backupを短期保持で開始し、復旧演習を1回実施する。
2. 外部AI委託の契約/保持確認
   - 理由: OpenAI/Deepgramへ音声・診療テキストを送るため、医療機関へ外部送信先、保持、学習利用、サブプロセッサを説明する必要がある。
   - 最小案: 本番projectでZDR/MAMまたは同等設定/契約を確認し、docsに証跡を残す。
3. public production入口のDDoS/WAF/rate limit
   - 理由: gatewayをpublic Cloud Runで運用する場合、app-level authだけでは入口防御が薄い。
   - 最小案: closed pilotでは許可origin、account lock、app-level rate limitで開始。本公開前にCloud Armorまたは同等の入口制御を入れる。
4. 監査ログの保全
   - 理由: 医療機関から「誰がいつ見た/編集した/確定したか」を問われる。
   - 最小案: まずFirestore auditを整備。本番前にCloud Logging sinkまたは別project/bucketへの転送を検討する。

### 低コスト前提の実装順

1. Auth hardening
   - malformed token、token長上限、auth 401正規化。
   - password policy、login失敗count、account lock。
2. Account lifecycle
   - member disable、session revocation、tokenVersion。
   - role/password/MFA変更時の強制revocation。
3. MFA
   - 管理者TOTP必須。
   - 一般operatorはfeature flagで段階必須化。
4. Browser/session protection
   - cookie-only、CSRF token、security headers。
   - localStorage operator token fallback廃止。
5. PHI temporary data
   - pending raw audio TTL。
   - finalize失敗時の短期retry/削除。
6. Audit and retention
   - audit event schema標準化。
   - retention cleanup dry-runと実行モード。
7. Small GCP additions
   - GCS短期audio buffer。
   - Cloud Tasks finalize。
   - Cloud Scheduler cleanup。
8. Safety tests and docs
   - LLM prompt injection mock tests。
   - BCP/external AI/data flow docs初版。

### 2026-04-19 実装開始分の反映状況

今回の修正では、低コスト枠のうち「本番前の基礎統制として先に潰すべきもの」を先行実装した。GCPリソースを新規追加するものは、費用と運用手順を確定してから次バッチで実装する。

#### 今回実装済み

| 領域 | 実装内容 | 主な対象 |
|---|---|---|
| token堅牢化 | 署名付きtokenの形式数、最大長、JSON parse例外を検証し、malformed tokenをnull/401に正規化 | `packages/core/src/lib/pairing-token.js` |
| password/account policy | 新規作成・パスワード再設定に12文字以上、英字、数字、記号を必須化。ログイン失敗10回で10分lock。失敗ログをorganization auditへ記録 | `packages/core/src/lib/password.js`, `packages/core/src/store/*store.js` |
| account disable/revocation | member status API、session revoke API、tokenVersion検証を追加。password reset、status変更、MFA登録で既存sessionを失効 | `services/gateway/src/server.js`, `packages/core/src/store/*store.js` |
| 管理者MFA/TOTP | privileged roleはTOTP必須。初回ログイン時に認証アプリ登録、以後6桁コード確認。challengeは署名付きでCloud Run複数instanceに依存しない | `services/gateway/src/server.js`, `packages/core/src/lib/totp.js` |
| MFA secret保護 | TOTP secretをAES-256-GCMで暗号化。productionでは`APP_FIELD_ENCRYPTION_KEY`必須。Secret Managerで管理する想定 | `packages/core/src/lib/field-crypto.js`, `services/gateway/src/server.js` |
| cookie-only/CSRF | frontendのoperator token localStorage fallbackを廃止。本番のoperator bearer authはdefault disabled。double-submit CSRF cookie/headerをstate-changing APIへ適用 | `apps/web/lib/operator-access.js`, `services/gateway/src/server.js` |
| security headers | API responseに`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, production HSTSを付与 | `services/gateway/src/server.js` |
| raw audio TTL | gateway memory上のfinalize待ちraw audioにTTL sweeperを追加。完了、破棄、録音再開、TTL expiryで削除しauditへ記録 | `services/gateway/src/server.js` |
| 管理UI | MFA登録/確認画面、member停止/再開、session失効、強化後password lengthを管理画面へ反映 | `apps/web/components/operator-login-panel.js`, `apps/web/components/admin-console.js` |
| tests/build | package unit testとweb production buildを確認 | `npm test`, `npm run build --workspace @medical/web` |

production反映前に必要な環境変数:

- `APP_FIELD_ENCRYPTION_KEY`: TOTP secret暗号化用。32 byte base64urlをSecret Managerで管理する。
- `APP_REQUIRE_PRIVILEGED_MFA=true`: privileged role MFAを有効化する。defaultはtrue。
- `APP_ALLOW_OPERATOR_BEARER_AUTH=false`: production defaultはfalse。明示してcookie-onlyを固定する。
- `PENDING_FINALIZE_AUDIO_TTL_MS`: gateway memory上のfinalize待ち音声TTL。初期値は30分。

#### 今回の低コスト枠だが次バッチで実装予定

次は引き続き少額または無料枠で進める。今回の実装に含めなかったが、修正予定から外したわけではない。

| 領域 | 次の修正方針 |
|---|---|
| device registry | trusted recorderをFirestoreへ永続化し、device revoke API/UI、最終利用時刻、端末名、状態を管理する |
| retention cleanup | Firestore session/turn/SOAP/audio metadataを対象にdry-run付きcleanup処理を作り、Cloud Scheduler 1 jobで起動する |
| GCS短期audio buffer | gateway memory依存をやめ、finalize待ちraw audioを24時間以内TTLのGCS objectへ移す |
| Cloud Tasks finalize | stop recording後のfinalizeをCloud Tasks経由にし、gateway request lifetimeと切り離す |
| app-level audit schema整理 | auth、member、MFA、device、retention、AI送信のevent type/payloadを棚卸しし、検索しやすいschemaへ揃える |
| LLM安全テスト | prompt injection、PHI漏えい誘導、出力形式破壊をmock testとして追加し、API費用なしでCIに入れる |
| runbook/docs | backup/restore、外部AI送信説明、BCP、責任分界表、production環境変数checklistを初版化する |

#### 今回対象外だが今後修正予定

以下は少額を超える可能性があるため今回の実装対象外にした。ただし、本番公開、医療機関導入、または実患者PHI運用の前提条件として継続して対応予定とする。

| 領域 | 今後の扱い |
|---|---|
| Firestore backup/PITR | 実患者PHIのproduction前に必須。scheduled backupまたはPITRを有効化し、復旧演習を実施する |
| Cloud Logging長期保管/sink | audit要件と保持期間を決めたうえで、別project/bucketへのsinkまたは保全方法を決める |
| Cloud Armor / WAF / LB | closed pilotではapp-level防御で開始可能。本公開前に入口防御として再評価する |
| KMS/CMEK | 初期はSecret Manager keyでfield encryption。enterprise要件または契約要件が出た段階でKMS/CMEKへ移行する |
| SIEM/EDR/MDM | 導入規模が増え、運用担当と監視フローを持てる段階で導入する |
| ISMS/ISO 27001、外部ペンテスト | 販売/大型導入前に必要。審査・外部委託費が大きいため今回対象外 |
| OpenAI/Deepgramの契約/ZDR/MAM確認 | 実患者PHIを本番送信するなら必須。契約・保持・学習利用・subprocessor説明の証跡を残す |

### Phase 0: まず直す小さな堅牢化

目的: P0実装に入る前に、現行リスクを小さくする。

対象:

- `packages/core/src/lib/pairing-token.js`
- `services/gateway/src/server.js`

修正:

1. `verifyToken` の `JSON.parse` をtry/catchし、不正tokenは例外ではなく `null` にする。
2. bearer/cookie/stream tokenの最大長を決める。例: 4096 bytes超は即401。
3. `startSoapGeneration` の `runFinalize(...).catch` でも `pendingFinalizeAudio` と `pendingFinalTranscriptJobs` の扱いを明示する。
   - retry優先なら `failedAt`, `expiresAt` を持つjobにする。
   - PHI最小保持優先なら失敗時も削除し、再録音を促す。
   - 医療SaaSとしては「短期TTL付きretry」を推奨する。
4. `pendingFinalizeAudio` にTTL sweeperを追加する。例: 30分を超えたraw audioを削除し、auditに `audio.buffer.expired` を残す。

受け入れ条件:

- malformed tokenで500が返らない。
- finalize失敗後もraw audioが無期限にMapへ残らない。
- raw audio削除時にPHI本文を含まないaudit eventが残る。

### Phase 1: MFAを実装する

目的: 厚労省チェックリストの二要素認証項目を満たし、管理者アカウント侵害リスクを下げる。

最初はTOTPを推奨する。WebAuthn/passkeyの方が理想だが、導入時の端末/ブラウザ/サポート負荷が大きい。TOTPでMFA必須化の土台を作り、後でWebAuthnを追加できるデータモデルにする。

対象:

- `packages/contracts/src/index.js`
- `packages/core/src/store/firestore-store.js`
- `packages/core/src/store/in-memory-store.js`
- `services/gateway/src/server.js`
- `apps/web/lib/operator-access.js`
- `apps/web/components/admin-console.js`
- login画面コンポーネント

データモデル:

- `members/{memberId}`
  - `mfaRequired: boolean`
  - `mfaEnrolledAt: string | null`
  - `mfaMethods: ["totp"]`
  - `mfaResetRequired: boolean`
- `login_identities/{identityKey}`
  - `failedLoginCount: number`
  - `lockedUntil: string | null`
  - `tokenVersion: number`
- `member_private/{memberId}` または暗号化可能なprivate field
  - `totpSecretEncrypted`
  - `recoveryCodeHashes[]`

API:

- `POST /api/v1/operator/login`
  - passwordが正しいがMFA必須ならcookie/tokenを発行せず、`{ requiresMfa: true, challengeId, expiresAt }` を返す。
  - MFA不要、または移行期間中の未必須userのみsession発行。
- `POST /api/v1/operator/mfa/verify`
  - `challengeId + totpCode` を検証し、成功時だけHttpOnly cookieを発行する。
- `POST /api/v1/operator/mfa/enroll/start`
  - QR用otpauth URIを返す。
- `POST /api/v1/operator/mfa/enroll/confirm`
  - TOTP検証後にMFAを有効化する。
- `POST /api/v1/admin/members/:memberId/mfa/reset`
  - 管理者がMFAをリセットする。audit必須。

実装方針:

1. 管理者ロール `platform_admin`, `org_owner`, `org_admin`, `it_admin` は `mfaRequired=true` を必須にする。
2. 初期移行では一般ロールは任意、production rollout後に全operator必須へ切り替える。
3. session tokenには `amr: ["pwd", "otp"]` と `mfaAt` を入れる。
4. 管理者APIは `amr` に `otp` がないtokenを拒否する。
5. TOTP secretはFirestore平文保存を避ける。最低限Secret Manager/KMS由来の鍵でアプリケーション層暗号化する。
6. MFA enroll/reset/login success/failureをauditに残す。TOTP値やsecretは絶対に残さない。

受け入れ条件:

- 管理者はMFA未完了ではadmin console/APIを開けない。
- passwordだけ漏れてもsession cookie/access tokenは発行されない。
- MFA resetは監査ログにactor, target member, timestampが残る。
- in-memory storeでもテスト可能。

### Phase 2: アカウント無効化とsession revocation

目的: 退職者/異動者/不要アカウントを確実に止める。

対象:

- `packages/contracts/src/index.js`
- `packages/core/src/store/firestore-store.js`
- `packages/core/src/store/in-memory-store.js`
- `services/gateway/src/server.js`
- `apps/web/components/admin-console.js`

データモデル:

- `members/{memberId}.status`
  - `active`
  - `disabled`
  - `locked`
  - `pending_mfa`
- `members/{memberId}.disabledAt`
- `members/{memberId}.disabledByMemberId`
- `login_identities/{identityKey}.tokenVersion`
- `login_identities/{identityKey}.sessionRevokedBefore`

API:

- `PATCH /api/v1/admin/members/:memberId/status`
  - active/disabled/lockedを変更。
  - 自分自身の最後の管理者権限を無効化できないguardを入れる。
- `POST /api/v1/admin/members/:memberId/revoke-sessions`
  - `tokenVersion` incrementまたは `sessionRevokedBefore=now`。
- `GET /api/v1/admin/access-review`
  - active members、last login、roles、MFA状態、最終操作日時を一覧化。

実装方針:

1. `requireOperatorAuth` は署名tokenだけで通さず、現在のmember/identity statusとtokenVersionを確認する。
2. すべての管理APIでdisabled/locked memberを拒否する。
3. role変更、password reset、MFA reset、status変更ではsession revocationを強制する。
4. admin consoleに「無効化」「セッション失効」「MFA状態」を表示する。

受け入れ条件:

- disabled memberの既存cookie/tokenは次リクエストで拒否される。
- account status変更はauditに残る。
- 最後のorg owner/org adminを誤って無効化できない。

### Phase 3: raw audio保持を本番向けに作り替える

目的: gateway memory上のPHI滞留をなくし、復旧可能で削除可能な音声処理にする。

短期修正:

- `pendingFinalizeAudio` はTTL付きにする。
- finalize失敗時の保持期間を明示する。
- `/healthz` またはadmin diagnosticにraw audio pending件数と総byte数だけ出す。PHI本文は出さない。

本命構成:

- Cloud Storage bucket: `AUDIO_BUCKET`
- Cloud Tasks queue: `finalize-session`
- Cloud Run: `medical-finalize`
- Firestore session fields:
  - `rawAudioPath`
  - `rawAudioSha256`
  - `rawAudioByteLength`
  - `rawAudioExpiresAt`
  - `finalizeJobId`
  - `finalizeAttempts`

実装方針:

1. 録音停止時、PCMをgateway memoryへ長期保持せずGCSへ書く。
2. GCS object名は `orgId/sessionId/attemptId/audio.wav` のようにguessしにくいprefixを含める。
3. GCS object metadataにPHI本文は入れない。
4. bucket lifecycleで短期音声を自動削除する。例: 1日または7日。
5. Cloud Tasksからprivate finalizeへOIDC付きで起動する。
6. finalize成功後、設定に応じて音声を即削除または期限削除へ任せる。
7. finalize失敗時もretry上限後に音声削除または隔離する。

受け入れ条件:

- Cloud Run再起動後もfinalize jobを再開できる。
- raw audioの保存場所、期限、削除イベントが追跡できる。
- gateway process memoryに長時間PHI audioが残らない。
- bucket lifecycleとアプリ側削除の両方がテストされている。

### Phase 4: 保持期限と削除ジョブ

目的: `retentionPolicy` を実データ削除に接続する。

対象:

- `packages/core/src/store/firestore-store.js`
- 新規: `services/maintenance` または `scripts/run_retention_cleanup.mjs`
- Cloud Scheduler

データ分類:

- audio: 最短保持。原則、SOAP生成後は削除。
- live transcript/final transcript: 診療記録の一部として扱う。
- SOAP draft/approved note: 医療機関契約と保存義務に合わせる。
- audit logs: PHI本文なしで長めに保持。

実装方針:

1. orgごとに以下を持つ。
   - `audioRetentionHours`
   - `draftRetentionDays`
   - `transcriptRetentionDays`
   - `approvedSoapRetentionDays`
   - `auditRetentionDays`
2. retention cleanupはdry-run modeを必須にする。
3. 削除対象件数、削除byte数、対象期間をaudit/admin logへ残す。
4. 医療機関との契約で「診療録本体は電子カルテへ転記後、本サービス側は短期保持」などを選べるようにする。

受け入れ条件:

- stagingでdry-run結果を確認できる。
- 指定日数超過データが自動削除される。
- 削除ログにPHI本文が含まれない。
- 誤削除復旧のため、production導入前にバックアップ/復旧手順が完成している。

### Phase 5: バックアップ/BCP/復旧演習

目的: サイバー攻撃や障害時に医療機関へ説明できる復旧体制を作る。

成果物:

- `docs/security/bcp.md`
- `docs/security/backup-restore-runbook.md`
- `docs/security/incident-response-runbook.md`
- `docs/security/contact-matrix.md`

GCP方針:

1. Firestore PITRまたはscheduled backupを有効化。
2. GCS bucketはversioning/lifecycle/retention方針を明記。
3. Secret Managerのrotation手順を作る。
4. Cloud Run service configをIaCまたはscriptで再現可能にする。
5. 復旧演習はstagingで四半期、本番相当で年1回。

受け入れ条件:

- RPO/RTOが文書化されている。
- Firestore restore手順を実行した証跡がある。
- インシデント時の社内/医療機関連絡テンプレートがある。
- 連絡体制図と責任者が明記されている。

### Phase 6: 外部AI委託管理

目的: OpenAI/Deepgramへ送信される医療情報の説明責任を満たす。

成果物:

- `docs/security/external-ai-processing.md`
- `docs/security/subprocessors.md`
- `docs/security/data-flow-and-retention.md`

実装/運用方針:

1. OpenAI projectはZDRまたはMAM対象にする。未承認なら本番PHI投入を止める判断基準を置く。
2. Deepgramも契約、保持、学習利用、リージョン、削除、サブプロセッサを確認する。
3. runtime configに `EXTERNAL_AI_PROCESSING_CONFIRMED=true` のようなproduction guardを追加し、未確認のproduction起動を失敗させる案を検討する。
4. OpenAI Responses APIは `store:false` を共通wrapperで強制する。
5. Web Search、Files、Vector Storeなど、保持や外部アクセスが増えるAPIを禁止リスト化する。

受け入れ条件:

- 医療機関に渡せる外部送信説明がある。
- providerごとの保持期間、削除依頼、サブプロセッサが文書化されている。
- production環境のOpenAI project設定を確認した証跡がある。

### Phase 7: rate limit, CSRF, security headers

目的: public gateway前提の入口防御を強化する。

rate limit:

1. Cloud Armorをgateway前段に置く。
2. loginはIP、org/loginId、org全体の3軸で制限する。
3. app内のrate limitはin-memoryだけに依存しない。
4. `getClientIp` はleftmost X-Forwarded-Forを無条件採用しない。

CSRF/session:

1. productionはcookie-onlyを基本にし、localStorage token fallbackを廃止する。
2. cross-site cookieを維持する場合はCSRF tokenを必須にする。
3. 可能ならwebとgatewayを同一siteに寄せ、`SameSite=Lax` へ戻す。

headers:

1. APIに `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, frame制御を入れる。
2. webにCSPを入れる。
3. HSTSは本番独自ドメイン確定後に有効化する。

受け入れ条件:

- localStorageにoperator tokenが残らない。
- state-changing APIはCSRF tokenなしで403。
- Cloud Armorまたは同等の入口rate limitが有効。
- securityheaders系のスキャンで重大な欠落がない。

### Phase 8: 監査ログ/アラート

目的: 侵害や誤操作を検知し、医療機関へ説明できる証跡を残す。

イベント標準化:

- `auth.login.success`
- `auth.login.failed`
- `auth.mfa.failed`
- `member.created`
- `member.disabled`
- `member.password_reset`
- `member.mfa_reset`
- `role.changed`
- `session.created`
- `recording.started`
- `recording.stopped`
- `soap.generated`
- `soap.approved`
- `soap.exported`
- `retention.deleted`

実装方針:

1. event schemaをcontracts化する。
2. audit eventにはPHI本文を入れない。
3. Cloud Logging sinkを専用log bucketへ送る。
4. 管理者操作、大量ログイン失敗、異常なexportをアラート化する。
5. org admin向けaudit exportを追加する。

受け入れ条件:

- 主要な管理操作とPHIアクセス操作がauditで追える。
- audit logは改ざんしにくい保管先へ転送される。
- アラートの通知先と対応手順が文書化されている。

### Phase 9: CI/security gate

目的: 依存関係、secret、containerの脆弱性を継続的に検出する。

追加するもの:

- DependabotまたはRenovate
- `npm audit --audit-level=high`
- CodeQLまたはSemgrep
- Gitleaks
- TrivyまたはGrype
- CycloneDX SBOM

受け入れ条件:

- PRで高リスク依存関係脆弱性が検出される。
- secretらしき値がcommitされると失敗する。
- container imageのcritical/high脆弱性がrelease前に見える。
- SBOMがbuild artifactとして残る。

### Phase 10: 医療機関向け開示資料

目的: medimoのISMS公開情報のように、外部から見える信頼材料を作る。

成果物:

- `docs/security/mds-sds.md`
- `docs/security/sla.md`
- `docs/security/shared-responsibility.md`
- `docs/security/security-whitepaper.md`
- `docs/security/annual-security-checklist.md`

内容:

1. 取り扱う医療情報の種類。
2. データフロー。
3. 外部送信先。
4. 保存場所と保持期間。
5. 暗号化。
6. 認証/MFA。
7. 権限管理。
8. 監査ログ。
9. バックアップ/BCP。
10. インシデント連絡。
11. 医療機関側で必要な運用。

受け入れ条件:

- 医療機関のセキュリティ確認にそのまま提出できる。
- 事業者確認用チェックリストに回答できる。
- 契約/SLA/責任分界と矛盾しない。

### 推奨Issue分割

1. `SEC-P0-01 malformed token and raw audio TTL hardening`
2. `SEC-P0-02 admin MFA with TOTP`
3. `SEC-P0-03 member disable and session revocation`
4. `SEC-P0-04 raw audio GCS + finalize worker`
5. `SEC-P0-05 retention cleanup job`
6. `SEC-P0-06 backup and BCP runbooks`
7. `SEC-P0-07 external AI processing governance`
8. `SEC-P1-01 Cloud Armor and robust rate limiting`
9. `SEC-P1-02 cookie-only auth and CSRF`
10. `SEC-P1-03 security headers and CSP`
11. `SEC-P1-04 audit log sink and alerting`
12. `SEC-P1-05 CI security gate`
13. `SEC-P1-06 device registry and revocation`
14. `SEC-P1-07 LLM prompt injection tests`
15. `SEC-P2-01 medical security disclosure package`

## 最終評価

現行実装はMVPとしてのアプリ内防御は一定水準にある。特にFirestore直アクセス拒否、RBAC、署名トークン、Secret Manager前提、PHIをログへ出さない方針は良い。

ただし、医療情報を扱う本番SaaSとしては、コードの脆弱性というより、医療ガイドラインが求める運用証跡と責任分界がまだ薄い。最重要差分は、MFA、アカウント無効化、バックアップ/BCP、保持/削除、外部AI委託、監査ログ運用である。

medimoの公開例のように医療AIサービスとして信頼を取るには、機能の安全性だけでなく、ISMS/第三者評価、医療機関へ渡せる開示書、年次運用、インシデント対応まで含めた「説明可能な管理体制」が必要になる。
