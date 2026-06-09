# Tests Documentation

このディレクトリは、自動テスト用データセットと品質評価方針をまとめる場所です。

## 診療報酬算定

- [診療報酬算定 1:1 Gold Dataset 計画](./fee-chart-to-claim-gold-dataset-plan.md)
- [診療報酬算定 SOAP E2E 網羅性拡張計画](./fee-soap-e2e-comprehensive-coverage-plan.md)

カルテ本文と診療報酬算定結果を 1:1 で対応させ、最終的にアプリの自動テストで算定品質を担保するための計画です。

網羅性拡張計画では、診療科、算定章、安全/未対応領域を層化し、現行300件を600から800件規模へ拡張するためのターゲットと監査方法を定義しています。
