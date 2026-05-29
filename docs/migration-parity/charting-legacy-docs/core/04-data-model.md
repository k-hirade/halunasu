# Data Model

## 概要

現在の永続化は organization-centric な Firestore モデルを採用している。
旧 docs にあった `clinics/{clinicId}` や `users/{userId}` を主軸にした構成ではない。

## top-level collections

### `organizations/{orgId}`

病院 / 医療機関の主レコード。

主な項目:

- `orgId`, `clinicId`
- `organizationCode`
- `displayName`
- `status`
- `timezone`
- `defaultPromptProfileId`
- `recordingMaxDurationMinutes`
- `billing`
- `access`
- `createdAt`, `updatedAt`

### `organization_codes/{organizationCode}`

- 医療機関コードから `orgId` を引くための index

### `login_identities/{organizationCode:loginId}`

ログイン identity。

主な項目:

- `organizationCode`
- `loginId`
- `memberId`
- `passwordHash`
- `tokenVersion`
- `status`
- `mfaRequired`
- `mfaSecretEncrypted`
- `mfaEnrolledAt`
- `failedLoginCount`
- `lockedUntil`

### `signup_applications/{signupId}`

公開申込フローの状態。

主な項目:

- `source` 現在は `lp_contact_form`
- `organizationName`, `displayName`
- `adminName`, `adminDisplayName`
- `adminEmail`
- `phoneNumber`
- `seatEstimate`
- `notes`
- `planCode`
- `status`
- `emailVerifiedAt`
- `orgId`, `memberId`
- `passwordSetupTokenId`
- `stripeCustomerId`, `stripeSubscriptionId`, `stripeCheckoutSessionId`
- `expiresAt`
- `errorCode`, `errorMessageSafe`

### `email_verification_tokens/{tokenHash}`

- contact signup のメール確認 token
- `status`: `active`, `used`, `expired`
- 現在の TTL は `24h`

### `password_setup_tokens/{tokenHash}`

- 初回パスワード設定 token
- `status`: `active`, `used`, `expired`

### `stripe_event_receipts/{eventId}`

- webhook / internal replay 用の Stripe event receipt
- `status`: `received`, `processed`, `ignored`, `failed`

### `pairings/{pairingId}`

スマホ接続 token。

主な項目:

- `sessionId`
- `tokenHash`
- `shortCode`
- `status`: `active`, `claimed`, `expired`, `revoked`
- `claimedByDeviceId`
- `expiresAt`
- `claimedAt`
- `createdAt`

現在の pairing TTL は `30 分`。

### `audio_tests/{testId}`

- PC / モバイル音声テストの一時レコード
- 現在の TTL は `10 分`

### `encounter_index/{sessionId}`

- session 一覧や検索のための top-level index

## organization 配下

### `organizations/{orgId}/members/{memberId}`

病院内メンバー。

主な項目:

- `memberId`
- `displayName`
- `loginId`
- `roles`
- `status`
- `defaultPromptProfileId`
- `defaultRecordingSource`
- `mfaRequired`
- `mfaEnrolledAt`

### `organizations/{orgId}/trusted_recorders/{deviceHash}`

- trusted local recorder の登録状態
- `deviceId`, `label`, `status`, `registeredByMemberId`, `revokedAt`

### `organizations/{orgId}/prompt_profiles/{profileId}`

SOAP prompt profile の親レコード。

主な項目:

- `profileId`
- `displayName`
- `scope`: `organization`, `facility`, `department`, `member`
- `status`: `draft`, `active`, `archived`
- `approved`
- `currentVersionId`
- `currentDraftVersionId`
- `templateKey`
- `outputTemplate`
- `customization`
- `sections`

### `organizations/{orgId}/prompt_profiles/{profileId}/versions/{versionId}`

- prompt profile version の履歴

### `organizations/{orgId}/audit_events/{eventId}`

- organization 単位の監査ログ
- member 管理、recording policy、billing access 変更などを保持

### `organizations/{orgId}/encounters/{sessionId}`

診療セッション本体。コード上の名称は `encounter` だが、API では `session` として扱う。

主な項目:

- `sessionId`
- `orgId`, `clinicId`
- `facilityId`, `departmentId`
- `createdByMemberId`, `doctorMemberId`
- `accessMemberIds`, `hiddenByMemberIds`
- `status`
- `pairingCode`, `pairingTokenId`
- `title`
- `patientId`
- `patientSnapshot`
- `patientDisplayName`
- `visitReason`
- `promptProfileId`
- `promptProfileSelectedAt`
- `promptProfileSelectedByMemberId`
- `promptProfileSelectionSource`
- `latestSoapVersionId`
- `startedAt`, `stoppedAt`, `finalizedAt`, `approvedAt`
- `recordingMaxDurationMinutes`
- `recordingExpiresAt`
- `recordingAutoStopTaskName`
- `recordingStopReason`
- `lastSequenceNo`
- `liveSttProvider`, `finalSttProvider`, `soapProvider`
- `mobileConnectionState`
- `audioSourceType`
- `audioConnectionState`
- `audioDeviceId`, `audioDeviceLabel`
- `pcConnectionCount`
- `latestPartialPreview`
- `latestFinalTurnIndex`
- `rawAudioPath`
- `errorCode`, `errorMessageSafe`
- `createdAt`, `updatedAt`

## subcollections under encounter

### `turns/{turnId}`

finalized transcript turn。

主な項目:

- `turnIndex`
- `source`: `live_stt`, `final_repass`, `manual_edit`
- `speaker`: `unknown`, `doctor`, `patient`, `other`
- `text`
- `startMs`, `endMs`
- `confidence`
- `isCorrected`
- `provider`
- `createdAt`, `updatedAt`

### `soap_versions/{versionId}`

SOAP version 履歴。

主な項目:

- `versionId`
- `version`
- `status`: `generating`, `ready`, `failed`, `approved`
- `outputText`
- `structuredJson`
- `model`
- `promptVersion`
- `templateKey`
- `promptProfileId`
- `promptProfileVersionId`
- `resolvedPromptHash`
- `inputTranscriptRevision`
- `createdBy`
- `approvedByUserId`
- `createdAt`, `updatedAt`

### `audit_events/{eventId}`

session 単位の監査ログ。

代表例:

- `recording.started`
- `recording.stopped`
- `recording.discarded`
- `recording.auto_stopped`
- `session.metadata.updated`
- `final_transcript.precompute.started`
- `final_transcript.segment_precompute.completed`
- `soap.finalize.started`
- `soap.finalize.completed`
- `review_note.saved`
- `review_note.approved`

## status enum

### session

- `ready`
- `paired`
- `recording`
- `degraded_recording`
- `stopped`
- `finalizing`
- `soap_ready`
- `approved`
- `failed`

### billing

- `pending_checkout`
- `trialing`
- `active`
- `past_due`
- `grace_period`
- `canceled`
- `unpaid`

### access

- `pending_setup`
- `active`
- `billing_action_required`
- `suspended`
- `canceled`

## raw audio の扱い

- `FINALIZE_MODE=inline` では、raw audio は finalization 完了まで gateway memory に保持される
- `FINALIZE_MODE != inline` では、GCS 保存後に `rawAudioPath` が session に書かれる
- したがって `rawAudioPath` は常に埋まる前提ではない

## index と検索

主な一覧系は `encounter_index` と organization 配下の encounter を併用する。
session history は organization / member / status / createdAt をもとに絞り込み、サーバ側ページングで返す。

## retention

- pairing token: `30 分`
- audio test: `10 分`
- email verification token: `24 時間`
- raw audio retention は運用ポリシーと cleanup job に依存

## 備考

- browser は Firestore client SDK の realtime subscription を直接使わない
- session / latestSoap / turns の client-facing schema は `packages/contracts/src/index.js` が source of truth
