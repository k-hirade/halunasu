#!/usr/bin/env python3
"""Verify, upload, or fetch an immutable fee white-box runtime artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence

from medical_fee_calculation.whitebox_artifacts import (
    WhiteboxArtifact,
    WhiteboxArtifactError,
    load_whitebox_artifact,
    sha256_file,
)


EXPECTED_TYPES = (
    "fee_context_classifier",
    "fee_master_linker",
    "fee_span_detector",
)
ARTIFACT_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class WhiteboxArtifactDistributionError(RuntimeError):
    """Raised when an artifact cannot be distributed without mutation."""


def verify_artifact(manifest_path: Path, *, expected_type: str) -> WhiteboxArtifact:
    manifest = _read_manifest(manifest_path)
    logical_names = tuple(sorted(_manifest_files(manifest)))
    return load_whitebox_artifact(
        manifest_path,
        expected_type=expected_type,
        required_files=logical_names,
    )


def immutable_remote_manifest_uri(
    artifact: WhiteboxArtifact,
    registry_uri: str,
) -> str:
    root = _normalize_gcs_uri(registry_uri).rstrip("/")
    artifact_version = _safe_artifact_version(artifact.artifact_version)
    return (
        f"{root}/{artifact.artifact_type}/{artifact_version}/"
        f"{artifact.manifest_path.name}"
    )


def upload_artifact(
    manifest_path: Path,
    *,
    expected_type: str,
    registry_uri: str,
    dry_run: bool,
) -> dict[str, Any]:
    artifact = verify_artifact(manifest_path, expected_type=expected_type)
    manifest_uri = immutable_remote_manifest_uri(artifact, registry_uri)
    base_uri = manifest_uri.rsplit("/", 1)[0]
    file_uploads = [
        {
            "logicalName": logical_name,
            "source": str(artifact.file_path(logical_name)),
            "destination": f"{base_uri}/{_artifact_relative_path(artifact, logical_name)}",
        }
        for logical_name in sorted(artifact.manifest["files"])
    ]
    result = {
        "status": "dry_run" if dry_run else "uploaded",
        "artifactType": artifact.artifact_type,
        "artifactVersion": artifact.artifact_version,
        "manifestSha256": sha256_file(artifact.manifest_path),
        "manifestUri": manifest_uri,
        "files": file_uploads,
    }
    if dry_run:
        return result

    remote_manifest = _gcloud_capture(
        ["gcloud", "storage", "cat", manifest_uri],
        allow_not_found=True,
    )
    if remote_manifest is not None:
        remote_sha = hashlib.sha256(remote_manifest).hexdigest()
        if remote_sha != result["manifestSha256"]:
            raise WhiteboxArtifactDistributionError(
                "immutable remote artifact version already has a different manifest"
            )
        result["status"] = "already_present"
        return result

    for item in file_uploads:
        _gcloud_run([
            "gcloud",
            "storage",
            "cp",
            "--if-generation-match=0",
            item["source"],
            item["destination"],
        ])
    _gcloud_run([
        "gcloud",
        "storage",
        "cp",
        "--if-generation-match=0",
        str(artifact.manifest_path),
        manifest_uri,
    ])
    return result


def fetch_artifact(
    manifest_uri: str,
    *,
    destination_manifest: Path,
    expected_type: str,
    dry_run: bool,
) -> dict[str, Any]:
    normalized_uri = _normalize_gcs_uri(manifest_uri)
    expected_version = _remote_artifact_version(
        normalized_uri,
        expected_type=expected_type,
    )
    result = {
        "status": "dry_run" if dry_run else "fetched",
        "artifactType": expected_type,
        "artifactVersion": expected_version,
        "manifestUri": normalized_uri,
        "destinationManifest": str(destination_manifest.expanduser().resolve()),
    }
    if dry_run:
        return result

    destination = destination_manifest.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{destination.parent.name}.download-",
        dir=destination.parent.parent,
    ) as temporary:
        download_root = Path(temporary)
        downloaded_manifest = download_root / destination.name
        remote_manifest = _gcloud_capture([
            "gcloud",
            "storage",
            "cat",
            normalized_uri,
        ], allow_not_found=False)
        if remote_manifest is None:
            raise WhiteboxArtifactDistributionError(
                f"remote artifact manifest is missing: {normalized_uri}"
            )
        downloaded_manifest.write_bytes(remote_manifest)
        manifest = _read_manifest(downloaded_manifest)
        if str(manifest.get("artifactVersion") or "").strip() != expected_version:
            raise WhiteboxArtifactDistributionError(
                "remote artifact URI version does not match the downloaded manifest"
            )
        if destination.exists():
            local_artifact = verify_artifact(
                destination,
                expected_type=expected_type,
            )
            if local_artifact.artifact_version != expected_version:
                raise WhiteboxArtifactDistributionError(
                    "destination artifact version differs from the remote artifact URI"
                )
            if sha256_file(destination) != sha256_file(downloaded_manifest):
                raise WhiteboxArtifactDistributionError(
                    "destination manifest differs from immutable remote manifest"
                )
            result.update({
                "status": "cached",
                "manifestSha256": sha256_file(destination),
                "fileCount": len(local_artifact.manifest["files"]),
            })
            return result
        base_uri = normalized_uri.rsplit("/", 1)[0]
        for logical_name, entry in sorted(_manifest_files(manifest).items()):
            relative_path = _safe_relative_path(entry.get("path"))
            target = download_root / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            _gcloud_run([
                "gcloud",
                "storage",
                "cp",
                f"{base_uri}/{relative_path.as_posix()}",
                str(target),
            ])
        downloaded = verify_artifact(
            downloaded_manifest,
            expected_type=expected_type,
        )
        install_artifact(downloaded, destination_manifest=destination)
        result.update({
            "manifestSha256": sha256_file(downloaded.manifest_path),
            "fileCount": len(downloaded.manifest["files"]),
        })
    return result


def install_artifact(
    downloaded: WhiteboxArtifact,
    *,
    destination_manifest: Path,
) -> None:
    destination = destination_manifest.expanduser().resolve()
    destination_root = destination.parent
    destination_root.mkdir(parents=True, exist_ok=True)

    downloaded_manifest_sha = sha256_file(downloaded.manifest_path)
    if destination.exists():
        if sha256_file(destination) != downloaded_manifest_sha:
            raise WhiteboxArtifactDistributionError(
                "destination manifest differs from immutable downloaded manifest"
            )

    for logical_name in sorted(downloaded.manifest["files"]):
        source = downloaded.file_path(logical_name)
        relative_path = _artifact_relative_path(downloaded, logical_name)
        target = destination_root / relative_path
        expected_sha = downloaded.manifest["files"][logical_name]["sha256"]
        if target.exists():
            if sha256_file(target) != expected_sha:
                raise WhiteboxArtifactDistributionError(
                    f"destination artifact file differs: {relative_path}"
                )
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary_target = target.with_name(f".{target.name}.partial-{os.getpid()}")
        try:
            shutil.copy2(source, temporary_target)
            if sha256_file(temporary_target) != expected_sha:
                raise WhiteboxArtifactDistributionError(
                    f"copied artifact checksum mismatch: {relative_path}"
                )
            os.replace(temporary_target, target)
        finally:
            temporary_target.unlink(missing_ok=True)

    if not destination.exists():
        temporary_manifest = destination.with_name(
            f".{destination.name}.partial-{os.getpid()}"
        )
        try:
            shutil.copy2(downloaded.manifest_path, temporary_manifest)
            if sha256_file(temporary_manifest) != downloaded_manifest_sha:
                raise WhiteboxArtifactDistributionError(
                    "copied artifact manifest checksum mismatch"
                )
            os.replace(temporary_manifest, destination)
        finally:
            temporary_manifest.unlink(missing_ok=True)

    verify_artifact(destination, expected_type=downloaded.artifact_type)


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.expanduser().read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise WhiteboxArtifactDistributionError(
            f"artifact manifest is missing: {path}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise WhiteboxArtifactDistributionError(
            f"artifact manifest is invalid JSON: {path}: {exc}"
        ) from exc
    if not isinstance(payload, dict):
        raise WhiteboxArtifactDistributionError("artifact manifest must be an object")
    return payload


def _manifest_files(manifest: Mapping[str, Any]) -> Mapping[str, Mapping[str, Any]]:
    files = manifest.get("files")
    if not isinstance(files, Mapping) or not files:
        raise WhiteboxArtifactDistributionError(
            "artifact manifest files must be a non-empty object"
        )
    for logical_name, entry in files.items():
        if not isinstance(logical_name, str) or not isinstance(entry, Mapping):
            raise WhiteboxArtifactDistributionError(
                "artifact manifest contains an invalid file entry"
            )
    return files


def _artifact_relative_path(
    artifact: WhiteboxArtifact,
    logical_name: str,
) -> PurePosixPath:
    entry = artifact.manifest["files"][logical_name]
    return _safe_relative_path(entry.get("path"))


def _safe_relative_path(value: Any) -> PurePosixPath:
    raw = str(value or "").strip()
    path = PurePosixPath(raw)
    if (
        not raw
        or path.is_absolute()
        or ".." in path.parts
        or "\\" in raw
    ):
        raise WhiteboxArtifactDistributionError(
            "artifact file path must stay under artifact root"
        )
    return path


def _normalize_gcs_uri(value: str) -> str:
    uri = str(value or "").strip()
    if (
        not uri.startswith("gs://")
        or uri == "gs://"
        or any(character.isspace() for character in uri)
        or ".." in PurePosixPath(uri.removeprefix("gs://")).parts
    ):
        raise WhiteboxArtifactDistributionError(
            "artifact registry location must be a safe gs:// URI"
        )
    return uri


def _remote_artifact_version(
    manifest_uri: str,
    *,
    expected_type: str,
) -> str:
    relative = PurePosixPath(manifest_uri.removeprefix("gs://"))
    manifest_filename = (
        "linker_manifest.json"
        if expected_type == "fee_master_linker"
        else "manifest.json"
    )
    if (
        len(relative.parts) < 4
        or relative.parts[-3] != expected_type
        or relative.parts[-1] != manifest_filename
    ):
        raise WhiteboxArtifactDistributionError(
            "artifact manifest URI must end with "
            f"{expected_type}/<version>/{manifest_filename}"
        )
    return _safe_artifact_version(relative.parts[-2])


def _safe_artifact_version(value: Any) -> str:
    version = str(value or "").strip()
    if not ARTIFACT_VERSION_PATTERN.fullmatch(version):
        raise WhiteboxArtifactDistributionError(
            "artifactVersion must contain only letters, digits, dot, underscore, or hyphen"
        )
    if version.lower() == "latest":
        raise WhiteboxArtifactDistributionError(
            "artifactVersion must be immutable and cannot be latest"
        )
    return version


def _gcloud_run(command: Sequence[str]) -> None:
    completed = subprocess.run(
        list(command),
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode:
        message = completed.stderr.strip() or completed.stdout.strip()
        raise WhiteboxArtifactDistributionError(
            f"gcloud artifact operation failed: {message}"
        )


def _gcloud_capture(
    command: Sequence[str],
    *,
    allow_not_found: bool,
) -> bytes | None:
    completed = subprocess.run(
        list(command),
        check=False,
        capture_output=True,
    )
    if completed.returncode == 0:
        return completed.stdout
    message = completed.stderr.decode("utf-8", errors="replace")
    if allow_not_found and any(
        marker in message.lower()
        for marker in (
            "not found",
            "no urls matched",
            "matched no objects or files",
            "404",
        )
    ):
        return None
    raise WhiteboxArtifactDistributionError(
        f"gcloud artifact lookup failed: {message.strip()}"
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--manifest", type=Path, required=True)
    verify_parser.add_argument("--expected-type", choices=EXPECTED_TYPES, required=True)

    upload_parser = subparsers.add_parser("upload")
    upload_parser.add_argument("--manifest", type=Path, required=True)
    upload_parser.add_argument("--expected-type", choices=EXPECTED_TYPES, required=True)
    upload_parser.add_argument("--registry-uri", required=True)
    upload_parser.add_argument("--dry-run", action="store_true")

    fetch_parser = subparsers.add_parser("fetch")
    fetch_parser.add_argument("--manifest-uri", required=True)
    fetch_parser.add_argument("--destination-manifest", type=Path, required=True)
    fetch_parser.add_argument("--expected-type", choices=EXPECTED_TYPES, required=True)
    fetch_parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.command == "verify":
            artifact = verify_artifact(
                args.manifest,
                expected_type=args.expected_type,
            )
            result = {
                "status": "verified",
                "artifactType": artifact.artifact_type,
                "artifactVersion": artifact.artifact_version,
                "manifestSha256": sha256_file(artifact.manifest_path),
                "fileCount": len(artifact.manifest["files"]),
            }
        elif args.command == "upload":
            result = upload_artifact(
                args.manifest,
                expected_type=args.expected_type,
                registry_uri=args.registry_uri,
                dry_run=args.dry_run,
            )
        else:
            result = fetch_artifact(
                args.manifest_uri,
                destination_manifest=args.destination_manifest,
                expected_type=args.expected_type,
                dry_run=args.dry_run,
            )
    except (
        WhiteboxArtifactDistributionError,
        WhiteboxArtifactError,
    ) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
