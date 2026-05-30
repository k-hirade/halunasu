# Migration Parity Audit

最終更新: 2026-05-30

## 結論

現行 `halunasu` は、共通プラットフォームの骨格を維持したまま、旧Charting Next.js UI、旧Fee Python算定エンジン、Referralの最小文書生成導線を復元した。ChartingはSTG/PRODともCloud Run GatewayとNetlify Next.js配信へ切り替え済みで、独自ドメイン上のログイン/API proxy/セッション一覧を確認済み。LP/Core Admin/Fee/Referralの静的Netlify配信もSTG/PRODへ反映済み。

ただし、完全移行として残る論点はまだある。主な未完了は、Fee公式マスターSQLiteのSTG/PROD配置、旧Billing/contact signup/Stripe導線の復元、Chartingのpatient/facility/department shared master bridge、Referralのブラウザ印刷/PDF UX確認、LPの旧フォーム導線の最終一致確認である。

今後の実装は以下を完了条件にする。

1. 旧アプリに存在した主要ルートが現行アプリにも存在する。
2. Netlify fallback によって未実装ルートが `index.html` に見えている状態を完了扱いしない。
3. 旧APIまたは同等の新APIが、旧UIの全操作を支えられる。
4. 旧テストが再利用できる場合は移植し、再利用できない場合は同じ失敗を検出する移行パリティテストを追加する。
5. STG/PRODの実デプロイで、ルート、ログイン、主要操作、API proxy、Cloud Run readyz を確認する。
6. 共通プラットフォームは維持し、病院、メンバー、患者、施設、診療科、権限、監査ログはCore責務に寄せる。

## 監査対象

旧資産:

- `/private/tmp/halunasu-old-audit2/medical`
- `/private/tmp/halunasu-old-audit2/medical-fee-calculation`
- `/private/tmp/halunasu-old-audit2/medical-lp`

現行:

- `/Users/hiradekeishi/medical-ai/halunasu`

## アプリ別Docs

- [Charting / SOAP](./charting.md)
- [Fee Calculation](./fee-calculation.md)
- [LP](./lp.md)
- [Core Platform / Admin](./core-platform-admin.md)
- [Referral](./referral.md)
- [GCP / Netlify](./gcp-netlify.md)
- [Test Plan](./test-plan.md)
- [Implementation Plan](./implementation-plan.md)
- [Complete Migration Tasks](./complete-migration-tasks.md)

## 現時点で復元済みのテスト資産

旧 `medical-fee-calculation` の126テストを `python/tests/legacy_medical_fee_calculation` に移植した。
旧 `medical` の詳細Docsを `docs/migration-parity/charting-legacy-docs` に保存した。
旧 `medical` のNext.js UI/E2Eを `apps/charting-web` に復元した。

確認コマンド:

```bash
PYTHONPATH=python python3 -m unittest discover -s python/tests/legacy_medical_fee_calculation
```

2026-05-30時点では旧Fee 126件すべて通過している。Charting旧E2Eは `npm run test --workspace @halunasu/charting-web` で11件すべて通過している。

## 2026-05-30 検証結果

通過済み:

- `npm run test`
- `npm run build`
- `npm run test:python`
- `npm run test:python:legacy-fee`
- `npm run test:migration-parity`
- `npm run audit:migration-parity`
- `WEB_E2E_PORT=3100 npm run test --workspace @halunasu/charting-web`
- STG `https://charting.stg.halunasu.com/sessions`
- PROD `https://charting.halunasu.com/sessions`
- STG/PROD Charting login/API proxy with Core seeded operator
- PROD `https://halunasu.com`
- PROD `https://admin.halunasu.com`
- PROD `https://fee.halunasu.com`
- PROD `https://referral.halunasu.com`

未完了:

- Fee公式マスターSQLiteのSTG/PROD配置
- Billing/contact signup/Stripe portal/webhookの本番導線復元
- Charting旧GatewayのCore shared master bridgeの残り
- Referralのブラウザ印刷/PDF UX確認
- LPの旧フォーム導線の最終確認

## 現時点で開始したCharting復元

旧 `medical/apps/web` のNext.js資産を `apps/charting-web` に取り込んだ。

- `app/`
- `components/`
- `lib/`
- `public/`
- `test/e2e/`
- `next.config.mjs`
- `netlify.toml`

また、旧UIが参照する `@medical/contracts` と、今後gateway/finalize復元で必要になる `@medical/core` を互換packageとして追加した。

旧静的 `apps/charting-web/index.html` は削除済み。ChartingはNext.js buildでのみ配信する。

Charting Next.js用の同一オリジンHTTP proxyと、Netlify deploy script `npm run deploy:netlify-charting-next` を追加済み。Gateway認証はCore Platform login identity/member/product entitlementを読む短期bridgeを追加済み。2026-05-30にSTG/PRODへ反映済み。

## 追加した移行パリティチェック

現行の未移行を機械的に検出するため、以下を追加する。

```bash
npm run audit:migration-parity
npm run test:migration-parity
```

`audit:migration-parity` はレポートのみ、`test:migration-parity` は未完了項目がある場合に失敗する。2026-05-30時点で、ローカルコード上のmock/placeholder移行パリティチェックは通過している。デプロイ確認は別途 `gcp-netlify.md` に記録する。
