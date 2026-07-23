# 前月確定入り Standing lane / M8 統合計測

## 目的

同一患者の2か月タイムラインを使い、次を一度にSTGで確認する。

1. 前月カルテからW1b初月候補が出る。
2. その候補を既存レビューAPIで人承認相当に確定すると、
   `fee_standing_billing_profiles`へ確定履歴が登録される。
3. 翌月カルテでW1履歴駆動候補が出る。
4. 翌月候補を人承認相当に確定すると、患者×月レセプトに対象コードが入る。
5. 前月からcopy-forwardした本文で縦断メモが使われ、
   `memoHitLineRatio > 0`になる。

fixtureは`data/tests/fee-standing-monthly-e2e/1002/`にある。患者名・保険番号等は合成値で、
既存UKEは当月比較にだけ使い、算定リクエストへは送らない。

## 前提

STG `fee-api-stg`で以下が必要。

```text
FEE_STANDING_FACTS=true
FEE_EXTRACTION_MEMO=true
```

確認コマンド:

```bash
gcloud run services describe fee-api-stg \
  --project halunasu-fee-stg \
  --region asia-northeast1 \
  --format=json |
jq -r '.spec.template.spec.containers[0].env[]
  | select(.name == "FEE_STANDING_FACTS" or .name == "FEE_EXTRACTION_MEMO")
  | "\(.name)=\(.value)"'
```

2026-07-23確認時点では両方`true`、revisionは`fee-api-stg-00171-gn6`だった。

## 実行

MFAを設定済みのアカウントでは、現在の6桁コードを渡す。

```bash
FEE_E2E_MFA_CODE='<現在の6桁コード>' \
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir data/tests/fee-standing-monthly-e2e/1002 \
  --seed-standing-prior-month \
  --approve-calculated-lines \
  --repeat 3 \
  --organization-code yamamoto-demo-stg \
  --login-id yamamoto-admin \
  --password-file .secrets/yamamoto-demo-stg-password.txt \
  --facility-id fac_9fe275b29feebb03bfeb9410f7 \
  --department-id dep_0a9c99c2dedcf0b6247294ef6a \
  --output-dir "docs/20260723-standing-monthly-e2e/$(date +%Y%m%d_%H%M%S)"
```

MFAコードはコマンド履歴へ残したくない場合、先に対話入力する。

```bash
read -s "FEE_E2E_MFA_CODE?MFA code: "
export FEE_E2E_MFA_CODE
```

fixtureとUKEの整合だけをネットワークなしで確認する場合:

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir data/tests/fee-standing-monthly-e2e/1002 \
  --seed-standing-prior-month \
  --approve-calculated-lines \
  --repeat 3 \
  --dry-run
```

## 合格条件

`result.json`の`summary.standingTimeline`で全反復が以下を満たす。

| 項目 | 条件 |
| --- | --- |
| `priorCandidateObservedCount` | `repeatCount`と同じ |
| `priorConfirmationRecordedCount` | `repeatCount`と同じ |
| `currentCandidateObservedCount` | `repeatCount`と同じ |
| `currentConfirmationRecordedCount` | `repeatCount`と同じ |
| `currentMonthlyLineIncludedCount` | `repeatCount`と同じ |
| `memoHitCount` | `repeatCount`と同じ |
| `allAcceptanceChecksPassed` | `true` |

個別反復では`standingTimeline`に、前月候補、確定profile、当月候補、当月確定profile、
月次明細、copy-forward受診のメモ指標を分けて保存する。合格しない場合も
`result.json`を保存して終了コード1にする。

## 安全性

- 前月の候補・当月の候補はどちらもレビューAPIで明示承認する。自動確定経路は増やさない。
- Firestoreへfixtureを直接書かず、製品と同じセッション作成・算定・承認フックを通す。
- 前月の期待コードは承認候補の照合にだけ使い、算定入力へ渡さない。
- 各反復は新しい合成患者を作るため、既存患者や別施設のstanding profileを再利用しない。
- copy-forward率は意図的に作った機構上限で、実顧客のDo記載率や実効削減率ではない。

## ローカル確認

2026-07-23:

- helperテスト: 6/6 pass
- 継続管理復元・standing lane・縦断メモの関連テスト: 63/63 pass
- fee-api全テスト: 282/282 pass
- `node --check`: evaluator / helperともpass
- dry-run: UKE 10コード・14回・11,313点、4受診を解析
- 前月`2026-06`、当月`2026-07`、copy-forward本文ハッシュ一致を確認

## STG事前計測で判明した欠落と対応

デプロイ前のrevision `fee-api-stg-00171-gn6`で、非MFAの評価専用アカウントを使って
前月算定まで実行した。standing catalogは228 familyを読み込めたが、
`P）在宅人工呼吸器管理を継続する。`に対してOpenAI抽出が
`standing_mentions=[]`を返したため、W1b候補ではなく同一コードの
`dictionary_scan_candidate`だけが出た。ハーネスはbasisも照合するため、これを成功扱いせず
`standing prior-month candidate missing codes 114005410`で停止した。

この欠落に対し、現在のworktreeでは次を汎用実装した。

- 明確な管理継続文を患者ID・マスターコード固定なしで`continued` mentionへ決定論復元する。
- 否定、不存在、予定、過去・他院、当日実施を含む文は復元しない。
- 復元行を`management_continuation`として抽出スナップショットへ保存する。
- 同じ行を当日実施の辞書候補と空抽出再試行から除外する。
- 復元されたmentionがW1b `standing_mention_first_month_candidate`へ到達するところまで
  テストする。候補は従来どおり承認前で、自動確定しない。

STG本計測はこのfee-api修正をデプロイした後に実行する。デプロイ前revisionでは、
ハーネスだけを再実行しても上記W1b欠落により合格しない。

```bash
TARGET_ENV=stg TARGET_SERVICE=fee-api \
  ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```
