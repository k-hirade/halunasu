"""公的マスターデータ(SQLite)のクエリ層

official_import.py で構築した masters.db に対する参照APIを提供する。
点検ルールはこのクラス経由で公的データ(基本マスター・電子点数表・
支払基金チェックマスタ)を参照する。
"""

from __future__ import annotations

import sqlite3
import threading
from functools import lru_cache
from pathlib import Path
from typing import Optional

# 特殊な傷病名コード(IY_Tekio): 傷病名を条件としない行
NON_DISEASE_CODES = {"0000000", "0000001", "0000002", "0000003"}

# 上限・下限年齢の特殊コード(基本マスター) → 近似年齢(歳)
AGE_SPECIAL = {
    "AA": 28 / 365,   # 生後28日
    "AE": 90 / 365,   # 生後90日
    "B3": 3.1,        # 3歳に達した日の翌月の1日
    "B6": 6.1,        # 6歳に達した日の翌月の1日
    "MG": 6.99,       # 未就学児
    "BF": 15.1,       # 15歳に達した日の翌月の1日
    "BK": 20.1,       # 20歳に達した日の翌月の1日
}


def decode_age(code: str) -> Optional[float]:
    """基本マスターの年齢コード(2桁)を年齢(歳)に変換。00=制限なし→None"""
    code = (code or "").strip()
    if not code or code == "00":
        return None
    if code in AGE_SPECIAL:
        return AGE_SPECIAL[code]
    try:
        return float(code)
    except ValueError:
        return None


class OfficialMasters:
    """masters.db への参照(読み取り専用・スレッドセーフ)

    sqlite3接続はスレッド間共有できないため、スレッドごとに接続を持つ。
    """

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        self._local = threading.local()
        self._conn.execute("SELECT 1")  # 接続確認(存在しなければここで例外)

    @property
    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    def close(self):
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    @staticmethod
    def find_default() -> Optional["OfficialMasters"]:
        """既定の場所から masters.db を探す"""
        for cand in [
            Path("master_data/masters.db"),
            Path(__file__).resolve().parents[2] / "master_data" / "masters.db",
        ]:
            if cand.exists():
                return OfficialMasters(cand)
        return None

    @property
    def effective_from(self) -> str:
        """このマスター版の適用開始年月(YYYYMM)。未設定なら '000000'(常に適用可)"""
        try:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE key='effective_from'"
            ).fetchone()
            return row[0] if row else "000000"
        except sqlite3.Error:
            return "000000"

    @property
    def version_label(self) -> str:
        try:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE key='version_label'"
            ).fetchone()
            return row[0] if row else ""
        except sqlite3.Error:
            return ""


    @lru_cache(maxsize=100000)
    def act(self, code: str) -> Optional[dict]:
        row = self._conn.execute("SELECT * FROM shinryo_koi WHERE code=?", (code,)).fetchone()
        return dict(row) if row else None

    @lru_cache(maxsize=100000)
    def drug(self, code: str) -> Optional[dict]:
        row = self._conn.execute("SELECT * FROM iyakuhin WHERE code=?", (code,)).fetchone()
        return dict(row) if row else None

    @lru_cache(maxsize=100000)
    def disease(self, code: str) -> Optional[dict]:
        row = self._conn.execute("SELECT * FROM byomei WHERE code=?", (code,)).fetchone()
        return dict(row) if row else None

    @lru_cache(maxsize=10000)
    def modifier(self, code: str) -> Optional[dict]:
        row = self._conn.execute("SELECT * FROM shushokugo WHERE code=?", (code,)).fetchone()
        return dict(row) if row else None

    @lru_cache(maxsize=10000)
    def comment(self, code: str) -> Optional[dict]:
        row = self._conn.execute("SELECT * FROM comment_master WHERE code=?", (code,)).fetchone()
        return dict(row) if row else None

    @lru_cache(maxsize=10000)
    def kizai(self, code: str) -> Optional[dict]:
        row = self._conn.execute("SELECT * FROM tokutei_kizai WHERE code=?", (code,)).fetchone()
        return dict(row) if row else None

    def counts(self) -> dict:
        out = {}
        for table, label in [
            ("shinryo_koi", "診療行為"), ("iyakuhin", "医薬品"), ("byomei", "傷病名"),
            ("shushokugo", "修飾語"), ("comment_master", "コメント"), ("tokutei_kizai", "特定器材"),
            ("etensu_haihan", "背反"), ("etensu_kaisu", "算定回数"),
            ("iy_tekio", "医薬品適応・投与量"), ("iy_kinki_byomei", "傷病名禁忌"),
            ("iy_heiyo_kinki", "併用禁忌"), ("si_shobyo", "診療行為適応"),
            ("cc_jirei", "チェック事例"),
        ]:
            out[label] = self._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        return out

    # -- 医薬品チェックデータ ---------------------------------------------------

    @lru_cache(maxsize=50000)
    def drug_indications(self, drug_code: str) -> tuple:
        """医薬品の適応傷病名行(実傷病名コードのみ)。空タプル=適応チェックデータなし"""
        rows = self._conn.execute(
            "SELECT disease_code, sex, age_min, age_max FROM iy_tekio "
            "WHERE drug_code=? AND disease_code NOT IN ('0000000','0000001','0000002','0000003')",
            (drug_code,),
        ).fetchall()
        return tuple((r[0], r[1], r[2], r[3]) for r in rows)

    @lru_cache(maxsize=50000)
    def drug_dose_rules(self, drug_code: str) -> tuple:
        """医薬品の投与量・投与日数制限行(傷病名を条件としない行 + 傷病名条件付き行)"""
        rows = self._conn.execute(
            "SELECT disease_code, sex, age_min, age_max, check_kubun, max_dose, max_days, tekigi "
            "FROM iy_tekio WHERE drug_code=? AND (max_dose < 99999.0 OR max_days < 999)",
            (drug_code,),
        ).fetchall()
        return tuple(tuple(r) for r in rows)

    @lru_cache(maxsize=50000)
    def drug_kinki_diseases(self, drug_code: str) -> tuple:
        """医薬品の禁忌傷病名コード"""
        rows = self._conn.execute(
            "SELECT disease_code FROM iy_kinki_byomei WHERE drug_code=?", (drug_code,)
        ).fetchall()
        return tuple(r[0] for r in rows)

    def heiyo_kinki_pairs(self, drug_codes: list) -> list:
        """医薬品コード群の中の併用禁忌ペア"""
        codes = sorted(set(drug_codes))
        if len(codes) < 2:
            return []
        ph = ",".join("?" * len(codes))
        rows = self._conn.execute(
            f"SELECT drug_a, drug_b FROM iy_heiyo_kinki WHERE drug_a IN ({ph}) AND drug_b IN ({ph})",
            codes + codes,
        ).fetchall()
        # 双方向収載のため片方向に正規化
        seen = set()
        out = []
        for a, b in rows:
            key = tuple(sorted((a, b)))
            if key not in seen:
                seen.add(key)
                out.append(key)
        return out

    @lru_cache(maxsize=50000)
    def toyoryo_groups(self, drug_code: str) -> tuple:
        """同一成分合算チェック(投与量グループ)の行"""
        rows = self._conn.execute(
            "SELECT group_name, unit, disease_code, sex, age_min, age_max, kikaku, taisho_flag, max_dose "
            "FROM iy_toyoryo_group WHERE drug_code=?",
            (drug_code,),
        ).fetchall()
        return tuple(tuple(r) for r in rows)

    @lru_cache(maxsize=50000)
    def act_indications(self, act_code: str) -> tuple:
        """診療行為の適応傷病名行"""
        rows = self._conn.execute(
            "SELECT disease_code, sex, age_min, age_max, nyugai, utagai FROM si_shobyo WHERE act_code=?",
            (act_code,),
        ).fetchall()
        return tuple(tuple(r) for r in rows)

    # -- 電子点数表 -------------------------------------------------------------

    def haihan_pairs(self, codes: list, span: str) -> list:
        """コード群の中の背反ペア。span: day/month/simul/week

        戻り値: [(code_a, code_b, kubun, name_a, name_b, tokurei)]
        """
        cs = sorted(set(codes))
        if len(cs) < 2:
            return []
        ph = ",".join("?" * len(cs))
        rows = self._conn.execute(
            f"SELECT code_a, code_b, kubun, name_a, name_b, tokurei FROM etensu_haihan "
            f"WHERE span=? AND code_a IN ({ph}) AND code_b IN ({ph})",
            [span] + cs + cs,
        ).fetchall()
        seen = set()
        out = []
        for r in rows:
            key = tuple(sorted((r[0], r[1])))
            if key in seen:
                continue
            seen.add(key)
            out.append(tuple(r))
        return out

    @lru_cache(maxsize=50000)
    def kaisu_limits(self, code: str) -> tuple:
        """診療行為の算定回数制限 [(unit_code, unit_name, max_count, tokurei)]"""
        rows = self._conn.execute(
            "SELECT unit_code, unit_name, max_count, tokurei FROM etensu_kaisu WHERE code=?",
            (code,),
        ).fetchall()
        return tuple(tuple(r) for r in rows)

    @lru_cache(maxsize=50000)
    def hojo(self, code: str) -> Optional[dict]:
        row = self._conn.execute("SELECT * FROM etensu_hojo WHERE code=?", (code,)).fetchone()
        return dict(row) if row else None

    @lru_cache(maxsize=20000)
    def hokatsu_children(self, group_no: str) -> tuple:
        """包括グループに含まれる(=包括される側の)診療行為"""
        rows = self._conn.execute(
            "SELECT code, name, tokurei FROM etensu_hokatsu WHERE group_no=?", (group_no,)
        ).fetchall()
        return tuple(tuple(r) for r in rows)

    # -- 傷病名検索(未コード化病名のコード化支援) --------------------------------

    @lru_cache(maxsize=1)
    def all_modifiers(self) -> tuple:
        """全修飾語 (code, name) — 未コード化病名の分解に使う"""
        rows = self._conn.execute(
            "SELECT code, name FROM shushokugo WHERE name != '' ORDER BY LENGTH(name) DESC"
        ).fetchall()
        return tuple((r[0], r[1]) for r in rows)

    @lru_cache(maxsize=5000)
    def search_diseases_by_name(self, text: str, limit: int = 5) -> tuple:
        """名称でレセ電傷病名を検索(完全一致→部分一致)。

        未コード化傷病名(0000999)のコード化候補提示に使う。
        戻り値: ((code, name, match_type), ...) match_type: exact / partial
        """
        text = (text or "").strip()
        if not text:
            return ()
        rows = self._conn.execute(
            "SELECT code, name FROM byomei WHERE name=? AND end_date='99999999' LIMIT ?",
            (text, limit),
        ).fetchall()
        if rows:
            return tuple((r[0], r[1], "exact") for r in rows)
        like = f"%{text}%"
        rows = self._conn.execute(
            "SELECT code, name FROM byomei WHERE name LIKE ? AND end_date='99999999' "
            "ORDER BY LENGTH(name) LIMIT ?",
            (like, limit),
        ).fetchall()
        return tuple((r[0], r[1], "partial") for r in rows)

    def decompose_uncoded_name(self, text: str) -> Optional[dict]:
        """未コード化病名を「接頭語+基本病名+接尾語」に分解してコード化候補を返す。

        例: 「急性気管支炎の疑い」→ 接頭語[急性(4012)] + 気管支炎 + 接尾語[の疑い(8002)]
        戻り値: {"prefixes": [(code,name)], "suffixes": [(code,name)],
                 "core": str, "candidates": ((code,name,match_type),...)} または None
        """
        core = (text or "").strip()
        if not core:
            return None
        prefixes, suffixes = [], []

        def exact(t: str) -> bool:
            cands = self.search_diseases_by_name(t)
            return bool(cands) and cands[0][2] == "exact"

        # 基本病名に到達したら剥がすのをやめる(貪欲に剥がしすぎない)
        while core and not exact(core):
            stripped = False
            for code, name in self.all_modifiers():
                if not name:
                    continue
                if code.startswith("8"):
                    if core.endswith(name) and len(core) > len(name):
                        suffixes.insert(0, (code, name))
                        core = core[: -len(name)]
                        stripped = True
                        break
                else:
                    if core.startswith(name) and len(core) > len(name):
                        prefixes.append((code, name))
                        core = core[len(name):]
                        stripped = True
                        break
            if not stripped:
                break
        candidates = self.search_diseases_by_name(core)
        if not candidates:
            return None
        return {
            "prefixes": prefixes,
            "suffixes": suffixes,
            "core": core,
            "candidates": candidates,
        }

    # -- 支払基金チェック事例(参考情報) -----------------------------------------

    @lru_cache(maxsize=50000)
    def cc_jirei_for(self, code: str) -> tuple:
        """コードに対する支払基金コンピュータチェック事例(観点・内容)"""
        rows = self._conn.execute(
            "SELECT kanten, content, ref_range, konkyo FROM cc_jirei WHERE master_code=? LIMIT 20",
            (code,),
        ).fetchall()
        return tuple(tuple(r) for r in rows)

    def meta(self) -> dict:
        return dict(self._conn.execute("SELECT key, value FROM meta").fetchall())


class MasterVersions:
    """年度版マスターのレジストリ。

    診療報酬改定をまたぐ点検のため、複数年度版の masters.db を保持し、
    レセプトの診療年月に応じて適用版を選択する。

    ファイル配置:
        master_data/masters.db          … 単一版(従来どおり。効力期間なし)
        master_data/masters_R06.db 等   … 年度版(meta.effective_from で切替)
    """

    def __init__(self, versions: list):
        # versions: [OfficialMasters] effective_from 昇順に整列
        self.versions = sorted(versions, key=lambda m: m.effective_from)

    @staticmethod
    def discover(base_dir: str | Path | None = None) -> Optional["MasterVersions"]:
        """master_data/ から利用可能な全年度版を検出する"""
        candidates = []
        for d in ([Path(base_dir)] if base_dir else [
            Path("master_data"),
            Path(__file__).resolve().parents[2] / "master_data",
        ]):
            if not d.is_dir():
                continue
            found = sorted(d.glob("masters*.db"))
            if found:
                candidates = found
                break
        if not candidates:
            return None
        return MasterVersions([OfficialMasters(p) for p in candidates])

    @property
    def latest(self) -> OfficialMasters:
        return self.versions[-1]

    def for_ym(self, ym: str) -> OfficialMasters:
        """診療年月(YYYYMM)に適用される版を返す。

        effective_from が診療年月以下のもののうち最新の版。
        該当がなければ(古すぎるレセプト)最古の版を返す。
        """
        ym = (ym or "").strip()
        if not ym or len(ym) != 6:
            return self.latest
        chosen = None
        for m in self.versions:
            if m.effective_from <= ym:
                chosen = m
        return chosen or self.versions[0]

    def labels(self) -> list:
        return [
            (m.version_label or Path(m.db_path).stem, m.effective_from)
            for m in self.versions
        ]

    # -- 基本マスター ---------------------------------------------------------
