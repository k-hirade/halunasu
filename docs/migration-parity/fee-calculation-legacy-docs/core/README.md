# 診療報酬算定コア設計

このディレクトリは、診療報酬算定ロジックを実装する前提となる制度理解、設計方針、データ戦略をまとめる。

2026-05-17 時点の公開情報を前提にしている。令和8年度改定は、薬価が 2026-04-01 施行、診療報酬本体および材料価格が 2026-06-01 施行であるため、実装では必ず算定日ごとのバージョン管理を行う。

## ドキュメント

- [診療報酬算定の全体像](./reimbursement-system-overview.md)
  - 制度構造、算定フロー、完全自動化が難しい理由。
- [算定ロジック設計](./calculation-logic-design.md)
  - 最適なハイブリッド型アーキテクチャ、ルールモデル、パターン別設計。
- [データセットと評価設計](./datasets-and-evaluation.md)
  - 正解ラベル付きデータの調査結果、教師データ構築、評価指標。
- [公式データと検体検査MVP調査](./official-data-and-lab-mvp-investigation.md)
  - 公式マスター、医科電子点数表、コメント関連テーブルの取得・解析結果と、検体検査MVPの実装範囲。
- [全病院対応ロードマップ](../implementation/nationwide-hospital-roadmap.md)
  - 地方厚生局データ、施設基準、hospital_profile、全国投入に向けた実装状況。
- [実オーダーCSV受入チェックリスト](../implementation/order-csv-intake-checklist.md)
  - 実CSVのprofile、contract生成、validate、pipeline、batch、review indexの運用手順。
- [公式マスター更新Runbook](../implementation/official-master-update-runbook.md)
  - 支払基金catalog、標準DB build manifest、dry-run検証、SQLite再ビルド、全国smokeの月次運用手順。
- [地方厚生局データ更新Runbook](../implementation/regional-master-update-runbook.md)
  - 全国地方厚生局manifestの固定、dry-run検証、smoke import、標準DB buildへの接続手順。
- [外来入力Schema棚卸し](../implementation/outpatient-input-schema-inventory.md)
  - 外来全体へ拡張するための `ClaimContext`、CSV標準列、領域別入力、preset対応状況、Step4完了範囲。
- [施設基準辞書](../implementation/facility-standard-dictionary.md)
  - 地方厚生局の施設基準略称を内部rule keyへ正規化し、検体検査管理加算、画像診断管理加算、入院基本料系へ接続する設計。
- [Step6 入院/DPC入口](../implementation/inpatient-dpc-step6.md)
  - 入院基本料の明示コード候補化、入院/DPC CSV mapping、DPCを `needs_review` に止める安全入口。
- [Step7 評価データセット](../implementation/gold-dataset-step7.md)
  - 実CSV/確定レセプト由来gold列、差分分類、改善backlog/action plan、入院/DPCを含む非PHI回帰サンプル。

## 基本方針

1. ルールエンジンを中核にする。
2. LLM は候補生成、表記ゆれ補正、根拠説明に限定する。
3. 点数計算、同時算定不可、包括、回数制限、施設基準の最終判定は決定的ロジックで行う。
4. 不確実な請求は自動確定せず、`needs_review` として人間確認に回す。
5. すべての判定に、告示、通知、疑義解釈、マスター、施設基準などの根拠を紐づける。

## 主要な一次情報

- 厚生労働省 令和8年度診療報酬改定: https://www.mhlw.go.jp/stf/newpage_67729.html
- 厚生労働省 診療報酬制度について: https://www.mhlw.go.jp/bunya/iryouhoken/iryouhoken01/dl/01b.pdf
- 厚生労働省 令和8年4月制度変更: https://www.mhlw.go.jp/stf/newpage_71570.html
- 支払基金 レセプト電算処理システム: https://www.ssk.or.jp/seikyushiharai/rezept/index.html
- 支払基金 診療報酬の審査・支払業務の流れ: https://www.ssk.or.jp/smph/shinryohoshu/gyomuflow/index.html
- 支払基金 審査の一般的な取扱い: https://www.ssk.or.jp/shinryohoshu/sinsa_jirei/kikin_shinsa_atukai/index.html
- 支払基金 基本マスター: https://www.ssk.or.jp/smph/seikyushiharai/tensuhyo/kihonmasta/index.html
- 支払基金 医科及び歯科電子点数表: https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html
