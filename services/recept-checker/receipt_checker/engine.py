"""チェックエンジン: 全ルールを全レセプトに適用して指摘を集約する"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

from .models import ClaimFile, Finding, Severity
from .rules import all_file_rules, all_rules
from .rules.base import CheckContext, FileRule, Rule

logger = logging.getLogger(__name__)


@dataclass
class CheckResult:
    """1ファイル分の点検結果"""

    claim_file: ClaimFile
    findings: list = field(default_factory=list)  # [Finding]
    rules_run: int = 0
    excluded_count: int = 0   # 点検除外設定により非表示にした指摘数
    master_version: str = ""  # 適用した年度版マスターの表示名

    @property
    def error_count(self) -> int:
        return sum(1 for f in self.findings if f.severity == Severity.ERROR)

    @property
    def warning_count(self) -> int:
        return sum(1 for f in self.findings if f.severity == Severity.WARNING)

    @property
    def info_count(self) -> int:
        return sum(1 for f in self.findings if f.severity == Severity.INFO)

    def findings_for(self, receipt_no: int) -> list:
        return [f for f in self.findings if f.receipt_no == receipt_no]

    @property
    def receipts_with_findings(self) -> int:
        return len({f.receipt_no for f in self.findings if f.receipt_no})

    def by_category(self) -> dict:
        out: dict = {}
        for f in self.findings:
            out.setdefault(f.category, []).append(f)
        return out


class CheckEngine:
    """点検の実行本体"""

    def __init__(
        self,
        masters,
        history=None,
        enabled_rule_ids: Optional[set] = None,
        disabled_rule_ids: Optional[set] = None,
        settings=None,
    ):
        self.masters = masters
        self.history = history
        self.settings = settings
        if settings is not None and disabled_rule_ids is None:
            disabled_rule_ids = settings.disabled_rule_ids()
        self.rules: list = [r for r in all_rules() if _enabled(r, enabled_rule_ids, disabled_rule_ids)]
        self.file_rules: list = [r for r in all_file_rules() if _enabled(r, enabled_rule_ids, disabled_rule_ids)]

    def run(self, claim_file: ClaimFile, options: Optional[dict] = None) -> CheckResult:
        # 診療年月に応じた年度版マスターを選択(改定またぎ対応)。
        # 月遅れ請求で異なる診療年月のレセプトが混在するため、版はレセプト単位で選ぶ。
        base_masters = self.masters
        used_versions: list = []
        ctx_cache: dict = {}

        def ctx_for(ym: str) -> CheckContext:
            if ym not in ctx_cache:
                masters = base_masters
                if ym and hasattr(base_masters, "for_ym"):
                    masters = base_masters.for_ym(ym)
                label = ""
                if getattr(masters, "official", None) is not None:
                    label = masters.official.version_label
                if label and label not in used_versions:
                    used_versions.append(label)
                ctx_cache[ym] = CheckContext(
                    claim_file=claim_file,
                    masters=masters,
                    history=self.history,
                    options=options or {},
                )
            return ctx_cache[ym]

        findings: list = list(claim_file.parse_errors)

        for receipt in claim_file.receipts:
            d = receipt.shinryo_ym_as_date()
            ym = f"{d.year:04d}{d.month:02d}" if d else _claim_ym(claim_file)
            ctx = ctx_for(ym)
            for rule in self.rules:
                try:
                    findings.extend(rule.check(receipt, ctx) or [])
                except Exception:
                    logger.exception(
                        "ルール %s がレセプト %s で例外を送出しました",
                        rule.rule_id, receipt.receipt_no,
                    )

        # ファイル横断ルールはファイル代表の診療年月の版で実行する
        ctx = ctx_for(_claim_ym(claim_file))

        for frule in self.file_rules:
            try:
                findings.extend(frule.check_file(ctx) or [])
            except Exception:
                logger.exception("ファイルルール %s が例外を送出しました", frule.rule_id)

        excluded = 0
        if self.settings is not None:
            findings, excluded = self.settings.filter_findings(findings)

        findings.sort(key=lambda f: f.sort_key())
        return CheckResult(
            claim_file=claim_file,
            findings=findings,
            rules_run=len(self.rules) + len(self.file_rules),
            excluded_count=excluded,
            master_version="、".join(used_versions),
        )


def _enabled(rule, enabled_ids, disabled_ids) -> bool:
    if enabled_ids is not None and rule.rule_id not in enabled_ids:
        return False
    if disabled_ids is not None and rule.rule_id in disabled_ids:
        return False
    return True


def _claim_ym(claim_file: ClaimFile) -> str:
    """ファイル内レセプトの診療年月をYYYYMMに正規化して返す"""
    for r in claim_file.receipts:
        d = r.shinryo_ym_as_date()
        if d:
            return f"{d.year:04d}{d.month:02d}"
    return ""
