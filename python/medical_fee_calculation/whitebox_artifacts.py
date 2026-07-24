"""Versioned artifact loading for the white-box extraction layers.

The fee runtime treats model artifacts like fee masters: a missing or invalid
artifact disables only the proposal layer. It must never silently load a
partially-written model or index.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse


WHITEBOX_ARTIFACT_SCHEMA_VERSION = 1
WHITEBOX_ARTIFACT_LICENSE_FIELDS = (
    "modelId",
    "license",
    "verifiedAt",
    "sourceUrl",
)
NON_COMMERCIAL_LICENSE_MARKERS = (
    "by-nc",
    "noncommercial",
    "non-commercial",
    "research-only",
    "research only",
)


class WhiteboxArtifactError(ValueError):
    """Raised when a configured white-box artifact is incomplete or invalid."""


@dataclass(frozen=True)
class WhiteboxArtifact:
    root: Path
    manifest_path: Path
    manifest: dict[str, Any]

    @property
    def artifact_type(self) -> str:
        return str(self.manifest["artifactType"])

    @property
    def artifact_version(self) -> str:
        return str(self.manifest["artifactVersion"])

    @property
    def model_version(self) -> str:
        return str(self.manifest["modelVersion"])

    def file_path(self, logical_name: str) -> Path:
        files = self.manifest.get("files", {})
        entry = files.get(logical_name)
        if not isinstance(entry, Mapping):
            raise WhiteboxArtifactError(
                f"artifact file entry is missing: {logical_name}"
            )
        relative_path = _safe_relative_path(entry.get("path"))
        return self.root / relative_path


def load_whitebox_artifact(
    manifest_path: str | Path | None,
    *,
    expected_type: str,
    required_files: tuple[str, ...] = (),
) -> WhiteboxArtifact:
    if not manifest_path:
        raise WhiteboxArtifactError(f"{expected_type} manifest is not configured")
    path = Path(manifest_path).expanduser().resolve()
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise WhiteboxArtifactError(f"artifact manifest is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise WhiteboxArtifactError(
            f"artifact manifest is invalid JSON: {path}: {exc}"
        ) from exc
    if not isinstance(manifest, dict):
        raise WhiteboxArtifactError("artifact manifest must be an object")
    if manifest.get("schemaVersion") != WHITEBOX_ARTIFACT_SCHEMA_VERSION:
        raise WhiteboxArtifactError(
            "artifact schemaVersion does not match the runtime"
        )
    if manifest.get("artifactType") != expected_type:
        raise WhiteboxArtifactError(
            f"artifactType must be {expected_type!r}"
        )
    for field in ("artifactVersion", "modelVersion", "modelRevision", "backend"):
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            raise WhiteboxArtifactError(f"artifact manifest field is missing: {field}")
    validate_artifact_license(manifest)
    files = manifest.get("files")
    if not isinstance(files, dict):
        raise WhiteboxArtifactError("artifact manifest files must be an object")

    root = path.parent
    artifact = WhiteboxArtifact(root=root, manifest_path=path, manifest=manifest)
    validate_artifact_files(artifact, required_files)
    return artifact


def validate_artifact_license(manifest: Mapping[str, Any]) -> dict[str, str]:
    license_record = manifest.get("license")
    if not isinstance(license_record, Mapping):
        raise WhiteboxArtifactError(
            "artifact manifest license verification is required"
        )
    normalized: dict[str, str] = {}
    for field in WHITEBOX_ARTIFACT_LICENSE_FIELDS:
        value = license_record.get(field)
        if not isinstance(value, str) or not value.strip():
            raise WhiteboxArtifactError(
                f"artifact manifest license field is missing: {field}"
            )
        normalized[field] = value.strip()

    license_name = normalized["license"].lower().replace("_", "-")
    if license_name in {"unknown", "unverified", "none"} or any(
        marker in license_name
        for marker in NON_COMMERCIAL_LICENSE_MARKERS
    ):
        raise WhiteboxArtifactError(
            "artifact license is not approved for commercial runtime use"
        )

    try:
        verified_at = date.fromisoformat(normalized["verifiedAt"])
    except ValueError as exc:
        raise WhiteboxArtifactError(
            "artifact manifest license verifiedAt must be YYYY-MM-DD"
        ) from exc
    if verified_at > date.today():
        raise WhiteboxArtifactError(
            "artifact manifest license verifiedAt cannot be in the future"
        )

    source_url = urlparse(normalized["sourceUrl"])
    if source_url.scheme != "https" or not source_url.netloc:
        raise WhiteboxArtifactError(
            "artifact manifest license sourceUrl must be an HTTPS URL"
        )
    return normalized


def validate_artifact_files(
    artifact: WhiteboxArtifact,
    logical_names: tuple[str, ...] | list[str],
) -> None:
    files = artifact.manifest.get("files", {})
    for logical_name in logical_names:
        file_path = artifact.file_path(logical_name)
        entry = files[logical_name]
        expected_sha = str(entry.get("sha256") or "").strip().lower()
        if len(expected_sha) != 64:
            raise WhiteboxArtifactError(
                f"artifact file sha256 is invalid: {logical_name}"
            )
        try:
            actual_sha = sha256_file(file_path)
        except FileNotFoundError as exc:
            raise WhiteboxArtifactError(
                f"artifact file is missing: {file_path}"
            ) from exc
        if actual_sha != expected_sha:
            raise WhiteboxArtifactError(
                f"artifact file checksum mismatch: {logical_name}"
            )


def artifact_readiness(
    manifest_path: str | Path | None,
    *,
    expected_type: str,
    required_files: tuple[str, ...] = (),
) -> dict[str, Any]:
    try:
        artifact = load_whitebox_artifact(
            manifest_path,
            expected_type=expected_type,
            required_files=required_files,
        )
    except WhiteboxArtifactError as exc:
        return {
            "available": False,
            "artifactType": expected_type,
            "reason": str(exc),
        }
    return {
        "available": True,
        "artifactType": expected_type,
        "artifactVersion": artifact.artifact_version,
        "modelVersion": artifact.model_version,
        "modelRevision": artifact.manifest["modelRevision"],
        "backend": artifact.manifest["backend"],
        "license": validate_artifact_license(artifact.manifest),
        "manifestSha256": sha256_file(artifact.manifest_path),
    }


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative_path(value: Any) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise WhiteboxArtifactError("artifact file path is empty")
    path = Path(raw)
    if path.is_absolute() or ".." in path.parts:
        raise WhiteboxArtifactError("artifact file path must stay under artifact root")
    return path
