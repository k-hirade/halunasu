from __future__ import annotations

import argparse
import csv
import io
import json
import tempfile
from collections import Counter
from datetime import date
from pathlib import Path

from medical_fee_calculation.claim_batch import (
    DEFAULT_NATIONWIDE_LAB_SMOKE_PROCEDURE_CODES,
    claim_batch_audit_summary_rows,
    claim_batch_audit_summary_to_csv,
    claim_batch_audit_summary_to_json,
    claim_batch_audit_summary_to_tsv,
    claim_batch_results_to_markdown,
    claim_batch_results_to_tsv,
    gold_difference_classification_to_csv,
    gold_difference_classification_to_json,
    gold_difference_classification_to_jsonl,
    gold_difference_classification_to_markdown,
    gold_difference_classification_to_tsv,
    gold_difference_classification_rows,
    gold_improvement_action_plan_to_csv,
    gold_improvement_action_plan_to_json,
    gold_improvement_action_plan_to_jsonl,
    gold_improvement_action_plan_to_markdown,
    gold_improvement_action_plan_to_tsv,
    gold_improvement_backlog_to_csv,
    gold_improvement_backlog_to_json,
    gold_improvement_backlog_to_jsonl,
    gold_improvement_backlog_to_markdown,
    gold_improvement_backlog_to_tsv,
    gold_evaluation_results_to_csv,
    gold_evaluation_results_to_json,
    gold_evaluation_results_to_jsonl,
    gold_evaluation_results_to_markdown,
    gold_evaluation_results_to_tsv,
    run_nationwide_outpatient_lab_smoke,
    run_gold_outpatient_lab_claim_evaluation,
    run_outpatient_lab_claim_batch,
    run_outpatient_lab_claim_payloads,
)
from medical_fee_calculation.claim_models import MasterSourceContext
from medical_fee_calculation.claim_models import CommentInput
from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.dpc_electronic_table import (
    build_dpc_electronic_table_inventory_batch,
    build_dpc_electronic_table_inventory_batch_from_catalog,
    dpc_electronic_table_inventory_to_markdown,
    dpc_electronic_table_inventory_to_tsv,
    import_dpc_electronic_table,
)
from medical_fee_calculation.dpc_hospital_coefficients import (
    audit_dpc_hospital_coefficient_registry_matches,
    dpc_hospital_coefficient_registry_audit_to_csv,
    dpc_hospital_coefficient_registry_audit_to_json,
    dpc_hospital_coefficient_registry_audit_to_markdown,
    dpc_hospital_coefficient_registry_audit_to_tsv,
    dpc_hospital_coefficient_registry_fix_plan_to_csv,
    dpc_hospital_coefficient_registry_fix_plan_to_json,
    dpc_hospital_coefficient_registry_fix_plan_to_markdown,
    dpc_hospital_coefficient_registry_fix_plan_to_tsv,
    extract_dpc_hospital_coefficients_from_pdf,
    extract_dpc_hospital_coefficients_from_text,
    import_dpc_hospital_coefficients,
    plan_dpc_hospital_coefficient_registry_fixes,
    write_dpc_hospital_coefficients_csv,
    write_dpc_hospital_coefficients_extraction_report,
)
from medical_fee_calculation.hospital_batch import (
    build_hospital_claim_run_contexts,
    hospital_claim_run_contexts_to_markdown,
    hospital_profile_batch_results_to_markdown,
    smoke_hospital_run_targets,
)
from medical_fee_calculation.hospital_importers import (
    REGIONAL_BUREAUS,
    import_hokkaido_facility_standards,
    import_hokkaido_hospital_registry,
    import_regional_facility_standards,
    import_regional_hospital_registry,
)
from medical_fee_calculation.hospital_quality import (
    hospital_run_target_summary_to_markdown,
    hospital_run_targets_to_markdown,
    hospital_registry_quality_to_markdown,
    list_hospital_run_targets,
    list_unmatched_active_hospitals,
    summarize_hospital_run_targets,
    summarize_hospital_registry_quality,
    unmatched_active_hospitals_to_markdown,
)
from medical_fee_calculation.importers import (
    import_comment_links,
    import_comment_master,
    import_electronic_fee_table,
    import_medical_procedure_master,
)
from medical_fee_calculation.order_csv_adapter import (
    build_order_csv_mapping_contract_template,
    convert_order_csv_to_claim_payloads,
    list_order_csv_column_map_presets,
    order_csv_contract_validation_to_markdown,
    order_csv_column_profile_to_markdown,
    order_csv_conversion_to_markdown,
    order_csv_payloads_to_jsonl,
    profile_order_csv_columns,
    validate_order_csv_mapping_contract,
)
from medical_fee_calculation.official_sources import (
    official_source_catalog_validation_to_markdown,
    official_source_catalog_validation_to_tsv,
    validate_official_source_catalog,
)
from medical_fee_calculation.regional_discovery import (
    build_manifest_template,
    discover_regional_source_files,
    select_regional_source_file_candidates,
)
from medical_fee_calculation.regional_download import (
    download_regional_source_catalog,
    download_regional_source_files_from_page,
    regional_download_batch_to_markdown,
)
from medical_fee_calculation.regional_manifest import (
    import_regional_manifest,
    regional_manifest_validation_to_markdown,
    regional_manifest_validation_to_tsv,
    validate_regional_manifest,
)
from medical_fee_calculation.regional_sources import (
    REGIONAL_SOURCE_KINDS,
    get_regional_source_page,
    list_regional_source_pages,
)
from medical_fee_calculation.regional_smoke import (
    regional_smoke_results_to_markdown,
    run_regional_manifest_smoke,
)
from medical_fee_calculation.standard_build import (
    build_standard_master_db,
    prepare_standard_build_manifest,
    standard_build_manifest_preparation_to_markdown,
    standard_build_manifest_validation_to_markdown,
    standard_build_manifest_validation_to_tsv,
    standard_build_results_to_markdown,
    standard_build_results_to_tsv,
    validate_standard_build_manifest,
)
from medical_fee_calculation.ssk_download import (
    diff_ssk_master_catalogs,
    discover_ssk_master_catalog,
    download_ssk_master_catalog,
    ssk_master_catalog_diff_to_markdown,
    ssk_master_catalog_discovery_to_markdown,
    ssk_master_catalog_download_to_markdown,
)


ORDER_CSV_PIPELINE_MANIFEST_VALIDATION_FIELDS = (
    "entry_id",
    "status",
    "evaluate_gold",
    "csv_path",
    "csv_exists",
    "contract_path",
    "contract_exists",
    "template_jsonl_path",
    "template_jsonl_exists",
    "contract_passed",
    "row_count",
    "has_gold_labels",
    "contract_error_count",
    "contract_warning_count",
    "reason",
)


def _init_db(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    conn.close()
    print(f"initialized {args.db}")


def _import_medical_procedures(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    result = import_medical_procedure_master(
        conn,
        args.csv,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        encoding=args.encoding,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        "imported medical_procedure_master "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _import_comments(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    result = import_comment_master(
        conn,
        args.csv,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        encoding=args.encoding,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        "imported comment_master "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _import_comment_links(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    result = import_comment_links(
        conn,
        args.csv,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        encoding=args.encoding,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        "imported comment_related_table "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _import_electronic_fee_table(args: argparse.Namespace) -> None:
    csv_paths = {
        "aux_master": args.aux_master,
        "bundles": args.bundles,
        "exclusions_day": args.exclusions_day,
        "exclusions_month": args.exclusions_month,
        "exclusions_simultaneous": args.exclusions_simultaneous,
        "exclusions_week": args.exclusions_week,
        "inpatient_basic": args.inpatient_basic,
        "frequency_limits": args.frequency_limits,
    }
    csv_paths = {name: path for name, path in csv_paths.items() if path is not None}

    conn = connect(args.db)
    initialize_schema(conn)
    result = import_electronic_fee_table(
        conn,
        csv_paths,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        encoding=args.encoding,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        "imported medical_electronic_fee_table "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _import_dpc_electronic_table(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    result = import_dpc_electronic_table(
        conn,
        args.xlsx,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        "imported dpc_electronic_table "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _import_dpc_hospital_coefficients(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    result = import_dpc_hospital_coefficients(
        conn,
        args.csv,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        encoding=args.encoding,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        "imported dpc_hospital_coefficient "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _extract_dpc_hospital_coefficients(args: argparse.Namespace) -> None:
    if args.pdf is None and args.text is None:
        raise SystemExit("--pdf or --text is required")
    if args.pdf is not None and args.text is not None:
        raise SystemExit("--pdf and --text are mutually exclusive")

    if args.pdf is not None:
        extraction = extract_dpc_hospital_coefficients_from_pdf(
            args.pdf,
            effective_from=args.effective_from,
            effective_to=args.effective_to,
        )
    else:
        extraction = extract_dpc_hospital_coefficients_from_text(
            args.text.read_text(encoding=args.encoding),
            text_source=str(args.text),
            effective_from=args.effective_from,
            effective_to=args.effective_to,
        )

    write_dpc_hospital_coefficients_csv(extraction, args.output)
    if args.report_output is not None:
        write_dpc_hospital_coefficients_extraction_report(extraction, args.report_output)
    print(
        "extracted dpc_hospital_coefficients "
        f"rows={len(extraction.rows)} warnings={len(extraction.warnings)} output={args.output}"
    )


def _audit_dpc_hospital_coefficients(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    rows = audit_dpc_hospital_coefficient_registry_matches(
        conn,
        source_id=args.source_id,
    )
    conn.close()

    if args.format == "markdown":
        content = dpc_hospital_coefficient_registry_audit_to_markdown(
            rows,
            include_matched=args.include_matched,
        )
    elif args.format == "json":
        content = dpc_hospital_coefficient_registry_audit_to_json(rows)
    elif args.format == "csv":
        content = dpc_hospital_coefficient_registry_audit_to_csv(rows)
    elif args.format == "tsv":
        content = dpc_hospital_coefficient_registry_audit_to_tsv(rows)
    else:
        raise SystemExit(f"unsupported format: {args.format}")

    if args.output is None:
        print(content)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
        print(
            "audited dpc_hospital_coefficients "
            f"rows={len(rows)} output={args.output}"
        )


def _plan_dpc_hospital_coefficient_fixes(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    rows = plan_dpc_hospital_coefficient_registry_fixes(
        conn,
        source_id=args.source_id,
        include_connected=args.include_connected,
    )
    conn.close()

    if args.format == "markdown":
        content = dpc_hospital_coefficient_registry_fix_plan_to_markdown(rows)
    elif args.format == "json":
        content = dpc_hospital_coefficient_registry_fix_plan_to_json(rows)
    elif args.format == "csv":
        content = dpc_hospital_coefficient_registry_fix_plan_to_csv(rows)
    elif args.format == "tsv":
        content = dpc_hospital_coefficient_registry_fix_plan_to_tsv(rows)
    else:
        raise SystemExit(f"unsupported format: {args.format}")

    if args.output is None:
        print(content)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
        print(
            "planned dpc_hospital_coefficient registry fixes "
            f"rows={len(rows)} output={args.output}"
        )


def _import_hokkaido_hospital_registry(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    result = import_hokkaido_hospital_registry(
        conn,
        args.xlsx,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        "imported hokkaido_hospital_registry "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _import_regional_hospital_registry(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    result = import_regional_hospital_registry(
        conn,
        args.xlsx,
        regional_bureau=args.regional_bureau,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        f"imported {args.regional_bureau}_hospital_registry "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _import_hokkaido_facility_standards(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    result = import_hokkaido_facility_standards(
        conn,
        args.xlsx,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        "imported hokkaido_facility_standards_medical "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _import_regional_facility_standards(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    result = import_regional_facility_standards(
        conn,
        args.xlsx,
        regional_bureau=args.regional_bureau,
        source_version=args.source_version,
        published_at=args.published_at,
        url=args.url,
        retrieved_at=args.retrieved_at,
    )
    conn.close()
    print(
        f"imported {args.regional_bureau}_facility_standards_medical "
        f"source_id={result.source_id} rows={result.row_count} sha256={result.checksum_sha256}"
    )


def _import_regional_manifest(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    results = import_regional_manifest(conn, args.manifest)
    conn.close()
    for result in results:
        print(
            f"imported {result.regional_bureau}_{result.kind} "
            f"path={result.path} source_id={result.source_id} "
            f"rows={result.row_count} sha256={result.checksum_sha256}"
        )
    print(f"imported regional_manifest entries={len(results)}")


def _validate_regional_manifest(args: argparse.Namespace) -> None:
    result = validate_regional_manifest(args.manifest)
    if args.format == "json":
        output = json.dumps(result.to_dict(), ensure_ascii=False, indent=2)
    elif args.format == "markdown":
        output = regional_manifest_validation_to_markdown(result)
    else:
        output = regional_manifest_validation_to_tsv(result)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    if args.fail_on_error and not result.ready:
        raise SystemExit(1)


def _build_standard_master_db(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    results = build_standard_master_db(
        conn,
        args.manifest,
        continue_on_error=not args.stop_on_error,
    )
    conn.close()

    if args.format == "json":
        output = json.dumps([result.to_dict() for result in results], ensure_ascii=False, indent=2)
    elif args.format == "markdown":
        output = standard_build_results_to_markdown(results)
    else:
        output = standard_build_results_to_tsv(results)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    if args.fail_on_error and any(result.status != "ok" for result in results):
        raise SystemExit(1)


def _prepare_standard_master_build_manifest(args: argparse.Namespace) -> None:
    result = prepare_standard_build_manifest(
        args.raw_root,
        source_version=args.source_version,
        published_at=args.published_at,
        retrieved_at=args.retrieved_at,
        regional_manifest=args.regional_manifest,
        extract_archives=not args.no_extract_archives,
        overwrite_extracted=args.overwrite_extracted,
        zip_metadata_encoding=args.zip_metadata_encoding,
    )

    if args.format == "json":
        output = json.dumps(result.manifest, ensure_ascii=False, indent=2) + "\n"
    else:
        output = standard_build_manifest_preparation_to_markdown(result)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    if args.fail_on_missing and result.missing_kinds:
        raise SystemExit(1)


def _validate_standard_master_build_manifest(args: argparse.Namespace) -> None:
    result = validate_standard_build_manifest(args.manifest)
    if args.format == "json":
        output = json.dumps(result.to_dict(), ensure_ascii=False, indent=2)
    elif args.format == "markdown":
        output = standard_build_manifest_validation_to_markdown(result)
    else:
        output = standard_build_manifest_validation_to_tsv(result)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    if args.fail_on_error and not result.ready:
        raise SystemExit(1)


def _download_ssk_master_catalog(args: argparse.Namespace) -> None:
    result = download_ssk_master_catalog(
        args.catalog,
        raw_root=args.raw_root,
        source_version=args.source_version,
        published_at=args.published_at,
        retrieved_at=args.retrieved_at,
        regional_manifest=args.regional_manifest,
        prepare_manifest=not args.no_prepare_manifest,
        overwrite=args.overwrite,
        timeout=args.timeout,
    )

    if args.standard_manifest_output is not None:
        if result.standard_build_manifest is None:
            raise SystemExit("--standard-manifest-output requires manifest preparation")
        args.standard_manifest_output.parent.mkdir(parents=True, exist_ok=True)
        args.standard_manifest_output.write_text(
            json.dumps(result.standard_build_manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    if args.format == "json":
        output = json.dumps(result.to_dict(), ensure_ascii=False, indent=2)
    elif args.format == "manifest":
        if result.standard_build_manifest is None:
            raise SystemExit("--format manifest requires manifest preparation")
        output = json.dumps(result.standard_build_manifest, ensure_ascii=False, indent=2)
    else:
        output = ssk_master_catalog_download_to_markdown(result)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    if args.fail_on_error and any(item.status != "ok" for item in result.items):
        raise SystemExit(1)
    if args.fail_on_missing and result.missing_kinds:
        raise SystemExit(1)


def _discover_ssk_master_catalog(args: argparse.Namespace) -> None:
    result = discover_ssk_master_catalog(
        source_version=args.source_version,
        page_encoding=args.page_encoding,
        timeout=args.timeout,
    )

    if args.format == "catalog":
        output = json.dumps(result.catalog, ensure_ascii=False, indent=2) + "\n"
    elif args.format == "json":
        output = json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n"
    else:
        output = ssk_master_catalog_discovery_to_markdown(result)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="" if output.endswith("\n") else "\n")

    if args.fail_on_warning and result.warnings:
        raise SystemExit(1)


def _diff_ssk_master_catalog(args: argparse.Namespace) -> None:
    result = diff_ssk_master_catalogs(args.old, args.new)

    if args.format == "json":
        output = json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n"
    else:
        output = ssk_master_catalog_diff_to_markdown(result)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="" if output.endswith("\n") else "\n")

    if args.fail_on_change and result.has_changes:
        raise SystemExit(1)


def _validate_official_source_catalog(args: argparse.Namespace) -> None:
    result = validate_official_source_catalog(args.catalog)
    if args.format == "json":
        output = json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n"
    elif args.format == "markdown":
        output = official_source_catalog_validation_to_markdown(result) + "\n"
    else:
        output = official_source_catalog_validation_to_tsv(result) + "\n"

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")

    if args.fail_on_error and not result.ready:
        raise SystemExit(1)


def _inventory_dpc_electronic_table(args: argparse.Namespace) -> None:
    if args.catalog is not None:
        if args.raw_root is None:
            raise SystemExit("--catalog requires --raw-root")
        result = build_dpc_electronic_table_inventory_batch_from_catalog(
            args.catalog,
            args.raw_root,
        )
    else:
        if not args.xlsx:
            raise SystemExit("--xlsx is required when --catalog is not specified")
        result = build_dpc_electronic_table_inventory_batch(
            args.xlsx,
            source_version=args.source_version,
        )

    if args.format == "json":
        output = json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n"
    elif args.format == "markdown":
        output = dpc_electronic_table_inventory_to_markdown(result) + "\n"
    else:
        output = dpc_electronic_table_inventory_to_tsv(result) + "\n"

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")

    if args.fail_on_missing and not result.ready_for_raw_import:
        raise SystemExit(1)


def _smoke_regional_manifest(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    results = run_regional_manifest_smoke(conn, args.manifest)
    conn.close()

    if args.format == "json":
        print(json.dumps([result.to_dict() for result in results], ensure_ascii=False, indent=2))
    elif args.format == "markdown":
        print(regional_smoke_results_to_markdown(results))
    else:
        print("entry\tregional_bureau\tkind\tstatus\trows\tsource_id\tpath\terror")
        for result in results:
            print(
                "\t".join(
                    (
                        str(result.entry_index),
                        result.regional_bureau,
                        result.kind,
                        result.status,
                        "" if result.row_count is None else str(result.row_count),
                        "" if result.source_id is None else str(result.source_id),
                        str(result.path),
                        result.error or "",
                    )
                )
            )

    if args.fail_on_error and any(result.status != "ok" for result in results):
        raise SystemExit(1)


def _summarize_hospital_registry(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    summaries = summarize_hospital_registry_quality(conn)
    conn.close()

    if args.format == "json":
        print(json.dumps([summary.to_dict() for summary in summaries], ensure_ascii=False, indent=2))
    elif args.format == "markdown":
        print(hospital_registry_quality_to_markdown(summaries))
    else:
        print(
            "regional_bureau\tregistry_rows\thospital_rows\tactive_hospital_rows\t"
            "facility_standard_institution_count\t"
            "active_hospital_with_facility_standard_count\t"
            "active_hospital_without_facility_standard_count"
        )
        for summary in summaries:
            print(
                "\t".join(
                    (
                        summary.regional_bureau,
                        str(summary.registry_rows),
                        str(summary.hospital_rows),
                        str(summary.active_hospital_rows),
                        str(summary.facility_standard_institution_count),
                        str(summary.active_hospital_with_facility_standard_count),
                        str(summary.active_hospital_without_facility_standard_count),
                    )
                )
            )


def _list_unmatched_active_hospitals(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    hospitals = list_unmatched_active_hospitals(conn)
    conn.close()

    if args.format == "json":
        print(json.dumps([hospital.to_dict() for hospital in hospitals], ensure_ascii=False, indent=2))
    elif args.format == "markdown":
        print(unmatched_active_hospitals_to_markdown(hospitals))
    else:
        print(
            "regional_bureau\tmedical_institution_code\tinstitution_name\taddress\t"
            "bed_count_text\tdepartments_text\tsame_bureau_name_match_count\t"
            "classification\trecommended_action"
        )
        for hospital in hospitals:
            print(
                "\t".join(
                    (
                        hospital.regional_bureau,
                        hospital.medical_institution_code,
                        hospital.institution_name,
                        hospital.address,
                        hospital.bed_count_text,
                        hospital.departments_text,
                        str(hospital.same_bureau_name_match_count),
                        hospital.classification,
                        hospital.recommended_action,
                    )
                )
            )


def _summarize_hospital_run_targets(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    summaries = summarize_hospital_run_targets(conn)
    conn.close()

    if args.format == "json":
        print(json.dumps([summary.to_dict() for summary in summaries], ensure_ascii=False, indent=2))
    elif args.format == "markdown":
        print(hospital_run_target_summary_to_markdown(summaries))
    else:
        print("included_in_default_run\tclassification\trecommended_action\tcount")
        for summary in summaries:
            print(
                "\t".join(
                    (
                        "1" if summary.included_in_default_run else "0",
                        summary.classification,
                        summary.recommended_action,
                        str(summary.count),
                    )
                )
            )


def _list_hospital_run_targets(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    targets = list_hospital_run_targets(conn, include_excluded=args.include_excluded)
    conn.close()

    if args.format == "json":
        print(json.dumps([target.to_dict() for target in targets], ensure_ascii=False, indent=2))
    elif args.format == "markdown":
        print(hospital_run_targets_to_markdown(targets))
    else:
        print(
            "included_in_default_run\tregional_bureau\tmedical_institution_code\t"
            "institution_name\taddress\tbed_count_text\tdepartments_text\t"
            "facility_standard_count\tclassification\trecommended_action\twarnings"
        )
        for target in targets:
            print(
                "\t".join(
                    (
                        "1" if target.included_in_default_run else "0",
                        target.regional_bureau,
                        target.medical_institution_code,
                        target.institution_name,
                        target.address,
                        target.bed_count_text,
                        target.departments_text,
                        str(target.facility_standard_count),
                        target.classification,
                        target.recommended_action,
                        ",".join(target.warnings),
                    )
                )
            )


def _smoke_hospital_run_targets(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    results = smoke_hospital_run_targets(
        conn,
        service_date=date.fromisoformat(args.service_date),
        include_excluded=args.include_excluded,
    )
    conn.close()

    if args.format == "json":
        print(json.dumps([result.to_dict() for result in results], ensure_ascii=False, indent=2))
    elif args.format == "markdown":
        print(hospital_profile_batch_results_to_markdown(results))
    else:
        print(
            "status\tregional_bureau\tmedical_institution_code\tinstitution_name\t"
            "target_included_in_default_run\tprofile_included_in_default_medical_run\t"
            "target_classification\tprofile_classification\t"
            "target_recommended_action\tprofile_recommended_action\t"
            "target_facility_standard_count\tprofile_facility_standard_count\t"
            "profile_dpc_hospital_coefficient_present\tprofile_dpc_hospital_group\t"
            "warnings\terror"
        )
        for result in results:
            print(
                "\t".join(
                    (
                        result.status,
                        result.regional_bureau,
                        result.medical_institution_code,
                        result.institution_name,
                        "1" if result.target_included_in_default_run else "0",
                        _optional_bool_tsv(result.profile_included_in_default_medical_run),
                        result.target_classification,
                        result.profile_classification or "",
                        result.target_recommended_action,
                        result.profile_recommended_action or "",
                        str(result.target_facility_standard_count),
                        (
                            ""
                            if result.profile_facility_standard_count is None
                            else str(result.profile_facility_standard_count)
                        ),
                        _optional_bool_tsv(result.profile_dpc_hospital_coefficient_present),
                        result.profile_dpc_hospital_group or "",
                        ",".join(result.warnings),
                        result.error or "",
                    )
                )
            )

    if args.fail_on_error and any(result.status != "ok" for result in results):
        raise SystemExit(1)


def _export_hospital_claim_contexts(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    contexts = build_hospital_claim_run_contexts(
        conn,
        service_date=date.fromisoformat(args.service_date),
        include_excluded=args.include_excluded,
        is_outpatient=not args.inpatient,
        limit=args.limit,
    )
    conn.close()

    if args.format == "json":
        output = json.dumps([context.to_dict() for context in contexts], ensure_ascii=False, indent=2)
    elif args.format == "jsonl":
        output = "\n".join(
            json.dumps(context.to_dict(), ensure_ascii=False, separators=(",", ":"))
            for context in contexts
        )
        if output:
            output += "\n"
    elif args.format == "markdown":
        output = hospital_claim_run_contexts_to_markdown(contexts)
    else:
        output = _hospital_claim_contexts_to_tsv(contexts)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)


def _run_outpatient_lab_claim_batch(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    results = run_outpatient_lab_claim_batch(
        conn,
        args.input,
        default_master_sources=_master_source_context_from_args(args),
        auto_master_sources=not args.no_auto_master_sources,
        limit=args.limit,
    )
    conn.close()

    if args.format == "json":
        output = json.dumps([result.to_dict() for result in results], ensure_ascii=False, indent=2)
    elif args.format == "jsonl":
        output = "\n".join(
            json.dumps(result.to_dict(), ensure_ascii=False, separators=(",", ":"))
            for result in results
        )
        if output:
            output += "\n"
    elif args.format == "markdown":
        output = claim_batch_results_to_markdown(results)
    else:
        output = claim_batch_results_to_tsv(results)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    _write_claim_batch_audit(args, results)

    if args.fail_on_error and any(result.status == "error" for result in results):
        raise SystemExit(1)
    if args.fail_on_review and any(result.status != "ok" for result in results):
        raise SystemExit(1)


def _run_order_csv_outpatient_lab_batch(args: argparse.Namespace) -> None:
    conversion = convert_order_csv_to_claim_payloads(
        args.csv,
        template_jsonl_path=args.template_jsonl,
        column_map_path=args.column_map,
        column_map_preset=args.column_map_preset,
        encoding=args.encoding,
    )
    if args.converted_output is not None:
        args.converted_output.parent.mkdir(parents=True, exist_ok=True)
        args.converted_output.write_text(
            order_csv_payloads_to_jsonl(conversion.payloads),
            encoding="utf-8",
        )
    if args.conversion_report_output is not None:
        args.conversion_report_output.parent.mkdir(parents=True, exist_ok=True)
        args.conversion_report_output.write_text(
            order_csv_conversion_to_markdown(conversion),
            encoding="utf-8",
        )

    conn = connect(args.db)
    initialize_schema(conn)
    results = run_outpatient_lab_claim_payloads(
        conn,
        conversion.payloads,
        default_master_sources=_master_source_context_from_args(args),
        auto_master_sources=not args.no_auto_master_sources,
        limit=args.limit,
    )
    conn.close()

    if args.format == "json":
        output = json.dumps([result.to_dict() for result in results], ensure_ascii=False, indent=2)
    elif args.format == "jsonl":
        output = "\n".join(
            json.dumps(result.to_dict(), ensure_ascii=False, separators=(",", ":"))
            for result in results
        )
        if output:
            output += "\n"
    elif args.format == "markdown":
        output = claim_batch_results_to_markdown(results)
    else:
        output = claim_batch_results_to_tsv(results)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    _write_claim_batch_audit(args, results)

    if args.fail_on_warning and conversion.warnings:
        raise SystemExit(1)
    if args.fail_on_error and any(result.status == "error" for result in results):
        raise SystemExit(1)
    if args.fail_on_review and any(result.status != "ok" for result in results):
        raise SystemExit(1)


def _evaluate_gold_outpatient_lab_claim_batch(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    results = run_gold_outpatient_lab_claim_evaluation(
        conn,
        args.input,
        default_master_sources=_master_source_context_from_args(args),
        auto_master_sources=not args.no_auto_master_sources,
        limit=args.limit,
        point_tolerance=args.point_tolerance,
    )
    conn.close()

    if args.format == "json":
        output = gold_evaluation_results_to_json(results)
    elif args.format == "jsonl":
        output = gold_evaluation_results_to_jsonl(results)
    elif args.format == "csv":
        output = gold_evaluation_results_to_csv(results)
    elif args.format == "tsv":
        output = gold_evaluation_results_to_tsv(results)
    else:
        output = gold_evaluation_results_to_markdown(results)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    if args.classification_output is not None:
        _write_text_output(
            args.classification_output,
            _gold_difference_classification_output(results, args.classification_format),
        )
    if args.backlog_output is not None:
        _write_text_output(
            args.backlog_output,
            _gold_improvement_backlog_output(results, args.backlog_format),
        )
    if args.action_plan_output is not None:
        _write_text_output(
            args.action_plan_output,
            _gold_improvement_action_plan_output(results, args.action_plan_format),
        )

    if args.fail_on_error and any(result.overall_verdict == "error" for result in results):
        raise SystemExit(1)
    if args.fail_on_review and any(result.overall_verdict == "needs_review" for result in results):
        raise SystemExit(1)
    if args.fail_on_mismatch and any(
        result.overall_verdict not in {"match", "unlabeled"} for result in results
    ):
        raise SystemExit(1)


def _run_nationwide_outpatient_lab_smoke(args: argparse.Namespace) -> None:
    conn = connect(args.db)
    initialize_schema(conn)
    procedure_codes = (
        tuple(args.procedure_code)
        if args.procedure_code
        else DEFAULT_NATIONWIDE_LAB_SMOKE_PROCEDURE_CODES
    )
    results = run_nationwide_outpatient_lab_smoke(
        conn,
        service_date=date.fromisoformat(args.service_date),
        procedure_codes=procedure_codes,
        collection_fee_inputs=tuple(args.collection_fee_input or ()),
        comment_inputs=tuple(
            CommentInput(code=code) for code in (args.comment_code or ())
        )
        + tuple(CommentInput(text=text) for text in (args.comment_text or ())),
        lab_management_facility_missing_policy=args.lab_management_facility_missing_policy,
        include_excluded=args.include_excluded,
        default_master_sources=_master_source_context_from_args(args),
        auto_master_sources=not args.no_auto_master_sources,
        limit=args.limit,
    )
    conn.close()

    if args.format == "json":
        output = json.dumps([result.to_dict() for result in results], ensure_ascii=False, indent=2)
    elif args.format == "jsonl":
        output = "\n".join(
            json.dumps(result.to_dict(), ensure_ascii=False, separators=(",", ":"))
            for result in results
        )
        if output:
            output += "\n"
    elif args.format == "markdown":
        output = claim_batch_results_to_markdown(results)
    else:
        output = claim_batch_results_to_tsv(results)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    _write_claim_batch_audit(args, results)

    if args.fail_on_error and any(result.status == "error" for result in results):
        raise SystemExit(1)
    if args.fail_on_review and any(result.status != "ok" for result in results):
        raise SystemExit(1)


def _convert_order_csv_to_claim_jsonl(args: argparse.Namespace) -> None:
    result = convert_order_csv_to_claim_payloads(
        args.csv,
        template_jsonl_path=args.template_jsonl,
        column_map_path=args.column_map,
        column_map_preset=args.column_map_preset,
        encoding=args.encoding,
    )

    if args.format == "json":
        output = json.dumps(list(result.payloads), ensure_ascii=False, indent=2)
    elif args.format == "markdown":
        output = order_csv_conversion_to_markdown(result)
    else:
        output = order_csv_payloads_to_jsonl(result.payloads)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    if args.fail_on_warning and result.warnings:
        raise SystemExit(1)


def _profile_order_csv_columns(args: argparse.Namespace) -> None:
    profile = profile_order_csv_columns(
        args.csv,
        column_map_path=args.column_map,
        column_map_preset=args.column_map_preset,
        encoding=args.encoding,
    )

    if args.format == "json":
        output = json.dumps(profile.to_dict(), ensure_ascii=False, indent=2)
    else:
        output = order_csv_column_profile_to_markdown(profile)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    if args.fail_on_warning and profile.warnings:
        raise SystemExit(1)


def _validate_order_csv_contract(args: argparse.Namespace) -> None:
    result = validate_order_csv_mapping_contract(
        args.csv,
        args.contract,
        column_map_path=args.column_map,
        column_map_preset=args.column_map_preset,
        encoding=args.encoding,
    )

    if args.format == "json":
        output = json.dumps(result.to_dict(), ensure_ascii=False, indent=2)
    else:
        output = order_csv_contract_validation_to_markdown(result)

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)

    if args.fail_on_error and not result.passed:
        raise SystemExit(1)


def _generate_order_csv_contract_template(args: argparse.Namespace) -> None:
    contract = build_order_csv_mapping_contract_template(
        args.csv,
        column_map_path=args.column_map,
        column_map_preset=args.column_map_preset,
        encoding=args.encoding,
        contract_id=args.contract_id,
        hospital_name=args.hospital_name,
        regional_bureau=args.regional_bureau,
        medical_institution_code=args.medical_institution_code,
        require_gold_labels=True if args.require_gold_labels else None,
        include_unmapped_columns=not args.strict_unmapped,
        minimum_row_count=args.minimum_row_count,
    )
    output = json.dumps(contract.to_dict(), ensure_ascii=False, indent=2) + "\n"
    if args.output is not None:
        _write_text_output(args.output, output)
    else:
        print(output)


def _run_order_csv_claim_pipeline(args: argparse.Namespace) -> None:
    summary = _execute_order_csv_claim_pipeline(args)
    _raise_for_order_csv_pipeline_failures(args, summary)


def _validate_order_csv_pipeline_manifest(args: argparse.Namespace) -> None:
    rows = _order_csv_pipeline_manifest_validation_rows(args)
    output = _order_csv_pipeline_manifest_validation_output(rows, args.format)
    if args.output is not None:
        _write_text_output(args.output, output)
    else:
        print(output)

    if args.fail_on_error and any(row["status"] == "error" for row in rows):
        raise SystemExit(1)
    if args.fail_on_warning and any(row["status"] in {"error", "warning"} for row in rows):
        raise SystemExit(1)


def _execute_order_csv_claim_pipeline(args: argparse.Namespace) -> dict[str, object]:
    contract_result = None
    if args.contract is not None:
        contract_result = validate_order_csv_mapping_contract(
            args.csv,
            args.contract,
            column_map_path=args.column_map,
            column_map_preset=args.column_map_preset,
            encoding=args.encoding,
        )
        profile = contract_result.profile
        if args.contract_output is not None:
            _write_text_output(
                args.contract_output,
                _order_csv_contract_output(contract_result, args.contract_format),
            )
    else:
        profile = profile_order_csv_columns(
            args.csv,
            column_map_path=args.column_map,
            column_map_preset=args.column_map_preset,
            encoding=args.encoding or "utf-8",
        )

    if args.profile_output is not None:
        _write_text_output(args.profile_output, _order_csv_profile_output(profile, args.profile_format))

    effective_column_map_preset = args.column_map_preset
    effective_encoding = args.encoding or "utf-8"
    if contract_result is not None:
        effective_column_map_preset = effective_column_map_preset or contract_result.contract.column_map_preset
        effective_encoding = args.encoding or contract_result.contract.encoding or "utf-8"

    conversion = convert_order_csv_to_claim_payloads(
        args.csv,
        template_jsonl_path=args.template_jsonl,
        column_map_path=args.column_map,
        column_map_preset=effective_column_map_preset,
        encoding=effective_encoding,
    )
    converted_jsonl = order_csv_payloads_to_jsonl(conversion.payloads)
    converted_input_path = args.converted_output
    if args.converted_output is not None:
        _write_text_output(args.converted_output, converted_jsonl)
    if args.conversion_report_output is not None:
        _write_text_output(args.conversion_report_output, order_csv_conversion_to_markdown(conversion))

    needs_gold_evaluation = (
        args.evaluate_gold
        or args.gold_output is not None
        or args.gold_classification_output is not None
        or args.gold_backlog_output is not None
        or getattr(args, "gold_action_plan_output", None) is not None
    )
    with tempfile.TemporaryDirectory() as tmp_dir:
        if needs_gold_evaluation and converted_input_path is None:
            converted_input_path = Path(tmp_dir) / "converted-order-claims.jsonl"
            converted_input_path.write_text(converted_jsonl, encoding="utf-8")

        conn = connect(args.db)
        initialize_schema(conn)
        batch_results = run_outpatient_lab_claim_payloads(
            conn,
            conversion.payloads,
            default_master_sources=_master_source_context_from_args(args),
            auto_master_sources=not args.no_auto_master_sources,
            limit=args.limit,
        )
        gold_results = None
        if needs_gold_evaluation and converted_input_path is not None:
            gold_results = run_gold_outpatient_lab_claim_evaluation(
                conn,
                converted_input_path,
                default_master_sources=_master_source_context_from_args(args),
                auto_master_sources=not args.no_auto_master_sources,
                limit=args.limit,
                point_tolerance=args.point_tolerance,
            )
        conn.close()

    batch_output = _claim_batch_results_output(batch_results, args.format)
    if args.output is not None:
        _write_text_output(args.output, batch_output)
    else:
        print(batch_output)

    _write_claim_batch_audit(args, batch_results)

    if gold_results is not None:
        gold_output = _gold_evaluation_results_output(gold_results, args.gold_format)
        if args.gold_output is not None:
            _write_text_output(args.gold_output, gold_output)
        elif args.evaluate_gold:
            print(gold_output)
        if args.gold_classification_output is not None:
            _write_text_output(
                args.gold_classification_output,
                _gold_difference_classification_output(
                    gold_results,
                    args.gold_classification_format,
                ),
            )
        if args.gold_backlog_output is not None:
            _write_text_output(
                args.gold_backlog_output,
                _gold_improvement_backlog_output(gold_results, args.gold_backlog_format),
            )
        if getattr(args, "gold_action_plan_output", None) is not None:
            _write_text_output(
                args.gold_action_plan_output,
                _gold_improvement_action_plan_output(
                    gold_results,
                    getattr(args, "gold_action_plan_format", "markdown"),
                ),
            )

    gold_classification_summary = _gold_classification_summary(gold_results)
    return {
        "entry_id": getattr(args, "entry_id", None),
        "output_dir": str(getattr(args, "output_dir", "") or ""),
        "profile_output": _path_summary(getattr(args, "profile_output", None)),
        "contract_output": _path_summary(getattr(args, "contract_output", None)),
        "converted_output": _path_summary(getattr(args, "converted_output", None)),
        "conversion_report_output": _path_summary(getattr(args, "conversion_report_output", None)),
        "claim_output": _path_summary(getattr(args, "output", None)),
        "audit_output": _path_summary(getattr(args, "audit_output", None)),
        "gold_output": _path_summary(getattr(args, "gold_output", None)),
        "gold_classification_output": _path_summary(
            getattr(args, "gold_classification_output", None)
        ),
        "gold_backlog_output": _path_summary(getattr(args, "gold_backlog_output", None)),
        "gold_action_plan_output": _path_summary(
            getattr(args, "gold_action_plan_output", None)
        ),
        "contract_passed": None if contract_result is None else contract_result.passed,
        "conversion_warning_count": len(conversion.warnings),
        "record_count": len(batch_results),
        "batch_error_count": sum(1 for result in batch_results if result.status == "error"),
        "batch_review_count": sum(1 for result in batch_results if result.status != "ok"),
        "gold_record_count": None if gold_results is None else len(gold_results),
        "gold_error_count": 0
        if gold_results is None
        else sum(1 for result in gold_results if result.overall_verdict == "error"),
        "gold_review_count": 0
        if gold_results is None
        else sum(1 for result in gold_results if result.overall_verdict == "needs_review"),
        "gold_mismatch_count": 0
        if gold_results is None
        else sum(result.overall_verdict not in {"match", "unlabeled"} for result in gold_results),
        "gold_classification_action_count": gold_classification_summary["action_count"],
        "gold_high_priority_classification_count": gold_classification_summary[
            "high_priority_count"
        ],
        "gold_top_classification": gold_classification_summary["top_classification"],
        "gold_top_feedback_target": gold_classification_summary["top_feedback_target"],
        "gold_classification_counts": gold_classification_summary["classification_counts"],
        "gold_feedback_target_counts": gold_classification_summary["feedback_target_counts"],
    }


def _raise_for_order_csv_pipeline_failures(args: argparse.Namespace, summary: dict[str, object]) -> None:
    if args.fail_on_contract_error and summary.get("contract_passed") is False:
        raise SystemExit(1)
    if args.fail_on_warning and summary["conversion_warning_count"]:
        raise SystemExit(1)
    if args.fail_on_error and (summary["batch_error_count"] or summary["gold_error_count"]):
        raise SystemExit(1)
    if args.fail_on_review and (summary["batch_review_count"] or summary["gold_review_count"]):
        raise SystemExit(1)
    if args.fail_on_mismatch and summary["gold_mismatch_count"]:
        raise SystemExit(1)


def _run_order_csv_claim_pipeline_batch(args: argparse.Namespace) -> None:
    entries = _load_order_csv_pipeline_batch_entries(args.manifest)
    summaries: list[dict[str, object]] = []
    for index, entry in enumerate(entries, start=1):
        entry_args = _order_csv_pipeline_batch_entry_args(args, entry, index)
        try:
            summary = _execute_order_csv_claim_pipeline(entry_args)
            summary["status"] = _order_csv_pipeline_summary_status(args, summary)
            summary["attention_reasons"] = ",".join(_order_csv_pipeline_summary_reasons(summary))
        except Exception as exc:  # noqa: BLE001 - keep batch execution entry-local.
            summary = {
                "entry_id": getattr(entry_args, "entry_id", f"entry-{index}"),
                "output_dir": str(getattr(entry_args, "output_dir", "") or ""),
                "status": "error",
                "attention_reasons": "entry_error",
                "profile_output": _path_summary(getattr(entry_args, "profile_output", None)),
                "contract_output": _path_summary(getattr(entry_args, "contract_output", None)),
                "converted_output": _path_summary(getattr(entry_args, "converted_output", None)),
                "conversion_report_output": _path_summary(
                    getattr(entry_args, "conversion_report_output", None)
                ),
                "claim_output": _path_summary(getattr(entry_args, "output", None)),
                "audit_output": _path_summary(getattr(entry_args, "audit_output", None)),
                "gold_output": _path_summary(getattr(entry_args, "gold_output", None)),
                "gold_classification_output": _path_summary(
                    getattr(entry_args, "gold_classification_output", None)
                ),
                "gold_backlog_output": _path_summary(
                    getattr(entry_args, "gold_backlog_output", None)
                ),
                "gold_action_plan_output": _path_summary(
                    getattr(entry_args, "gold_action_plan_output", None)
                ),
                "contract_passed": None,
                "conversion_warning_count": "",
                "record_count": "",
                "batch_error_count": "",
                "batch_review_count": "",
                "gold_record_count": "",
                "gold_error_count": "",
                "gold_review_count": "",
                "gold_mismatch_count": "",
                "gold_classification_action_count": "",
                "gold_high_priority_classification_count": "",
                "gold_top_classification": "",
                "gold_top_feedback_target": "",
                "gold_classification_counts": {},
                "gold_feedback_target_counts": {},
                "error": str(exc),
            }
        summaries.append(summary)

    output = _order_csv_pipeline_batch_output(summaries, args.summary_format)
    if args.output is not None:
        _write_text_output(args.output, output)
    else:
        print(output)

    if args.review_index_output is not None:
        _write_text_output(
            args.review_index_output,
            _order_csv_pipeline_review_index_output(summaries, args.review_index_format),
        )

    if args.fail_on_batch_error and any(summary.get("status") != "ok" for summary in summaries):
        raise SystemExit(1)


def _load_order_csv_pipeline_batch_entries(manifest_path: Path) -> list[dict[str, object]]:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        raise ValueError("order CSV pipeline batch manifest must contain an entries array")
    result: list[dict[str, object]] = []
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"order CSV pipeline batch entry {index} must be an object")
        result.append(entry)
    return result


def _order_csv_pipeline_manifest_validation_rows(
    args: argparse.Namespace,
) -> list[dict[str, object]]:
    entries = _load_order_csv_pipeline_batch_entries(args.manifest)
    rows: list[dict[str, object]] = []
    for index, entry in enumerate(entries, start=1):
        entry_id = _order_csv_pipeline_entry_id(entry, index)
        csv_path = _manifest_entry_path(args.manifest, entry, "csv")
        contract_path = _manifest_entry_path(args.manifest, entry, "contract")
        template_jsonl_path = (
            _manifest_entry_path(args.manifest, entry, "template_jsonl") or args.template_jsonl
        )
        evaluate_gold = bool(entry.get("evaluate_gold", args.evaluate_gold))
        errors: list[str] = []
        warnings: list[str] = []
        contract_passed: bool | str = ""
        row_count: int | str = ""
        has_gold_labels: bool | str = ""
        contract_error_count = 0
        contract_warning_count = 0

        if csv_path is None:
            errors.append("csv is missing")
        elif not csv_path.exists():
            errors.append("csv file does not exist")

        if contract_path is None:
            errors.append("contract is missing")
        elif not contract_path.exists():
            errors.append("contract file does not exist")

        if template_jsonl_path is None:
            if args.require_template_jsonl:
                errors.append("template_jsonl is missing")
        elif not template_jsonl_path.exists():
            errors.append("template_jsonl file does not exist")

        if csv_path is not None and csv_path.exists() and contract_path is not None and contract_path.exists():
            try:
                contract_result = validate_order_csv_mapping_contract(
                    csv_path,
                    contract_path,
                    column_map_path=_manifest_entry_path(args.manifest, entry, "column_map") or args.column_map,
                    column_map_preset=str(entry.get("column_map_preset") or args.column_map_preset or "") or None,
                    encoding=str(entry.get("encoding") or args.encoding or "") or None,
                )
                contract_passed = contract_result.passed
                row_count = contract_result.profile.row_count
                has_gold_labels = contract_result.profile.has_gold_labels
                contract_error_count = sum(1 for check in contract_result.checks if check.status == "error")
                contract_warning_count = sum(1 for check in contract_result.checks if check.status == "warning")
                if not contract_result.passed:
                    errors.append("contract validation failed")
                if (args.require_gold_labels or evaluate_gold) and not contract_result.profile.has_gold_labels:
                    errors.append("gold labels are required but missing")
            except Exception as exc:  # noqa: BLE001 - keep manifest validation entry-local.
                errors.append(f"contract validation raised: {exc}")

        status = "error" if errors else ("warning" if warnings else "ok")
        rows.append(
            {
                "entry_id": entry_id,
                "status": status,
                "evaluate_gold": evaluate_gold,
                "csv_path": _path_summary(csv_path),
                "csv_exists": bool(csv_path is not None and csv_path.exists()),
                "contract_path": _path_summary(contract_path),
                "contract_exists": bool(contract_path is not None and contract_path.exists()),
                "template_jsonl_path": _path_summary(template_jsonl_path),
                "template_jsonl_exists": bool(
                    template_jsonl_path is not None and template_jsonl_path.exists()
                ),
                "contract_passed": contract_passed,
                "row_count": row_count,
                "has_gold_labels": has_gold_labels,
                "contract_error_count": contract_error_count,
                "contract_warning_count": contract_warning_count,
                "reason": "; ".join((*errors, *warnings)),
            }
        )
    return rows


def _order_csv_pipeline_batch_entry_args(
    args: argparse.Namespace,
    entry: dict[str, object],
    index: int,
) -> argparse.Namespace:
    entry_id = _order_csv_pipeline_entry_id(entry, index)
    entry_dir = args.output_root / _safe_path_component(entry_id)
    evaluate_gold = bool(entry.get("evaluate_gold", args.evaluate_gold))
    gold_output = entry_dir / f"gold-evaluation.{_output_extension(args.gold_format)}" if evaluate_gold else None
    gold_classification_output = (
        entry_dir / f"gold-classification.{_output_extension(args.gold_classification_format)}"
        if evaluate_gold
        else None
    )
    gold_backlog_output = (
        entry_dir / f"gold-backlog.{_output_extension(args.gold_backlog_format)}"
        if evaluate_gold
        else None
    )
    gold_action_plan_output = (
        entry_dir / f"gold-action-plan.{_output_extension(args.gold_action_plan_format)}"
        if evaluate_gold
        else None
    )
    manifest_path = args.manifest
    return argparse.Namespace(
        entry_id=entry_id,
        output_dir=entry_dir,
        db=args.db,
        csv=_manifest_entry_path(manifest_path, entry, "csv"),
        contract=_manifest_entry_path(manifest_path, entry, "contract"),
        template_jsonl=_manifest_entry_path(manifest_path, entry, "template_jsonl") or args.template_jsonl,
        column_map=_manifest_entry_path(manifest_path, entry, "column_map") or args.column_map,
        column_map_preset=str(entry.get("column_map_preset") or args.column_map_preset or "") or None,
        encoding=str(entry.get("encoding") or args.encoding or "") or None,
        profile_output=entry_dir / f"profile.{_output_extension(args.profile_format)}",
        profile_format=args.profile_format,
        contract_output=entry_dir / f"contract-validation.{_output_extension(args.contract_format)}"
        if entry.get("contract")
        else None,
        contract_format=args.contract_format,
        converted_output=entry_dir / "converted.jsonl",
        conversion_report_output=entry_dir / "conversion.md",
        format=args.format,
        output=entry_dir / f"claim-results.{_output_extension(args.format)}",
        audit_output=entry_dir / f"claim-audit.{_output_extension(args.audit_format)}",
        audit_format=args.audit_format,
        evaluate_gold=evaluate_gold,
        gold_output=gold_output,
        gold_format=args.gold_format,
        gold_classification_output=gold_classification_output,
        gold_classification_format=args.gold_classification_format,
        gold_backlog_output=gold_backlog_output,
        gold_backlog_format=args.gold_backlog_format,
        gold_action_plan_output=gold_action_plan_output,
        gold_action_plan_format=args.gold_action_plan_format,
        point_tolerance=args.point_tolerance,
        limit=args.limit,
        fail_on_contract_error=False,
        fail_on_warning=False,
        fail_on_error=False,
        fail_on_review=False,
        fail_on_mismatch=False,
        no_auto_master_sources=args.no_auto_master_sources,
        medical_procedure_source_id=args.medical_procedure_source_id,
        drug_source_id=args.drug_source_id,
        material_source_id=args.material_source_id,
        electronic_fee_source_id=args.electronic_fee_source_id,
        comment_source_id=args.comment_source_id,
        registry_source_id=args.registry_source_id,
        facility_source_id=args.facility_source_id,
    )


def _manifest_entry_path(
    manifest_path: Path,
    entry: dict[str, object],
    key: str,
) -> Path | None:
    value = entry.get(key)
    if value is None or value == "":
        return None
    path = Path(str(value))
    if path.is_absolute():
        return path
    return manifest_path.parent / path


def _order_csv_pipeline_entry_id(entry: dict[str, object], index: int) -> str:
    for key in ("id", "contract_id", "hospital_id", "medical_institution_code"):
        value = entry.get(key)
        if value:
            return str(value)
    csv_path = entry.get("csv")
    if csv_path:
        return Path(str(csv_path)).stem
    return f"entry-{index}"


def _safe_path_component(value: str) -> str:
    result = "".join(char if char.isalnum() or char in ("-", "_", ".") else "_" for char in value)
    return result.strip("._") or "entry"


def _output_extension(output_format: str) -> str:
    return "md" if output_format == "markdown" else output_format


def _path_summary(value: object) -> str:
    return "" if value is None else str(value)


def _order_csv_pipeline_summary_status(
    args: argparse.Namespace,
    summary: dict[str, object],
) -> str:
    if _order_csv_pipeline_summary_failed_by_flags(args, summary):
        return "failed"
    if _order_csv_pipeline_summary_needs_attention(summary):
        return "needs_attention"
    return "ok"


def _order_csv_pipeline_summary_failed_by_flags(
    args: argparse.Namespace,
    summary: dict[str, object],
) -> bool:
    return (
        (args.fail_on_contract_error and summary.get("contract_passed") is False)
        or (args.fail_on_warning and _summary_count(summary.get("conversion_warning_count")) > 0)
        or (
            args.fail_on_error
            and (
                _summary_count(summary.get("batch_error_count")) > 0
                or _summary_count(summary.get("gold_error_count")) > 0
            )
        )
        or (
            args.fail_on_review
            and (
                _summary_count(summary.get("batch_review_count")) > 0
                or _summary_count(summary.get("gold_review_count")) > 0
            )
        )
        or (args.fail_on_mismatch and _summary_count(summary.get("gold_mismatch_count")) > 0)
    )


def _order_csv_pipeline_summary_needs_attention(summary: dict[str, object]) -> bool:
    return bool(_order_csv_pipeline_summary_reasons(summary))


def _order_csv_pipeline_summary_reasons(summary: dict[str, object]) -> tuple[str, ...]:
    reasons: list[str] = []
    if summary.get("status") == "error" or summary.get("error"):
        reasons.append("entry_error")
    if summary.get("contract_passed") is False:
        reasons.append("contract_failed")
    if _summary_count(summary.get("conversion_warning_count")) > 0:
        reasons.append("conversion_warning")
    if _summary_count(summary.get("batch_error_count")) > 0:
        reasons.append("batch_error")
    if _summary_count(summary.get("batch_review_count")) > 0:
        reasons.append("batch_review")
    if _summary_count(summary.get("gold_error_count")) > 0:
        reasons.append("gold_error")
    if _summary_count(summary.get("gold_review_count")) > 0:
        reasons.append("gold_review")
    if _summary_count(summary.get("gold_mismatch_count")) > 0:
        reasons.append("gold_mismatch")
    return tuple(reasons)


def _gold_classification_summary(results: object | None) -> dict[str, object]:
    if results is None:
        return {
            "action_count": None,
            "high_priority_count": None,
            "top_classification": "",
            "top_feedback_target": "",
            "classification_counts": {},
            "feedback_target_counts": {},
        }
    rows = gold_difference_classification_rows(results)
    classification_counts = Counter(str(row["classification"]) for row in rows)
    feedback_target_counts = Counter(str(row["feedback_target"]) for row in rows)
    return {
        "action_count": sum(
            count
            for classification, count in classification_counts.items()
            if classification != "match"
        ),
        "high_priority_count": sum(
            1 for row in rows if row["priority"] == "high" and row["classification"] != "match"
        ),
        "top_classification": _top_counter_key(classification_counts, exclude=("match",)),
        "top_feedback_target": _top_counter_key(feedback_target_counts, exclude=("none",)),
        "classification_counts": dict(sorted(classification_counts.items())),
        "feedback_target_counts": dict(sorted(feedback_target_counts.items())),
    }


def _top_counter_key(counter: Counter[str], *, exclude: tuple[str, ...] = ()) -> str:
    excluded = set(exclude)
    candidates = ((key, count) for key, count in counter.items() if key not in excluded)
    try:
        return max(candidates, key=lambda item: (item[1], item[0]))[0]
    except ValueError:
        return ""


def _summary_count(value: object) -> int:
    if value is None or value == "":
        return 0
    return int(value)


def _order_csv_pipeline_batch_output(summaries: list[dict[str, object]], output_format: str) -> str:
    if output_format == "json":
        return json.dumps(summaries, ensure_ascii=False, indent=2)
    if output_format == "csv":
        return _order_csv_pipeline_batch_to_delimited(summaries, delimiter=",")
    if output_format == "tsv":
        return _order_csv_pipeline_batch_to_delimited(summaries, delimiter="\t")
    return _order_csv_pipeline_batch_to_markdown(summaries)


def _order_csv_pipeline_manifest_validation_output(
    rows: list[dict[str, object]],
    output_format: str,
) -> str:
    if output_format == "json":
        return json.dumps(rows, ensure_ascii=False, indent=2)
    if output_format == "csv":
        return _order_csv_pipeline_manifest_validation_to_delimited(rows, delimiter=",")
    if output_format == "tsv":
        return _order_csv_pipeline_manifest_validation_to_delimited(rows, delimiter="\t")
    return _order_csv_pipeline_manifest_validation_to_markdown(rows)


def _order_csv_pipeline_manifest_validation_to_markdown(
    rows: list[dict[str, object]],
) -> str:
    status_counts = Counter(str(row["status"]) for row in rows)
    lines = [
        "# Order CSV Pipeline Manifest Validation",
        "",
        f"Entries: {len(rows)}",
        f"Ready: {'yes' if rows and all(row['status'] == 'ok' for row in rows) else 'no'}",
        "",
        "| Status | Count |",
        "| --- | ---: |",
    ]
    for status, count in sorted(status_counts.items()):
        lines.append(f"| {status} | {count} |")
    lines.extend(
        (
            "",
            "| Entry | Status | Gold | CSV | Contract | Template | Contract Passed | Rows | Gold Labels | Reason |",
            "| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- |",
        )
    )
    for row in rows:
        lines.append(
            "| "
            + " | ".join(
                (
                    _escape_markdown_table_cell(str(row["entry_id"])),
                    str(row["status"]),
                    _bool_cell(row["evaluate_gold"]),
                    _bool_cell(row["csv_exists"]),
                    _bool_cell(row["contract_exists"]),
                    _bool_cell(row["template_jsonl_exists"]),
                    _bool_cell(row["contract_passed"]),
                    str(row["row_count"]),
                    _bool_cell(row["has_gold_labels"]),
                    _escape_markdown_table_cell(str(row["reason"])),
                )
            )
            + " |"
        )
    return "\n".join(lines)


def _order_csv_pipeline_manifest_validation_to_delimited(
    rows: list[dict[str, object]],
    *,
    delimiter: str,
) -> str:
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=ORDER_CSV_PIPELINE_MANIFEST_VALIDATION_FIELDS,
        delimiter=delimiter,
        lineterminator="\n",
    )
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {field: row.get(field, "") for field in ORDER_CSV_PIPELINE_MANIFEST_VALIDATION_FIELDS}
        )
    return output.getvalue()


def _order_csv_pipeline_review_index_output(
    summaries: list[dict[str, object]],
    output_format: str,
) -> str:
    if output_format == "json":
        return json.dumps(_order_csv_pipeline_review_index_data(summaries), ensure_ascii=False, indent=2)
    return _order_csv_pipeline_review_index_to_markdown(summaries)


def _order_csv_pipeline_review_index_data(summaries: list[dict[str, object]]) -> dict[str, object]:
    entries_by_reason: dict[str, list[dict[str, str]]] = {}
    for summary in summaries:
        for reason in _summary_reasons(summary):
            entries_by_reason.setdefault(reason, []).append(_order_csv_pipeline_review_entry(summary, reason))
    return {
        "review_entry_count": len(
            {
                str(summary.get("entry_id") or "")
                for summary in summaries
                if _summary_reasons(summary)
            }
        ),
        "reasons": entries_by_reason,
    }


def _order_csv_pipeline_review_index_to_markdown(summaries: list[dict[str, object]]) -> str:
    review_entries = [summary for summary in summaries if _summary_reasons(summary)]
    lines = [
        "# Order CSV Claim Pipeline Review Index",
        "",
        f"Entries needing review: {len(review_entries)}",
    ]
    if not review_entries:
        lines.extend(("", "No entries need review."))
        return "\n".join(lines)

    for reason in _review_reason_order():
        reason_entries = [
            _order_csv_pipeline_review_entry(summary, reason)
            for summary in summaries
            if reason in _summary_reasons(summary)
        ]
        if not reason_entries:
            continue
        lines.extend(
            (
                "",
                f"## {reason}",
                "",
                "| Entry | Status | Artifacts | Output dir | Error |",
                "| --- | --- | --- | --- | --- |",
            )
        )
        for entry in reason_entries:
            lines.append(
                "| "
                + " | ".join(
                    (
                        _escape_markdown_table_cell(entry["entry_id"]),
                        _escape_markdown_table_cell(entry["status"]),
                        _escape_markdown_table_cell(entry["artifacts"]),
                        _escape_markdown_table_cell(entry["output_dir"]),
                        _escape_markdown_table_cell(entry["error"]),
                    )
                )
                + " |"
            )
    return "\n".join(lines)


def _order_csv_pipeline_review_entry(
    summary: dict[str, object],
    reason: str,
) -> dict[str, str]:
    return {
        "entry_id": str(summary.get("entry_id") or ""),
        "status": str(summary.get("status") or ""),
        "reason": reason,
        "artifacts": ", ".join(_review_artifacts_for_reason(summary, reason)),
        "output_dir": str(summary.get("output_dir") or ""),
        "error": str(summary.get("error") or ""),
    }


def _review_artifacts_for_reason(summary: dict[str, object], reason: str) -> tuple[str, ...]:
    fields_by_reason = {
        "entry_error": ("profile_output", "contract_output", "conversion_report_output"),
        "contract_failed": ("contract_output", "profile_output"),
        "conversion_warning": ("conversion_report_output", "converted_output"),
        "batch_error": ("claim_output", "audit_output", "converted_output"),
        "batch_review": ("claim_output", "audit_output", "converted_output"),
        "gold_error": (
            "gold_action_plan_output",
            "gold_backlog_output",
            "gold_classification_output",
            "gold_output",
            "claim_output",
            "converted_output",
        ),
        "gold_review": (
            "gold_action_plan_output",
            "gold_backlog_output",
            "gold_classification_output",
            "gold_output",
            "claim_output",
            "converted_output",
        ),
        "gold_mismatch": (
            "gold_action_plan_output",
            "gold_backlog_output",
            "gold_classification_output",
            "gold_output",
            "claim_output",
            "converted_output",
        ),
    }
    return tuple(
        str(summary.get(field_name))
        for field_name in fields_by_reason.get(reason, ("output_dir",))
        if summary.get(field_name)
    )


def _summary_reasons(summary: dict[str, object]) -> tuple[str, ...]:
    raw = str(summary.get("attention_reasons") or "")
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _review_reason_order() -> tuple[str, ...]:
    return (
        "entry_error",
        "contract_failed",
        "conversion_warning",
        "batch_error",
        "batch_review",
        "gold_error",
        "gold_review",
        "gold_mismatch",
    )


def _order_csv_pipeline_batch_to_markdown(summaries: list[dict[str, object]]) -> str:
    classification_counts = _aggregate_summary_counter(summaries, "gold_classification_counts")
    feedback_target_counts = _aggregate_summary_counter(summaries, "gold_feedback_target_counts")
    lines = [
        "# Order CSV Claim Pipeline Batch",
        "",
        f"Entries: {len(summaries)}",
        f"OK: {sum(1 for summary in summaries if summary.get('status') == 'ok')}",
        f"Needs attention: {sum(1 for summary in summaries if summary.get('status') == 'needs_attention')}",
        f"Failed: {sum(1 for summary in summaries if summary.get('status') == 'failed')}",
        f"Error: {sum(1 for summary in summaries if summary.get('status') == 'error')}",
        f"Contract failed: {sum(1 for summary in summaries if summary.get('contract_passed') is False)}",
        f"Conversion warnings: {sum(_summary_count(summary.get('conversion_warning_count')) for summary in summaries)}",
        f"Batch errors: {sum(_summary_count(summary.get('batch_error_count')) for summary in summaries)}",
        f"Batch review: {sum(_summary_count(summary.get('batch_review_count')) for summary in summaries)}",
        f"Gold mismatches: {sum(_summary_count(summary.get('gold_mismatch_count')) for summary in summaries)}",
        f"Gold classification actions: {sum(_summary_count(summary.get('gold_classification_action_count')) for summary in summaries)}",
        f"Gold high priority classifications: {sum(_summary_count(summary.get('gold_high_priority_classification_count')) for summary in summaries)}",
        "",
        "| Entry | Status | Reasons | Contract | Warnings | Records | Batch errors | Batch review | Gold records | Gold errors | Gold review | Gold mismatch | Gold actions | Gold high | Top classification | Top target | Output dir | Error |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |",
    ]
    for summary in summaries:
        row = _order_csv_pipeline_batch_row(summary)
        lines.append(
            "| "
            + " | ".join(
                (
                    _escape_markdown_table_cell(row["entry_id"]),
                    _escape_markdown_table_cell(row["status"]),
                    _escape_markdown_table_cell(row["attention_reasons"]),
                    row["contract_status"],
                    row["conversion_warning_count"],
                    row["record_count"],
                    row["batch_error_count"],
                    row["batch_review_count"],
                    row["gold_record_count"],
                    row["gold_error_count"],
                    row["gold_review_count"],
                    row["gold_mismatch_count"],
                    row["gold_classification_action_count"],
                    row["gold_high_priority_classification_count"],
                    _escape_markdown_table_cell(row["gold_top_classification"]),
                    _escape_markdown_table_cell(row["gold_top_feedback_target"]),
                    _escape_markdown_table_cell(row["output_dir"]),
                    _escape_markdown_table_cell(row["error"]),
                )
            )
            + " |"
        )
    if classification_counts:
        lines.extend(("", "## Gold Classification Counts", "", "| Classification | Count |", "| --- | ---: |"))
        for classification, count in sorted(classification_counts.items()):
            lines.append(f"| {classification} | {count} |")
    if feedback_target_counts:
        lines.extend(("", "## Gold Feedback Target Counts", "", "| Feedback Target | Count |", "| --- | ---: |"))
        for target, count in sorted(feedback_target_counts.items()):
            lines.append(f"| {target} | {count} |")
    return "\n".join(lines)


def _order_csv_pipeline_batch_to_delimited(
    summaries: list[dict[str, object]],
    *,
    delimiter: str,
) -> str:
    output = io.StringIO()
    fieldnames = (
        "entry_id",
        "status",
        "attention_reasons",
        "contract_status",
        "conversion_warning_count",
        "record_count",
        "batch_error_count",
        "batch_review_count",
        "gold_record_count",
        "gold_error_count",
        "gold_review_count",
        "gold_mismatch_count",
        "gold_classification_action_count",
        "gold_high_priority_classification_count",
        "gold_top_classification",
        "gold_top_feedback_target",
        "output_dir",
        "error",
    )
    writer = csv.DictWriter(output, fieldnames=fieldnames, delimiter=delimiter, lineterminator="\n")
    writer.writeheader()
    for summary in summaries:
        writer.writerow(_order_csv_pipeline_batch_row(summary))
    return output.getvalue()


def _order_csv_pipeline_batch_row(summary: dict[str, object]) -> dict[str, str]:
    contract = summary.get("contract_passed")
    contract_status = "skipped" if contract is None else ("pass" if contract else "fail")
    return {
        "entry_id": str(summary.get("entry_id") or ""),
        "status": str(summary.get("status") or ""),
        "attention_reasons": str(summary.get("attention_reasons") or ""),
        "contract_status": contract_status,
        "conversion_warning_count": _summary_cell(summary.get("conversion_warning_count")),
        "record_count": _summary_cell(summary.get("record_count")),
        "batch_error_count": _summary_cell(summary.get("batch_error_count")),
        "batch_review_count": _summary_cell(summary.get("batch_review_count")),
        "gold_record_count": _summary_cell(summary.get("gold_record_count")),
        "gold_error_count": _summary_cell(summary.get("gold_error_count")),
        "gold_review_count": _summary_cell(summary.get("gold_review_count")),
        "gold_mismatch_count": _summary_cell(summary.get("gold_mismatch_count")),
        "gold_classification_action_count": _summary_cell(
            summary.get("gold_classification_action_count")
        ),
        "gold_high_priority_classification_count": _summary_cell(
            summary.get("gold_high_priority_classification_count")
        ),
        "gold_top_classification": str(summary.get("gold_top_classification") or ""),
        "gold_top_feedback_target": str(summary.get("gold_top_feedback_target") or ""),
        "output_dir": str(summary.get("output_dir") or ""),
        "error": str(summary.get("error") or ""),
    }


def _aggregate_summary_counter(
    summaries: list[dict[str, object]],
    field_name: str,
) -> Counter[str]:
    counter: Counter[str] = Counter()
    for summary in summaries:
        counter.update(_summary_counter(summary.get(field_name)))
    return counter


def _summary_counter(value: object) -> Counter[str]:
    if not isinstance(value, dict):
        return Counter()
    counter: Counter[str] = Counter()
    for key, count in value.items():
        counter[str(key)] += _summary_count(count)
    return counter


def _summary_cell(value: object) -> str:
    if value is None:
        return ""
    return str(value)


def _bool_cell(value: object) -> str:
    if value == "":
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    return str(value)


def _escape_markdown_table_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def _write_text_output(path: Path, output: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(output, encoding="utf-8")


def _order_csv_profile_output(profile: object, output_format: str) -> str:
    if output_format == "json":
        return json.dumps(profile.to_dict(), ensure_ascii=False, indent=2)
    return order_csv_column_profile_to_markdown(profile)


def _order_csv_contract_output(result: object, output_format: str) -> str:
    if output_format == "json":
        return json.dumps(result.to_dict(), ensure_ascii=False, indent=2)
    return order_csv_contract_validation_to_markdown(result)


def _claim_batch_results_output(results: object, output_format: str) -> str:
    if output_format == "json":
        return json.dumps([result.to_dict() for result in results], ensure_ascii=False, indent=2)
    if output_format == "jsonl":
        output = "\n".join(
            json.dumps(result.to_dict(), ensure_ascii=False, separators=(",", ":"))
            for result in results
        )
        return output + "\n" if output else ""
    if output_format == "tsv":
        return claim_batch_results_to_tsv(results)
    return claim_batch_results_to_markdown(results)


def _gold_evaluation_results_output(results: object, output_format: str) -> str:
    if output_format == "json":
        return gold_evaluation_results_to_json(results)
    if output_format == "jsonl":
        return gold_evaluation_results_to_jsonl(results)
    if output_format == "csv":
        return gold_evaluation_results_to_csv(results)
    if output_format == "tsv":
        return gold_evaluation_results_to_tsv(results)
    return gold_evaluation_results_to_markdown(results)


def _gold_difference_classification_output(results: object, output_format: str) -> str:
    if output_format == "json":
        return gold_difference_classification_to_json(results)
    if output_format == "jsonl":
        return gold_difference_classification_to_jsonl(results)
    if output_format == "csv":
        return gold_difference_classification_to_csv(results)
    if output_format == "tsv":
        return gold_difference_classification_to_tsv(results)
    return gold_difference_classification_to_markdown(results)


def _gold_improvement_backlog_output(results: object, output_format: str) -> str:
    if output_format == "json":
        return gold_improvement_backlog_to_json(results)
    if output_format == "jsonl":
        return gold_improvement_backlog_to_jsonl(results)
    if output_format == "csv":
        return gold_improvement_backlog_to_csv(results)
    if output_format == "tsv":
        return gold_improvement_backlog_to_tsv(results)
    return gold_improvement_backlog_to_markdown(results)


def _gold_improvement_action_plan_output(results: object, output_format: str) -> str:
    if output_format == "json":
        return gold_improvement_action_plan_to_json(results)
    if output_format == "jsonl":
        return gold_improvement_action_plan_to_jsonl(results)
    if output_format == "csv":
        return gold_improvement_action_plan_to_csv(results)
    if output_format == "tsv":
        return gold_improvement_action_plan_to_tsv(results)
    return gold_improvement_action_plan_to_markdown(results)


def _write_claim_batch_audit(args: argparse.Namespace, results: object) -> None:
    audit_output = getattr(args, "audit_output", None)
    if audit_output is None:
        return
    rows = claim_batch_audit_summary_rows(results)
    audit_format = getattr(args, "audit_format", "csv")
    if audit_format == "json":
        output = claim_batch_audit_summary_to_json(rows)
    elif audit_format == "tsv":
        output = claim_batch_audit_summary_to_tsv(rows)
    else:
        output = claim_batch_audit_summary_to_csv(rows)
    audit_output.parent.mkdir(parents=True, exist_ok=True)
    audit_output.write_text(output, encoding="utf-8")


def _add_outpatient_claim_batch_parser(
    subparsers: argparse._SubParsersAction,
    command_name: str,
    *,
    help_text: str,
) -> None:
    run_claim_batch = subparsers.add_parser(command_name, help=help_text)
    run_claim_batch.add_argument("--db", required=True, type=Path)
    run_claim_batch.add_argument("--input", required=True, type=Path)
    run_claim_batch.add_argument(
        "--format",
        choices=("jsonl", "json", "tsv", "markdown"),
        default="markdown",
    )
    run_claim_batch.add_argument("--output", type=Path)
    run_claim_batch.add_argument("--audit-output", type=Path)
    run_claim_batch.add_argument("--audit-format", choices=("csv", "json", "tsv"), default="csv")
    run_claim_batch.add_argument("--limit", type=int)
    run_claim_batch.add_argument("--fail-on-error", action="store_true")
    run_claim_batch.add_argument("--fail-on-review", action="store_true")
    run_claim_batch.add_argument(
        "--no-auto-master-sources",
        action="store_true",
        help="Do not fill missing source IDs from the latest imported DB master sources",
    )
    run_claim_batch.add_argument("--medical-procedure-source-id", type=int)
    run_claim_batch.add_argument("--drug-source-id", type=int)
    run_claim_batch.add_argument("--material-source-id", type=int)
    run_claim_batch.add_argument("--electronic-fee-source-id", type=int)
    run_claim_batch.add_argument("--comment-source-id", type=int)
    run_claim_batch.add_argument("--registry-source-id", type=int)
    run_claim_batch.add_argument("--facility-source-id", type=int)
    run_claim_batch.set_defaults(func=_run_outpatient_lab_claim_batch)


def _add_order_csv_outpatient_claim_batch_parser(
    subparsers: argparse._SubParsersAction,
    command_name: str,
    *,
    help_text: str,
) -> None:
    run_order_csv_batch = subparsers.add_parser(command_name, help=help_text)
    run_order_csv_batch.add_argument("--db", required=True, type=Path)
    run_order_csv_batch.add_argument("--csv", required=True, type=Path)
    run_order_csv_batch.add_argument("--template-jsonl", type=Path)
    run_order_csv_batch.add_argument("--column-map", type=Path)
    run_order_csv_batch.add_argument(
        "--column-map-preset",
        choices=list_order_csv_column_map_presets(),
    )
    run_order_csv_batch.add_argument("--encoding", default="utf-8")
    run_order_csv_batch.add_argument(
        "--format",
        choices=("jsonl", "json", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_batch.add_argument("--output", type=Path)
    run_order_csv_batch.add_argument("--audit-output", type=Path)
    run_order_csv_batch.add_argument("--audit-format", choices=("csv", "json", "tsv"), default="csv")
    run_order_csv_batch.add_argument(
        "--converted-output",
        type=Path,
        help="Optional path to save the intermediate ClaimContext JSONL",
    )
    run_order_csv_batch.add_argument(
        "--conversion-report-output",
        type=Path,
        help="Optional path to save CSV conversion warnings and counts as Markdown",
    )
    run_order_csv_batch.add_argument("--limit", type=int)
    run_order_csv_batch.add_argument("--fail-on-warning", action="store_true")
    run_order_csv_batch.add_argument("--fail-on-error", action="store_true")
    run_order_csv_batch.add_argument("--fail-on-review", action="store_true")
    run_order_csv_batch.add_argument(
        "--no-auto-master-sources",
        action="store_true",
        help="Do not fill missing source IDs from the latest imported DB master sources",
    )
    run_order_csv_batch.add_argument("--medical-procedure-source-id", type=int)
    run_order_csv_batch.add_argument("--drug-source-id", type=int)
    run_order_csv_batch.add_argument("--material-source-id", type=int)
    run_order_csv_batch.add_argument("--electronic-fee-source-id", type=int)
    run_order_csv_batch.add_argument("--comment-source-id", type=int)
    run_order_csv_batch.add_argument("--registry-source-id", type=int)
    run_order_csv_batch.add_argument("--facility-source-id", type=int)
    run_order_csv_batch.set_defaults(func=_run_order_csv_outpatient_lab_batch)


def _add_gold_claim_batch_parser(
    subparsers: argparse._SubParsersAction,
    command_name: str,
    *,
    help_text: str,
) -> None:
    gold_claim_batch = subparsers.add_parser(command_name, help=help_text)
    gold_claim_batch.add_argument("--db", required=True, type=Path)
    gold_claim_batch.add_argument("--input", required=True, type=Path)
    gold_claim_batch.add_argument(
        "--format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    gold_claim_batch.add_argument("--output", type=Path)
    gold_claim_batch.add_argument("--classification-output", type=Path)
    gold_claim_batch.add_argument(
        "--classification-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    gold_claim_batch.add_argument("--backlog-output", type=Path)
    gold_claim_batch.add_argument(
        "--backlog-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    gold_claim_batch.add_argument("--action-plan-output", type=Path)
    gold_claim_batch.add_argument(
        "--action-plan-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    gold_claim_batch.add_argument("--limit", type=int)
    gold_claim_batch.add_argument("--point-tolerance", type=float, default=0.001)
    gold_claim_batch.add_argument("--fail-on-error", action="store_true")
    gold_claim_batch.add_argument("--fail-on-review", action="store_true")
    gold_claim_batch.add_argument("--fail-on-mismatch", action="store_true")
    gold_claim_batch.add_argument(
        "--no-auto-master-sources",
        action="store_true",
        help="Do not fill missing source IDs from the latest imported DB master sources",
    )
    gold_claim_batch.add_argument("--medical-procedure-source-id", type=int)
    gold_claim_batch.add_argument("--drug-source-id", type=int)
    gold_claim_batch.add_argument("--material-source-id", type=int)
    gold_claim_batch.add_argument("--electronic-fee-source-id", type=int)
    gold_claim_batch.add_argument("--comment-source-id", type=int)
    gold_claim_batch.add_argument("--registry-source-id", type=int)
    gold_claim_batch.add_argument("--facility-source-id", type=int)
    gold_claim_batch.set_defaults(func=_evaluate_gold_outpatient_lab_claim_batch)


def _hospital_claim_contexts_to_tsv(contexts: object) -> str:
    lines = [
        (
            "service_date\tregional_bureau\tmedical_institution_code\tinstitution_name\t"
            "is_outpatient\tincluded_in_default_medical_run\tdefault_run_classification\t"
            "default_run_recommended_action\tfacility_standard_keys\twarnings"
        )
    ]
    for context in contexts:
        lines.append(
            "\t".join(
                (
                    context.service_date.isoformat(),
                    context.regional_bureau,
                    context.medical_institution_code,
                    context.institution_name,
                    "1" if context.is_outpatient else "0",
                    "1" if context.included_in_default_medical_run else "0",
                    context.default_run_classification or "",
                    context.default_run_recommended_action or "",
                    ",".join(context.facility_standard_keys),
                    ",".join(context.warnings),
                )
            )
        )
    return "\n".join(lines)


def _optional_bool_tsv(value: bool | None) -> str:
    if value is None:
        return ""
    return "1" if value else "0"


def _master_source_context_from_args(args: argparse.Namespace) -> MasterSourceContext:
    return MasterSourceContext(
        medical_procedure_source_id=args.medical_procedure_source_id,
        drug_source_id=args.drug_source_id,
        material_source_id=args.material_source_id,
        electronic_fee_source_id=args.electronic_fee_source_id,
        comment_source_id=args.comment_source_id,
        registry_source_id=args.registry_source_id,
        facility_source_id=args.facility_source_id,
    )


def _list_regional_source_pages(args: argparse.Namespace) -> None:
    pages = list_regional_source_pages(args.kind)
    print("regional_bureau\tkind\timporter_status\texpected_publication\turl")
    for page in pages:
        print(
            "\t".join(
                (
                    page.regional_bureau,
                    page.kind,
                    page.importer_status,
                    page.expected_publication,
                    page.url,
                )
            )
        )


def _discover_regional_source_files(args: argparse.Namespace) -> None:
    page_url = args.page_url
    if page_url is None:
        source_page = get_regional_source_page(args.regional_bureau, args.kind)
        page_url = source_page.url

    html = args.html.read_text(encoding=args.encoding)
    candidates = discover_regional_source_files(
        html,
        page_url=page_url,
        regional_bureau=args.regional_bureau,
        kind=args.kind,
    )
    output_candidates = select_regional_source_file_candidates(candidates) if args.recommended_only else candidates

    if args.format == "json":
        print(json.dumps([candidate.to_dict() for candidate in output_candidates], ensure_ascii=False, indent=2))
        return

    if args.format == "manifest":
        if args.source_version is None:
            raise SystemExit("--source-version is required when --format manifest")
        manifest = build_manifest_template(
            output_candidates,
            source_version=args.source_version,
            raw_root=args.raw_root,
            published_at=args.published_at,
            retrieved_at=args.retrieved_at,
        )
        if args.manifest_output is not None:
            _write_json(args.manifest_output, manifest)
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return

    print("regional_bureau\tkind\textension\tis_importable\tselection_score\tlabel\turl")
    for candidate in output_candidates:
        print(
            "\t".join(
                (
                    candidate.regional_bureau or "",
                    candidate.kind or "",
                    candidate.extension,
                    "1" if candidate.is_importable else "0",
                    str(candidate.to_dict()["selection_score"]),
                    candidate.label,
                    candidate.url,
                )
            )
        )


def _download_regional_source_files(args: argparse.Namespace) -> None:
    result = download_regional_source_files_from_page(
        regional_bureau=args.regional_bureau,
        kind=args.kind,
        source_version=args.source_version,
        raw_root=args.raw_root,
        page_url=args.page_url,
        page_encoding=args.page_encoding,
        published_at=args.published_at,
        retrieved_at=args.retrieved_at,
        recommended_only=not args.include_all_candidates,
        overwrite=args.overwrite,
        timeout=args.timeout,
    )
    if args.manifest_output is not None:
        _write_json(args.manifest_output, result.manifest)
    if args.format == "manifest":
        print(json.dumps(result.manifest, ensure_ascii=False, indent=2))
    elif args.format == "json":
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    else:
        print("url\tpath\tsize_bytes\tchecksum_sha256")
        for downloaded_file in result.downloaded_files:
            print(
                "\t".join(
                    (
                        downloaded_file.url,
                        str(downloaded_file.path),
                        str(downloaded_file.size_bytes),
                        downloaded_file.checksum_sha256,
                    )
                )
            )


def _download_regional_catalog(args: argparse.Namespace) -> None:
    result = download_regional_source_catalog(
        source_version=args.source_version,
        raw_root=args.raw_root,
        regional_bureaus=tuple(args.regional_bureau or ()),
        kinds=tuple(args.kind or ()),
        page_encoding=args.page_encoding,
        published_at=args.published_at,
        retrieved_at=args.retrieved_at,
        recommended_only=not args.include_all_candidates,
        overwrite=args.overwrite,
        timeout=args.timeout,
    )
    if args.manifest_output is not None:
        _write_json(args.manifest_output, result.manifest)
    if args.format == "manifest":
        print(json.dumps(result.manifest, ensure_ascii=False, indent=2))
    elif args.format == "json":
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    elif args.format == "markdown":
        print(regional_download_batch_to_markdown(result))
    else:
        print("regional_bureau\tkind\tstatus\tcandidates\tselected\tfiles\terror")
        for item in result.items:
            item_result = item.result
            print(
                "\t".join(
                    (
                        item.regional_bureau,
                        item.kind,
                        item.status,
                        "" if item_result is None else str(item_result.candidate_count),
                        "" if item_result is None else str(item_result.selected_count),
                        "" if item_result is None else str(len(item_result.downloaded_files)),
                        item.error or "",
                    )
                )
            )

    if args.fail_on_error and any(item.status != "ok" for item in result.items):
        raise SystemExit(1)


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="medical-fee")
    subparsers = parser.add_subparsers(required=True)

    init_db = subparsers.add_parser("init-db", help="Initialize a SQLite database")
    init_db.add_argument("--db", required=True, type=Path)
    init_db.set_defaults(func=_init_db)

    import_medical = subparsers.add_parser(
        "import-medical-procedures",
        help="Import the official medical procedure master CSV",
    )
    import_medical.add_argument("--db", required=True, type=Path)
    import_medical.add_argument("--csv", required=True, type=Path)
    import_medical.add_argument("--source-version", required=True)
    import_medical.add_argument("--published-at")
    import_medical.add_argument("--url")
    import_medical.add_argument("--encoding", default="cp932")
    import_medical.add_argument("--retrieved-at")
    import_medical.set_defaults(func=_import_medical_procedures)

    import_comments = subparsers.add_parser(
        "import-comments",
        help="Import the official comment master CSV",
    )
    import_comments.add_argument("--db", required=True, type=Path)
    import_comments.add_argument("--csv", required=True, type=Path)
    import_comments.add_argument("--source-version", required=True)
    import_comments.add_argument("--published-at")
    import_comments.add_argument("--url")
    import_comments.add_argument("--encoding", default="cp932")
    import_comments.add_argument("--retrieved-at")
    import_comments.set_defaults(func=_import_comments)

    import_comment_related = subparsers.add_parser(
        "import-comment-links",
        help="Import the official comment related table CSV",
    )
    import_comment_related.add_argument("--db", required=True, type=Path)
    import_comment_related.add_argument("--csv", required=True, type=Path)
    import_comment_related.add_argument("--source-version", required=True)
    import_comment_related.add_argument("--published-at")
    import_comment_related.add_argument("--url")
    import_comment_related.add_argument("--encoding", default="cp932")
    import_comment_related.add_argument("--retrieved-at")
    import_comment_related.set_defaults(func=_import_comment_links)

    import_electronic = subparsers.add_parser(
        "import-electronic-fee-table",
        help="Import the official medical electronic fee table CSV files",
    )
    import_electronic.add_argument("--db", required=True, type=Path)
    import_electronic.add_argument("--source-version", required=True)
    import_electronic.add_argument("--published-at")
    import_electronic.add_argument("--url")
    import_electronic.add_argument("--encoding", default="cp932")
    import_electronic.add_argument("--retrieved-at")
    import_electronic.add_argument("--aux-master", type=Path)
    import_electronic.add_argument("--bundles", type=Path)
    import_electronic.add_argument("--exclusions-day", type=Path)
    import_electronic.add_argument("--exclusions-month", type=Path)
    import_electronic.add_argument("--exclusions-simultaneous", type=Path)
    import_electronic.add_argument("--exclusions-week", type=Path)
    import_electronic.add_argument("--inpatient-basic", type=Path)
    import_electronic.add_argument("--frequency-limits", type=Path)
    import_electronic.set_defaults(func=_import_electronic_fee_table)

    import_dpc_electronic = subparsers.add_parser(
        "import-dpc-electronic-table",
        help="Import a DPC electronic fee table XLSX as traceable raw rows and core normalized tables",
    )
    import_dpc_electronic.add_argument("--db", required=True, type=Path)
    import_dpc_electronic.add_argument("--xlsx", required=True, type=Path)
    import_dpc_electronic.add_argument("--source-version", required=True)
    import_dpc_electronic.add_argument("--published-at")
    import_dpc_electronic.add_argument("--url")
    import_dpc_electronic.add_argument("--retrieved-at")
    import_dpc_electronic.set_defaults(func=_import_dpc_electronic_table)

    import_dpc_coefficients = subparsers.add_parser(
        "import-dpc-hospital-coefficients",
        help="Import audited CSV/TSV extracted from the official DPC hospital coefficient notice",
    )
    import_dpc_coefficients.add_argument("--db", required=True, type=Path)
    import_dpc_coefficients.add_argument("--csv", required=True, type=Path)
    import_dpc_coefficients.add_argument("--source-version", required=True)
    import_dpc_coefficients.add_argument("--published-at")
    import_dpc_coefficients.add_argument("--url")
    import_dpc_coefficients.add_argument("--encoding", default="utf-8-sig")
    import_dpc_coefficients.add_argument("--retrieved-at")
    import_dpc_coefficients.set_defaults(func=_import_dpc_hospital_coefficients)

    extract_dpc_coefficients = subparsers.add_parser(
        "extract-dpc-hospital-coefficients",
        help="Extract DPC hospital coefficient rows from the official notice PDF or extracted text",
    )
    extract_dpc_coefficients.add_argument("--pdf", type=Path)
    extract_dpc_coefficients.add_argument("--text", type=Path)
    extract_dpc_coefficients.add_argument("--output", required=True, type=Path)
    extract_dpc_coefficients.add_argument("--report-output", type=Path)
    extract_dpc_coefficients.add_argument("--encoding", default="utf-8")
    extract_dpc_coefficients.add_argument("--effective-from", default="2026-06-01")
    extract_dpc_coefficients.add_argument("--effective-to", default="9999-12-31")
    extract_dpc_coefficients.set_defaults(func=_extract_dpc_hospital_coefficients)

    audit_dpc_coefficients = subparsers.add_parser(
        "audit-dpc-hospital-coefficients",
        help="Classify DPC hospital coefficient rows by registry match status",
    )
    audit_dpc_coefficients.add_argument("--db", required=True, type=Path)
    audit_dpc_coefficients.add_argument("--source-id", type=int)
    audit_dpc_coefficients.add_argument(
        "--format",
        choices=("markdown", "json", "csv", "tsv"),
        default="markdown",
    )
    audit_dpc_coefficients.add_argument("--output", type=Path)
    audit_dpc_coefficients.add_argument(
        "--include-matched",
        action="store_true",
        help="Include exact matches in markdown row detail",
    )
    audit_dpc_coefficients.set_defaults(func=_audit_dpc_hospital_coefficients)

    plan_dpc_coefficient_fixes = subparsers.add_parser(
        "plan-dpc-hospital-coefficient-fixes",
        help="Build a review/action plan for DPC coefficient rows not safely connected to registry",
    )
    plan_dpc_coefficient_fixes.add_argument("--db", required=True, type=Path)
    plan_dpc_coefficient_fixes.add_argument("--source-id", type=int)
    plan_dpc_coefficient_fixes.add_argument(
        "--format",
        choices=("markdown", "json", "csv", "tsv"),
        default="markdown",
    )
    plan_dpc_coefficient_fixes.add_argument("--output", type=Path)
    plan_dpc_coefficient_fixes.add_argument(
        "--include-connected",
        action="store_true",
        help="Include already connected exact matches in the fix plan",
    )
    plan_dpc_coefficient_fixes.set_defaults(func=_plan_dpc_hospital_coefficient_fixes)

    import_hokkaido_registry = subparsers.add_parser(
        "import-hokkaido-hospital-registry",
        help="Import Hokkaido Regional Bureau hospital registry Excel",
    )
    import_hokkaido_registry.add_argument("--db", required=True, type=Path)
    import_hokkaido_registry.add_argument("--xlsx", required=True, type=Path)
    import_hokkaido_registry.add_argument("--source-version", required=True)
    import_hokkaido_registry.add_argument("--published-at")
    import_hokkaido_registry.add_argument("--url")
    import_hokkaido_registry.add_argument("--retrieved-at")
    import_hokkaido_registry.set_defaults(func=_import_hokkaido_hospital_registry)

    import_regional_registry = subparsers.add_parser(
        "import-regional-hospital-registry",
        help="Import a Regional Bureau hospital registry Excel matching the normalized workbook layout",
    )
    import_regional_registry.add_argument("--db", required=True, type=Path)
    import_regional_registry.add_argument("--xlsx", required=True, type=Path)
    import_regional_registry.add_argument("--regional-bureau", required=True, choices=sorted(REGIONAL_BUREAUS))
    import_regional_registry.add_argument("--source-version", required=True)
    import_regional_registry.add_argument("--published-at")
    import_regional_registry.add_argument("--url")
    import_regional_registry.add_argument("--retrieved-at")
    import_regional_registry.set_defaults(func=_import_regional_hospital_registry)

    import_hokkaido_facility = subparsers.add_parser(
        "import-hokkaido-facility-standards",
        help="Import Hokkaido Regional Bureau medical facility standards Excel",
    )
    import_hokkaido_facility.add_argument("--db", required=True, type=Path)
    import_hokkaido_facility.add_argument("--xlsx", required=True, type=Path)
    import_hokkaido_facility.add_argument("--source-version", required=True)
    import_hokkaido_facility.add_argument("--published-at")
    import_hokkaido_facility.add_argument("--url")
    import_hokkaido_facility.add_argument("--retrieved-at")
    import_hokkaido_facility.set_defaults(func=_import_hokkaido_facility_standards)

    import_regional_facility = subparsers.add_parser(
        "import-regional-facility-standards",
        help="Import Regional Bureau medical facility standards Excel matching the normalized workbook layout",
    )
    import_regional_facility.add_argument("--db", required=True, type=Path)
    import_regional_facility.add_argument("--xlsx", required=True, type=Path)
    import_regional_facility.add_argument("--regional-bureau", required=True, choices=sorted(REGIONAL_BUREAUS))
    import_regional_facility.add_argument("--source-version", required=True)
    import_regional_facility.add_argument("--published-at")
    import_regional_facility.add_argument("--url")
    import_regional_facility.add_argument("--retrieved-at")
    import_regional_facility.set_defaults(func=_import_regional_facility_standards)

    import_manifest = subparsers.add_parser(
        "import-regional-manifest",
        help="Import Regional Bureau hospital registry/facility standard files from a JSON manifest",
    )
    import_manifest.add_argument("--db", required=True, type=Path)
    import_manifest.add_argument("--manifest", required=True, type=Path)
    import_manifest.set_defaults(func=_import_regional_manifest)

    validate_regional = subparsers.add_parser(
        "validate-regional-manifest",
        help="Validate Regional Bureau manifest coverage and local file paths before import",
    )
    validate_regional.add_argument("--manifest", required=True, type=Path)
    validate_regional.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    validate_regional.add_argument("--output", type=Path)
    validate_regional.add_argument("--fail-on-error", action="store_true")
    validate_regional.set_defaults(func=_validate_regional_manifest)

    build_standard = subparsers.add_parser(
        "build-standard-master-db",
        help="Build a SQLite DB from a standard official master manifest",
    )
    build_standard.add_argument("--db", required=True, type=Path)
    build_standard.add_argument("--manifest", required=True, type=Path)
    build_standard.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    build_standard.add_argument("--output", type=Path)
    build_standard.add_argument("--fail-on-error", action="store_true")
    build_standard.add_argument(
        "--stop-on-error",
        action="store_true",
        help="Stop immediately instead of reporting later manifest entries",
    )
    build_standard.set_defaults(func=_build_standard_master_db)

    prepare_standard = subparsers.add_parser(
        "prepare-standard-master-build-manifest",
        help="Extract local official master ZIP files and generate a standard build manifest",
    )
    prepare_standard.add_argument("--raw-root", required=True, type=Path)
    prepare_standard.add_argument("--source-version", required=True)
    prepare_standard.add_argument("--published-at")
    prepare_standard.add_argument("--retrieved-at")
    prepare_standard.add_argument("--regional-manifest", type=Path)
    prepare_standard.add_argument("--format", choices=("json", "markdown"), default="json")
    prepare_standard.add_argument("--output", type=Path)
    prepare_standard.add_argument(
        "--no-extract-archives",
        action="store_true",
        help="Only scan existing CSV files; do not extract ZIP archives",
    )
    prepare_standard.add_argument("--overwrite-extracted", action="store_true")
    prepare_standard.add_argument("--zip-metadata-encoding", default="cp932")
    prepare_standard.add_argument("--fail-on-missing", action="store_true")
    prepare_standard.set_defaults(func=_prepare_standard_master_build_manifest)

    validate_standard = subparsers.add_parser(
        "validate-standard-master-build-manifest",
        help="Validate a standard official master manifest before building the SQLite DB",
    )
    validate_standard.add_argument("--manifest", required=True, type=Path)
    validate_standard.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    validate_standard.add_argument("--output", type=Path)
    validate_standard.add_argument("--fail-on-error", action="store_true")
    validate_standard.set_defaults(func=_validate_standard_master_build_manifest)

    download_ssk = subparsers.add_parser(
        "download-ssk-master-catalog",
        help="Download official SSK master ZIP/CSV files from a URL catalog and prepare a build manifest",
    )
    download_ssk.add_argument("--catalog", required=True, type=Path)
    download_ssk.add_argument("--raw-root", required=True, type=Path)
    download_ssk.add_argument("--source-version")
    download_ssk.add_argument("--published-at")
    download_ssk.add_argument("--retrieved-at")
    download_ssk.add_argument("--regional-manifest", type=Path)
    download_ssk.add_argument("--format", choices=("json", "markdown", "manifest"), default="markdown")
    download_ssk.add_argument("--output", type=Path)
    download_ssk.add_argument("--standard-manifest-output", type=Path)
    download_ssk.add_argument("--no-prepare-manifest", action="store_true")
    download_ssk.add_argument("--overwrite", action="store_true")
    download_ssk.add_argument("--timeout", type=float, default=30.0)
    download_ssk.add_argument("--fail-on-error", action="store_true")
    download_ssk.add_argument("--fail-on-missing", action="store_true")
    download_ssk.set_defaults(func=_download_ssk_master_catalog)

    discover_ssk = subparsers.add_parser(
        "discover-ssk-master-catalog",
        help="Discover official SSK master download URLs from the official SSK source pages",
    )
    discover_ssk.add_argument("--source-version")
    discover_ssk.add_argument("--page-encoding", default="utf-8")
    discover_ssk.add_argument("--timeout", type=float, default=30.0)
    discover_ssk.add_argument("--format", choices=("catalog", "json", "markdown"), default="catalog")
    discover_ssk.add_argument("--output", type=Path)
    discover_ssk.add_argument("--fail-on-warning", action="store_true")
    discover_ssk.set_defaults(func=_discover_ssk_master_catalog)

    diff_ssk = subparsers.add_parser(
        "diff-ssk-master-catalog",
        help="Compare two SSK master URL catalogs and report monthly changes",
    )
    diff_ssk.add_argument("--old", required=True, type=Path)
    diff_ssk.add_argument("--new", required=True, type=Path)
    diff_ssk.add_argument("--format", choices=("json", "markdown"), default="markdown")
    diff_ssk.add_argument("--output", type=Path)
    diff_ssk.add_argument("--fail-on-change", action="store_true")
    diff_ssk.set_defaults(func=_diff_ssk_master_catalog)

    validate_sources = subparsers.add_parser(
        "validate-official-source-catalog",
        help="Validate Step10 official source catalog coverage for DPC and receipt specs",
    )
    validate_sources.add_argument("--catalog", required=True, type=Path)
    validate_sources.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    validate_sources.add_argument("--output", type=Path)
    validate_sources.add_argument("--fail-on-error", action="store_true")
    validate_sources.set_defaults(func=_validate_official_source_catalog)

    inventory_dpc = subparsers.add_parser(
        "inventory-dpc-electronic-table",
        help="Inventory DPC electronic fee table XLSX sheets before raw import",
    )
    inventory_dpc.add_argument("--xlsx", action="append", type=Path)
    inventory_dpc.add_argument("--catalog", type=Path)
    inventory_dpc.add_argument("--raw-root", type=Path)
    inventory_dpc.add_argument("--source-version")
    inventory_dpc.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    inventory_dpc.add_argument("--output", type=Path)
    inventory_dpc.add_argument("--fail-on-missing", action="store_true")
    inventory_dpc.set_defaults(func=_inventory_dpc_electronic_table)

    smoke_manifest = subparsers.add_parser(
        "smoke-regional-manifest",
        help="Import each Regional Bureau manifest entry and report per-entry success/failure",
    )
    smoke_manifest.add_argument("--db", required=True, type=Path)
    smoke_manifest.add_argument("--manifest", required=True, type=Path)
    smoke_manifest.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    smoke_manifest.add_argument("--fail-on-error", action="store_true")
    smoke_manifest.set_defaults(func=_smoke_regional_manifest)

    summarize_registry = subparsers.add_parser(
        "summarize-hospital-registry",
        help="Summarize hospital registry rows and facility-standard coverage by Regional Bureau",
    )
    summarize_registry.add_argument("--db", required=True, type=Path)
    summarize_registry.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    summarize_registry.set_defaults(func=_summarize_hospital_registry)

    unmatched_hospitals = subparsers.add_parser(
        "list-unmatched-active-hospitals",
        help="List active hospitals without matching facility standards",
    )
    unmatched_hospitals.add_argument("--db", required=True, type=Path)
    unmatched_hospitals.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    unmatched_hospitals.set_defaults(func=_list_unmatched_active_hospitals)

    summarize_targets = subparsers.add_parser(
        "summarize-hospital-run-targets",
        help="Summarize active hospitals included/excluded from the default nationwide run",
    )
    summarize_targets.add_argument("--db", required=True, type=Path)
    summarize_targets.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    summarize_targets.set_defaults(func=_summarize_hospital_run_targets)

    list_targets = subparsers.add_parser(
        "list-hospital-run-targets",
        help="List active hospitals selected for the default nationwide run",
    )
    list_targets.add_argument("--db", required=True, type=Path)
    list_targets.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    list_targets.add_argument(
        "--include-excluded",
        action="store_true",
        help="Also list active hospitals excluded from the default nationwide run",
    )
    list_targets.set_defaults(func=_list_hospital_run_targets)

    smoke_targets = subparsers.add_parser(
        "smoke-hospital-run-targets",
        help="Resolve hospital profiles for default nationwide run targets and report mismatches",
    )
    smoke_targets.add_argument("--db", required=True, type=Path)
    smoke_targets.add_argument("--service-date", required=True)
    smoke_targets.add_argument("--format", choices=("tsv", "json", "markdown"), default="markdown")
    smoke_targets.add_argument(
        "--include-excluded",
        action="store_true",
        help="Also smoke hospitals excluded from the default nationwide run",
    )
    smoke_targets.add_argument("--fail-on-error", action="store_true")
    smoke_targets.set_defaults(func=_smoke_hospital_run_targets)

    export_contexts = subparsers.add_parser(
        "export-hospital-claim-contexts",
        help="Export ClaimContext templates for hospital run targets",
    )
    export_contexts.add_argument("--db", required=True, type=Path)
    export_contexts.add_argument("--service-date", required=True)
    export_contexts.add_argument("--format", choices=("jsonl", "json", "tsv", "markdown"), default="jsonl")
    export_contexts.add_argument(
        "--include-excluded",
        action="store_true",
        help="Also export hospitals excluded from the default nationwide run",
    )
    export_contexts.add_argument(
        "--inpatient",
        action="store_true",
        help="Mark generated encounter templates as inpatient instead of outpatient",
    )
    export_contexts.add_argument("--limit", type=int)
    export_contexts.add_argument("--output", type=Path)
    export_contexts.set_defaults(func=_export_hospital_claim_contexts)

    _add_outpatient_claim_batch_parser(
        subparsers,
        "run-outpatient-claim-batch",
        help_text="Run outpatient claim calculation for real-order ClaimContext JSONL input",
    )
    _add_outpatient_claim_batch_parser(
        subparsers,
        "run-inpatient-claim-batch",
        help_text="Run inpatient claim calculation for real-order ClaimContext JSONL input",
    )
    _add_outpatient_claim_batch_parser(
        subparsers,
        "run-outpatient-lab-claim-batch",
        help_text=(
            "Run outpatient lab claim calculation for real-order ClaimContext JSONL input "
            "(legacy alias)"
        ),
    )

    _add_gold_claim_batch_parser(
        subparsers,
        "evaluate-gold-claim-batch",
        help_text="Run outpatient claim calculation and compare with gold labels",
    )
    _add_gold_claim_batch_parser(
        subparsers,
        "evaluate-gold-inpatient-claim-batch",
        help_text="Run inpatient claim calculation and compare with gold labels",
    )
    _add_gold_claim_batch_parser(
        subparsers,
        "evaluate-gold-outpatient-lab-claim-batch",
        help_text=(
            "Run outpatient lab claim calculation and compare with gold labels "
            "(legacy alias)"
        ),
    )

    run_nationwide_smoke = subparsers.add_parser(
        "run-nationwide-outpatient-lab-smoke",
        help="Run a representative outpatient lab claim against every hospital run target",
    )
    run_nationwide_smoke.add_argument("--db", required=True, type=Path)
    run_nationwide_smoke.add_argument("--service-date", required=True)
    run_nationwide_smoke.add_argument(
        "--procedure-code",
        action="append",
        help=(
            "Procedure code to inject. Defaults to "
            + ",".join(DEFAULT_NATIONWIDE_LAB_SMOKE_PROCEDURE_CODES)
        ),
    )
    run_nationwide_smoke.add_argument("--collection-fee-input", action="append")
    run_nationwide_smoke.add_argument("--comment-code", action="append")
    run_nationwide_smoke.add_argument("--comment-text", action="append")
    run_nationwide_smoke.add_argument(
        "--lab-management-facility-missing-policy",
        choices=("ignore", "review"),
        default="ignore",
        help=(
            "How to handle missing facility standards for lab management fees. "
            "Default ignore treats it as a normal non-candidate; review emits a blocked message."
        ),
    )
    run_nationwide_smoke.add_argument(
        "--include-excluded",
        action="store_true",
        help="Also run hospitals excluded from the default nationwide medical run",
    )
    run_nationwide_smoke.add_argument("--format", choices=("jsonl", "json", "tsv", "markdown"), default="markdown")
    run_nationwide_smoke.add_argument("--output", type=Path)
    run_nationwide_smoke.add_argument("--audit-output", type=Path)
    run_nationwide_smoke.add_argument("--audit-format", choices=("csv", "json", "tsv"), default="csv")
    run_nationwide_smoke.add_argument("--limit", type=int)
    run_nationwide_smoke.add_argument("--fail-on-error", action="store_true")
    run_nationwide_smoke.add_argument("--fail-on-review", action="store_true")
    run_nationwide_smoke.add_argument(
        "--no-auto-master-sources",
        action="store_true",
        help="Do not fill missing source IDs from the latest imported DB master sources",
    )
    run_nationwide_smoke.add_argument("--medical-procedure-source-id", type=int)
    run_nationwide_smoke.add_argument("--drug-source-id", type=int)
    run_nationwide_smoke.add_argument("--material-source-id", type=int)
    run_nationwide_smoke.add_argument("--electronic-fee-source-id", type=int)
    run_nationwide_smoke.add_argument("--comment-source-id", type=int)
    run_nationwide_smoke.add_argument("--registry-source-id", type=int)
    run_nationwide_smoke.add_argument("--facility-source-id", type=int)
    run_nationwide_smoke.set_defaults(func=_run_nationwide_outpatient_lab_smoke)

    convert_order_csv = subparsers.add_parser(
        "convert-order-csv-to-claim-jsonl",
        help="Convert generic real-order CSV rows into ClaimContext JSONL input",
    )
    convert_order_csv.add_argument("--csv", required=True, type=Path)
    convert_order_csv.add_argument("--template-jsonl", type=Path)
    convert_order_csv.add_argument("--column-map", type=Path)
    convert_order_csv.add_argument(
        "--column-map-preset",
        choices=list_order_csv_column_map_presets(),
    )
    convert_order_csv.add_argument("--encoding", default="utf-8")
    convert_order_csv.add_argument("--format", choices=("jsonl", "json", "markdown"), default="jsonl")
    convert_order_csv.add_argument("--output", type=Path)
    convert_order_csv.add_argument("--fail-on-warning", action="store_true")
    convert_order_csv.set_defaults(func=_convert_order_csv_to_claim_jsonl)

    profile_order_csv = subparsers.add_parser(
        "profile-order-csv-columns",
        help="Inspect real-order CSV columns before converting them into ClaimContext JSONL",
    )
    profile_order_csv.add_argument("--csv", required=True, type=Path)
    profile_order_csv.add_argument("--column-map", type=Path)
    profile_order_csv.add_argument(
        "--column-map-preset",
        choices=list_order_csv_column_map_presets(),
    )
    profile_order_csv.add_argument("--encoding", default="utf-8")
    profile_order_csv.add_argument("--format", choices=("markdown", "json"), default="markdown")
    profile_order_csv.add_argument("--output", type=Path)
    profile_order_csv.add_argument("--fail-on-warning", action="store_true")
    profile_order_csv.set_defaults(func=_profile_order_csv_columns)

    validate_order_csv_contract = subparsers.add_parser(
        "validate-order-csv-contract",
        help="Validate real-order CSV columns against a hospital-specific mapping contract",
    )
    validate_order_csv_contract.add_argument("--csv", required=True, type=Path)
    validate_order_csv_contract.add_argument("--contract", required=True, type=Path)
    validate_order_csv_contract.add_argument("--column-map", type=Path)
    validate_order_csv_contract.add_argument(
        "--column-map-preset",
        choices=list_order_csv_column_map_presets(),
    )
    validate_order_csv_contract.add_argument("--encoding")
    validate_order_csv_contract.add_argument("--format", choices=("markdown", "json"), default="markdown")
    validate_order_csv_contract.add_argument("--output", type=Path)
    validate_order_csv_contract.add_argument("--fail-on-error", action="store_true")
    validate_order_csv_contract.set_defaults(func=_validate_order_csv_contract)

    generate_order_csv_contract = subparsers.add_parser(
        "generate-order-csv-contract-template",
        help="Generate a hospital order CSV mapping contract template from observed CSV columns",
    )
    generate_order_csv_contract.add_argument("--csv", required=True, type=Path)
    generate_order_csv_contract.add_argument("--column-map", type=Path)
    generate_order_csv_contract.add_argument(
        "--column-map-preset",
        choices=list_order_csv_column_map_presets(),
    )
    generate_order_csv_contract.add_argument("--encoding", default="utf-8")
    generate_order_csv_contract.add_argument("--contract-id")
    generate_order_csv_contract.add_argument("--hospital-name")
    generate_order_csv_contract.add_argument("--regional-bureau")
    generate_order_csv_contract.add_argument("--medical-institution-code")
    generate_order_csv_contract.add_argument("--require-gold-labels", action="store_true")
    generate_order_csv_contract.add_argument(
        "--strict-unmapped",
        action="store_true",
        help="Do not copy currently unmapped CSV columns into allowed_unmapped_columns",
    )
    generate_order_csv_contract.add_argument("--minimum-row-count", type=int, default=1)
    generate_order_csv_contract.add_argument("--output", type=Path)
    generate_order_csv_contract.set_defaults(func=_generate_order_csv_contract_template)

    run_order_csv_pipeline = subparsers.add_parser(
        "run-order-csv-claim-pipeline",
        help="Profile, validate, convert, run outpatient claim batch, and optionally evaluate gold labels",
    )
    run_order_csv_pipeline.add_argument("--db", required=True, type=Path)
    run_order_csv_pipeline.add_argument("--csv", required=True, type=Path)
    run_order_csv_pipeline.add_argument("--contract", type=Path)
    run_order_csv_pipeline.add_argument("--template-jsonl", type=Path)
    run_order_csv_pipeline.add_argument("--column-map", type=Path)
    run_order_csv_pipeline.add_argument(
        "--column-map-preset",
        choices=list_order_csv_column_map_presets(),
    )
    run_order_csv_pipeline.add_argument("--encoding")
    run_order_csv_pipeline.add_argument("--profile-output", type=Path)
    run_order_csv_pipeline.add_argument(
        "--profile-format",
        choices=("markdown", "json"),
        default="markdown",
    )
    run_order_csv_pipeline.add_argument("--contract-output", type=Path)
    run_order_csv_pipeline.add_argument(
        "--contract-format",
        choices=("markdown", "json"),
        default="markdown",
    )
    run_order_csv_pipeline.add_argument("--converted-output", type=Path)
    run_order_csv_pipeline.add_argument("--conversion-report-output", type=Path)
    run_order_csv_pipeline.add_argument(
        "--format",
        choices=("jsonl", "json", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline.add_argument("--output", type=Path)
    run_order_csv_pipeline.add_argument("--audit-output", type=Path)
    run_order_csv_pipeline.add_argument("--audit-format", choices=("csv", "json", "tsv"), default="csv")
    run_order_csv_pipeline.add_argument("--evaluate-gold", action="store_true")
    run_order_csv_pipeline.add_argument("--gold-output", type=Path)
    run_order_csv_pipeline.add_argument(
        "--gold-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline.add_argument("--gold-classification-output", type=Path)
    run_order_csv_pipeline.add_argument(
        "--gold-classification-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline.add_argument("--gold-backlog-output", type=Path)
    run_order_csv_pipeline.add_argument(
        "--gold-backlog-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline.add_argument("--gold-action-plan-output", type=Path)
    run_order_csv_pipeline.add_argument(
        "--gold-action-plan-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline.add_argument("--point-tolerance", type=float, default=0.001)
    run_order_csv_pipeline.add_argument("--limit", type=int)
    run_order_csv_pipeline.add_argument("--fail-on-contract-error", action="store_true")
    run_order_csv_pipeline.add_argument("--fail-on-warning", action="store_true")
    run_order_csv_pipeline.add_argument("--fail-on-error", action="store_true")
    run_order_csv_pipeline.add_argument("--fail-on-review", action="store_true")
    run_order_csv_pipeline.add_argument("--fail-on-mismatch", action="store_true")
    run_order_csv_pipeline.add_argument(
        "--no-auto-master-sources",
        action="store_true",
        help="Do not fill missing source IDs from the latest imported DB master sources",
    )
    run_order_csv_pipeline.add_argument("--medical-procedure-source-id", type=int)
    run_order_csv_pipeline.add_argument("--drug-source-id", type=int)
    run_order_csv_pipeline.add_argument("--material-source-id", type=int)
    run_order_csv_pipeline.add_argument("--electronic-fee-source-id", type=int)
    run_order_csv_pipeline.add_argument("--comment-source-id", type=int)
    run_order_csv_pipeline.add_argument("--registry-source-id", type=int)
    run_order_csv_pipeline.add_argument("--facility-source-id", type=int)
    run_order_csv_pipeline.set_defaults(func=_run_order_csv_claim_pipeline)

    validate_order_csv_pipeline_manifest = subparsers.add_parser(
        "validate-order-csv-pipeline-manifest",
        help="Validate order CSV pipeline manifest entries before running a multi-hospital batch",
    )
    validate_order_csv_pipeline_manifest.add_argument("--manifest", required=True, type=Path)
    validate_order_csv_pipeline_manifest.add_argument("--template-jsonl", type=Path)
    validate_order_csv_pipeline_manifest.add_argument("--column-map", type=Path)
    validate_order_csv_pipeline_manifest.add_argument(
        "--column-map-preset",
        choices=list_order_csv_column_map_presets(),
    )
    validate_order_csv_pipeline_manifest.add_argument("--encoding")
    validate_order_csv_pipeline_manifest.add_argument(
        "--format",
        choices=("markdown", "json", "csv", "tsv"),
        default="markdown",
    )
    validate_order_csv_pipeline_manifest.add_argument("--output", type=Path)
    validate_order_csv_pipeline_manifest.add_argument("--evaluate-gold", action="store_true")
    validate_order_csv_pipeline_manifest.add_argument("--require-gold-labels", action="store_true")
    validate_order_csv_pipeline_manifest.add_argument("--require-template-jsonl", action="store_true")
    validate_order_csv_pipeline_manifest.add_argument("--fail-on-error", action="store_true")
    validate_order_csv_pipeline_manifest.add_argument("--fail-on-warning", action="store_true")
    validate_order_csv_pipeline_manifest.set_defaults(func=_validate_order_csv_pipeline_manifest)

    run_order_csv_pipeline_batch = subparsers.add_parser(
        "run-order-csv-claim-pipeline-batch",
        help="Run the order CSV claim pipeline for multiple hospitals from a manifest",
    )
    run_order_csv_pipeline_batch.add_argument("--db", required=True, type=Path)
    run_order_csv_pipeline_batch.add_argument("--manifest", required=True, type=Path)
    run_order_csv_pipeline_batch.add_argument("--output-root", required=True, type=Path)
    run_order_csv_pipeline_batch.add_argument("--template-jsonl", type=Path)
    run_order_csv_pipeline_batch.add_argument("--column-map", type=Path)
    run_order_csv_pipeline_batch.add_argument(
        "--column-map-preset",
        choices=list_order_csv_column_map_presets(),
    )
    run_order_csv_pipeline_batch.add_argument("--encoding")
    run_order_csv_pipeline_batch.add_argument(
        "--profile-format",
        choices=("markdown", "json"),
        default="markdown",
    )
    run_order_csv_pipeline_batch.add_argument(
        "--contract-format",
        choices=("markdown", "json"),
        default="markdown",
    )
    run_order_csv_pipeline_batch.add_argument(
        "--format",
        choices=("jsonl", "json", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline_batch.add_argument("--audit-format", choices=("csv", "json", "tsv"), default="csv")
    run_order_csv_pipeline_batch.add_argument("--evaluate-gold", action="store_true")
    run_order_csv_pipeline_batch.add_argument(
        "--gold-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline_batch.add_argument(
        "--gold-classification-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline_batch.add_argument(
        "--gold-backlog-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline_batch.add_argument(
        "--gold-action-plan-format",
        choices=("jsonl", "json", "csv", "tsv", "markdown"),
        default="markdown",
    )
    run_order_csv_pipeline_batch.add_argument(
        "--summary-format",
        choices=("markdown", "json", "csv", "tsv"),
        default="markdown",
    )
    run_order_csv_pipeline_batch.add_argument("--output", type=Path)
    run_order_csv_pipeline_batch.add_argument("--review-index-output", type=Path)
    run_order_csv_pipeline_batch.add_argument(
        "--review-index-format",
        choices=("markdown", "json"),
        default="markdown",
    )
    run_order_csv_pipeline_batch.add_argument("--point-tolerance", type=float, default=0.001)
    run_order_csv_pipeline_batch.add_argument("--limit", type=int)
    run_order_csv_pipeline_batch.add_argument("--fail-on-contract-error", action="store_true")
    run_order_csv_pipeline_batch.add_argument("--fail-on-warning", action="store_true")
    run_order_csv_pipeline_batch.add_argument("--fail-on-error", action="store_true")
    run_order_csv_pipeline_batch.add_argument("--fail-on-review", action="store_true")
    run_order_csv_pipeline_batch.add_argument("--fail-on-mismatch", action="store_true")
    run_order_csv_pipeline_batch.add_argument(
        "--fail-on-batch-error",
        action="store_true",
        help="Exit nonzero when any entry fails the selected batch gates or raises an entry-local error",
    )
    run_order_csv_pipeline_batch.add_argument(
        "--no-auto-master-sources",
        action="store_true",
        help="Do not fill missing source IDs from the latest imported DB master sources",
    )
    run_order_csv_pipeline_batch.add_argument("--medical-procedure-source-id", type=int)
    run_order_csv_pipeline_batch.add_argument("--drug-source-id", type=int)
    run_order_csv_pipeline_batch.add_argument("--material-source-id", type=int)
    run_order_csv_pipeline_batch.add_argument("--electronic-fee-source-id", type=int)
    run_order_csv_pipeline_batch.add_argument("--comment-source-id", type=int)
    run_order_csv_pipeline_batch.add_argument("--registry-source-id", type=int)
    run_order_csv_pipeline_batch.add_argument("--facility-source-id", type=int)
    run_order_csv_pipeline_batch.set_defaults(func=_run_order_csv_claim_pipeline_batch)

    _add_order_csv_outpatient_claim_batch_parser(
        subparsers,
        "run-order-csv-outpatient-claim-batch",
        help_text="Convert real-order CSV rows and run outpatient claim calculation in one step",
    )
    _add_order_csv_outpatient_claim_batch_parser(
        subparsers,
        "run-order-csv-inpatient-claim-batch",
        help_text="Convert real-order CSV rows and run inpatient claim calculation in one step",
    )
    _add_order_csv_outpatient_claim_batch_parser(
        subparsers,
        "run-order-csv-outpatient-lab-batch",
        help_text=(
            "Convert real-order CSV rows and run outpatient lab claim calculation in one step "
            "(legacy alias)"
        ),
    )

    list_sources = subparsers.add_parser(
        "list-regional-source-pages",
        help="List official Regional Bureau source pages for hospital registry and facility standards",
    )
    list_sources.add_argument("--kind", choices=sorted(REGIONAL_SOURCE_KINDS))
    list_sources.set_defaults(func=_list_regional_source_pages)

    discover_sources = subparsers.add_parser(
        "discover-regional-source-files",
        help="Extract xlsx/zip/pdf links from a saved Regional Bureau HTML page",
    )
    discover_sources.add_argument("--html", required=True, type=Path)
    discover_sources.add_argument("--encoding", default="utf-8")
    discover_sources.add_argument("--regional-bureau", required=True, choices=sorted(REGIONAL_BUREAUS))
    discover_sources.add_argument("--kind", required=True, choices=sorted(REGIONAL_SOURCE_KINDS))
    discover_sources.add_argument("--page-url")
    discover_sources.add_argument("--format", choices=("tsv", "json", "manifest"), default="tsv")
    discover_sources.add_argument("--source-version")
    discover_sources.add_argument("--published-at")
    discover_sources.add_argument("--retrieved-at")
    discover_sources.add_argument("--raw-root", default="data/raw/kouseikyoku")
    discover_sources.add_argument("--recommended-only", action="store_true")
    discover_sources.add_argument("--manifest-output", type=Path)
    discover_sources.set_defaults(func=_discover_regional_source_files)

    download_sources = subparsers.add_parser(
        "download-regional-source-files",
        help="Download recommended Regional Bureau source files and emit a manifest",
    )
    download_sources.add_argument("--regional-bureau", required=True, choices=sorted(REGIONAL_BUREAUS))
    download_sources.add_argument("--kind", required=True, choices=sorted(REGIONAL_SOURCE_KINDS))
    download_sources.add_argument("--source-version", required=True)
    download_sources.add_argument("--raw-root", default="data/raw/kouseikyoku")
    download_sources.add_argument("--page-url")
    download_sources.add_argument("--page-encoding", default="utf-8")
    download_sources.add_argument("--published-at")
    download_sources.add_argument("--retrieved-at")
    download_sources.add_argument("--include-all-candidates", action="store_true")
    download_sources.add_argument("--overwrite", action="store_true")
    download_sources.add_argument("--timeout", type=float, default=30.0)
    download_sources.add_argument("--format", choices=("tsv", "json", "manifest"), default="manifest")
    download_sources.add_argument("--manifest-output", type=Path)
    download_sources.set_defaults(func=_download_regional_source_files)

    download_catalog = subparsers.add_parser(
        "download-regional-catalog",
        help="Download Regional Bureau source files from every catalog page and emit a combined manifest",
    )
    download_catalog.add_argument("--source-version", required=True)
    download_catalog.add_argument("--raw-root", default="data/raw/kouseikyoku")
    download_catalog.add_argument("--regional-bureau", action="append", choices=sorted(REGIONAL_BUREAUS))
    download_catalog.add_argument("--kind", action="append", choices=sorted(REGIONAL_SOURCE_KINDS))
    download_catalog.add_argument("--page-encoding", default="utf-8")
    download_catalog.add_argument("--published-at")
    download_catalog.add_argument("--retrieved-at")
    download_catalog.add_argument("--include-all-candidates", action="store_true")
    download_catalog.add_argument("--overwrite", action="store_true")
    download_catalog.add_argument("--timeout", type=float, default=30.0)
    download_catalog.add_argument("--format", choices=("tsv", "json", "manifest", "markdown"), default="markdown")
    download_catalog.add_argument("--manifest-output", type=Path)
    download_catalog.add_argument("--fail-on-error", action="store_true")
    download_catalog.set_defaults(func=_download_regional_catalog)

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
