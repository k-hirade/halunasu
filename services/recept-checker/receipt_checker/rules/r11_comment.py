"""R11: 摘要記載チェック

特定の診療行為の算定時に必要なコメント(摘要)や症状詳記の
記載漏れを点検する。要件は masters/data/comment_requirements.csv を参照。

令和6年改定でも「摘要欄記載事項」の対象は拡大しており、
記載漏れはコンピュータチェックで機械的に返戻される代表例。
"""

from __future__ import annotations

from ..models import Receipt, Severity
from .base import CheckContext, Rule


class CommentRequirementRule(Rule):
    rule_id = "CM-001"
    name = "摘要記載の漏れ"
    category = "摘要記載"
    description = "算定時にコメント・症状詳記が必要な項目の記載漏れを検出"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        has_shoujoushouki = bool(receipt.symptom_details)
        for it in receipt.acts:
            req = ctx.masters.comment_requirements.get(it.code)
            if req is None:
                continue
            if req.requirement == "shoujoushouki":
                if not has_shoujoushouki:
                    out.append(
                        self.make_finding(
                            receipt,
                            f"「{it.display_name}」の算定には症状詳記が必要ですが、記録されていません",
                            target=it.display_name,
                            detail=req.message,
                            suggestion="SJレコード(症状詳記)で医学的必要性を説明してください。",
                        )
                    )
            else:
                if not it.comments:
                    out.append(
                        self.make_finding(
                            receipt,
                            f"「{it.display_name}」の算定にはコメント(摘要)の記載が必要ですが、記録されていません",
                            target=it.display_name,
                            detail=req.message,
                            suggestion="厚労省「レセプト摘要欄への記載事項」に定められたコメントコードを記録してください。記載漏れは返戻対象です。",
                        )
                    )
        return out


class WordProcessorCommentRule(Rule):
    rule_id = "CM-002"
    name = "フリーテキストコメントの多用"
    category = "摘要記載"
    description = "コメントコード化されていない自由記載(81系・未コード)コメントの多用を検出"
    default_severity = Severity.INFO

    FREE_TEXT_THRESHOLD = 5

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        free_texts = 0
        for it in receipt.items:
            for code, _text in it.comments:
                if code.startswith("81") or not code:
                    free_texts += 1
        for c in receipt.standalone_comments:
            if not c.code or c.code.startswith("81"):
                free_texts += 1
        if free_texts > self.FREE_TEXT_THRESHOLD:
            return [
                self.make_finding(
                    receipt,
                    f"自由記載コメントが{free_texts}件あります",
                    suggestion="定型コメントコード(82〜84系)で表現できるものは置き換えを検討してください。",
                )
            ]
        return []


class UnknownCommentCodeRule(Rule):
    rule_id = "CM-003"
    name = "コメントコードのマスター未登録"
    category = "摘要記載"
    description = "使用されたコメントコードがコメントマスターに存在するか点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official:
            return out
        seen: set = set()

        def check_code(code: str, text: str):
            if not code or code in seen:
                return
            seen.add(code)
            if official.comment(code) is None:
                out.append(
                    self.make_finding(
                        receipt,
                        f"コメントコード {code} がコメントマスターにありません",
                        target=text[:20] if text else code,
                        suggestion="コードの誤り、または廃止済みコードの可能性があります。",
                    )
                )

        for it in receipt.items:
            for code, text in it.comments:
                check_code(code, text)
        for c in receipt.standalone_comments:
            check_code(c.code, c.text)
        return out


RULES = [CommentRequirementRule(), WordProcessorCommentRule(), UnknownCommentCodeRule()]
FILE_RULES = []
