"""公的マスターデータのSQLite取込み

master_data/raw/ に展開済みの公的データ(download.py参照)を読み、
点検エンジンが参照する SQLite データベースを構築する。

使い方:
    python -m receipt_checker.masters.official_import \
        [--raw master_data/raw] [--db master_data/masters.db]

列位置は「レセプト電算処理システム マスターファイル仕様説明書」
「医科電子点数表の活用手引き」「コンピュータチェック対象事例ファイル
仕様書(チェックマスタ)」に基づき、実ファイルで実証確認済み。
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from pathlib import Path

SCHEMA = """
DROP TABLE IF EXISTS shinryo_koi;
CREATE TABLE shinryo_koi (
    code TEXT PRIMARY KEY,
    name TEXT, kana TEXT, full_name TEXT,
    tensu_type TEXT, tensu REAL,
    nyugai TEXT,            -- 入外適用 0:両方 1:入院のみ 2:入院外のみ
    hosp_clinic TEXT,       -- 病院・診療所区分
    byomei_kanren TEXT,     -- 傷病名関連区分(5:特定疾患療養管理料等)
    jitsu_nissu TEXT,       -- 実日数区分
    nissu_kaisu TEXT,
    kaisu_limit INTEGER,    -- 上限回数(0=制限なし)
    kaisu_error TEXT,
    chukasan_code TEXT,     -- 注加算コード(基本項目と加算を結ぶ)
    chukasan_ban TEXT,      -- 注加算通番(0=基本項目)
    lower_age TEXT, upper_age TEXT,
    kensa_hantei TEXT,      -- 検査等実施判断区分(1:実施料 2:判断料)
    kensa_group TEXT,       -- 検査グループ
    kokuji_kubun TEXT,      -- 告示等識別(1:基本 7:加算 9:通則加算)
    kubun TEXT,             -- 点数表区分(A000等)
    end_date TEXT
);
DROP TABLE IF EXISTS iyakuhin;
CREATE TABLE iyakuhin (
    code TEXT PRIMARY KEY,
    name TEXT, kana TEXT, full_name TEXT,
    unit TEXT, price_type TEXT, price REAL,
    mayaku TEXT,            -- 0:通常 1:麻薬 2:毒薬 3:覚醒剤原料 5:向精神薬
    biological INTEGER, kohatsu INTEGER,
    zokei TEXT, chusha_yoryo REAL,
    dosage_form TEXT,       -- 1:内用 3:その他 4:注射 6:外用 8:歯科用
    yj_code TEXT,
    generic_code TEXT, generic_name TEXT, generic_kasan TEXT,
    end_date TEXT
);
DROP TABLE IF EXISTS byomei;
CREATE TABLE byomei (
    code TEXT PRIMARY KEY,
    name TEXT, short_name TEXT, kana TEXT,
    icd10 TEXT,
    tandoku_kinshi TEXT,    -- 01:修飾語必須
    hoken_gai INTEGER,      -- 1:保険請求対象外
    tokutei_shikkan TEXT,   -- 特定疾患等対象区分(05:特定疾患療養管理料等)
    nanbyo_gairai TEXT,     -- 09:難病外来指導管理料対象
    end_date TEXT
);
DROP TABLE IF EXISTS shushokugo;
CREATE TABLE shushokugo (code TEXT PRIMARY KEY, name TEXT, kubun TEXT);
DROP TABLE IF EXISTS comment_master;
CREATE TABLE comment_master (
    code TEXT PRIMARY KEY, pattern TEXT, name TEXT, selectable INTEGER, end_date TEXT
);
DROP TABLE IF EXISTS tokutei_kizai;
CREATE TABLE tokutei_kizai (
    code TEXT PRIMARY KEY, name TEXT, unit TEXT, price_type TEXT, price REAL,
    lower_age TEXT, upper_age TEXT, end_date TEXT
);

-- 電子点数表
DROP TABLE IF EXISTS etensu_hojo;
CREATE TABLE etensu_hojo (
    code TEXT PRIMARY KEY,
    h_unit1 TEXT, h_group1 TEXT, h_unit2 TEXT, h_group2 TEXT, h_unit3 TEXT, h_group3 TEXT,
    hai_day INTEGER, hai_month INTEGER, hai_simul INTEGER, hai_week INTEGER,
    nyuin_group TEXT, kaisu_flag INTEGER, end_date TEXT
);
DROP TABLE IF EXISTS etensu_hokatsu;
CREATE TABLE etensu_hokatsu (
    group_no TEXT, code TEXT, name TEXT, tokurei TEXT, end_date TEXT
);
CREATE INDEX idx_hokatsu_group ON etensu_hokatsu(group_no);
CREATE INDEX idx_hokatsu_code ON etensu_hokatsu(code);
DROP TABLE IF EXISTS etensu_haihan;
CREATE TABLE etensu_haihan (
    span TEXT,              -- day / month / simul / week
    code_a TEXT, name_a TEXT, code_b TEXT, name_b TEXT,
    kubun TEXT,             -- 1:①を算定 2:②を算定 3:いずれか一方
    tokurei TEXT, end_date TEXT
);
CREATE INDEX idx_haihan_a ON etensu_haihan(code_a);
DROP TABLE IF EXISTS etensu_kaisu;
CREATE TABLE etensu_kaisu (
    code TEXT, name TEXT, unit_code TEXT, unit_name TEXT,
    max_count INTEGER, tokurei TEXT, end_date TEXT
);
CREATE INDEX idx_kaisu_code ON etensu_kaisu(code);
DROP TABLE IF EXISTS etensu_nyuin;
CREATE TABLE etensu_nyuin (
    group_no TEXT, code TEXT, name TEXT, kasan_id TEXT, end_date TEXT
);
CREATE INDEX idx_nyuin_code ON etensu_nyuin(code);

-- 支払基金チェックマスタ
DROP TABLE IF EXISTS iy_tekio;
CREATE TABLE iy_tekio (
    drug_code TEXT, disease_code TEXT, sex TEXT,
    age_min REAL, age_max REAL, check_kubun TEXT,
    max_dose REAL, max_days INTEGER, tekigi TEXT, ref_range TEXT
);
CREATE INDEX idx_tekio_drug ON iy_tekio(drug_code);
DROP TABLE IF EXISTS iy_kinki_byomei;
CREATE TABLE iy_kinki_byomei (drug_code TEXT, disease_code TEXT, ref_range TEXT);
CREATE INDEX idx_kinki_drug ON iy_kinki_byomei(drug_code);
DROP TABLE IF EXISTS iy_heiyo_kinki;
CREATE TABLE iy_heiyo_kinki (drug_a TEXT, drug_b TEXT, ref_range TEXT);
CREATE INDEX idx_heiyo_a ON iy_heiyo_kinki(drug_a);
DROP TABLE IF EXISTS iy_manzen;
CREATE TABLE iy_manzen (
    drug_code TEXT, keitai TEXT, group_name TEXT, disease_code TEXT,
    taisho_flag TEXT, manzen_flag TEXT, manzen_days INTEGER,
    reset_days INTEGER, keisu REAL
);
CREATE INDEX idx_manzen_drug ON iy_manzen(drug_code);
DROP TABLE IF EXISTS iy_toyoryo_group;
CREATE TABLE iy_toyoryo_group (
    drug_code TEXT, keitai TEXT, unit TEXT, group_name TEXT, disease_code TEXT,
    sex TEXT, age_min REAL, age_max REAL, kikaku REAL, taisho_flag TEXT, max_dose REAL
);
CREATE INDEX idx_toyoryo_drug ON iy_toyoryo_group(drug_code);
DROP TABLE IF EXISTS si_shobyo;
CREATE TABLE si_shobyo (
    act_code TEXT, disease_code TEXT, sex TEXT,
    age_min REAL, age_max REAL, nyugai TEXT, utagai TEXT, ref_range TEXT
);
CREATE INDEX idx_sishobyo_act ON si_shobyo(act_code);
DROP TABLE IF EXISTS cc_jirei;
CREATE TABLE cc_jirei (
    master_code TEXT, name TEXT, target TEXT, kanten TEXT, content TEXT,
    ref_range TEXT, ika TEXT, konkyo TEXT, konkyo_text TEXT, jirei_code TEXT
);
CREATE INDEX idx_jirei_code ON cc_jirei(master_code);

DROP TABLE IF EXISTS meta;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""


def _f(v: str):
    v = (v or "").strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _i(v: str):
    f = _f(v)
    return int(f) if f is not None else None


def _rows(path: Path, skip_header: bool = False):
    with open(path, encoding="cp932", errors="replace", newline="") as fh:
        reader = csv.reader(fh)
        for i, row in enumerate(reader):
            if skip_header and i == 0:
                continue
            if row:
                yield row


def _find(raw: Path, prefix: str, suffixes=(".csv", ".txt")) -> Path | None:
    files = [p for p in raw.iterdir() if p.suffix.lower() in suffixes]
    cands = sorted(p for p in files if p.name.lower().startswith(prefix.lower()))
    if cands:
        return cands[-1]
    # ZIP内ファイル名の空白有無の揺れ(例: 「01 補助…」と「01補助…」)に耐えるため、
    # アンダースコアを無視した前方一致でも探す
    norm_prefix = prefix.lower().replace("_", "")
    cands = sorted(
        p for p in files
        if p.name.lower().replace("_", "").startswith(norm_prefix)
    )
    return cands[-1] if cands else None


def _batch_insert(conn, sql, rows, batch=5000):
    buf = []
    n = 0
    for r in rows:
        buf.append(r)
        if len(buf) >= batch:
            conn.executemany(sql, buf)
            n += len(buf)
            buf.clear()
    if buf:
        conn.executemany(sql, buf)
        n += len(buf)
    return n


def import_all(
    raw_dir: str | Path,
    db_path: str | Path,
    quiet: bool = False,
    effective_from: str = "000000",
    version_label: str = "",
) -> dict:
    raw = Path(raw_dir)
    db = Path(db_path)
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.executescript(SCHEMA)
    counts: dict = {}

    def log(label, n):
        counts[label] = n
        if not quiet:
            print(f"  {label}: {n:,}件")

    # ---- 医科診療行為マスター (s_*.csv, 150列) ----
    p = _find(raw, "s_")
    if p:
        def gen():
            for r in _rows(p):
                if len(r) < 113 or r[1] != "S":
                    continue
                alpha = r[84].strip()
                kubun = ""
                if alpha and alpha not in ("-", "*"):
                    kubun = alpha + r[91].strip()
                    eda = r[92].strip()
                    if eda and eda != "00":
                        kubun += f"-{int(eda)}"
                yield (
                    r[2], r[4], r[6], r[112],
                    r[10], _f(r[11]), r[12], r[18],
                    r[24], r[26], r[27],
                    _i(r[35]), r[36], r[37], r[38],
                    r[40], r[41], r[49], r[50], r[67],
                    kubun, r[87],
                )
        n = _batch_insert(conn, "INSERT OR REPLACE INTO shinryo_koi VALUES (" + ",".join("?" * 22) + ")", gen())
        log("医科診療行為マスター", n)

    # ---- 医薬品マスター (y_*.csv, 42列) ----
    p = _find(raw, "y_")
    if p:
        def gen():
            for r in _rows(p):
                if len(r) < 35 or r[1] != "Y":
                    continue
                yield (
                    r[2], r[4], r[6], r[34],
                    r[9], r[10], _f(r[11]),
                    r[13], _i(r[15]), _i(r[16]),
                    r[19], _f(r[20]), r[27],
                    r[31],
                    r[36] if len(r) > 36 else "",
                    r[37] if len(r) > 37 else "",
                    r[38] if len(r) > 38 else "",
                    r[30],
                )
        n = _batch_insert(conn, "INSERT OR REPLACE INTO iyakuhin VALUES (" + ",".join("?" * 18) + ")", gen())
        log("医薬品マスター", n)

    # ---- 傷病名マスター (b_*.txt, 46列) ----
    p = _find(raw, "b_")
    if p:
        def gen():
            for r in _rows(p):
                if len(r) < 44 or r[1] != "B":
                    continue
                icd = r[15].strip() or r[13].strip()
                yield (
                    r[2], r[5], r[7], r[9],
                    icd, r[18], _i(r[19]) or 0, r[20], r[42], r[23],
                )
        n = _batch_insert(conn, "INSERT OR REPLACE INTO byomei VALUES (" + ",".join("?" * 10) + ")", gen())
        log("傷病名マスター", n)

    # ---- 修飾語マスター (z_*.txt, 19列) ----
    p = _find(raw, "z_")
    if p:
        def gen():
            for r in _rows(p):
                if len(r) < 19 or r[1] != "Z":
                    continue
                yield (r[2], r[6], r[18])
        n = _batch_insert(conn, "INSERT OR REPLACE INTO shushokugo VALUES (?,?,?)", gen())
        log("修飾語マスター", n)

    # ---- コメントマスター (c_*.csv, 30列) ----
    p = _find(raw, "c_")
    if p:
        def gen():
            for r in _rows(p):
                if len(r) < 23 or r[1] != "C":
                    continue
                yield (r[22], r[3], r[6], _i(r[19]) or 0, r[21])
        n = _batch_insert(conn, "INSERT OR REPLACE INTO comment_master VALUES (?,?,?,?,?)", gen())
        log("コメントマスター", n)

    # ---- 特定器材マスター (t_*.csv, 37列) ----
    p = _find(raw, "t_")
    if p:
        def gen():
            for r in _rows(p):
                if len(r) < 30 or r[1] != "T":
                    continue
                yield (r[2], r[4], r[9], r[10], _f(r[11]), r[14], r[15], r[29])
        n = _batch_insert(conn, "INSERT OR REPLACE INTO tokutei_kizai VALUES (?,?,?,?,?,?,?,?)", gen())
        log("特定器材マスター", n)

    # ---- 電子点数表: 補助マスター (27列) ----
    p = _find(raw, "01_hojo")
    if p:
        def gen():
            for r in _rows(p):
                if len(r) < 27:
                    continue
                yield (
                    r[1], r[3], r[4], r[5], r[6], r[7], r[8],
                    _i(r[9]) or 0, _i(r[10]) or 0, _i(r[11]) or 0, _i(r[12]) or 0,
                    r[19], _i(r[20]) or 0, r[26],
                )
        n = _batch_insert(conn, "INSERT OR REPLACE INTO etensu_hojo VALUES (" + ",".join("?" * 14) + ")", gen())
        log("電子点数表(補助)", n)

    # ---- 電子点数表: 包括テーブル (7列) ----
    p = _find(raw, "02_hokatsu")
    if p:
        n = _batch_insert(
            conn, "INSERT INTO etensu_hokatsu VALUES (?,?,?,?,?)",
            ((r[1], r[2], r[3], r[4], r[6]) for r in _rows(p) if len(r) >= 7),
        )
        log("電子点数表(包括)", n)

    # ---- 電子点数表: 背反テーブル1〜4 (10列) ----
    spans = [("03-1", "day"), ("03-2", "month"), ("03-3", "simul"), ("03-4", "week")]
    total = 0
    for prefix, span in spans:
        p = _find(raw, prefix)
        if not p:
            continue
        total += _batch_insert(
            conn, "INSERT INTO etensu_haihan VALUES (?,?,?,?,?,?,?,?)",
            (
                (span, r[1], r[2], r[3], r[4], r[5], r[6], r[9])
                for r in _rows(p) if len(r) >= 10
            ),
        )
    log("電子点数表(背反)", total)

    # ---- 電子点数表: 算定回数テーブル (14列) ----
    p = _find(raw, "05_santei_kaisu")
    if p:
        n = _batch_insert(
            conn, "INSERT INTO etensu_kaisu VALUES (?,?,?,?,?,?,?)",
            (
                (r[1], r[2], r[3], r[4], _i(r[5]), r[6], r[13])
                for r in _rows(p) if len(r) >= 14
            ),
        )
        log("電子点数表(算定回数)", n)

    # ---- 電子点数表: 入院基本料テーブル (8列) ----
    p = _find(raw, "04_nyuin")
    if p:
        n = _batch_insert(
            conn, "INSERT INTO etensu_nyuin VALUES (?,?,?,?,?)",
            ((r[1], r[2], r[3], r[4], r[7]) for r in _rows(p) if len(r) >= 8),
        )
        log("電子点数表(入院基本料)", n)

    # ---- チェックマスタ: 医薬品適応 (ヘッダーあり, 24列) ----
    p = _find(raw, "IY_Tekio")
    if p:
        def gen():
            for r in _rows(p, skip_header=True):
                if len(r) < 24 or r[22] in ("1", "9"):
                    continue
                yield (
                    r[0], r[1], r[4], _f(r[5]), _f(r[6]), r[7],
                    _f(r[12]), _i(r[14]), r[20], r[23],
                )
        n = _batch_insert(conn, "INSERT INTO iy_tekio VALUES (?,?,?,?,?,?,?,?,?,?)", gen())
        log("チェックマスタ(医薬品適応・投与量)", n)

    # ---- チェックマスタ: 傷病名禁忌 (8列) ----
    p = _find(raw, "IY_ShobyoKinki")
    if p:
        n = _batch_insert(
            conn, "INSERT INTO iy_kinki_byomei VALUES (?,?,?)",
            (
                (r[0], r[1], r[7])
                for r in _rows(p, skip_header=True)
                if len(r) >= 8 and r[6] not in ("1", "9")
            ),
        )
        log("チェックマスタ(傷病名禁忌)", n)

    # ---- チェックマスタ: 併用禁忌 (10列) ----
    p = _find(raw, "IY_HeiyoKinki")
    if p:
        n = _batch_insert(
            conn, "INSERT INTO iy_heiyo_kinki VALUES (?,?,?)",
            (
                (r[0], r[1], r[9])
                for r in _rows(p, skip_header=True)
                if len(r) >= 10 and r[8] not in ("1", "9")
            ),
        )
        log("チェックマスタ(併用禁忌)", n)

    # ---- チェックマスタ: 漫然投与グループ (11列) ----
    p = _find(raw, "IY_Manzen")
    if p:
        n = _batch_insert(
            conn, "INSERT INTO iy_manzen VALUES (?,?,?,?,?,?,?,?,?)",
            (
                (r[0], r[1], r[2], r[3], r[4], r[5], _i(r[6]), _i(r[7]), _f(r[8]))
                for r in _rows(p, skip_header=True)
                if len(r) >= 11 and r[9] not in ("1", "9")
            ),
        )
        log("チェックマスタ(漫然投与)", n)

    # ---- チェックマスタ: 投与量グループ (13列) ----
    p = _find(raw, "IY_Toyoryou")
    if p:
        n = _batch_insert(
            conn, "INSERT INTO iy_toyoryo_group VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                (r[0], r[1], r[2], r[3], r[4], r[5], _f(r[6]), _f(r[7]), _f(r[8]), r[9], _f(r[10]))
                for r in _rows(p, skip_header=True)
                if len(r) >= 13 and r[11] not in ("1", "9")
            ),
        )
        log("チェックマスタ(投与量グループ)", n)

    # ---- チェックマスタ: 診療行為適応 (13列) ----
    p = _find(raw, "SI_Shobyo")
    if p:
        n = _batch_insert(
            conn, "INSERT INTO si_shobyo VALUES (?,?,?,?,?,?,?,?)",
            (
                (r[0], r[1], r[6], _f(r[7]), _f(r[8]), r[9], r[10], r[12])
                for r in _rows(p, skip_header=True)
                if len(r) >= 13 and r[11] not in ("1", "9")
            ),
        )
        log("チェックマスタ(診療行為適応)", n)

    # ---- チェックマスタ: 対象事例 (20列) ----
    p = _find(raw, "CC_JIREI")
    if p:
        n = _batch_insert(
            conn, "INSERT INTO cc_jirei VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[10], r[11], r[12])
                for r in _rows(p, skip_header=True)
                if len(r) >= 20 and r[14] not in ("1", "9")
            ),
        )
        log("チェックマスタ(対象事例)", n)

    import datetime
    conn.execute(
        "INSERT OR REPLACE INTO meta VALUES ('imported_at', ?)",
        (datetime.datetime.now().isoformat(timespec="seconds"),),
    )
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('raw_dir', ?)", (str(raw),))
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('effective_from', ?)", (effective_from,))
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('version_label', ?)", (version_label,))
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    return counts


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="公的マスターのSQLite取込み",
        epilog=(
            "改定またぎ対応: 年度版ごとに --db masters_R06.db --effective 202406 --label 令和6年度版 "
            "のように取り込むと、点検時に診療年月へ適用される版が自動選択されます。"
        ),
    )
    ap.add_argument("--raw", default="master_data/raw")
    ap.add_argument("--db", default="master_data/masters.db")
    ap.add_argument("--effective", default="000000",
                    help="この版の適用開始年月(YYYYMM)。例: 令和8年度版=202606")
    ap.add_argument("--label", default="", help="版の表示名。例: 令和8年度版")
    args = ap.parse_args(argv)
    if not Path(args.raw).is_dir():
        print(f"エラー: {args.raw} がありません。先に download.py を実行してください")
        return 1
    print(f"取込み開始: {args.raw} → {args.db}"
          + (f"(適用開始: {args.effective})" if args.effective != "000000" else ""))
    import_all(args.raw, args.db, effective_from=args.effective, version_label=args.label)
    print("完了")
    return 0


if __name__ == "__main__":
    sys.exit(main())
