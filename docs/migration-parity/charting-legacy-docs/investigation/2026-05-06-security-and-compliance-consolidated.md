# 2026-05-06 セキュリティ / 医療法令準拠チェック 統合版

対象:

- `medical/` 全体
  - `services/gateway`
  - `services/billing`
  - `services/finalize`
  - `apps/web`
  - `packages/core`
- `medical-lp/`
- 本番 Cloud Run / Cloud Storage / Cloud Scheduler の実運用設定

位置づけ:

- 本文書は、同日作成の個別メモ
  - `2026-05-06-security-and-compliance-review.md`
  - `2026-05-06-security-and-compliance-audit.md`
  を読み合わせて整理した**統合版**である
- 重複は避け、実装・運用設定・公開文書の突合で再確認できた事項だけを残している

注意:

- 法的助言ではない
- 「違法」と断定するものではなく、**ToB SaaS としての脆弱性**と、**医療情報を扱うサービスとして準拠を説明するための不足**を整理した

## 結論

- **P0 は無し**
  - この調査範囲では、認証回避、権限昇格、PHI 全件漏えいに直結する高確度の即時停止案件は確認していない
- **P1 は 6 件**
  - 実装修正が必要なものと、医療機関向け説明責任に関わるものが混在している
- **P2 は 5 件**
  - hardening、公開面、継続的運用の強化が中心

## Progress

2026-05-06 時点で、以下は着手済みまたは事実確認済みである。

- `trust proxy=true` は code 上 `TRUST_PROXY_HOPS` ベースへ修正着手
- `password-setup` の GET / POST には rate limit 追加着手
- `BILLING_INTERNAL_SECRET` は production 必須化、および timing-safe 比較へ修正着手
- 公開 privacy には Deepgram 追記着手
- 外部 AI 処理・責任分界・SLA・復元 runbook の内部 docs 雛形を追加
- OpenAI / Deepgram / 復元演習の証跡収集テンプレートを追加
  - `docs/security/evidence/openai-data-controls-checklist.md`
  - `docs/security/evidence/deepgram-vendor-evidence.md`
  - `docs/security/evidence/restore-drill-template.md`
- `medical-finalize` は STG / PROD とも **ingress=internal** へ切替済み
- `gateway` / `billing` の公開エラー応答は `publicMessage` / `safeMessage` 優先へ見直し、admin SOAP preview SSE でも raw provider error をそのまま返さないよう修正着手
- STG / PROD の `medical-gateway` はどちらも
  - `FINALIZE_MODE=worker`
  - `FINALIZE_TASKS_QUEUE=session-finalize`
  - `FINALIZE_TASKS_SERVICE_ACCOUNT_EMAIL=medical-tasks-invoker-sa@...`
  を設定しており、Cloud Tasks 経由で `medical-finalize` を起動していることを確認した

したがって、P1 の中でも
- `trust proxy`
- `password-setup`
- billing internal secret
- privacy の委託先整合
は **修正進行中**、
- `medical-finalize` は **STG / PROD とも internal ingress へ hardening 済み**
として扱う。

## 確認できた強い点

### 1. PHI の直接アクセス経路は絞れている

- Firestore はクライアント直アクセス禁止
- PHI は gateway 経由でのみ扱う
- RBAC と組織境界の考え方は入っている

根拠:

- `firestore.rules`
- `services/gateway/src/server.js`
- `packages/contracts/src/index.js`

### 2. 認証・秘密情報の基本は押さえている

- パスワード: PBKDF2 SHA-256 / 210,000 iterations
- 署名トークン: HMAC
- privileged role には TOTP MFA
- MFA secret は AES-256-GCM で暗号化保存

根拠:

- `packages/core/src/lib/password.js`
- `packages/core/src/lib/pairing-token.js`
- `packages/core/src/lib/field-crypto.js`
- `services/gateway/src/server.js`

### 3. 監査・保持期限・削除まわりは以前より前進している

- 監査イベントが主要操作に入っている
- raw audio bucket は public access prevention / uniform bucket-level access / 7日 lifecycle 済み
- retention cleanup scheduler が存在する

確認した実運用:

- `gs://medical-492407-raw-audio`
  - `public_access_prevention = enforced`
  - `uniform_bucket_level_access = true`
  - lifecycle delete age `7`
- Cloud Scheduler
  - `medical-retention-cleanup`
  - `medical-billing-enforce-trial-expiration`
  - `medical-billing-enforce-grace-periods`

### 4. 公開申込導線は整理されている

- 旧 `/signup` backend は削除済み
- 新規導線は `/contact-signup` に一本化
- verify は `GET` で副作用を起こさず、明示 `POST` に分離済み
- public status 返却も縮小済み

根拠:

- `services/billing/src/routes/contact-signup.js`
- `docs/impl/2026-04-28-billing-security-refactor-audit.md`

## Findings

## P1

### P1-01 `trust proxy=true` のままで、IP ベース制御の信頼性が弱い

ステータス:

- **修正着手済み**

現状:

- `services/gateway/src/server.js`
- `services/billing/src/server.js`

の両方で `app.set("trust proxy", true);` を使っている。

懸念:

- Cloud Run / GCLB 配下で `trust proxy=true` を雑に使うと、`req.ip` が **クライアント投入の X-Forwarded-For に影響される** 余地が残る
- その結果、
  - レートリミット
  - 監査ログ上の IP 識別
の信頼性が下がる

影響:

- 即認証回避ではない
- ただし、login / MFA / public signup の abuse control の実効性に影響するので、ToB SaaS として放置はよくない

提案:

1. `trust proxy` を Cloud Run 前提の hop 数に絞る
2. `getClientIp` 相当の実装があれば、rightmost / trusted proxy 前提で明示制御する
3. IP だけに頼らず、account / email / org 軸との複合レートリミットを維持する

### P1-02 `medical-finalize` が public ingress のまま

ステータス:

- **対応済み**

追加確認:

- 2026-05-06 時点で、STG / PROD とも `run.googleapis.com/ingress = internal`
- STG / PROD gateway はどちらも `FINALIZE_MODE=worker` と `FINALIZE_TASKS_QUEUE=session-finalize` を設定
- Cloud Run 公式 docs 上も、同一 project の Cloud Tasks は `internal` ingress の到達元として許可される
- IAM 上も `medical-tasks-invoker-sa` が invoker で、匿名 invoker は確認されていない

解釈:

- 当初の「public ingress のまま」という懸念は解消した
- 以後の再deployでも戻らないよう、`scripts/deploy_finalize_cloud_run.sh` は `--ingress internal` 前提に修正した

現状:

- `medical-finalize` は internal ingress
- 防御は
  - Cloud Tasks + OIDC + `run.invoker`
  - `X-Finalize-Internal-Secret`
  の二層

根拠:

- `services/finalize/src/server.js`
- `scripts/deploy_finalize_cloud_run.sh`
- STG / PROD Cloud Run `medical-finalize` 設定

影響:

- すぐ exploit されるとまでは言わない
- ただし、**医療情報を扱う内部 worker を public URL + shared secret で守る**のは設計として弱い
- 将来の誤設定や secret 漏えい時の防御層が薄い

提案:

1. `medical-finalize` の internal ingress を維持する
2. Cloud Tasks からの OIDC + `run.invoker` を維持する
3. `FINALIZE_INTERNAL_SECRET` は補助防御として維持する

### P1-03 `password-setup` 公開エンドポイントにレートリミットがない

ステータス:

- **修正着手済み**

現状:

- `GET /api/v1/password-setup/:tokenId`
- `POST /api/v1/password-setup/:tokenId`

に明示のレートリミットがない

根拠:

- `services/billing/src/routes/password-setup.js`

影響:

- トークン自体は十分長く、総当たりの現実性は低い
- ただし
  - token 状態の観測
  - 大量リクエスト
  - onboarding 導線への妨害
への防御としては不十分

提案:

1. IP 軸
2. tokenId 軸

の 2 軸で `assertWithinRateLimit` 相当を追加する

### P1-04 公開プライバシーポリシーと実運用の外部委託先が一致していない

ステータス:

- **修正着手済み**

現状:

- 本番 gateway は `LIVE_STT_FALLBACK_PROVIDER=deepgram`
- `DEEPGRAM_API_KEY` も設定されている
- つまり Deepgram fallback は本番で有効
- しかし公開プライバシーポリシーには Deepgram の記載がない

根拠:

- `packages/core/src/stt/live-stt-config.js`
- `packages/core/src/stt/live-stt-pipeline.js`
- 本番 `medical-gateway` 設定
- `medical-lp/privacy.html`

影響:

- これは docs 漏れで済ませにくい
- 医療機関が患者への説明や院内審査を行う際に、**外部送信先説明の不一致**になる

提案:

1. `privacy.html` に Deepgram を追加
2. OpenAI / Deepgram / Stripe / Resend / Google Cloud の用途・送信データ・移転先を統一表で管理
3. 医療機関向けに外部委託先一覧を別紙化する

### P1-05 OpenAI / Deepgram の保持制御・契約証跡が repo から確認できない

ステータス:

- **雛形 docs 追加済み**
- **実証跡の取得は未完了**

追加進捗:

- OpenAI 用の確認テンプレートを `docs/security/evidence/openai-data-controls-checklist.md` に追加
- Deepgram 用の確認テンプレートを `docs/security/evidence/deepgram-vendor-evidence.md` に追加
- `docs/security/evidence/README.md` に収集対象と保存ルールを追記

現状:

- Responses API では `store: false` を使っている
- ただし本番 OpenAI project の
  - Zero Data Retention
  - Modified Abuse Monitoring
  - 実際の project / org 設定
は repo から確認できない
- Deepgram 側の保持・学習利用・subprocessor 証跡も repo にはない
- 加えて、現行コード上は Deepgram への `mip_opt_out=true` 付与が無く、学習利用の opt-out をコードで担保していない
- Deepgram の処理 region もコードからは固定できていない

根拠:

- `packages/core/src/openai/responses-structured.js`
- `packages/core/src/stt/openai-live-stt.js`
- `packages/core/src/stt/openai-final-transcribe.js`
- `packages/core/src/stt/deepgram-live-stt.js`

影響:

- 実装はある程度保守的
- しかし、医療 SaaS としては **「設定しているはず」では弱い**
- 委託先監督・越境移転説明・患者情報外部送信の説明責任が残る
- 特に Deepgram については、privacy 追記だけでは不十分で、学習利用 opt-out が契約既定値依存のまま残る

提案:

1. 本番 OpenAI project の `Data controls` 証跡を保存
2. Deepgram の契約条件、保持、学習利用、subprocessor を確認して保存
3. `docs/security` か `docs/investigation` に外部 AI 委託管理メモを常設する

次の具体作業:

1. OpenAI Platform で本番 key の属する org / project を特定
2. `Settings > Organization > Data controls` の org / project スクリーンショットを取得
3. Deepgram 契約画面または契約書から retention / DPA / MIP opt-out 条件を転記
4. `mip_opt_out=true` をコードで付けるか、契約既定値で十分とするか判断する
5. 上記テンプレートの未完了項目を埋める

### P1-06 BCP / 復元演習 / SLA / 責任分界の証跡が弱い

ステータス:

- **雛形 docs 追加済み**
- **実復元演習記録と対外版の整備は未完了**

追加進捗:

- `docs/security/bcp.md`
- `docs/security/backup-restore-runbook.md`
- `docs/security/sla.md`
- `docs/security/shared-responsibility.md`
- `docs/security/evidence/restore-drill-template.md`

を追加済み

現状:

- retention cleanup や bucket lifecycle はある
- ただし
  - Firestore / GCS / Cloud Run の復元演習記録
  - RPO / RTO
  - サイバー攻撃想定 BCP
  - 医療機関向け SLA / 責任分界
が repo から確認できない

根拠:

- `docs/runbooks/security-operations.md`
- `docs/impl/2026-04-19-medical-security-gap-analysis.md`
- `docs/core/07-gcp-deployment.md`

影響:

- コード脆弱性ではない
- ただし、厚労省 6.0 と医療情報サービス提供者ガイドライン 2.0 ではかなり重要
- 「実装はあるが、監査で出す現物が足りない」状態

提案:

1. 復元演習を実施し記録化
2. BCP / インシデント対応 / 連絡体制を runbook 化
3. `MDS/SDS/SLA/責任分界` を docs 化

次の具体作業:

1. STG で復元演習を 1 回実施
2. `docs/security/evidence/restore-drill-template.md` に記録
3. 課題を `backup-restore-runbook.md` へ反映

## P2

### P2-01 `BILLING_INTERNAL_SECRET` 検証は timing-safe でなく、起動時アサーションも弱い

現状:

- `services/billing/src/routes/internal-billing.js` は `===` 比較
- production で秘密未設定時に起動時 fail-fast も入っていない

評価:

- 直ちに危険というほどではない
- ただし internal endpoint を守るコードとしては雑

提案:

1. `timingSafeEqual` に揃える
2. production では未設定時に起動失敗

### P2-02 公開 LP に基本的なセキュリティヘッダがない

現状:

- `medical/netlify.toml` には CSP/HSTS 等がある
- `medical-lp/netlify.toml` には cache / redirect しかない

影響:

- LP / manual / legal pages も公開面
- clickjacking, HSTS, MIME sniffing 対策が薄い

提案:

1. `X-Content-Type-Options`
2. `Referrer-Policy`
3. `X-Frame-Options`
4. `Strict-Transport-Security`

を最低限入れる

### P2-03 app 側 CSP / Cookie hardening はまだ改善余地がある

現状:

- CSP に `script-src 'unsafe-inline'` と `style-src 'unsafe-inline'`
- operator session cookie は `HttpOnly; Secure; SameSite=None` だが `__Host-` prefix ではない

提案:

1. nonce/hash ベース CSP へ段階移行
2. `__Host-` cookie prefix を検討
3. `SameSite=None` が本当に必要な経路を棚卸しする

### P2-04 流出済みパスワード対策がない

現状:

- 12文字以上 + 英数字記号 + lockout はある
- ただし
  - breached password check
  - password history
はない

提案:

1. 既知漏えいパスワード blacklist
2. 可能なら HIBP k-Anonymity
3. パスワード履歴導入

### P2-05 対外開示資料がまだ薄い

現状:

- 利用規約、プライバシーポリシー、特商法ページはある
- ただし、医療機関が求める
  - SLA
  - 責任分界
  - サブプロセッサ一覧
  - インシデント通知方針
のまとまった資料は見当たらない

提案:

1. `docs/security/mds-sds.md`
2. `docs/security/sla.md`
3. `docs/security/shared-responsibility.md`
4. `docs/security/subprocessors.md`

を別途作る

## 医療法令・ガイドライン観点の整理

### 個人情報保護法

評価:

- 「医療機関が同意取得主体、ハルナスは委託先」という整理は妥当
- ただし、委託先監督・越境移転・第三者提供記録・漏えい報告の**証跡化**が弱い

不足:

- 委託先評価記録
- 第三者提供記録の運用
- 個情委報告テンプレ
- OpenAI / Deepgram の契約・保持証跡

### 厚労省 医療情報システム安全管理ガイドライン 6.0

評価:

- RBAC、MFA、監査、保持期限、暗号化の基本線はある
- ただし
  - 復元演習
  - BCP
  - 開示書
  - サービス事業者としての説明可能性
が弱い

### 厚労省 サイバーセキュリティ対策チェックリスト

評価:

- privileged MFA、アカウント無効化、ログ等は前進
- 一方で
  - 安全管理責任者
  - 資産台帳
  - 開示書 / SLA / 責任分界
  - 棚卸しレポート
の現物が不足

### 経産省 / 総務省 事業者向けガイドライン 2.0

評価:

- コードよりも、**説明責任のための文書群**が不足
- 特に
  - 責任分界
  - サービス仕様 / SLA
  - サブプロセッサ管理
  - 第三者認証
は課題

## 優先順

1. `trust proxy` の見直し
2. `medical-finalize` の private 化
3. `password-setup` のレートリミット
4. `privacy.html` に Deepgram 追加
5. OpenAI / Deepgram の契約・保持・ZDR 証跡整理
6. BCP / 復元演習 / SLA / 責任分界 docs 作成
7. `medical-lp` の security headers 追加

## 参考

- 厚生労働省: 医療情報システムの安全管理に関するガイドライン 第6.0版
  - https://www.mhlw.go.jp/stf/shingi/0000516275_00006.html
- 厚生労働省: 医療機関等におけるサイバーセキュリティ対策チェックリストマニュアル（令和7年5月）
  - https://www.mhlw.go.jp/content/10808000/001490741.pdf
- 経済産業省 / 総務省: 医療情報を取り扱う情報システム・サービスの提供事業者における安全管理ガイドライン 第2.0版
  - https://www.meti.go.jp/policy/mono_info_service/healthcare/teikyoujigyousyagl.html
- 個人情報保護委員会 / 厚生労働省: 医療・介護関係事業者における個人情報の適切な取扱いのためのガイダンス
  - https://www.ppc.go.jp/personalinfo/legal/iryoukaigo_guidance
- OpenAI: Your data / Zero Data Retention
  - https://developers.openai.com/api/docs/guides/your-data#zero-data-retention
  - https://developers.openai.com/api/docs/guides/your-data#storage-requirements-and-retention-controls-per-endpoint
