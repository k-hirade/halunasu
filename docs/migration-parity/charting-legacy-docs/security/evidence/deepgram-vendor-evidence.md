# Deepgram 委託先証跡チェックリスト

更新日: 2026-05-06

目的:

- 本番 fallback STT に利用している Deepgram について、保持・学習利用・subprocessor・契約条件の証跡を整理する

## 1. repo / runtime から確認済みの事実

- 本番 `medical-gateway` は `LIVE_STT_FALLBACK_PROVIDER=deepgram`
- `DEEPGRAM_API_KEY` secret を参照
- したがって、Deepgram は本番の実利用中 vendor
- 現行コードでは、Deepgram WebSocket URL に `mip_opt_out=true` を付与していない
- 現行コードでは、Deepgram 側の明示的な region 指定も行っていない

## 2. 公式公開情報で確認済みの事実

### Customer Data の位置づけ

Deepgram privacy policy では、Customer Data は customer agreement に従って処理され、Deepgram は customer の指示のもとで処理する旨が記載されている。

参考:

- https://deepgram.com/privacy

### DPA

Deepgram privacy policy では、GDPR 対象 customer について DPA を締結すると記載がある。

参考:

- https://deepgram.com/privacy

### model improvement / 学習利用

Deepgram docs では、`Model Improvement Partnership Program` に契約上含まれるデータのみを将来のモデル学習に使うとしている。また、`mip_opt_out=true` で opt-out できると記載がある。

参考:

- https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program

### subprocessors

Deepgram は公開 subprocessor 一覧を持っている。

参考:

- https://deepgram.com/privacy/subprocessors

## 3. 記録すべき事項

### 必須

1. 契約形態
   - pay-as-you-go / enterprise / BAA / DPA
2. 保持期間
3. 学習利用の既定値
4. `mip_opt_out` を使うかどうか
5. subprocessor 一覧の取得日
6. 主な処理地域

### 推奨

7. BAA 可否
8. HIPAA / SOC2 などの対外説明資料
9. API project / key の管理者

## 4. 記録テンプレート

### 確認日時

- YYYY-MM-DD HH:mm JST:

### 契約情報

- plan:
- DPA:
- BAA:

### 保持・学習利用

- customer data retention:
- model improvement default:
- `mip_opt_out` 利用方針:

### subprocessors

- 取得日:
- URL:
- 音声データに関係する主要 subprocessor:

### スクリーンショット / 保管先

- `docs/security/evidence/deepgram-privacy-<YYYYMMDD>.pdf`
- `docs/security/evidence/deepgram-subprocessors-<YYYYMMDD>.pdf`

## 5. 現時点の判断

まだ **社内で保管された正式証跡は不足** している。
公開サイトの確認だけでは、実契約上の保持条件や opt-out の既定運用までは確定できない。加えて、現行コード上は `mip_opt_out=true` を付与していないため、契約・アカウント既定値に依存している状態である。

## 6. 未完了項目

- [ ] Deepgram 契約形態の確認
- [ ] 保持期間の契約条件確認
- [ ] `mip_opt_out` を app で付けるか方針決定
- [ ] subprocessor 一覧の保管
- [ ] BAA / DPA の保管先記録
