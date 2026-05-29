# API and Event Design

## 基本方針

- HTTP: 認証、一覧取得、設定変更、session command
- WebSocket: live transcript、録音状態、SOAP 進行状況
- モバイル音声: WebSocket binary frame
- browser の operator session: cookie + CSRF
- モバイル参加: pairing token + stream token

旧 docs にあった colon-style endpoint ではなく、現在は slash/action 形式が source of truth である。

## 認証モデル

### operator

- `POST /api/v1/operator/login`
- `organizationCode + loginId + password`
- browser は HttpOnly cookie session を基本に使う
- state-changing request は `X-CSRF-Token` を要求する
- bearer auth は互換 / service-to-service 用に残るが、frontend の基本経路では cookie を使う

### mobile

- pairing claim 後に短命な stream token を受け取る
- token は `sessionId`, `deviceId`, `pairingId`, `orgId` に束縛される

## gateway HTTP API

### operator auth

- `POST /api/v1/operator/login`
- `POST /api/v1/operator/mfa/verify`
- `POST /api/v1/operator/mfa/enroll/confirm`
- `GET /api/v1/operator/me`
- `POST /api/v1/operator/logout`
- `GET /api/v1/operator/csrf`

### settings / admin

- `GET /api/v1/admin/organizations`
- `POST /api/v1/admin/organizations`
- `PATCH /api/v1/admin/organizations/:orgId/recording-policy`
- `GET /api/v1/admin/role-definitions`
- `GET /api/v1/admin/members`
- `POST /api/v1/admin/members`
- `PATCH /api/v1/admin/members/:memberId/preferences`
- `POST /api/v1/admin/members/:memberId/password`
- `PATCH /api/v1/admin/members/:memberId/roles`
- `PATCH /api/v1/admin/members/:memberId/status`
- `POST /api/v1/admin/members/:memberId/revoke-sessions`
- `POST /api/v1/admin/members/:memberId/mfa-reset`
- `GET /api/v1/admin/trusted-recorders`
- `POST /api/v1/admin/trusted-recorders/:deviceId/revoke`
- `POST /api/v1/admin/audio-tests`
- `GET /api/v1/admin/audio-tests/:testId`
- `POST /api/v1/admin/audio-tests/:testId/complete`
- `GET /api/v1/admin/soap-formats`
- `POST /api/v1/admin/soap-formats`
- `GET /api/v1/admin/soap-formats/:formatId`
- `POST /api/v1/admin/soap-formats/:formatId/draft`
- `POST /api/v1/admin/soap-formats/:formatId/publish`
- `POST /api/v1/admin/soap-formats/:formatId/archive`
- `POST /api/v1/admin/soap-formats/preview`
- `POST /api/v1/admin/soap-formats/infer`
- `POST /api/v1/admin/soap-formats/preview-stream`
- `POST /api/v1/admin/soap-formats/:formatId/preview`
- `POST /api/v1/admin/soap-format-assignments`
- `GET /api/v1/admin/audit-events`

### session

- `POST /api/v1/sessions`
- `GET /api/v1/sessions`
- `DELETE /api/v1/sessions/:sessionId`
- `GET /api/v1/sessions/:sessionId`
- `GET /api/v1/sessions/:sessionId/prompt-options`
- `POST /api/v1/sessions/:sessionId/prompt-profile`
- `POST /api/v1/sessions/:sessionId/metadata`
- `POST /api/v1/sessions/:sessionId/pairings`
- `POST /api/v1/sessions/:sessionId/assign-recorder`
- `POST /api/v1/sessions/:sessionId/recording/source`
- `POST /api/v1/sessions/:sessionId/recording/start`
- `POST /api/v1/sessions/:sessionId/recording/stop`
- `POST /api/v1/sessions/:sessionId/recording/discard`
- `POST /api/v1/sessions/:sessionId/generate-soap`
- `POST /api/v1/sessions/:sessionId/regenerate-soap`
- `POST /api/v1/sessions/:sessionId/review-note`
- `POST /api/v1/sessions/:sessionId/approve-note`

### mobile / recorder

- `POST /api/v1/pairings/:pairingId/claim`
- `POST /api/v1/mobile/sessions/:sessionId/recording/start`
- `POST /api/v1/mobile/sessions/:sessionId/recording/stop`
- `POST /api/v1/mobile/recorders/register`
- `GET /api/v1/mobile/recorders/assignment`

### audio test public endpoints

- `POST /api/v1/audio-tests/:testId/claim`
- `POST /api/v1/audio-tests/:testId/state`
- `POST /api/v1/audio-tests/:testId/complete`

### internal

- `POST /internal/recording/auto-stop`
- `GET /healthz`

## billing service API

### public onboarding

- `POST /api/v1/contact-signups`
- `GET /api/v1/contact-signups/verify`
- `POST /api/v1/contact-signups/verify`
- `GET /api/v1/contact-signups/:signupId/status`
- `POST /api/v1/contact-signups/:signupId/resend`
- `GET /api/v1/password-setup/:tokenId`
- `POST /api/v1/password-setup/:tokenId`

### authenticated billing

- `GET /api/v1/billing/status`
- `POST /api/v1/billing/checkout-session`
- `POST /api/v1/billing/portal-session`

### webhook / internal ops

- `POST /api/v1/stripe/webhook`
- `POST /internal/billing/process-stripe-event`
- `POST /internal/billing/reconcile-subscription`
- `POST /internal/billing/enforce-grace-periods`
- `POST /internal/billing/enforce-trial-expiration`
- `GET /healthz`

## WebSocket

endpoint:

```text
/ws
```

### client -> server bootstrap

```json
{
  "type": "auth.hello",
  "role": "pc",
  "sessionId": "ses_xxx",
  "token": "cookie_sentinel_or_stream_token",
  "deviceId": "optional",
  "pairingId": "optional"
}
```

role:

- `pc`
- `mobile`
- `recorder`

### server -> client auth response

```json
{
  "type": "auth.ok",
  "sessionId": "ses_xxx",
  "connectionId": "pc-..."
}
```

## WebSocket client messages

### `audio.metadata`

```json
{
  "type": "audio.metadata",
  "sampleRateHz": 24000,
  "channels": 1,
  "encoding": "pcm16"
}
```

### `mic.ready`

- 録音端末のマイク準備完了を通知する

### `mic.disabled`

- マイク無効化や permission 解除を通知する

### binary audio frame

- `mobile` と `recorder` が PCM frame を送る

## 主要 server events

### session / recording

- `session.state.updated`
- `recording.started`
- `recording.stopped`
- `recording.discarded`
- `recording.auto_stopped`
- `recording.degraded`
- `recording.source_selected`

### transcript

- `transcript.partial`
- `transcript.final`
- `transcript.corrected`
- `transcript.live_stt.dropped`
- `highlights.updated`

### audio / device

- `audio.first_frame_received`
- `audio.activity`
- `audio.mic_ready`
- `audio.capture.summary`
- `audio.pending_finalize.expired`

### SOAP

- `soap.status`
- `soap.stream.updated`
- `soap.ready`

### error / keepalive

- `error`
- `ping`

## 代表的なレスポンス形

### `GET /api/v1/sessions/:sessionId`

```json
{
  "session": {},
  "pairing": {},
  "turns": [],
  "latestSoap": {}
}
```

### `GET /api/v1/sessions`

```json
{
  "sessions": [],
  "page": 1,
  "pageSize": 20,
  "totalCount": 0,
  "totalPages": 0
}
```

### `POST /api/v1/pairings/:pairingId/claim`

```json
{
  "sessionId": "ses_xxx",
  "orgId": "org_xxx",
  "clinicId": "org_xxx",
  "status": "paired",
  "patientDisplayName": null,
  "visitReason": null,
  "wsUrl": "wss://.../ws",
  "streamToken": "..."
}
```

## 未実装 / future

- `GET /api/v1/sessions/{sessionId}/export` は docs 上の構想はあるが、現行 gateway に未実装
- Firestore client realtime subscription を前提にした event contract は現行 browser 実装では使っていない
