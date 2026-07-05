"""マスターデータのロード

2種類のデータを扱う:

1. 基本マスター(名称解決・属性参照用)
   - 診療行為マスター / 医薬品マスター / 傷病名マスター / 修飾語マスター
   - 同梱のデモマスター(CSV, UTF-8)のほか、診療報酬情報提供サービス
     (shinryohoshu.mhlw.go.jp)からダウンロードした本番マスターの取込みに対応

2. 点検ルールデータ(チェックの根拠となる対応表)
   - 医薬品適応 / 診療行為適応 / 併用禁忌 / 用量・日数制限
   - 併算定不可(背反) / 回数制限 / 算定もれパターン / 摘要記載要件
   - 年齢性別制限

すべてCSVで管理し、医事課職員が自院ルールを追記できる構成とする。
"""

from __future__ import annotations

import csv
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .official import MasterVersions, OfficialMasters

logger = logging.getLogger(__name__)

DEFAULT_DATA_DIR = Path(__file__).parent / "data"


# ---------------------------------------------------------------------------
# 行データ構造
# ---------------------------------------------------------------------------

@dataclass
class ShinryoKoi:
    """診療行為マスターの1行"""
    code: str
    name: str
    points: Optional[float] = None
    point_type: str = ""     # 点数識別(1:金額 3:点数 等)
    min_age: Optional[int] = None
    max_age: Optional[int] = None
    sex: str = ""            # 1:男のみ 2:女のみ 空:制限なし
    category: str = ""       # 区分(初再診/医学管理/検査...)自由記述


@dataclass
class Iyakuhin:
    """医薬品マスターの1行"""
    code: str
    name: str
    unit: str = ""
    price: Optional[float] = None
    dose_form: str = ""          # 剤形(内服/外用/注射)
    max_daily_dose: Optional[float] = None  # 1日最大用量(単位はunitと同じ)
    days_limit: Optional[int] = None        # 投与日数上限(14/30/90等)
    narcotic_class: str = ""     # 麻毒区分(麻薬/向精神薬等)
    generic_name: str = ""       # 一般名(成分名) 併用禁忌の照合キー


@dataclass
class Byomei:
    code: str
    name: str
    icd10: str = ""


@dataclass
class DrugIndication:
    """医薬品の適応(この医薬品にはこれらの病名のいずれかが必要)"""
    drug_code: str
    drug_name: str
    disease_codes: set = field(default_factory=set)
    disease_keywords: list = field(default_factory=list)


@dataclass
class ActIndication:
    """診療行為の適応(この診療行為にはこれらの病名のいずれかが必要)"""
    act_code: str
    act_name: str
    disease_codes: set = field(default_factory=set)
    disease_keywords: list = field(default_factory=list)


@dataclass
class Contraindication:
    """併用禁忌の組み合わせ(一般名レベルで照合)"""
    generic_a: str
    name_a: str
    generic_b: str
    name_b: str
    reason: str = ""


@dataclass
class ExclusivePair:
    """併算定不可(背反)の組み合わせ"""
    code_a: str
    name_a: str
    code_b: str
    name_b: str
    span: str = "same_month"   # same_day | same_month
    reason: str = ""
    source: str = ""           # 根拠(告示・通知)


@dataclass
class FrequencyLimit:
    """算定回数制限"""
    code: str
    name: str
    period: str = "month"      # day | week | month | once(初回のみ)
    max_count: int = 1
    reason: str = ""


@dataclass
class MissingPattern:
    """算定もれパターン: トリガーがあるのに期待算定がない"""
    pattern_id: str
    trigger_type: str          # act | drug | drug_category | disease
    trigger_codes: set = field(default_factory=set)
    trigger_keywords: list = field(default_factory=list)
    expected_codes: set = field(default_factory=set)
    expected_name: str = ""
    message: str = ""
    severity: str = "info"


@dataclass
class CommentRequirement:
    """摘要記載(コメント・症状詳記)が必要な診療行為"""
    act_code: str
    act_name: str
    requirement: str = "comment"   # comment | shoujoushouki(症状詳記)
    message: str = ""


@dataclass
class AgeSexRestriction:
    """年齢・性別制限(診療行為・医薬品共通)"""
    code: str
    name: str
    sex: str = ""                  # 1:男のみ 2:女のみ
    min_age: Optional[int] = None
    max_age: Optional[int] = None
    message: str = ""


# ---------------------------------------------------------------------------
# MasterSet
# ---------------------------------------------------------------------------

@dataclass
class MasterSet:
    """全マスターを束ねる参照セット"""

    shinryo_koi: dict = field(default_factory=dict)     # code -> ShinryoKoi
    iyakuhin: dict = field(default_factory=dict)        # code -> Iyakuhin
    byomei: dict = field(default_factory=dict)          # code -> Byomei
    shushokugo: dict = field(default_factory=dict)      # code -> name

    drug_indications: dict = field(default_factory=dict)    # drug_code -> DrugIndication
    act_indications: dict = field(default_factory=dict)     # act_code -> ActIndication
    contraindications: list = field(default_factory=list)   # [Contraindication]
    exclusive_pairs: list = field(default_factory=list)     # [ExclusivePair]
    frequency_limits: dict = field(default_factory=dict)    # code -> FrequencyLimit
    missing_patterns: list = field(default_factory=list)    # [MissingPattern]
    comment_requirements: dict = field(default_factory=dict)  # act_code -> CommentRequirement
    age_sex_restrictions: dict = field(default_factory=dict)  # code -> AgeSexRestriction

    data_dir: str = ""
    official: Optional[OfficialMasters] = None  # 公的マスター(SQLite)。あれば優先
    versions: Optional[MasterVersions] = None   # 年度版レジストリ(改定またぎ対応)

    @property
    def has_official(self) -> bool:
        return self.official is not None

    def for_ym(self, ym: str) -> "MasterSet":
        """診療年月(YYYYMM)に適用される年度版マスターを束ねたビューを返す。

        年度版が1つしかない場合は自分自身を返す(コピー不要)。
        """
        if not self.versions or len(self.versions.versions) <= 1:
            return self
        selected = self.versions.for_ym(ym)
        if selected is self.official:
            return self
        import dataclasses

        return dataclasses.replace(self, official=selected)

    # -- 名称解決 -------------------------------------------------------------

    def act_name(self, code: str) -> str:
        if self.official:
            m = self.official.act(code)
            if m:
                return m["name"]
        m = self.shinryo_koi.get(code)
        return m.name if m else ""

    def drug_name(self, code: str) -> str:
        if self.official:
            m = self.official.drug(code)
            if m:
                return m["name"]
        m = self.iyakuhin.get(code)
        return m.name if m else ""

    def disease_name(self, code: str) -> str:
        if self.official:
            m = self.official.disease(code)
            if m:
                return m["name"]
        m = self.byomei.get(code)
        return m.name if m else ""

    def kizai_name(self, code: str) -> str:
        if self.official:
            m = self.official.kizai(code)
            if m:
                return m["name"]
        return ""

    def modifier_name(self, code: str) -> str:
        if self.official:
            m = self.official.modifier(code)
            if m:
                return m["name"]
        return self.shushokugo.get(code, "")

    def resolve_names(self, claim_file) -> None:
        """レセプト内のコードに名称を付与する(UI表示用)

        名称解決も点検と同じく診療年月に応じた年度版で行い、
        見つからない場合は他の年度版にフォールバックする
        (改定で廃止/新設されたコードも名称表示できるようにする)。
        """
        for r in claim_file.receipts:
            d_ym = r.shinryo_ym_as_date()
            ym = f"{d_ym.year:04d}{d_ym.month:02d}" if d_ym else ""
            view = self.for_ym(ym) if ym else self

            def lookup(kind_fn_name: str, code: str) -> str:
                name = getattr(view, kind_fn_name)(code)
                if name or not self.versions:
                    return name
                # 他年度版へのフォールバック(廃止・未適用コードの名称表示用)
                for v in self.versions.versions:
                    if view.official is not None and v is view.official:
                        continue
                    import dataclasses

                    alt = dataclasses.replace(self, official=v)
                    name = getattr(alt, kind_fn_name)(code)
                    if name:
                        return name
                return ""

            for d in r.diseases:
                if not d.resolved_name:
                    base = lookup("disease_name", d.code)
                    if base:
                        prefix, suffix = view._modifier_names(d.modifiers)
                        d.resolved_name = prefix + base + suffix
            for it in r.items:
                if it.resolved_name:
                    continue
                if it.rec_type == "SI":
                    it.resolved_name = lookup("act_name", it.code)
                elif it.rec_type == "IY":
                    it.resolved_name = lookup("drug_name", it.code)
                elif it.rec_type == "TO":
                    it.resolved_name = lookup("kizai_name", it.code)

    def _modifier_names(self, modifiers: str) -> tuple:
        """修飾語コード列を(接頭語, 接尾語)の表示文字列に変換"""
        prefix, suffix = "", ""
        m = (modifiers or "").strip()
        for i in range(0, len(m) - len(m) % 4, 4):
            code = m[i:i + 4]
            name = self.modifier_name(code)
            if not name:
                continue
            # 8xxx系は接尾語(「の疑い」等)、それ以外は接頭語
            if code.startswith("8"):
                suffix += name
            else:
                prefix += name
        return prefix, suffix

    # -- 統計 -----------------------------------------------------------------

    def stats(self) -> dict:
        if self.official:
            out = dict(self.official.counts())
            out["施設ルール(併算定不可)"] = len(self.exclusive_pairs)
            out["施設ルール(適応)"] = len(self.drug_indications) + len(self.act_indications)
            out["施設ルール(算定もれ)"] = len(self.missing_patterns)
            return out
        return {
            "診療行為マスター": len(self.shinryo_koi),
            "医薬品マスター": len(self.iyakuhin),
            "傷病名マスター": len(self.byomei),
            "修飾語マスター": len(self.shushokugo),
            "医薬品適応": len(self.drug_indications),
            "診療行為適応": len(self.act_indications),
            "併用禁忌": len(self.contraindications),
            "併算定不可(背反)": len(self.exclusive_pairs),
            "回数制限": len(self.frequency_limits),
            "算定もれパターン": len(self.missing_patterns),
            "摘要記載要件": len(self.comment_requirements),
            "年齢性別制限": len(self.age_sex_restrictions),
        }


# ---------------------------------------------------------------------------
# CSV読込
# ---------------------------------------------------------------------------

def _read_csv(path: Path) -> list:
    """ヘッダー付きCSVを dict のリストで返す(UTF-8/BOM対応)"""
    if not path.exists():
        logger.warning("マスターファイルがありません: %s", path)
        return []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return [
            {k.strip(): (v or "").strip() for k, v in row.items() if k}
            for row in csv.DictReader(fh)
        ]


def _opt_int(v: str) -> Optional[int]:
    v = (v or "").strip()
    if not v:
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def _opt_float(v: str) -> Optional[float]:
    v = (v or "").strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _split(v: str) -> list:
    return [x.strip() for x in (v or "").split(";") if x.strip()]


def load_masters(
    data_dir: str | Path | None = None,
    official_db: str | Path | None = None,
) -> MasterSet:
    """マスターディレクトリからMasterSetを構築する

    official_db を指定するか、既定の場所(master_data/masters.db)に
    公的マスターDBがあれば併せてロードし、点検はそちらを優先する。
    """
    d = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
    ms = MasterSet(data_dir=str(d))

    if official_db:
        ms.official = OfficialMasters(official_db)
        ms.versions = MasterVersions([ms.official])
    else:
        ms.versions = MasterVersions.discover()
        if ms.versions:
            ms.official = ms.versions.latest
    if ms.official:
        logger.info(
            "公的マスターDBを使用: %s(年度版: %d)",
            ms.official.db_path,
            len(ms.versions.versions) if ms.versions else 1,
        )

    for row in _read_csv(d / "shinryo_koi.csv"):
        ms.shinryo_koi[row["code"]] = ShinryoKoi(
            code=row["code"],
            name=row.get("name", ""),
            points=_opt_float(row.get("points", "")),
            point_type=row.get("point_type", ""),
            min_age=_opt_int(row.get("min_age", "")),
            max_age=_opt_int(row.get("max_age", "")),
            sex=row.get("sex", ""),
            category=row.get("category", ""),
        )

    for row in _read_csv(d / "iyakuhin.csv"):
        ms.iyakuhin[row["code"]] = Iyakuhin(
            code=row["code"],
            name=row.get("name", ""),
            unit=row.get("unit", ""),
            price=_opt_float(row.get("price", "")),
            dose_form=row.get("dose_form", ""),
            max_daily_dose=_opt_float(row.get("max_daily_dose", "")),
            days_limit=_opt_int(row.get("days_limit", "")),
            narcotic_class=row.get("narcotic_class", ""),
            generic_name=row.get("generic_name", ""),
        )

    for row in _read_csv(d / "byomei.csv"):
        ms.byomei[row["code"]] = Byomei(
            code=row["code"],
            name=row.get("name", ""),
            icd10=row.get("icd10", ""),
        )

    for row in _read_csv(d / "shushokugo.csv"):
        ms.shushokugo[row["code"]] = row.get("name", "")

    for row in _read_csv(d / "drug_indications.csv"):
        ms.drug_indications[row["drug_code"]] = DrugIndication(
            drug_code=row["drug_code"],
            drug_name=row.get("drug_name", ""),
            disease_codes=set(_split(row.get("disease_codes", ""))),
            disease_keywords=_split(row.get("disease_keywords", "")),
        )

    for row in _read_csv(d / "act_indications.csv"):
        ms.act_indications[row["act_code"]] = ActIndication(
            act_code=row["act_code"],
            act_name=row.get("act_name", ""),
            disease_codes=set(_split(row.get("disease_codes", ""))),
            disease_keywords=_split(row.get("disease_keywords", "")),
        )

    for row in _read_csv(d / "contraindications.csv"):
        ms.contraindications.append(
            Contraindication(
                generic_a=row["generic_a"],
                name_a=row.get("name_a", ""),
                generic_b=row["generic_b"],
                name_b=row.get("name_b", ""),
                reason=row.get("reason", ""),
            )
        )

    for row in _read_csv(d / "exclusive_pairs.csv"):
        ms.exclusive_pairs.append(
            ExclusivePair(
                code_a=row["code_a"],
                name_a=row.get("name_a", ""),
                code_b=row["code_b"],
                name_b=row.get("name_b", ""),
                span=row.get("span", "same_month") or "same_month",
                reason=row.get("reason", ""),
                source=row.get("source", ""),
            )
        )

    for row in _read_csv(d / "frequency_limits.csv"):
        period = row.get("period", "month") or "month"
        if period not in ("day", "week", "month", "once") and not (
            period.endswith("months") and period[:-6].isdigit()
        ):
            logger.warning(
                "frequency_limits.csv: 未対応のperiod「%s」(コード%s)はスキップされます"
                "(対応: day/week/month/once/Nmonths)",
                period, row.get("code"),
            )
            continue
        ms.frequency_limits[row["code"]] = FrequencyLimit(
            code=row["code"],
            name=row.get("name", ""),
            period=period,
            max_count=_opt_int(row.get("max_count", "")) or 1,
            reason=row.get("reason", ""),
        )

    for row in _read_csv(d / "missing_patterns.csv"):
        ms.missing_patterns.append(
            MissingPattern(
                pattern_id=row.get("pattern_id", ""),
                trigger_type=row.get("trigger_type", "act"),
                trigger_codes=set(_split(row.get("trigger_codes", ""))),
                trigger_keywords=_split(row.get("trigger_keywords", "")),
                expected_codes=set(_split(row.get("expected_codes", ""))),
                expected_name=row.get("expected_name", ""),
                message=row.get("message", ""),
                severity=row.get("severity", "info") or "info",
            )
        )

    for row in _read_csv(d / "comment_requirements.csv"):
        ms.comment_requirements[row["act_code"]] = CommentRequirement(
            act_code=row["act_code"],
            act_name=row.get("act_name", ""),
            requirement=row.get("requirement", "comment") or "comment",
            message=row.get("message", ""),
        )

    for row in _read_csv(d / "age_sex_restrictions.csv"):
        ms.age_sex_restrictions[row["code"]] = AgeSexRestriction(
            code=row["code"],
            name=row.get("name", ""),
            sex=row.get("sex", ""),
            min_age=_opt_int(row.get("min_age", "")),
            max_age=_opt_int(row.get("max_age", "")),
            message=row.get("message", ""),
        )

    logger.info("マスターをロードしました: %s", ms.stats())
    return ms
