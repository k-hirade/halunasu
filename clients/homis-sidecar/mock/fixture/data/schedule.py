"""診療計画パターン → 予約日生成ヘルパ。

本物HOMISを走査するスクレイパの予約日算出と同一のアルゴリズムで予約日を算出する。
これにより「疑似カルテに載せる訪問日」と「スクレイパが診療計画から再計算する予約日」が
必ず一致し、在医総管の算定日判定などが実データ同様に動作する。

パターン文字列の例:
  "2、4週　土"   → 第2・第4 土曜日（月2回）
  "毎週　木"     → 毎週 木曜日（第1〜第5週すべて。frequency は 4 を返す＝スクレイパ仕様に合わせる）
  "第3週　水"    → 第3 水曜日（月1回）

注: スクレイパと同一挙動を保つため、「毎週」は月内の全該当曜日を
    予約日として返す（第5週があれば5日）が、frequency（月回数）は 4 固定で返す。
"""
import calendar
import re

WEEKDAY_MAP = {"月": 0, "火": 1, "水": 2, "木": 3, "金": 4, "土": 5, "日": 6}
WEEKDAY_JP = ["月", "火", "水", "木", "金", "土", "日"]


def parse_plan(pattern_text: str):
    """パターン文字列 → (weeks, weekday_idx, frequency)。
    スクレイパの診療計画解析ロジックを踏襲。"""
    pattern_text = (pattern_text or "").strip()
    wd_match = re.search(r"週\s*([月火水木金土日])", pattern_text)
    if not wd_match:
        return ([], None, 0)
    weekday_idx = WEEKDAY_MAP.get(wd_match.group(1))
    if "毎週" in pattern_text:
        return ([1, 2, 3, 4, 5], weekday_idx, 4)
    week_part = pattern_text.split("週")[0] if "週" in pattern_text else ""
    weeks = [int(ch) for ch in week_part if ch.isdigit()]
    return (weeks, weekday_idx, len(weeks))


def scheduled_days(year: int, month: int, pattern_text: str):
    """指定年月・パターンの予約日（day の int リスト）を算出。"""
    weeks, weekday_idx, _ = parse_plan(pattern_text)
    if weekday_idx is None or not weeks:
        return []
    days = []
    cal = calendar.Calendar()
    for d in cal.itermonthdates(year, month):
        if d.month != month:
            continue
        if d.weekday() != weekday_idx:
            continue
        nth = (d.day - 1) // 7 + 1
        if nth in weeks:
            days.append(d.day)
    return sorted(days)


def weekday_label(year: int, month: int, day: int) -> str:
    """指定日の曜日（漢字1文字）。日付行やカレンダー表示に使う。"""
    import datetime
    return WEEKDAY_JP[datetime.date(year, month, day).weekday()]
