"""R01: 形式チェック

レセプトの記録内容そのものの整合性を点検する。
(ファイル構造の破損は parser が FMT-000 として報告する)
"""

from __future__ import annotations

import re

from ..models import Receipt, Severity, parse_receipt_date, parse_receipt_ym
from .base import CheckContext, FileRule, Rule


class RequiredFieldsRule(Rule):
    rule_id = "FMT-001"
    name = "必須項目の欠落"
    category = "形式"
    description = "氏名・性別・生年月日・診療年月・レセプト種別など必須項目の記録漏れを検出"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        checks = [
            (receipt.patient_name, "氏名"),
            (receipt.sex, "男女区分"),
            (receipt.birthdate, "生年月日"),
            (receipt.shinryo_ym, "診療年月"),
            (receipt.type_code, "レセプト種別"),
        ]
        for value, label in checks:
            if not value:
                out.append(self.make_finding(receipt, f"{label}が記録されていません"))
        if receipt.sex and receipt.sex not in ("1", "2"):
            out.append(
                self.make_finding(
                    receipt,
                    f"男女区分が不正です(値: {receipt.sex})",
                    detail="1:男 2:女 のいずれかを記録してください。",
                )
            )
        if receipt.type_code and not re.fullmatch(r"\d{4}", receipt.type_code):
            out.append(
                self.make_finding(receipt, f"レセプト種別が4桁の数字ではありません(値: {receipt.type_code})")
            )
        return out


class DateConsistencyRule(Rule):
    rule_id = "FMT-002"
    name = "日付の整合性"
    category = "形式"
    description = "生年月日・診療年月・診療開始日・入院日の前後関係を点検"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        birth = receipt.birthdate_as_date()
        shinryo = receipt.shinryo_ym_as_date()

        if receipt.birthdate and birth is None:
            out.append(self.make_finding(receipt, f"生年月日が解釈できません(値: {receipt.birthdate})"))
        if receipt.shinryo_ym and shinryo is None:
            out.append(self.make_finding(receipt, f"診療年月が解釈できません(値: {receipt.shinryo_ym})"))

        if birth and shinryo and birth > shinryo:
            out.append(
                self.make_finding(
                    receipt,
                    "生年月日が診療年月より後になっています",
                    detail=f"生年月日: {birth}, 診療年月: {shinryo.strftime('%Y-%m')}",
                )
            )

        for d in receipt.diseases:
            sd = d.start_date_as_date()
            if d.start_date and sd is None:
                out.append(
                    self.make_finding(
                        receipt,
                        f"傷病名「{d.display_name}」の診療開始日が解釈できません(値: {d.start_date})",
                        target=d.display_name,
                    )
                )
                continue
            if sd and shinryo:
                # 診療開始日が診療年月の月末より後 = 未来の病名
                if (sd.year, sd.month) > (shinryo.year, shinryo.month):
                    out.append(
                        self.make_finding(
                            receipt,
                            f"傷病名「{d.display_name}」の診療開始日({sd})が診療年月({shinryo.strftime('%Y-%m')})より後です",
                            target=d.display_name,
                        )
                    )
            if sd and birth and sd < birth:
                out.append(
                    self.make_finding(
                        receipt,
                        f"傷病名「{d.display_name}」の診療開始日({sd})が生年月日より前です",
                        target=d.display_name,
                    )
                )

        nyuin = parse_receipt_date(receipt.nyuin_ymd)
        if receipt.nyuin_ymd and nyuin is None:
            out.append(self.make_finding(receipt, f"入院年月日が解釈できません(値: {receipt.nyuin_ymd})"))
        if nyuin and shinryo and (nyuin.year, nyuin.month) > (shinryo.year, shinryo.month):
            out.append(
                self.make_finding(receipt, f"入院年月日({nyuin})が診療年月({shinryo.strftime('%Y-%m')})より後です")
            )
        if receipt.is_inpatient and not receipt.nyuin_ymd:
            out.append(self.make_finding(receipt, "入院レセプトですが入院年月日が記録されていません"))
        return out


class UnknownCodeRule(Rule):
    rule_id = "FMT-003"
    name = "マスター未登録コード"
    category = "形式"
    description = "診療行為・医薬品・傷病名コードがマスターに存在するか点検"
    default_severity = Severity.WARNING

    def _find_in_other_versions(self, ms, kind: str, code: str):
        """他の年度版マスターにコードが存在するか(改定で廃止/未適用の新設コードの特定)

        戻り値: (マスター行, 版の表示名, その版が適用版より新しいか) または None
        """
        if not ms.versions or ms.official is None:
            return None
        current_eff = ms.official.effective_from
        for v in ms.versions.versions:
            if v is ms.official:
                continue
            m = getattr(v, kind)(code)
            if m:
                return m, v.version_label, v.effective_from > current_eff
        return None

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        ms = ctx.masters
        out = []
        d_ym = receipt.shinryo_ym_as_date()
        ym = f"{d_ym.year:04d}{d_ym.month:02d}" if d_ym else ""

        def expired(m) -> bool:
            end = (m.get("end_date") or "").strip()
            return bool(ym) and end.isdigit() and end != "99999999" and end[:6] < ym

        if ms.official:
            # 公的マスター(全件)での存在・廃止チェック
            for d in receipt.diseases:
                if d.is_uncoded or not d.code:
                    continue
                m = ms.official.disease(d.code)
                if m is None:
                    out.append(
                        self.make_finding(
                            receipt,
                            f"傷病名コード {d.code} が傷病名マスターにありません",
                            target=d.name or d.code,
                            suggestion="コードの誤り、または廃止済みコードの可能性があります。",
                        )
                    )
                elif expired(m):
                    out.append(
                        self.make_finding(
                            receipt,
                            f"傷病名「{m['name']}」({d.code})は廃止済みコードです(廃止日: {m['end_date']})",
                            target=m["name"],
                            suggestion="移行先の傷病名コードに置き換えてください(支払基金の移行対応テーブル参照)。",
                        )
                    )
            for it in receipt.items:
                if not it.code:
                    continue
                if it.rec_type == "SI":
                    m = ms.official.act(it.code)
                    kind, label = "act", "診療行為"
                elif it.rec_type == "IY":
                    m = ms.official.drug(it.code)
                    kind, label = "drug", "医薬品"
                elif it.rec_type == "TO":
                    m = ms.official.kizai(it.code)
                    kind, label = "kizai", "特定器材"
                else:
                    continue
                if m is None:
                    # 他年度版に存在すれば「改定で廃止」または「未適用の新設」と特定できる
                    other = self._find_in_other_versions(ms, kind, it.code)
                    if other:
                        om, olabel, is_newer = other
                        if is_newer:
                            msg = (
                                f"「{om['name']}」({it.code})は診療報酬改定で新設されたコードで、"
                                f"この診療年月にはまだ適用されません"
                                f"(適用マスター: {ms.official.version_label or '現行版'})"
                            )
                            sugg = "改定施行前の診療分には改定前のコード・点数を使用してください。"
                        else:
                            msg = (
                                f"「{om['name']}」({it.code})は診療報酬改定で廃止されたコードです"
                                f"(適用マスター: {ms.official.version_label or '現行版'}に存在しません)"
                            )
                            sugg = "改定後の後継項目(統合・再編先)のコードに置き換えてください。廃止コードでの請求は返戻対象です。"
                        out.append(
                            self.make_finding(
                                receipt,
                                msg,
                                target=om["name"],
                                detail=f"{olabel}には収載されていますが、この診療年月には使用できません。",
                                suggestion=sugg,
                            )
                        )
                    else:
                        out.append(
                            self.make_finding(
                                receipt,
                                f"{label}コード {it.code} が{label}マスターにありません",
                                target=it.display_name,
                                suggestion="コードの誤り、または廃止済みコードの可能性があります。",
                            )
                        )
                elif expired(m):
                    out.append(
                        self.make_finding(
                            receipt,
                            f"「{m['name']}」({it.code})は廃止済みコードです(廃止日: {m['end_date']})",
                            target=m["name"],
                            suggestion="廃止コードでの請求は返戻対象です。後継コードを確認してください。",
                        )
                    )
            return out

        # 公的マスターなし: 十分な規模のCSVマスターがある場合のみ動作
        if len(ms.byomei) >= 1000:
            for d in receipt.diseases:
                if d.is_uncoded or not d.code:
                    continue
                if d.code not in ms.byomei:
                    out.append(
                        self.make_finding(
                            receipt,
                            f"傷病名コード {d.code} が傷病名マスターにありません",
                            target=d.name or d.code,
                        )
                    )
        if len(ms.shinryo_koi) >= 1000:
            for it in receipt.acts:
                if it.code and it.code not in ms.shinryo_koi:
                    out.append(
                        self.make_finding(
                            receipt,
                            f"診療行為コード {it.code} が診療行為マスターにありません",
                            target=it.display_name,
                        )
                    )
        if len(ms.iyakuhin) >= 1000:
            for it in receipt.drugs:
                if it.code and it.code not in ms.iyakuhin:
                    out.append(
                        self.make_finding(
                            receipt,
                            f"医薬品コード {it.code} が医薬品マスターにありません",
                            target=it.display_name,
                        )
                    )
        return out


class JitsuNissuRule(Rule):
    rule_id = "FMT-004"
    name = "診療実日数の整合性"
    category = "形式"
    description = "診療実日数と算定日情報から推定した受診日数の食い違いを点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        days = receipt.jitsu_nissu
        if days is None:
            out.append(
                self.make_finding(
                    receipt, "診療実日数が記録されていません", severity=Severity.ERROR
                )
            )
            return out
        visit_days = receipt.visit_days
        # 外来のみ: 初診・再診等の算定日から受診日数を推定できる場合に比較
        if not receipt.is_inpatient and visit_days:
            if days > len(visit_days) and len(visit_days) > 0:
                # 実日数 > 算定日情報の日数 → 記録漏れの可能性(参考)
                out.append(
                    self.make_finding(
                        receipt,
                        f"診療実日数({days}日)が算定日情報から推定される受診日数({len(visit_days)}日)より多くなっています",
                        severity=Severity.INFO,
                        detail=f"算定日: {', '.join(str(d) for d in visit_days)}日",
                        suggestion="算定日情報の記録漏れ、または実日数の誤りがないか確認してください。",
                    )
                )
            if days < len(visit_days):
                out.append(
                    self.make_finding(
                        receipt,
                        f"診療実日数({days}日)より多い日数({len(visit_days)}日)の算定日が記録されています",
                        detail=f"算定日: {', '.join(str(d) for d in visit_days)}日",
                    )
                )
        if days == 0:
            out.append(self.make_finding(receipt, "診療実日数が0日です"))
        return out


class FixedPointsRule(Rule):
    rule_id = "FMT-006"
    name = "固定点数の不一致"
    category = "形式"
    description = "診療行為の記録点数がマスターの所定点数と一致するか点検(F査定=固定点数誤り対策。改定直後の旧点数請求を検出)"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official:
            return out
        reported: set = set()
        for it in receipt.acts:
            if not it.code or it.code in reported:
                continue
            if it.points is None or it.quantity is not None:
                continue  # 点数未記録(剤の継続行)や数量依存(きざみ)項目は対象外
            if it.zai_row_count > 1:
                continue  # 複数行の剤は点数が剤合計のため単一コードと比較できない
            m = official.act(it.code)
            if not m or (m.get("tensu_type") or "") != "3":
                continue  # 点数識別3(点数)以外(金額・%加算減算等)は対象外
            tensu = m.get("tensu")
            if tensu is None or tensu <= 0:
                continue
            if abs(it.points - tensu) > 0.001:
                reported.add(it.code)
                out.append(
                    self.make_finding(
                        receipt,
                        f"「{it.display_name}」の記録点数({it.points}点)がマスターの所定点数({tensu:g}点)と一致しません",
                        target=it.display_name,
                        detail=f"適用マスター: {official.version_label or '現行版'}。診療報酬改定直後は旧点数のままの請求(F査定=固定点数誤り)が多発します。",
                        suggestion="点数マスターの更新漏れがないか確認してください。逓減・特例措置等の正当な理由がある場合はこの指摘を除外設定してください。",
                    )
                )
        return out


class TotalPointsRule(FileRule):
    rule_id = "FMT-005"
    name = "合計点数の検算"
    category = "形式"
    description = "GOレコードの総件数・総合計点数とレセプト内容の突合"
    default_severity = Severity.ERROR

    def check_file(self, ctx: CheckContext) -> list:
        from ..models import Finding

        out = []
        cf = ctx.claim_file
        if not cf.go_totals:
            return out
        total_count = cf.go_totals.get("total_count")
        if total_count is not None and total_count != len(cf.receipts):
            out.append(
                Finding(
                    rule_id=self.rule_id,
                    rule_name=self.name,
                    category=self.category,
                    severity=self.default_severity,
                    message=(
                        f"GOレコードの総件数({total_count}件)と"
                        f"実際のレセプト件数({len(cf.receipts)}件)が一致しません"
                    ),
                )
            )
        total_points = cf.go_totals.get("total_points")
        actual = sum(r.total_points or 0 for r in cf.receipts)
        if total_points is not None and actual and total_points != actual:
            out.append(
                Finding(
                    rule_id=self.rule_id,
                    rule_name=self.name,
                    category=self.category,
                    severity=self.default_severity,
                    message=(
                        f"GOレコードの総合計点数({total_points:,}点)と"
                        f"各レセプト合計点数の和({actual:,}点)が一致しません"
                    ),
                )
            )
        return out


RULES = [
    RequiredFieldsRule(),
    DateConsistencyRule(),
    UnknownCodeRule(),
    JitsuNissuRule(),
    FixedPointsRule(),
]
FILE_RULES = [TotalPointsRule()]
