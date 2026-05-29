# Product Spec

## 概要

`ハルナス` は、外来診療の会話を録音し、リアルタイム書き起こしと SOAP 下書き作成を行う診療記録アシスタントである。

現在の実装は、診療フロー本体に加えて、設定管理、権限管理、公開申込、初回パスワード設定、契約状態表示まで含む。

## 現在のサーフェス

### 認証済み

- `/` 診療ダッシュボード
- `/sessions/[sessionId]` 診療ワークスペース
- `/admin` 設定 / 管理コンソール
- `/billing` 実体は `/admin?section=account` へ誘導

### 公開

- `/contact-signup`
- `/contact-signup/submitted`
- `/contact-signup/verify`
- `/setup-password/[tokenId]`
- `/mobile/join`
- `/mobile/recorder`
- `/mobile/audio-test`

## 主な利用フロー

1. 医療機関コード、個人 ID、パスワードでログインする。
2. ダッシュボードで新規診療を作成する。
3. 診療ワークスペースで録音方法を選ぶ。
4. スマホを QR / 接続リンクで参加させるか、この PC のマイクを録音元にする。
5. 録音中はリアルタイム書き起こしを表示する。
6. 録音停止後に final transcript と SOAP を作成する。
7. 医師が内容を確認し、必要なら再生成・手修正・承認する。

## 機能要件

### FR-01 ログインとアクセス制御

- ログインは `organizationCode + loginId + password` を使う。
- 特権ロールには MFA を要求できる。
- 組織の `access.status` に応じて、ログイン可否と診療操作可否を切り替える。

### FR-02 セッション作成と履歴

- ダッシュボードから新規診療を開始できる。
- 既存セッションを検索、状態フィルタ、ページング付きで確認できる。
- セッションのホーム一覧からの非表示化を行える。

### FR-03 デバイス参加

- 録音スマホは QR または接続リンクで参加できる。
- pairing token は短命で、再発行時に旧 token を失効させる。
- 1 セッションにつき 1 つの active pairing を前提とする。

### FR-04 録音ソース

- 録音ソースは `linked_mobile` と `local_browser` の 2 種類を持つ。
- スマホ参加時は、スマホまたは PC から録音開始できる。
- PC 録音時は trusted recorder / local recorder の割当を扱える。

### FR-05 リアルタイム書き起こし

- PC UI は partial / final transcript を WebSocket で受信する。
- final turn は永続化される。
- unstable な partial と finalized text を UI 上で区別する。

### FR-06 録音停止と finalization

- 録音停止で live STT を閉じ、セッションを `finalizing` に遷移させる。
- 既定は gateway 内 `inline` finalization である。
- `FINALIZE_MODE != inline` の場合は GCS / finalize worker / Cloud Tasks の経路に切り替えられる。

### FR-07 SOAP 生成

- SOAP は stop 後に生成できる。
- primary output は `outputText` であり、EMR に貼り付けやすい平文を返す。
- provider 由来の JSON は `structuredJson` として保持する。
- 公開済み prompt profile を選択して SOAP を再生成できる。

### FR-08 レビューと承認

- 医師は SOAP を手修正して保存できる。
- 承認すると `approved` 状態に遷移する。
- transcript と SOAP の全文コピーを行える。

### FR-09 設定 / 管理

- `/admin` ではロールに応じて以下を表示する。
- 権限管理
- プロンプト設定
- 音声テスト
- 操作ログ
- アカウント

### FR-10 公開申込と初回設定

- 公開フォームから問い合わせ申込を送信できる。
- メール確認リンクから病院アカウント作成と初回パスワード設定に進める。
- 契約状態はログイン後のアカウント画面で確認できる。

## 非機能要件

### 性能

- partial transcript latency: `p50 < 700 ms`
- finalized turn latency: `p95 < 2.0 s`
- SOAP ready after stop: `p95 < 20 s`

### 可用性

- live STT の provider fallback を持つ
- reconnect 後に HTTP fetch + WebSocket で状態を復元できる
- stop 後に final transcript が短すぎる場合は live transcript を安全側で採用する

### セキュリティ

- browser session は HttpOnly cookie と CSRF で保護する
- pairing link は URL hash fragment を使い、token を request line に載せない
- REST / WebSocket ともにロールと session ownership を検証する
- 本番の特権 MFA では暗号化フィールド鍵を必須にする

### コスト

- Redis なしで運用開始できる
- hot path の partial transcript を Firestore に毎 token 書き込みしない
- gateway の live fanout は instance-local であるため、初期運用は `max-instances=1` を前提にする

## 現在の実装済み範囲

- ダッシュボード、診療ワークスペース、スマホ参加 UI
- PC / スマホの 2 録音モード
- リアルタイム書き起こし、final transcript、SOAP 生成
- 手修正、承認、再生成
- 組織 / メンバー / プロンプト / 監査ログ / 音声テスト
- 公開申込、メール確認、初回パスワード設定
- Stripe checkout / portal / webhook 処理

## 将来対応

- EMR export API
- 自動 speaker diarization の精度改善
- multi-instance fanout
- analytics / usage dashboard
- 外部 SSO や clinic IdP との連携
