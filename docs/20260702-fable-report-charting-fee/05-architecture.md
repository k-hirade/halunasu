# 05. アーキテクチャ・コード健全性（追加テーマ）

「セキュリティ/UI/UX/パフォーマンス/ロジック」の根っこに共通して効いているのが構造の問題なので、独立テーマとして立てる。

---

## 総評

モノレポ（`apps` / `services` / `packages` / `python`）＋workspace＋contracts層の分離という**骨格は良い**。プロダクト境界（`packages/product-boundaries`, `security-boundaries`）を明示し、契約（`*-contracts`）でスキーマを共有する規律もある。

問題は**「巨大単一ファイル」への集中**。ここがレビュー精度・変更コスト・パフォーマンス・テスト容易性すべてを同時に押し下げている。

---

## 高-1: 巨大ファイルの集中

| ファイル | 行数 | 役割 |
|---------|------|------|
| `services/fee-api/src/clinical-calculation-input.js` | 8,889 | 臨床入力→算定入力の変換・ルール |
| `services/charting-gateway/src/server.js` | 7,977 | WS/逐語/SOAP/認証/pairing/監査 全部 |
| `apps/fee-web/components/fee-workspace.js` | 6,348 | 算定/月次/レセプト/設定の全UI |
| `services/fee-api/src/server.js` | 6,291 | 全ルート＋算定オーケストレーション |
| `apps/charting-web/components/admin-console.js` | 3,507 | 管理画面全部 |
| `python/.../cli.py` | 3,535 | CLI |
| `apps/charting-web/components/encounter-workspace.js` | 3,372 | 録音〜SOAPの全UI |

**なぜ問題か**:
- **レビュー**: 1ファイルに機能が同居し、差分の影響範囲が読めない。
- **テスト**: 内部関数が多く、純関数を切り出せずユニットテストしにくい（fee-workspace の赤文字ロジック等）。
- **パフォーマンス**: フロントはコード分割の単位がファイル＝分割不能（[03](03-performance.md) 中-1）。
- **変更コスト**: 「1画面直したいのに6,348行を読む」状態。

**推奨（段階的・低リスク）**:
1. **純関数の抽出が最優先**。`fee-workspace.js` の `woundDetail*`/`normalize*`/`clinicalInlineAnnotation*` 群を `packages/fee-core` かローカル `lib/clinical-annotations.js` へ移し、テスト付与。
2. gateway は責務で物理分割（`ws-hub` / `transcription` / `soap` / `auth` / `pairing`）。既に `charting-finalize` サービスがあるので、逐語/SOAPはそちらへ寄せる自然な線がある。
3. fee-api の `server.js` はルーティングとハンドラを分離（`routes/` ディレクトリ化）。
4. UIはルート単位コンポーネントへ分割（パフォーマンスと同時解決）。

これは一度に全部やる必要はない。**「触るときに割る」**運用ルールを決めるだけでも劣化は止まる。

---

## 中-1: fee ドメインのロジック二重実装

[04](04-logic.md) 中-1 と重複するが、アーキ観点でも重要。算定の正典が Python にありつつ、円換算・集計・区分ラベルなど請求規則の断片が JS（fee-core）にも散る。**「請求に効く定数・規則の置き場所」を1つに決める**ことが、改定対応時の事故を最も減らす。

**推奨**: 診療報酬改定で変わる値（点数、換算、区分）を「データ（マスタ/JSON）」として1箇所に持ち、Python/JS 双方がそれを読む。ロジックの二重実装ではなくデータの単一供給にする。

---

## 中-2: gateway のステートフル設計（スケール前提の不一致）

[01](01-security.md) 高-3 / [03](03-performance.md) 中-3 と同根。Cloud Run（水平スケール・使い捨てインスタンス）にデプロイしながら、gateway が録音・ソケット・レジストリをインメモリ保持。**「ステートフルなWSハブ」と「ステートレス志向のserverless」のミスマッチ**。

**推奨**: 明示的に「gateway は単一インスタンス（min=max=1）運用」と決めるか、状態を外部ストア（Redis等）へ出してステートレス化するか、どちらかに倒す。今は暗黙的に前者に依存している。

---

## 低: 良い構造は伸ばす

- **contracts層**（`fee-contracts`, `platform-contracts`, `charting-contracts`）でのバリデーション集約は良い。dead fields を削除した最近の整理も good。
- **store の抽象化**（`memory-store` / `firestore-store` / `create-store`）でテスト時にインメモリに差し替えられるのは優秀。fee-api の8,852行テストはこの恩恵。
- **auth-client / web-ui の共有**でプロダクト間の認証UIを一本化した動きは正しい。

---

## 対応の優先順位（アーキテクチャ）

1. **高-1**: 純関数の抽出（テスト可能化）から着手。「触るときに割る」ルール制定。
2. **中-2**: gateway のステート方針を明示決定。
3. **中-1**: 請求規則をデータ単一供給に。
