"""点検ルールの基底クラスと実行コンテキスト"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

from ..models import ClaimFile, Finding, Receipt, Severity

if TYPE_CHECKING:
    from ..masters.loader import MasterSet
    from ..store import HistoryStore


@dataclass
class CheckContext:
    """ルール実行時に参照できる共有情報"""

    claim_file: ClaimFile
    masters: "MasterSet"
    history: Optional["HistoryStore"] = None  # 縦覧点検用(過去レセプト)
    options: dict = field(default_factory=dict)


class Rule(ABC):
    """点検ルールの基底クラス

    サブクラスは rule_id / name / category / severity を定義し、
    check() で1レセプトを点検して Finding のリストを返す。
    """

    rule_id: str = ""
    name: str = ""
    category: str = ""
    description: str = ""          # ルールの説明(UI表示用)
    default_severity: Severity = Severity.WARNING

    @abstractmethod
    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        """1レセプトを点検して list[Finding] を返す"""

    def make_finding(
        self,
        receipt: Receipt,
        message: str,
        *,
        severity: Optional[Severity] = None,
        target: str = "",
        detail: str = "",
        suggestion: str = "",
    ) -> Finding:
        return Finding(
            rule_id=self.rule_id,
            rule_name=self.name,
            category=self.category,
            severity=severity or self.default_severity,
            message=message,
            receipt_no=receipt.receipt_no,
            patient_name=receipt.patient_name,
            target=target,
            detail=detail,
            suggestion=suggestion,
        )


class FileRule(ABC):
    """ファイル全体(全レセプト横断)を点検するルール"""

    rule_id: str = ""
    name: str = ""
    category: str = ""
    description: str = ""
    default_severity: Severity = Severity.WARNING

    @abstractmethod
    def check_file(self, ctx: CheckContext) -> list:
        """ファイル全体を点検して list[Finding] を返す"""
