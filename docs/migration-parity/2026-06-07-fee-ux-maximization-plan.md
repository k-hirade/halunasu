# 診療報酬算定 UX 最大化 修正計画

作成日: 2026-06-07

## 目的

診療報酬算定アプリを、専門知識が浅い利用者でも「貼る → 候補を見る → 迷わず確認・増減 → 確定に近いレセプト案を作る」流れで使える状態に近づける。

UXの北極星:

> 患者とカルテ本文から、算定できる可能性を見逃さず、過剰算定を避けながら、平易な日本語で確認・採否・点数調整ができる。

## 現状の強み

- 2カラムの作業画面がある。
- 患者ピッカーがある。
- カルテ本文からAI/ルールで病名・算定候補を補完できる。
- `増点提案 / 算定中 / 外し・保留 / 確認・修正` のバケット構造が入り始めている。
- 算定行は `算定する / 保留 / 算定しない` で採否を変えられる。
- 自動保存がある。
- SOAP風モーダルで候補の理由を読める土台がある。

## 現状の主要ボトルネック

### 1. 正確性

- 合計が「候補化済み部分合計」ではあるが、どこまで候補化できていて、どこが未確定・未対応なのかが弱い。
- 増点提案が `算定する +○点` として合計に足せない。
- 点数が不明な提案は `点数確認` に留まり、取りこぼし防止のUXとして弱い。
- 病名と診療行為の適応チェックはまだ未成熟で、査定リスクの説明が弱い。

### 2. わかりやすさ

- エンジン由来の英語・内部コード・内部sourceが表示に混じる可能性がある。
- `確認事項` が「何をすれば解決するか」ではなく、警告文の表示に寄っている。
- 件数・バケット・レビューの単一ソース化が途中で、UI側のフォールバック分類が残っている。

### 3. 簡単さ

- 入力フォームに詳細条件が多く、初見では「何を入れればよいか」が分かりにくい。
- 算定中の体感改善は進んでいるが、即時の粗候補とAI完了後の更新の見せ方はまだ改善余地がある。
- 確定・出力導線はまだ弱く、実務上の成果物まで完結しない。

## 今回の必須修正スコープ

以下の星3項目を今回の実装対象にする。

### ★★★ B2. 増点提案の完成

目的:

- 「条件を満たせば算定できる」を、実際に点数へ足せる操作にする。
- 過剰算定を避けるため、条件未確認のものは自動採用しない。

ASIS:

- `増点提案` は出るが、多くは `条件を確認` / `保留` で止まる。
- 提案が警告文字列に近く、候補行として採用できる構造になっていない。
- `potentialPoints` がない提案は具体的な増点額が出ない。

TOBE:

- 提案を以下に分ける。
  - `adoptable`: コード・点数・条件が揃っており、確認後に `算定する +○点` で算定中へ移せる。
  - `select_required`: 候補は分かるがコードが確定できず、`候補を選ぶ` が必要。
  - `confirm_required`: 実施済み/施設基準/病名/コメントなどの条件確認が必要。
  - `not_billable_now`: 予定・検討・指導のみなど、今回は算定しない理由が明確。
- `proposal` は可能な限り `candidateLine` を持つ。
- 採用できる提案は `potentialPoints` を実値で返す。
- UIは `算定する +○点` / `候補を選ぶ` / `条件を確認` / `保留` を出し分ける。

データモデル案:

```js
{
  kind: "proposal",
  proposalId: "proposal_xxx",
  title: "CA125",
  displayReason: "当日実施済みの検体検査として候補化できます。",
  conditionText: "検査実施日と同月算定条件を確認してください。",
  actionType: "adoptable",
  potentialPoints: 136,
  candidateLine: {
    code: "160038010",
    name: "ＣＡ１２５",
    orderType: "lab",
    points: 136,
    totalPoints: 136
  },
  evidence: {
    text: "血液検査：CA125 68 U/mL",
    source: "clinical_text"
  }
}
```

実装対象:

- `packages/fee-core/src/index.js`
- `services/fee-api/src/clinical-calculation-input.js`
- `services/fee-api/src/server.js`
- `apps/fee-web/components/fee-workspace.js`
- 関連テスト

### ★★★ B1. 部分合計＋未計算範囲の明示

目的:

- 「この合計が確定請求の全体ではない」ことを誤認させない。
- ただし、固定文言で「初再診は未計算」と出さない。初再診など一部は既に候補化できるため、実際の結果から動的に表示する。

ASIS:

- `候補化済み部分合計` の文言はある。
- どの範囲が候補化済みで、どの範囲が確認・未対応なのかが弱い。
- レセプト案が完成品に見えやすい。

TOBE:

- 合計表示は `候補化済み部分合計` に統一する。
- `候補化済み範囲` / `確認が必要な範囲` / `未対応の範囲` をバッジ表示する。
- 未対応範囲は固定文言ではなく、算定結果・coverage・未解決イベントから生成する。

表示例:

- 候補化済み: 初再診、検体検査、画像
- 確認必要: 医学管理、投薬日数、施設基準
- 未対応: 在宅、手術、リハビリ

実装対象:

- `packages/fee-core/src/index.js`
- `apps/fee-web/components/fee-workspace.js`
- 必要に応じて `services/fee-api/src/clinical-calculation-input.js`

### ★★★ C. 全面日本語化＋件数単一ソース

目的:

- 医療事務が読める日本語だけで判断できるようにする。
- 件数・レビュー・バケットのズレをなくす。

ASIS:

- `D026 judgement fee for group`、`Collection fee requested by blood_venous`、`hospital_profile_missing` などの内部語が残る可能性がある。
- `reviewItems` と `candidateWorkbench` の二重構造があり、UI側のフォールバック分類も残る。
- `確認事項` の見出しが抽象的すぎる。

TOBE:

- UIは原則 `candidateWorkbench` を唯一の表示モデルとして使う。
- `reviewItems` は互換APIとして残すが、画面の主表示には使わない。
- 英語・内部コード・内部sourceはUIに出さない。
- すべての表示項目に以下を持たせる。
  - `displayTitle`
  - `displayReason`
  - `conditionText`
  - `businessCategory`
  - `nextActionLabel`
- 件数は `candidateWorkbench.counts` のみを表示する。

実装対象:

- `packages/fee-core/src/index.js`
- `apps/fee-web/components/fee-workspace.js`
- 関連テスト

## 今回はスコープ外にするもの

以下は重要だが、星3完了後に扱う。

- 病名適応チェックの本格実装。
- 確定・レセ電/CSV出力。
- 算定ステッパーと確定チェックリスト。
- AI完了前のルールベース即時候補のストリーミング表示。
- 施設基準マスタの管理UI。

## 実装順序

1. `candidateWorkbench` の表示モデルを拡張する。
   - `counts`
   - `coverageSummary`
   - `proposals`
   - `issues`
   - `includedLines / pendingLines / excludedLines`
2. UIを `candidateWorkbench` 単一ソースへ寄せる。
3. 日本語化ヘルパーをcore側に集約し、UI側の文字列推測を減らす。
4. 増点提案に `actionType`、`potentialPoints`、`candidateLine` を追加する。
5. 採用可能な提案だけ `算定する +○点` を表示する。
6. 提案採用後に合計が変わるよう、採用状態の永続化と `receiptDraft` 再計算を接続する。
7. テストを追加・更新する。
8. `fee-web` buildで検証する。

## 成功条件

- 合計が「候補化済み部分合計」として誤解なく表示される。
- 候補化済み・確認必要・未対応範囲が見える。
- 増点提案が `算定する +○点`、`候補を選ぶ`、`条件を確認` に分かれて表示される。
- 採用できる提案は、採用後に合計へ反映される。
- UI上の理由・警告・区分に英語や内部sourceが露出しない。
- 上部件数と各バケット件数が一致する。
- 既存の `reviewDecisions` との互換性を壊さない。

## データ削除について

今回の設計は既存データとの互換性を保つ方針で進めるため、現時点ではSTG/PRODデータ削除は不要。

ただし、提案採用状態を新しい永続モデルへ移す段階で、STG/PRODの古い検証用Fee sessionがUI確認の邪魔になる場合は、テスト病院配下のFee session削除を検討する。

## 実装メモ

2026-06-07 時点で着手した内容:

- `fee-core` に `candidateProposals` を追加し、増点提案を警告文字列とは別の構造として正規化できるようにした。
- `candidateProposals` のうち `candidateLine` と `potentialPoints` を持つものは、レビューで `approved` にすると `receiptDraft.lines` へ追加し、合計点数に反映する。
- `candidateWorkbench` に `counts`、`coverageSummary`、`potentialPointsTotal` を追加し、UIの件数と部分合計を単一モデルから表示できるようにした。
- Fee Web の候補画面は `候補化済み部分合計 / 要確認 / 増点余地` を表示し、候補化範囲バッジを出す。
- 構造化された採用可能提案は `算定する +○点` と表示できる。

未完了:

- 既存の文字列警告から安全に `candidateProposals` を生成する実装は未着手。コード・点数・条件を安全に決められるものから段階的に追加する。
- 病名適応チェック、確定・出力、ステッパーは今回スコープ外。
