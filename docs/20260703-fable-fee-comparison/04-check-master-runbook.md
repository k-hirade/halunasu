# 04. レセ点検マスタ取込 Runbook（CCデータ＋病名コード化）

フェーズ1の A（適応/禁忌/併用）と C（病名コード化）を**実データで有効化**する手順。
コードは実装済み（`check_masters_import.py` / `checks_api.py`）。ここでは公的データを取得して取り込む運用手順を示す。

すべて公的・無償（社会保険診療報酬支払基金）。患者情報は含まない。

---

## 1. 取得するデータ（令和8年度＝R8）

| データ | 内容 | 入手元 |
|---|---|---|
| 傷病名マスタ `b_*.txt` | 病名コード↔名称（病名コード化に必須） | ssk.or.jp 基本マスタ kihonmasta_07 |
| 修飾語マスタ `z_*.txt` | 接頭語・接尾語（「急性」「の疑い」等） | 同 kihonmasta_08 |
| コンピュータチェックマスタ | `IY_Tekio`(適応/投与量) `IY_ShobyoKinki`(禁忌) `IY_HeiyoKinki`(併用禁忌) `SI_Shobyo`(診療行為適応) 他 | ssk.or.jp `shinryohoshu/ssk_cc/`（`..._CC_JIREI_CHECKMASTA.zip`） |

URL例（改定・更新で変わるため要確認。`~/medical-ai/recept-checker/receipt_checker/masters/download.py` に既知URLあり）:
- `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_07.files/b_20260601.zip`
- `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_08.files/z_20260601.zip`
- `https://www.ssk.or.jp/shinryohoshu/ssk_cc/index.files/20251031_CC_JIREI_CHECKMASTA.zip`

医科診療行為 `s_*` / 医薬品 `y_*` は halunasu の既存マスタDB（`medical_procedures`/`drugs`）が保持しているため再取得不要。

---

## 2. 展開

ダウンロードした ZIP を1つのディレクトリに展開する（ファイルが横並びになればよい）。

```bash
mkdir -p /tmp/check-raw && cd /tmp/check-raw
# 各 zip を展開（b_*.txt, z_*.txt, IY_Tekio*.csv, IY_ShobyoKinki*.csv,
#                IY_HeiyoKinki*.csv, SI_Shobyo*.csv 等が並ぶ状態にする）
unzip -o b_20260601.zip
unzip -o z_20260601.zip
unzip -o 20251031_CC_JIREI_CHECKMASTA.zip
```

文字コードは cp932（Shift_JIS）。取込側で自動処理する。

---

## 3. 取り込み

halunasu の点検マスタは**算定用マスタDBと同じ SQLite に同居**させる（`check_lookup`/`resolve_diseases` が参照）。

```bash
cd ~/medical-ai/halunasu
PYTHONPATH=python python3 -m medical_fee_calculation.check_masters_import \
    --raw /tmp/check-raw \
    --db  master_data/master.sqlite \
    --label 令和8年度版 \
    --effective 202606
```

出力例:
```
取込開始: /tmp/check-raw → master_data/master.sqlite
  傷病名: 27,684件
  修飾語: 1,3xx件
  医薬品適応: 1,2xx,xxx件
  禁忌傷病名: ...件
  併用禁忌: 4,208件
  診療行為適応: 218,375件
完了: 合計 x,xxx,xxx件
```

- 再実行は全件リフレッシュ（`payer_check_master` の旧行を削除して入れ直し）なので重複しない。
- `--db` は worker が使う `FEE_MASTER_DB_PATH` と同じパスにすること。

### 本番/STGマスタへ自動同梱（公式ビルドに接続）
手動取込ではなく、**公式マスタビルドで自動的に同梱**したい場合は、`build_fee_master_official.py`
に `--check-master-raw` を渡す（gzip 圧縮前に取り込むので配布物に含まれる）:

```bash
PYTHONPATH=python python3 scripts/build_fee_master_official.py \
    --overwrite \
    --check-master-raw /tmp/check-raw \
    --check-master-label 令和8年度版 \
    --check-master-effective 202606
```

`--check-master-raw` を省略すると従来どおり点検マスタは同梱されない（既定オフ）。
デプロイ配布物（gzip）に含めたい環境だけ指定する運用。

### サイズ注意（運用判断）
医薬品適応は約123万行。算定用マスタDBに同居させると gzip 配布サイズが増える。
配布サイズを増やしたくない場合は、点検マスタを**別DB**に取り込み、worker 側で `ATTACH DATABASE` する構成に切替可能（`checks_api.py` のクエリを ATTACH 名前空間へ向ける小改修。将来対応）。

---

## 4. 動作確認

取込後、算定を実行すると点検が自動で効く（fee-api の算定パスに接続済み）。単体確認は次のとおり。

```bash
# check_lookup（適応/禁忌/併用/病名名称）
echo '{"db_path":"master_data/master.sqlite","drug_codes":["620000600"],"disease_codes":["8830592"]}' \
 | PYTHONPATH=python python3 -m medical_fee_calculation.checks_api

# resolve_diseases（病名コード化: 名称→傷病名コード＋疑いフラグ＋分解）
echo '{"op":"resolve_diseases","db_path":"master_data/master.sqlite","names":["急性気管支炎の疑い"]}' \
 | PYTHONPATH=python python3 -m medical_fee_calculation.checks_api
```

---

## 5. 有効化される点検（fee-core claim-checks）

取込が済むと、算定時に以下が reviewIssues として自動付与される（`server.js resolveIndicationReviewIssues`）:

| ルール | 重大度 | 内容 |
|---|---|---|
| IY-001 | warning / info | 医薬品の適応病名なし／疑い病名のみ |
| IY-003 | error | 禁忌傷病名への投与 |
| IY-004 | error | 併用禁忌 |
| SI-001 | warning | 診療行為の適応病名なし |

病名は `resolve_diseases` で名称→コードに寄せてから照合する（カルテ由来の名称主体病名に対応）。
解決できない病名（`matchType: none`）は無指摘（安全側）。

---

## 6. テスト（データ無しでも通る）

実データが無くてもロジックはフィクスチャで検証済み:

```bash
# 取込パーサ（合成フォーマットで parse→INSERT→lookup）
PYTHONPATH=python python3 -m unittest python.tests.test_check_masters_import
# check_lookup / resolve_diseases（病名分解・疑い判定含む）
PYTHONPATH=python python3 -m unittest python.tests.test_checks_api
# fee-core 点検ロジック（適応/禁忌/併用/算定もれ）
node --test packages/fee-core/test/claim-checks.test.js
```

---

## 7. 改定・更新時

診療報酬改定・マスタ更新時は、新しい年度版ZIPを取得して再取込する。
`--effective` を診療年月に合わせて設定（例: R8本体=202606）。多版運用（診療年月で版切替）は、
`master_edition` 的な版解決を `check_lookup` に足す将来対応で（[02] E’ / [01] E と連動）。
