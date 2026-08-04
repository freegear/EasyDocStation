"""Document conversion adapters shared by RAG ingestion and comparison tools."""

from __future__ import annotations

import importlib.metadata
import json
import os
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

try:
    from defusedxml import ElementTree as SafeET
except Exception:  # defusedxml is installed with Docling/MarkItDown; stdlib remains a fallback.
    SafeET = ET


DOCLING_EXTENSIONS = {
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "html", "htm", "csv",
}
DOCLING_XML_ROOTS = {"doclang", "article", "xbrl", "us-patent-grant", "us-patent-application"}
_docling_converter = None


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except Exception:
        return ""


def normalize_converter(value: str | None) -> str:
    value = str(value or "docling").strip().lower()
    return value if value in {"docling", "markitdown"} else "docling"


def _xml_local_name(tag: str) -> str:
    return str(tag or "").split("}")[-1].lower()


def is_supported_docling_xml(path: str) -> bool:
    try:
        for _, elem in SafeET.iterparse(path, events=("start",)):
            return _xml_local_name(elem.tag) in DOCLING_XML_ROOTS
    except Exception:
        return False
    return False


def supports_docling(path: str) -> bool:
    ext = Path(path).suffix.lower().lstrip(".")
    if ext == "xml":
        return is_supported_docling_xml(path)
    return ext in DOCLING_EXTENSIONS


@dataclass
class ConversionResult:
    text: str = ""
    converter: str = ""
    version: str = ""
    status: str = "failure"
    elapsed_sec: float = 0.0
    error: str = ""
    document_json: dict[str, Any] | None = None
    fallback_used: bool = False
    fallback_pipeline: str = ""
    attempts: list[dict[str, Any]] = field(default_factory=list)

    def report(self, *, source_path: str = "", file_hash: str = "") -> dict[str, Any]:
        data = asdict(self)
        data.pop("text", None)
        data.pop("document_json", None)
        data.update({
            "source_file": os.path.basename(source_path),
            "source_size": os.path.getsize(source_path) if source_path and os.path.isfile(source_path) else 0,
            "file_hash": file_hash,
            "text_length": len(self.text),
        })
        return data


def _status_value(value: Any) -> str:
    raw = getattr(value, "value", value)
    normalized = str(raw or "success").strip().lower().replace(" ", "_")
    if "partial" in normalized:
        return "partial_success"
    if "success" in normalized:
        return "success"
    return normalized or "success"


def _get_docling_converter():
    global _docling_converter
    if _docling_converter is None:
        from docling.document_converter import DocumentConverter
        _docling_converter = DocumentConverter()
    return _docling_converter


def convert_with_docling(path: str, *, max_file_size: int | None = None) -> ConversionResult:
    started = time.time()
    if not supports_docling(path):
        return ConversionResult(
            converter="docling",
            version=package_version("docling"),
            elapsed_sec=round(time.time() - started, 3),
            error="unsupported_format_or_xml_schema",
        )
    try:
        kwargs = {"raises_on_error": False}
        if max_file_size and max_file_size > 0:
            kwargs["max_file_size"] = int(max_file_size)
        result = _get_docling_converter().convert(path, **kwargs)
        document = getattr(result, "document", None)
        text = document.export_to_markdown().strip() if document is not None else ""
        document_json = document.export_to_dict() if document is not None else None
        status = _status_value(getattr(result, "status", "success"))
        errors = getattr(result, "errors", None) or []
        error = "; ".join(str(getattr(item, "error_message", item)) for item in errors)
        if not text and status == "success":
            status = "failure"
            error = error or "empty_conversion_result"
        return ConversionResult(
            text=text,
            converter="docling",
            version=package_version("docling"),
            status=status,
            elapsed_sec=round(time.time() - started, 3),
            error=error,
            document_json=document_json,
        )
    except Exception as exc:
        return ConversionResult(
            converter="docling",
            version=package_version("docling"),
            elapsed_sec=round(time.time() - started, 3),
            error=str(exc),
        )


def convert_with_markitdown(path: str) -> ConversionResult:
    started = time.time()
    try:
        from markitdown import MarkItDown
        converted = MarkItDown().convert(path)
        text = (getattr(converted, "text_content", "") or "").strip()
        return ConversionResult(
            text=text,
            converter="markitdown",
            version=package_version("markitdown"),
            status="success" if text else "failure",
            elapsed_sec=round(time.time() - started, 3),
            error="" if text else "empty_conversion_result",
        )
    except Exception as exc:
        return ConversionResult(
            converter="markitdown",
            version=package_version("markitdown"),
            elapsed_sec=round(time.time() - started, 3),
            error=str(exc),
        )


def convert_xml_structured_text(path: str) -> ConversionResult:
    started = time.time()
    try:
        root = SafeET.parse(path).getroot()
        lines: list[str] = []

        def visit(element: ET.Element, parent_path: str = "") -> None:
            name = _xml_local_name(element.tag)
            current_path = f"{parent_path}/{name}" if parent_path else f"/{name}"
            text = (element.text or "").strip()
            attributes = " ".join(f"@{key}={value}" for key, value in element.attrib.items())
            value = " ".join(part for part in (attributes, text) if part)
            if value:
                lines.append(f"{current_path}: {value}")
            for child in list(element):
                visit(child, current_path)

        visit(root)
        text = "\n".join(lines).strip()
        return ConversionResult(
            text=text,
            converter="xml_structured_text",
            version="stdlib",
            status="success" if text else "failure",
            elapsed_sec=round(time.time() - started, 3),
            error="" if text else "empty_conversion_result",
        )
    except Exception as exc:
        return ConversionResult(
            converter="xml_structured_text",
            version="stdlib",
            elapsed_sec=round(time.time() - started, 3),
            error=str(exc),
        )


def convert_document(
    path: str,
    *,
    preferred: str = "docling",
    fallback_to_markitdown: bool = True,
    max_file_size: int | None = None,
) -> ConversionResult:
    preferred = normalize_converter(preferred)
    if max_file_size and os.path.isfile(path) and os.path.getsize(path) > max_file_size:
        return ConversionResult(
            converter=preferred,
            error=f"file_size_limit_exceeded:{os.path.getsize(path)}>{max_file_size}",
        )
    ext = Path(path).suffix.lower().lstrip(".")
    if preferred == "docling" and ext == "xml" and not is_supported_docling_xml(path):
        first = convert_xml_structured_text(path)
    else:
        first = (
            convert_with_docling(path, max_file_size=max_file_size)
            if preferred == "docling"
            else convert_with_markitdown(path)
        )
    attempts = [{
        "converter": first.converter,
        "version": first.version,
        "status": first.status,
        "elapsed_sec": first.elapsed_sec,
        "error": first.error,
        "text_length": len(first.text),
    }]
    if first.text:
        first.attempts = attempts
        return first

    if preferred == "docling" and fallback_to_markitdown:
        fallback = convert_with_markitdown(path)
        attempts.append({
            "converter": fallback.converter,
            "version": fallback.version,
            "status": fallback.status,
            "elapsed_sec": fallback.elapsed_sec,
            "error": fallback.error,
            "text_length": len(fallback.text),
        })
        fallback.fallback_used = True
        fallback.fallback_pipeline = "markitdown"
        fallback.attempts = attempts
        return fallback

    first.attempts = attempts
    return first


def write_conversion_outputs(output_dir: str, result: ConversionResult, *, source_path: str, file_hash: str = "") -> None:
    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    if result.text:
        (target / f"converted_{result.converter}.md").write_text(result.text, encoding="utf-8")
    if result.converter == "docling" and result.document_json is not None:
        (target / "converted_docling.json").write_text(
            json.dumps(result.document_json, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    (target / "conversion_report.json").write_text(
        json.dumps(result.report(source_path=source_path, file_hash=file_hash), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
