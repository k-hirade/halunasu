# 2026-05-06 セキュリティ / 法令準拠チェック

対象:

- `medical` アプリ全体
- 本番 Cloud Run (`medical-gateway`, `medical-billing`, `medical-finalize`)
- 公開 LP / 法務ページ

目的:

- ToB SaaS として見たときに、明確な脆弱性や防御不足がないかを確認する
- 医療情報を扱うサービスとして、国内ガイドラインや個人情報保護の観点で、実装と運用に不足がないかを確認する

注意:

- 本メモは技術・運用観点の調査結果であり、法的助言ではない
- 「違法」と断定するものではなく、主に「準拠を主張するには証跡が不足している点」または「実装/運用を強化すべき点」を整理した

## 総評

- **P0 は確認していない**
  - 直ちに停止すべき、または高確度で悪用可能な認証回避・権限昇格・PHI 全件流出相当の脆弱性は、この調査範囲では見つかっていない
- **P1 は 4 件**
  - 主に「医療 SaaS としての境界防御」「外部委託先管理・越境移転説明」「内部 worker の公開状態」「BCP/復旧証跡」
- **P2 は 4 件**
  - 主に「ヘッダ/CSP の追加硬化」「Cookie/パスワードの強化」「公開 LP のヘッダ不足」「対外開示資料の厚み」

## 確認できた強い点

### 1. PHI への直接アクセスをフロントから許していない

- Firestore 直アクセスは禁止で、PHI は gateway 経由に集約されている
- 認可は組織境界とロールに寄せている

関連:

- `firestore.rules`
- `services/gateway/src/server.js`
- `packages/contracts/src/index.js`

### 2. 認証・トークンまわりは最低限の水準を満たしている

- パスワードは PBKDF2 SHA-256 / 210,000 iterations
- トークンは HMAC 署名
- MFA は privileged role に対して導入済み
- MFA secret は暗号化保存

関連:

- `packages/core/src/lib/password.js`
- `packages/core/src/lib/pairing-token.js`
- `packages/core/src/lib/field-crypto.js`
- `services/gateway/src/server.js`

### 3. 監査・保持期限まわりは以前より改善されている

- 監査イベントは多くの重要操作で記録される
- raw audio bucket は public access prevention / uniform bucket-level access / 7日 lifecycle が入っている
- retention cleanup 用 scheduler job が存在する

確認した実運用:

- `gs://medical-492407-raw-audio`
  - `public_access_prevention = enforced`
  - `uniform_bucket_level_access = true`
  - `age = 7` の delete lifecycle
- Cloud Scheduler
  - `medical-retention-cleanup`
  - `medical-billing-enforce-trial-expiration`
  - `medical-billing-enforce-grace-periods`

### 4. 公開申込導線は以前より安全になっている

- 旧 `/signup` backend は削除済み
- 新規導線は `/contact-signup` に一本化済み
- verify は `GET` で副作用を起こさず、明示 `POST` で処理する形に修正済み
- public status の返却内容も縮小されている

関連:

- `services/billing/src/routes/contact-signup.js`
- `docs/impl/2026-04-28-billing-security-refactor-audit.md`

## Findings

## P1

### P1-01 `medical-finalize` が public ingress のまま公開されている

現状:

- 本番 `medical-finalize` は Cloud Run の `run.googleapis.com/ingress = all`
- `https://medical-finalize-76iydsp3na-an.a.run.app` で公開されている
- 認証は `X-Finalize-Internal-Secret` の shared secret に依存している

関連:

- `services/finalize/src/server.js`
- 本番 Cloud Run 設定 (`medical-finalize`)

評価:

- 現時点で即 exploitable とまでは言わない
- ただし、医療情報を扱う内部 worker としては、防御が **アプリ層の shared secret だけ** なのは弱い
- 誤設定・ログ漏えい・将来の経路追加に対して脆い

ToB / 医療 SaaS 観点:

- 内部専用 worker は、公開 URL ではなく **private ingress + IAM/OIDC** が自然
- 厚労省 6.0 と医療情報サービス提供者ガイドライン 2.0 の文脈では、役割分離と通信経路保護の説明責任が弱い

提案:

1. `medical-finalize` を internal / internal-and-cloud-load-balancing に寄せる
2. Cloud Tasks からの呼び出しは OIDC + `run.invoker` へ変更
3. `FINALIZE_INTERNAL_SECRET` は二重化対策として残してもよいが、主防御にしない

### P1-02 外部委託先・越境移転の説明と実運用が一致していない

現状:

- 本番 gateway は `LIVE_STT_FALLBACK_PROVIDER=deepgram`
- `DEEPGRAM_API_KEY` も設定されている
- つまり本番では **Deepgram fallback** が有効
- しかし公開プライバシーポリシーには **Deepgram の記載がない**

関連:

- `packages/core/src/stt/live-stt-config.js`
- `packages/core/src/stt/live-stt-pipeline.js`
- 本番 `medical-gateway` Cloud Run 設定
- `medical-lp/privacy.html`

評価:

- これは単なる docs 漏れではなく、**患者データの外部送信先説明の不一致**
- 医療機関が本人説明・同意取得を行う前提なら、委託先・再委託先・越境移転先の説明材料は一致している必要がある

提案:

1. `privacy.html` に Deepgram を追加
2. OpenAI / Deepgram / Resend / Stripe / Google Cloud について、用途・送信データ・保存の有無・主な移転先を統一表で管理
3. 医療機関向けに、委託先一覧と責任分界を別紙化する

### P1-03 OpenAI / Deepgram の保持制御・契約証跡がリポジトリから確認できない

現状:

- OpenAI Responses API では `store: false` を指定している
- ただし、Realtime / Audio Transcriptions / Deepgram については、**本番 org/project の ZDR / Modified Abuse Monitoring / 契約条件** はコードから証明できない

関連:

- `packages/core/src/openai/responses-structured.js`
- `packages/core/src/stt/openai-live-stt.js`
- `packages/core/src/stt/openai-final-transcribe.js`
- `packages/core/src/stt/deepgram-live-stt.js`

評価:

- 実装としては最小限の保持抑制はしている
- ただし、医療サービスとしては
  - どの OpenAI project を使っているか
  - ZDR が有効か
  - Deepgram 側の保持/学習利用条件はどうか
  - DPA/契約書はあるか
 まで証跡化しないと説明責任が弱い

提案:

1. 本番 OpenAI project の `Data controls` 画面の証跡を保存
2. Deepgram の保持・学習利用・リージョン・subprocessor 条件を確認し保存
3. `docs/investigation` か runbook に、外部 AI 委託先管理のチェックリストを追加

### P1-04 BCP / 復元演習 / 対外開示資料の証跡が不足している

現状:

- retention cleanup、raw audio lifecycle、scheduler は実装済み
- 一方で、**復元演習の実施記録、RPO/RTO、サイバー攻撃想定 BCP、SLA/責任分界の対外資料** は repo から確認できない

関連:

- `docs/runbooks/security-operations.md`
- `docs/impl/2026-04-19-medical-security-gap-analysis.md`
- `docs/core/07-gcp-deployment.md`

評価:

- これはコード脆弱性ではない
- ただし、医療機関・薬局向けチェックリストや、提供事業者ガイドライン 2.0 の観点では重要
- 「実装はあるが、監査で見せる現物が弱い」状態

提案:

1. サイバー攻撃想定 BCP を作成
2. Firestore / GCS / Cloud Run の復元演習を実施し、結果を記録
3. 医療機関向けの SLA / 責任分界 / 開示書を別紙で整備

## P2

### P2-01 公開 LP に基本的なセキュリティヘッダが入っていない

現状:

- アプリ本体の `medical/netlify.toml` には
  - HSTS
  - CSP
  - `X-Frame-Options`
  - `X-Content-Type-Options`
  などがある
- 一方 `medical-lp/netlify.toml` は cache と redirect だけで、**セキュリティヘッダがない**

関連:

- `medical/netlify.toml`
- `medical-lp/netlify.toml`

評価:

- 申込導線そのものは app 側に寄せているので、即重大ではない
- ただし、LP / manual / legal pages も公開面なので、clickjacking / MIME sniffing / HSTS 未設定は残る

提案:

1. `medical-lp/netlify.toml` に app 相当の基本ヘッダを追加
2. 少なくとも
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy`
   - `X-Frame-Options: DENY`
   - `Strict-Transport-Security`
   を入れる

### P2-02 ブラウザ側 hardening はまだ詰められる

現状:

- アプリの CSP はあるが `script-src 'unsafe-inline'` と `style-src 'unsafe-inline'` を含む
- operator session cookie は `HttpOnly; Secure; SameSite=None` だが、`__Host-` prefix ではない

関連:

- `medical/netlify.toml`
- `packages/core/src/lib/auth.js`

評価:

- いまの実装でも実用上は成立している
- ただし ToB の堅牢性としては、より詰められる

提案:

1. Next.js / inline script 要件を整理し、nonce/hash ベース CSP へ段階移行
2. Cookie 名を `__Host-` prefix に寄せられるか検討
3. `SameSite=None` が本当に必要な経路を棚卸しする

### P2-03 パスワード対策は最低限で、流出済みパスワード対策がない

現状:

- 12文字以上、英字/数字/記号を要求
- ハッシュ強度も十分
- ただし
  - password history
  - breached password check
  はない

関連:

- `packages/core/src/lib/password.js`

評価:

- 緊急性は低い
- ただし、管理者中心の ToB サービスで MFA 併用とはいえ、もう一段上げられる

提案:

1. パスワード再設定時の履歴チェック
2. 少なくとも上位漏えいパスワード blacklist
3. 可能なら HIBP k-Anonymity 型の照合検討

### P2-04 利用規約・法務ページだけでは責任分界の説明が薄い

現状:

- 利用規約、プライバシーポリシー、特商法ページは存在する
- ただし、医療機関向けサービスとして重要な
  - 正式診療録ではなく下書きであること
  - 医療機関側が行う同意取得
  - 障害時・委託先利用時の責任分界
  - サービスレベル
  を営業/契約資料としてまとめたものは見当たらない

関連:

- `medical-lp/terms.html`
- `medical-lp/privacy.html`
- `medical-lp/tokushoho.html`

評価:

- これはアプリ脆弱性ではない
- ただし、医療機関の情シス・院長決裁・監査では重要

提案:

1. `サービス仕様適合開示書`
2. `責任分界`
3. `SLA`
4. `外部委託先一覧`

を別紙で整備する

## 優先順位

1. **P1-01** `medical-finalize` の private 化
2. **P1-02** プライバシーポリシーへ Deepgram 追加、外部委託先説明の整合
3. **P1-03** OpenAI / Deepgram の契約・保持・ZDR 証跡の保存
4. **P1-04** BCP / 復元演習 / 開示書の整備
5. **P2-01** LP へのセキュリティヘッダ追加
6. **P2-02 / P2-03** CSP / Cookie / パスワード hardening

## 参考基準

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
