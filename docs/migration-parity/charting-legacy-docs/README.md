# Design Docs Index

このディレクトリは、`ハルナス` の現行実装と今後の運用方針を整理するための設計ドキュメント群です。

## 推奨読書順

1. [01-product-purpose.md](core/01-product-purpose.md)
2. [02-product-spec.md](core/02-product-spec.md)
3. [03-system-architecture.md](core/03-system-architecture.md)
4. [04-data-model.md](core/04-data-model.md)
5. [05-api-and-events.md](core/05-api-and-events.md)
6. [06-screen-flows.md](core/06-screen-flows.md)
7. [07-gcp-deployment.md](core/07-gcp-deployment.md)
8. [08-open-questions.md](core/08-open-questions.md)
9. [09-docs-inventory-and-gaps.md](core/09-docs-inventory-and-gaps.md)

## 補助ドキュメント

- [10-stripe-billing-and-onboarding.md](core/10-stripe-billing-and-onboarding.md)
- [11-contact-trial-and-later-payment.md](core/11-contact-trial-and-later-payment.md)
- [12-contact-trial-implementation-tasks.md](core/12-contact-trial-implementation-tasks.md)

`11` と `12` は将来設計や実装タスクの色が強く、`01-10` より source of truth としての優先度は低いです。

## Runbooks

- [MFA Break-Glass Runbook](runbooks/mfa-break-glass.md)
- [Security Operations Runbook](runbooks/security-operations.md)

## 現在の前提

- プロダクト名: `ハルナス`
- frontend: Netlify 上の Next.js
- backend: Cloud Run `medical-gateway`
- billing / onboarding: `services/billing`
- primary live STT: OpenAI Realtime
- live STT fallback: Deepgram
- final transcript: OpenAI `gpt-4o-mini-transcribe`
- SOAP / facts extraction: OpenAI Structured Outputs
- durable store: Firestore
- current standard finalize mode: `inline`
- target async finalize path: GCS + Cloud Tasks + `medical-finalize`
- primary region: `asia-northeast1`
- canonical STG project: `medical-stg-493105`
- historical / dev project: `medical-492407`

## 運用方針

- 実装に追従して core docs を更新する
- 現在の実装と将来の target architecture が違う場合は、同一文書内で分けて書く
- UI / API / Firestore の名前はコード実装に合わせる
- `docs/impl` は経緯や監査メモとして扱い、source of truth にはしない

## 用途

1. プロダクト認識を揃える
2. 実装済み API / UI / data model の参照先を一つに寄せる
3. デプロイ、運用、セキュリティレビューの土台にする
