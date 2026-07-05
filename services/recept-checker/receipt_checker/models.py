"""レセプトデータモデル

UKEファイルの各レコードをパースした結果を保持するデータクラス群。
点検ルールはこれらのモデルに対して動作する(UKEの生データには依存しない)。
"""

from __future__ import annotations

import datetime
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ---------------------------------------------------------------------------
# 点検結果
# ---------------------------------------------------------------------------

class Severity(str, Enum):
    """指摘の重大度"""

    ERROR = "error"      # 返戻・査定リスクが高い/形式エラー(要修正)
    WARNING = "warning"  # 査定リスクあり/要確認
    INFO = "info"        # 算定もれ候補・参考情報


@dataclass
class Finding:
    """1件の指摘事項"""

    rule_id: str           # 例: "SY-001"
    rule_name: str         # 例: "疑い病名の長期放置"
    category: str          # 例: "傷病名"
    severity: Severity
    message: str           # 指摘内容(具体的に)
    receipt_no: Optional[int] = None   # 対象レセプト番号
    patient_name: str = ""
    target: str = ""       # 対象の診療行為・医薬品・傷病名など
    detail: str = ""       # 根拠・補足
    suggestion: str = ""   # 対処方法の提案

    def sort_key(self):
        order = {Severity.ERROR: 0, Severity.WARNING: 1, Severity.INFO: 2}
        return (self.receipt_no or 0, order[self.severity], self.rule_id)


# ---------------------------------------------------------------------------
# レセプト構成要素
# ---------------------------------------------------------------------------

@dataclass
class Facility:
    """IRレコード: 医療機関情報"""

    payer_kind: str = ""        # 審査支払機関 1:社保 2:国保
    prefecture: str = ""        # 都道府県コード
    tensuhyo: str = ""          # 点数表 1:医科
    facility_code: str = ""     # 医療機関コード(7桁)
    name: str = ""              # 医療機関名称
    seikyu_ym: str = ""         # 請求年月(GYYMM 和暦)
    multi_volume: str = ""      # マルチボリューム識別
    phone: str = ""


@dataclass
class Insurance:
    """HOレコード: 保険者情報"""

    insurer_number: str = ""    # 保険者番号
    symbol: str = ""            # 被保険者証記号
    number: str = ""            # 被保険者証番号
    days: Optional[int] = None  # 診療実日数
    total_points: Optional[int] = None  # 合計点数
    futan_kingaku: Optional[int] = None  # 負担金額(職務上等)
    raw: list = field(default_factory=list)


@dataclass
class Kohi:
    """KOレコード: 公費情報"""

    futansha_number: str = ""   # 公費負担者番号
    jukyusha_number: str = ""   # 公費受給者番号
    days: Optional[int] = None
    total_points: Optional[int] = None
    raw: list = field(default_factory=list)


@dataclass
class Disease:
    """SYレコード: 傷病名"""

    code: str = ""              # 傷病名コード(7桁) 0000999=未コード化(ワープロ病名)
    start_date: str = ""        # 診療開始日 GYYMMDD(和暦)または YYYYMMDD
    tenki: str = ""             # 転帰区分 1:継続(治ゆ・死亡・中止以外) 2:治ゆ 3:死亡 4:中止(転医)
    modifiers: str = ""         # 修飾語コード(4桁×最大20個連結)
    name: str = ""              # 傷病名称(未コード化時などに記録)
    is_main: bool = False       # 主傷病
    comment: str = ""           # 補足コメント
    line_no: int = 0            # UKEファイル内の行番号(1始まり)

    # マスター解決後に設定される表示名
    resolved_name: str = ""

    @property
    def display_name(self) -> str:
        return self.resolved_name or self.name or f"(傷病名コード:{self.code})"

    @property
    def is_suspected(self) -> bool:
        """疑い病名か(修飾語8002=「の疑い」)"""
        return "8002" in _split_modifiers(self.modifiers) or "疑い" in (self.name or "")

    @property
    def is_uncoded(self) -> bool:
        """未コード化傷病名(ワープロ病名)か"""
        return self.code == "0000999"

    def start_date_as_date(self) -> Optional[datetime.date]:
        return parse_receipt_date(self.start_date)


@dataclass
class CommentItem:
    """COレコード(または SI/IY/TO 内のコメント)"""

    shinryo_shikibetsu: str = ""
    futan_kubun: str = ""
    code: str = ""              # コメントコード(9桁、81/82/83/84/85...パターン)
    text: str = ""              # 文字データ
    line_no: int = 0


@dataclass
class ServiceItem:
    """SI(診療行為)/IY(医薬品)/TO(特定器材)レコード"""

    rec_type: str = ""              # "SI" | "IY" | "TO"
    shinryo_shikibetsu: str = ""    # 診療識別(11初診,12再診,...,90入院基本料 等)
    futan_kubun: str = ""           # 負担区分
    code: str = ""                  # 診療行為/医薬品/特定器材コード(9桁)
    quantity: Optional[float] = None  # 数量データ・使用量
    points: Optional[int] = None    # 点数(金額)。剤の先頭行以外は空
    count: int = 1                  # 回数
    unit_code: str = ""             # 単位コード(TO)
    unit_price: Optional[float] = None  # 単価(TO)
    name: str = ""                  # 名称(未コード化時などに記録)
    day_counts: list = field(default_factory=list)  # 算定日情報: 31要素、各日の回数
    comments: list = field(default_factory=list)    # 行内コメント [(code, text), ...]
    line_no: int = 0
    zai_row_count: int = 1  # この行が属する剤(点数・回数算定単位)の行数

    # マスター解決後に設定される情報
    resolved_name: str = ""

    @property
    def display_name(self) -> str:
        return self.resolved_name or self.name or f"(コード:{self.code})"

    @property
    def total_count(self) -> int:
        """算定日情報があれば合計回数、なければ回数フィールド"""
        if self.day_counts and any(c for c in self.day_counts):
            return sum(c for c in self.day_counts if c)
        return self.count

    @property
    def days_used(self) -> list:
        """算定された日(1〜31)のリスト"""
        return [i + 1 for i, c in enumerate(self.day_counts) if c]


@dataclass
class SymptomDetail:
    """SJレコード: 症状詳記"""

    kubun: str = ""     # 症状詳記区分 01〜99
    text: str = ""
    line_no: int = 0


@dataclass
class Receipt:
    """REレコード + 配下のレコード群 = 1件のレセプト"""

    receipt_no: int = 0             # レセプト番号
    type_code: str = ""             # レセプト種別(4桁) 例: 1112=医科・国保単独・本人入院 等
    shinryo_ym: str = ""            # 診療年月 GYYMM(和暦)
    patient_name: str = ""          # 氏名(カナまたは漢字)
    sex: str = ""                   # 男女区分 1:男 2:女
    birthdate: str = ""             # 生年月日 GYYMMDD(和暦)または YYYYMMDD
    kyufu_wariai: str = ""          # 給付割合
    nyuin_ymd: str = ""             # 入院年月日
    tokki_jiko: str = ""            # レセプト特記事項
    karte_no: str = ""              # カルテ番号
    kana_name: str = ""             # カタカナ氏名(令和6年〜)
    line_no: int = 0

    insurance: Optional[Insurance] = None
    kohis: list = field(default_factory=list)
    diseases: list = field(default_factory=list)      # [Disease]
    items: list = field(default_factory=list)         # [ServiceItem] 記録順
    standalone_comments: list = field(default_factory=list)  # [CommentItem]
    symptom_details: list = field(default_factory=list)      # [SymptomDetail]

    # --- 導出プロパティ -----------------------------------------------------

    @property
    def is_inpatient(self) -> bool:
        """入院レセプトか(レセプト種別4桁目 1:入院 2:入院外)"""
        return len(self.type_code) == 4 and self.type_code[3] == "1"

    @property
    def sex_label(self) -> str:
        return {"1": "男", "2": "女"}.get(self.sex, "不明")

    def shinryo_ym_as_date(self) -> Optional[datetime.date]:
        """診療年月の1日を西暦dateで返す"""
        return parse_receipt_ym(self.shinryo_ym)

    def birthdate_as_date(self) -> Optional[datetime.date]:
        return parse_receipt_date(self.birthdate)

    @property
    def age(self) -> Optional[int]:
        """診療年月初日時点の満年齢"""
        b = self.birthdate_as_date()
        s = self.shinryo_ym_as_date()
        if not b or not s:
            return None
        age = s.year - b.year - ((s.month, s.day) < (b.month, b.day))
        return max(age, 0)

    @property
    def main_diseases(self) -> list:
        return [d for d in self.diseases if d.is_main]

    @property
    def active_diseases(self) -> list:
        """転帰が「継続」の傷病名"""
        return [d for d in self.diseases if d.tenki in ("", "1")]

    def items_of(self, rec_type: str) -> list:
        return [i for i in self.items if i.rec_type == rec_type]

    @property
    def drugs(self) -> list:
        return self.items_of("IY")

    @property
    def acts(self) -> list:
        return self.items_of("SI")

    def acts_by_code(self, code: str) -> list:
        return [i for i in self.items if i.rec_type == "SI" and i.code == code]

    def has_act(self, code: str) -> bool:
        return any(i.code == code for i in self.items if i.rec_type == "SI")

    def has_disease_code(self, code: str) -> bool:
        return any(d.code == code for d in self.diseases)

    @property
    def total_points(self) -> Optional[int]:
        if self.insurance:
            return self.insurance.total_points
        return None

    @property
    def jitsu_nissu(self) -> Optional[int]:
        """診療実日数"""
        if self.insurance and self.insurance.days is not None:
            return self.insurance.days
        for k in self.kohis:
            if k.days is not None:
                return k.days
        return None

    @property
    def visit_days(self) -> list:
        """診療行為の算定日情報から受診日(1〜31)を推定"""
        days = set()
        for it in self.items:
            days.update(it.days_used)
        return sorted(days)


@dataclass
class ClaimFile:
    """UKEファイル全体"""

    facility: Facility = field(default_factory=Facility)
    receipts: list = field(default_factory=list)   # [Receipt]
    go_totals: dict = field(default_factory=dict)  # GOレコード {総件数, 総合計点数}
    parse_errors: list = field(default_factory=list)  # [Finding] パース時の形式エラー
    source_name: str = ""
    encoding: str = ""


# ---------------------------------------------------------------------------
# 日付ユーティリティ(和暦GYYMMDD/西暦YYYYMMDD 両対応)
# ---------------------------------------------------------------------------

_GENGO_BASE = {
    "1": 1867,  # 明治
    "2": 1911,  # 大正
    "3": 1925,  # 昭和
    "4": 1988,  # 平成
    "5": 2018,  # 令和
}


def wareki_to_seireki(gengo: str, yy: int) -> Optional[int]:
    """和暦(元号コード+年)を西暦年に変換"""
    base = _GENGO_BASE.get(gengo)
    if base is None or yy == 0:
        return None
    return base + yy


def parse_receipt_date(s: str) -> Optional[datetime.date]:
    """レセプトの日付文字列を date に変換。

    対応形式:
      - GYYMMDD (7桁・和暦。G=元号コード)
      - YYYYMMDD (8桁・西暦)
    """
    if not s:
        return None
    s = s.strip()
    try:
        if re.fullmatch(r"\d{7}", s):
            year = wareki_to_seireki(s[0], int(s[1:3]))
            if year is None:
                return None
            return datetime.date(year, int(s[3:5]), int(s[5:7]))
        if re.fullmatch(r"\d{8}", s):
            return datetime.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None
    return None


def parse_receipt_ym(s: str) -> Optional[datetime.date]:
    """診療年月(GYYMM 和暦 または YYYYMM 西暦)を月初日の date に変換"""
    if not s:
        return None
    s = s.strip()
    try:
        if re.fullmatch(r"\d{5}", s):
            year = wareki_to_seireki(s[0], int(s[1:3]))
            if year is None:
                return None
            return datetime.date(year, int(s[3:5]), 1)
        if re.fullmatch(r"\d{6}", s):
            return datetime.date(int(s[:4]), int(s[4:6]), 1)
    except ValueError:
        return None
    return None


def format_ym(s: str) -> str:
    """診療年月を「2024年6月」形式の表示用文字列に"""
    d = parse_receipt_ym(s)
    if not d:
        return s
    return f"{d.year}年{d.month}月"


def months_between(d1: datetime.date, d2: datetime.date) -> int:
    """d1からd2までの月数差"""
    return (d2.year - d1.year) * 12 + (d2.month - d1.month)


def _split_modifiers(modifiers: str) -> list:
    """修飾語コード(4桁連結)を分割"""
    m = (modifiers or "").strip()
    return [m[i:i + 4] for i in range(0, len(m) - len(m) % 4, 4)]
