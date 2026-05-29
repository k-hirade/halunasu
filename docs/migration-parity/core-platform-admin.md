# Core Platform / Admin Migration Parity

## Verdict

骨格は存在し、Netlify静的配信はSTG/PRODへ反映済み。共通プラットフォームとしての方向性は正しいが、旧 `medical` のadmin機能を完全には包含していない。旧adminの臨床アプリ固有設定はCharting product責務へ分ける。

## 現行Core責務

現行 `platform-api` / `core-admin` は以下を扱う。

- login / session / logout / MFA
- signup applications
- organizations
- members
- facilities
- departments
- patients
- product entitlements
- audit events
- data requests

これは共通DB化の中核として妥当。

## 旧adminにあったもの

旧 `medical/apps/web/components/admin-console.js` は以下も含んでいた。

- SOAPフォーマット/プロンプト設定
- prompt infer / preview / streaming preview
- member別prompt assignment
- trusted recorders
- audio tests
- recording policy
- member password reset
- role変更
- status変更
- session revoke
- MFA reset
- audit events

## 分離方針

Coreに置く:

- organization
- member
- role/entitlement
- facility
- department
- patient
- audit event
- auth/MFA/password/session revoke
- signup application
- billing entitlement

Charting productに置く:

- SOAP format/prompt
- prompt assignment
- recording policy
- trusted recorder
- audio test
- mobile pairing
- raw audio/transcript/SOAP storage

Core AdminからCharting Adminへ遷移できるようにするが、Charting固有データをCore DBに混ぜない。

## GCP責務

推奨:

- Core project: shared Firestore/Auth-like session/secrets/platform-api/core-admin
- Charting project: gateway/finalize/audio/GCS/STT/SOAP integrations
- Fee project: fee-api/master calculation artifacts
- Referral project: referral-api/PDF generation artifacts

ただし、shared patient/facility/memberはCore projectに寄せる。各product projectはCoreのID/snapshotを持つ。

## 完了条件

- 旧adminの共通機能はCore Adminに存在する。
- 旧adminのCharting固有機能はCharting Adminに存在する。
- Core AdminからCharting Adminへの導線がある。
- 権限とentitlementがCoreで一元判定される。
- STG/PRODでadmin操作が動作確認済み。Static deploy Done / admin CRUD smoke Pending.
