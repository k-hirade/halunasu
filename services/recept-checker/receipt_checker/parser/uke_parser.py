"""医科レセプト電算処理システム UKEファイルパーサー

「レセプト電算処理システム 記録条件仕様(医科用)」に基づき、
CSV形式・Shift_JISのUKEファイルを ClaimFile / Receipt モデルに変換する。

対応レコード:
    IR 医療機関情報 / RE レセプト共通 / HO 保険者 / KO 公費 / SN 資格確認
    SY 傷病名 / SI 診療行為 / IY 医薬品 / TO 特定器材 / CO コメント
    SJ 症状詳記 / GO 診療報酬請求書

仕様上の要点:
- UKEのフィールドにカンマ・改行・引用符の規約はないため、行を単純に
  カンマ分割する(csvモジュールのクォート解釈は誤動作の原因になるため不使用)
- 剤(点数・回数算定単位)は代表レコードにのみ点数・回数・算定日情報を記録し、
  他のレコードでは省略される → 代表レコードの回数・算定日を剤内の全行に引き継ぐ
- 未知のレコード種別は警告として記録し、処理は継続する(前方互換)
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from ..models import (
    ClaimFile,
    CommentItem,
    Disease,
    Facility,
    Finding,
    Insurance,
    Kohi,
    Receipt,
    ServiceItem,
    Severity,
    SymptomDetail,
)

# SI/IY: 8〜13項目目がコメント3組、14項目目から算定日情報31日分
_SI_COMMENT_START = 7   # 0始まりインデックス
_SI_DAY_START = 13
# TO: 単位コード・単価・名称・商品名が入るぶん後ろにずれる
_TO_COMMENT_START = 11
_TO_DAY_START = 17

# セル内の制御文字(タブ等を含む不可視文字)は除去する
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def parse_uke_file(path: str | Path) -> ClaimFile:
    p = Path(path)
    return parse_uke_bytes(p.read_bytes(), source_name=p.name)


def parse_uke_bytes(data: bytes, source_name: str = "") -> ClaimFile:
    """UKEファイルのバイト列をパースする。

    文字コードはBOM付きUTF-8 → UTF-8 → cp932(Shift_JIS)の順に判定する
    (UTF-8は自己検証性が高く、cp932の日本語が偶然有効なUTF-8になることは
    実質ないため、この順序で誤判定を避けられる)。
    """
    text, encoding = _decode(data)
    cf = ClaimFile(source_name=source_name, encoding=encoding)
    parser = _UkeParser(cf)
    # レコード区切りはCR+LF(CR単独・LF単独にも耐性を持たせる)。
    # str.splitlines()は垂直タブ等でも分割してしまうため使わない。
    for line_no, line in enumerate(re.split(r"\r\n|\r|\n", text), start=1):
        if not line.strip():
            continue
        fields = line.split(",")
        parser.feed(line_no, fields)
    parser.finish()
    return cf


def _decode(data: bytes) -> tuple:
    # ファイル終端のEOFコード(1A)は記録条件仕様上の終端マーク
    data = data.rstrip(b"\x1a")
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace"), "utf-8-sig"
    try:
        return data.decode("utf-8"), "utf-8" if not data.isascii() else "ascii/cp932互換"
    except UnicodeDecodeError:
        pass
    try:
        return data.decode("cp932"), "cp932"
    except UnicodeDecodeError:
        return data.decode("cp932", errors="replace"), "cp932(置換あり)"


class _UkeParser:
    def __init__(self, cf: ClaimFile):
        self.cf = cf
        self.current: Optional[Receipt] = None
        self.last_item: Optional[ServiceItem] = None
        self.pending_zai: list = []  # 点数・回数・算定日が未記録の剤内継続行
        self.seen_ir = False
        self.unknown_types: dict = {}

    # -- helpers -------------------------------------------------------------

    def _err(self, line_no: int, message: str, severity=Severity.ERROR, detail: str = ""):
        self.cf.parse_errors.append(
            Finding(
                rule_id="FMT-000",
                rule_name="ファイル形式",
                category="形式",
                severity=severity,
                message=f"{line_no}行目: {message}",
                receipt_no=self.current.receipt_no if self.current else None,
                patient_name=self.current.patient_name if self.current else "",
                detail=detail,
            )
        )

    def feed(self, line_no: int, fields: list):
        rec = (fields[0] or "").strip().upper()
        handler = getattr(self, f"_on_{rec.lower()}", None)
        if handler is None:
            # 未知レコードは種別ごとに1回だけ通知
            if rec not in self.unknown_types:
                self.unknown_types[rec] = line_no
                self._err(
                    line_no,
                    f"未対応のレコード種別「{rec}」をスキップしました",
                    severity=Severity.INFO,
                    detail="DPC用レコード等は現バージョンでは点検対象外です。",
                )
            return
        try:
            handler(line_no, fields)
        except Exception as e:  # 個別レコードの破損はファイル全体を止めない
            self._err(line_no, f"レコード({rec})の解析に失敗しました: {e}")

    def finish(self):
        self._flush_zai()
        if not self.seen_ir:
            self._err(0, "IRレコード(医療機関情報)がありません")
        if not self.cf.receipts:
            self._err(0, "REレコード(レセプト)が1件もありません")

    # -- 剤(点数・回数算定単位)の解決 ----------------------------------------

    def _flush_zai(self):
        """代表レコードが現れないまま剤が終わった場合、回数を1として確定する"""
        for it in self.pending_zai:
            if it.count == 0:
                it.count = 1
        self.pending_zai = []

    def _add_item(self, item: ServiceItem, has_own_values: bool):
        """SI/IY/TO行を追加し、剤の代表レコードの回数・算定日を継続行へ引き継ぐ"""
        self.current.items.append(item)
        self.last_item = item
        if has_own_values:
            # 代表レコード: 保留中の継続行に回数・算定日情報を引き継ぐ
            zai_rows = len(self.pending_zai) + 1
            item.zai_row_count = zai_rows
            for member in self.pending_zai:
                member.count = item.count
                member.day_counts = list(item.day_counts)
                member.zai_row_count = zai_rows
            self.pending_zai = []
        else:
            # 点数・回数・算定日がすべて未記録 → 剤内の継続行として保留
            item.count = 0  # 代表レコード確定まで未確定
            self.pending_zai.append(item)

    # -- record handlers -----------------------------------------------------

    def _on_ir(self, line_no: int, f: list):
        self.seen_ir = True
        self.cf.facility = Facility(
            payer_kind=_s(f, 1),
            prefecture=_s(f, 2),
            tensuhyo=_s(f, 3),
            facility_code=_s(f, 4),
            name=_s(f, 6),
            seikyu_ym=_s(f, 7),
            multi_volume=_s(f, 8),
            phone=_s(f, 9),
        )

    def _on_re(self, line_no: int, f: list):
        self._flush_zai()
        r = Receipt(
            receipt_no=_i(f, 1) or (len(self.cf.receipts) + 1),
            type_code=_s(f, 2),
            shinryo_ym=_s(f, 3),
            patient_name=_s(f, 4),
            sex=_s(f, 5),
            birthdate=_s(f, 6),
            kyufu_wariai=_s(f, 7),
            nyuin_ymd=_s(f, 8),
            tokki_jiko=_s(f, 11),
            karte_no=_s(f, 13),
            kana_name=_s(f, 36),
            line_no=line_no,
        )
        self.cf.receipts.append(r)
        self.current = r
        self.last_item = None

    def _require_receipt(self, line_no: int, rec: str) -> bool:
        if self.current is None:
            self._err(line_no, f"{rec}レコードがREレコードより前に出現しました")
            return False
        return True

    def _on_ho(self, line_no: int, f: list):
        if not self._require_receipt(line_no, "HO"):
            return
        self.current.insurance = Insurance(
            insurer_number=_s(f, 1),
            symbol=_s(f, 2),
            number=_s(f, 3),
            days=_i(f, 4),
            total_points=_i(f, 5),
            raw=f,
        )

    def _on_ko(self, line_no: int, f: list):
        if not self._require_receipt(line_no, "KO"):
            return
        self.current.kohis.append(
            Kohi(
                futansha_number=_s(f, 1),
                jukyusha_number=_s(f, 2),
                days=_i(f, 4),
                total_points=_i(f, 5),
                raw=f,
            )
        )

    def _on_sn(self, line_no: int, f: list):
        # 資格確認レコード: 点検対象外だが受理する
        if not self._require_receipt(line_no, "SN"):
            return

    def _on_jd(self, line_no: int, f: list):
        # 受診日等レコード: 受理のみ(点検には算定日情報を使用)
        if not self._require_receipt(line_no, "JD"):
            return

    def _on_mf(self, line_no: int, f: list):
        # 窓口負担額レコード: 受理のみ
        if not self._require_receipt(line_no, "MF"):
            return

    def _on_gr(self, line_no: int, f: list):
        # 包括評価対象外理由レコード: 受理のみ
        if not self._require_receipt(line_no, "GR"):
            return

    def _on_sy(self, line_no: int, f: list):
        if not self._require_receipt(line_no, "SY"):
            return
        self.current.diseases.append(
            Disease(
                code=_s(f, 1),
                start_date=_s(f, 2),
                tenki=_s(f, 3),
                modifiers=_s(f, 4),
                name=_s(f, 5),
                is_main=_s(f, 6) in ("01", "1"),
                comment=_s(f, 7),
                line_no=line_no,
            )
        )

    def _on_si(self, line_no: int, f: list):
        self._item(line_no, f, "SI")

    def _on_iy(self, line_no: int, f: list):
        self._item(line_no, f, "IY")

    def _item(self, line_no: int, f: list, rec_type: str):
        if not self._require_receipt(line_no, rec_type):
            return
        points = _i(f, 5)
        count = _i(f, 6)
        day_counts = _days(f, _SI_DAY_START)
        item = ServiceItem(
            rec_type=rec_type,
            shinryo_shikibetsu=_s(f, 1),
            futan_kubun=_s(f, 2),
            code=_s(f, 3),
            quantity=_f(f, 4),
            points=points,
            count=count or 1,
            comments=_comments(f, _SI_COMMENT_START),
            day_counts=day_counts,
            line_no=line_no,
        )
        # 剤の2行目以降は診療識別が空 → 直前の項目から引き継ぐ
        if not item.shinryo_shikibetsu and self.last_item is not None:
            item.shinryo_shikibetsu = self.last_item.shinryo_shikibetsu
        has_own = points is not None or count is not None or bool(day_counts)
        self._add_item(item, has_own)

    def _on_to(self, line_no: int, f: list):
        if not self._require_receipt(line_no, "TO"):
            return
        points = _i(f, 5)
        count = _i(f, 6)
        day_counts = _days(f, _TO_DAY_START)
        item = ServiceItem(
            rec_type="TO",
            shinryo_shikibetsu=_s(f, 1),
            futan_kubun=_s(f, 2),
            code=_s(f, 3),
            quantity=_f(f, 4),
            points=points,
            count=count or 1,
            unit_code=_s(f, 7),
            unit_price=_f(f, 8),
            name=_s(f, 9) or _s(f, 10),
            comments=_comments(f, _TO_COMMENT_START),
            day_counts=day_counts,
            line_no=line_no,
        )
        if not item.shinryo_shikibetsu and self.last_item is not None:
            item.shinryo_shikibetsu = self.last_item.shinryo_shikibetsu
        has_own = points is not None or count is not None or bool(day_counts)
        self._add_item(item, has_own)

    def _on_co(self, line_no: int, f: list):
        if not self._require_receipt(line_no, "CO"):
            return
        comment = CommentItem(
            shinryo_shikibetsu=_s(f, 1),
            futan_kubun=_s(f, 2),
            code=_s(f, 3),
            text=_s(f, 4),
            line_no=line_no,
        )
        # 直前の診療行為・医薬品への補足として扱う(なければレセプト全体の補足)
        if self.last_item is not None:
            self.last_item.comments.append((comment.code, comment.text))
        else:
            self.current.standalone_comments.append(comment)

    def _on_sj(self, line_no: int, f: list):
        if not self._require_receipt(line_no, "SJ"):
            return
        self.current.symptom_details.append(
            SymptomDetail(kubun=_s(f, 1), text=_s(f, 2), line_no=line_no)
        )

    def _on_go(self, line_no: int, f: list):
        self._flush_zai()
        self.cf.go_totals = {
            "total_count": _i(f, 1),
            "total_points": _i(f, 2),
        }


# -- field accessors ---------------------------------------------------------

def _s(fields: list, idx: int) -> str:
    if idx < len(fields) and fields[idx] is not None:
        return _CONTROL_CHARS.sub("", fields[idx]).strip()
    return ""


def _i(fields: list, idx: int) -> Optional[int]:
    v = _s(fields, idx)
    if not v:
        return None
    try:
        return int(v)
    except ValueError:
        try:
            return int(float(v))
        except ValueError:
            return None


def _f(fields: list, idx: int) -> Optional[float]:
    v = _s(fields, idx)
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _comments(fields: list, start: int) -> list:
    """コメントコード・文字データ 3組を取り出す"""
    out = []
    for k in range(3):
        code = _s(fields, start + k * 2)
        text = _s(fields, start + k * 2 + 1)
        if code or text:
            out.append((code, text))
    return out


def _days(fields: list, start: int) -> list:
    """算定日情報(1日〜31日)を回数のリストに。記録がなければ空リスト。"""
    if len(fields) <= start:
        return []
    counts = []
    for d in range(31):
        counts.append(_i(fields, start + d) or 0)
    if not any(counts):
        return []
    return counts
