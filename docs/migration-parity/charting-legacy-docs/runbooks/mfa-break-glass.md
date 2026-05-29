# MFA Break-Glass Runbook

作成日: 2026-04-19

## 目的

管理者の認証アプリ紛失、端末故障、全管理者ロックアウト時に、MFA登録だけを安全に解除し、次回ログインで再登録させる。

この手順はパスワードを変更しない。MFA secretを削除し、`tokenVersion` を進めて既存sessionを失効する。

## 通常手順

1. 別の管理者でWeb管理画面にログインする。
2. `設定 > 権限管理` を開く。
3. 対象メンバーの `MFAリセット` を押す。
4. 対象メンバーへ、次回ログイン時に認証アプリを再登録するよう伝える。
5. `操作ログ` で `MFAリセット` が記録されていることを確認する。

## 全管理者がログインできない場合

Cloud Shellまたは管理端末で、対象projectへgcloud認証済みで実行する。

Dry run:

```bash
GOOGLE_CLOUD_PROJECT=medical-stg-493105 \
npm run ops:mfa-reset -- \
  --organization-code=<hospital-code> \
  --login-id=<login-id>
```

Apply:

```bash
GOOGLE_CLOUD_PROJECT=medical-stg-493105 \
npm run ops:mfa-reset -- \
  --organization-code=<hospital-code> \
  --login-id=<login-id> \
  --apply
```

prodでは `GOOGLE_CLOUD_PROJECT=medical-492407` を使う。

## 実行後確認

1. 対象メンバーがパスワードでログインする。
2. 認証アプリ登録QRコードが表示される。
3. 認証アプリの6桁コードで登録を完了する。
4. `操作ログ` に以下が残ることを確認する。
   - `member.mfa_reset`
   - `member.mfa_enabled`

## 禁止事項

- `mfaRequired=false` にしない。
- `APP_FIELD_ENCRYPTION_KEY` を再生成しない。
- Firestore ConsoleでPHI本文を閲覧しない。
- audit eventを削除しない。

## 事後対応

- 実行者、理由、対象メンバー、日時をインシデント管理または運用台帳に記録する。
- 同じメンバーで複数回発生した場合は端末紛失、共有アカウント、退職/異動漏れを確認する。
- 本番前に年1回以上、stgでこの手順の復旧演習を行う。
