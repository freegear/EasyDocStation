#!/usr/bin/env python3
"""
RAG 학습 스크립트
표준 입력 JSON을 받아 텍스트/문서를 임베딩 후 LanceDB에 저장합니다.

핵심 원칙:
- 검색용 본문(text)과 출처/추적용 메타데이터(metadata)를 분리
- PDF는 가능한 경우 Unstructured partition_pdf를 사용해 page_number/type 보존
- Unstructured 미설치/오류 시 pypdf -> tesseract OCR -> gemma OCR 순서로 fallback
"""

import hashlib
import json
import os
import platform
import re
import sys
import io
import base64
import time
import threading
from datetime import datetime, timezone

# ─── 입력 파싱 ────────────────────────────────────────────────
try:
    payload = json.loads(sys.stdin.read())
except Exception as e:
    print(f"[ERROR] 입력 JSON 파싱 실패: {e}", file=sys.stderr)
    sys.exit(1)

cfg        = payload.get("config", {})
posts      = payload.get("posts", [])
comments   = payload.get("comments", [])
delete_ids = payload.get("delete_ids", [])

def default_lancedb_path():
    env_lancedb = os.getenv("EASYDOC_LANCEDB_PATH", "").strip()
    if env_lancedb:
        return env_lancedb
    env_db_base = os.getenv("EASYDOC_DB_BASE", "").strip()
    if env_db_base:
        return os.path.join(env_db_base, "LanceDB")
    env_station = os.getenv("EASYDOC_STATION_FOLDER", "").strip()
    if env_station:
        return os.path.join(env_station, "Database", "LanceDB")
    repo_default = os.path.abspath(os.path.join(os.path.dirname(__file__), "../Database/LanceDB"))
    if platform.system().lower() == "linux":
        linux_default = "/home/freegear/EasyDocStation/Database/LanceDB"
        if os.path.exists("/home/freegear/EasyDocStation"):
            return linux_default
    return repo_default


def default_file_training_path():
    env_file_training = os.getenv("EASYDOC_FILE_TRAINING_PATH", "").strip()
    if env_file_training:
        return env_file_training
    env_station = os.getenv("EASYDOC_STATION_FOLDER", "").strip()
    if env_station:
        return os.path.join(env_station, "Database", "ObjectFile", "FileTrainingData")
    repo_default = os.path.abspath(os.path.join(os.path.dirname(__file__), "../Database/ObjectFile/FileTrainingData"))
    if platform.system().lower() == "linux":
        linux_default = "/home/freegear/EasyDocStation/Database/ObjectFile/FileTrainingData"
        if os.path.exists("/home/freegear/EasyDocStation"):
            return linux_default
    return repo_default

LANCEDB_PATH  = cfg.get("lancedb_path") or default_lancedb_path()
FILE_TRAINING_PATH = cfg.get("file_training_path") or default_file_training_path()
CHUNK_SIZE    = int(cfg.get("chunk_size", 800))
CHUNK_OVERLAP = int(cfg.get("chunk_overlap", 100))
VECTOR_SIZE   = int(cfg.get("vector_size", 1024))
DOC_VERSION   = datetime.now(timezone.utc).isoformat()
OCR_MODEL     = cfg.get("ocr_model") or os.getenv("EASYDOC_OCR_MODEL", "gemma4:e4b")
OCR_MAX_PAGES = int(cfg.get("ocr_max_pages", os.getenv("EASYDOC_OCR_MAX_PAGES", "30")))
OCR_LANG      = cfg.get("ocr_lang") or os.getenv("EASYDOC_OCR_LANG", "kor+eng")
PDF_PARSE_STRATEGY = str(cfg.get("pdf_parse_strategy", os.getenv("EASYDOC_PDF_PARSE_STRATEGY", "fast"))).strip().lower()
PDF_PARSE_TIMEOUT_SEC = int(cfg.get("pdf_parse_timeout_sec", os.getenv("EASYDOC_PDF_PARSE_TIMEOUT_SEC", "180")))
OLLAMA_HOST   = os.getenv("OLLAMA_HOST", "127.0.0.1")
OLLAMA_PORT   = int(os.getenv("OLLAMA_PORT", "11434"))
OLLAMA_CHAT_URL = f"http://{OLLAMA_HOST}:{OLLAMA_PORT}/api/chat"
AMOUNT_RE = re.compile(r"(?<!\d)(\d{1,3}(?:,\d{3})+|\d{5,})(?:\s*원)?")

if not posts and not comments and not delete_ids:
    print("[RAG] 학습할 데이터가 없습니다.")
    sys.exit(0)

# ─── 라이브러리 로드 ──────────────────────────────────────────
import pdfplumber
from langchain_community.document_loaders import Docx2txtLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
import lancedb
import requests
import pytesseract

# ─── 임베딩 모델 로드 ─────────────────────────────────────────
import torch
MODEL_NAME = "BAAI/bge-m3"
device = "mps" if torch.backends.mps.is_available() else "cpu"
print(f"[RAG] 임베딩 모델 로드 중: {MODEL_NAME} (device={device}) ...", flush=True)
embed_model = SentenceTransformer(MODEL_NAME, device=device)
print(f"[RAG] 임베딩 모델 로드 완료 (device={device})", flush=True)

# ─── LanceDB 연결 ─────────────────────────────────────────────
os.makedirs(LANCEDB_PATH, exist_ok=True)
os.makedirs(FILE_TRAINING_PATH, exist_ok=True)
db = lancedb.connect(LANCEDB_PATH)
TABLE_NAME = "my_rag_table"


def ensure_table(vector_size):
    init_meta = {
        "post_id": "",
        "chunk_id": 0,
        "chunk_index": 0,
        "type": "system",
        "channel_id": "",
        "attachment_id": "",
        "comment_id": "",
        "source": "",
        "file_name": "",
        "page_number": 0,
        "element_id": "",
        "original_content": "",
        "img_path": "",
        "doc_version": "",
        "file_hash": "",
        "amount_total": 0,
        "amount_subtotal": 0,
        "amount_vat": 0,
        "currency": "",
        "amount_candidates": "",
    }
    init_data = [{
        "vector": [0.0] * vector_size,
        "text": "__init__",
        "metadata": init_meta,
    }]

    def _table_exists():
        try:
            raw = db.list_tables() if hasattr(db, "list_tables") else db.table_names()
        except Exception:
            raw = []
        names = set()
        for item in (raw or []):
            if isinstance(item, str):
                names.add(item)
                continue
            if isinstance(item, dict):
                n = item.get("name") or item.get("table_name")
                if n:
                    names.add(str(n))
                continue
            n = getattr(item, "name", None)
            if n:
                names.add(str(n))
            else:
                names.add(str(item))
        return TABLE_NAME in names

    if not _table_exists():
        try:
            tbl = db.create_table(TABLE_NAME, data=init_data)
            print(f"[RAG] 테이블 생성 완료 (dim={vector_size})")
            return tbl
        except Exception as e:
            # 동시 실행/목록 지연 등으로 이미 생성된 경우 open_table로 복구
            if "already exists" not in str(e):
                raise
            print(f"[RAG] 테이블 생성 경합 감지, 기존 테이블 사용: {e}", flush=True)

    tbl = db.open_table(TABLE_NAME)
    vec_size = tbl.schema.field("vector").type.list_size
    meta_field = next((f for f in tbl.schema if f.name == "metadata"), None)
    meta_subfields = [sf.name for sf in meta_field.type] if meta_field else []

    required = [
        "post_id", "chunk_id", "chunk_index", "type", "channel_id",
        "attachment_id", "comment_id", "source", "file_name", "page_number",
        "element_id", "original_content", "img_path", "doc_version", "file_hash",
        "amount_total", "amount_subtotal", "amount_vat", "currency", "amount_candidates",
    ]

    needs_recreate = vec_size != vector_size
    if not needs_recreate:
        for r in required:
            if r not in meta_subfields:
                needs_recreate = True
                break

    if needs_recreate:
        print(f"[RAG] 스키마 불일치 → 테이블 재생성 (dim={vector_size})", flush=True)
        tbl = db.create_table(TABLE_NAME, data=init_data, mode="overwrite")

    return tbl


table = ensure_table(VECTOR_SIZE)

if delete_ids:
    for del_id in delete_ids:
        try:
            safe_id = str(del_id).replace("'", "''")
            table.delete(f"metadata.post_id = '{safe_id}'")
            print(f"[RAG] 기존 청크 삭제 완료: post_id={del_id}", flush=True)
        except Exception as e:
            print(f"[RAG] 청크 삭제 실패 (post_id={del_id}): {e}", file=sys.stderr)
    if not posts and not comments:
        print("[RAG] 삭제 전용 처리 완료")
        sys.exit(0)

text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE,
    chunk_overlap=CHUNK_OVERLAP,
    separators=["\n\n", "\n", ".", " "],
    length_function=len,
)


def normalize_text(value):
    txt = (value or "").strip()
    txt = re.sub(r"\s+", " ", txt)
    return txt.strip()


def safe_name(value, default_value="unknown"):
    s = str(value or "").strip()
    if not s:
        s = default_value
    s = re.sub(r"[^\w.\-]+", "_", s)
    return s[:120] if len(s) > 120 else s


def build_file_training_dir(post_id, comment_id, attachment_id, source_name):
    post_key = safe_name(post_id, "post_unknown")
    comment_key = safe_name(comment_id, "no_comment")
    attach_key = safe_name(attachment_id, "no_attachment")
    source_key = safe_name(source_name, "source_unknown")
    return os.path.join(FILE_TRAINING_PATH, post_key, comment_key, attach_key, source_key)


def write_json_file(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def persist_split_results(base_dir, split_records):
    os.makedirs(base_dir, exist_ok=True)
    write_json_file(os.path.join(base_dir, "text.json"), split_records.get("text", []))
    write_json_file(os.path.join(base_dir, "table.json"), split_records.get("table", []))
    write_json_file(os.path.join(base_dir, "image.json"), split_records.get("image", []))


def safe_int(value, default=0):
    try:
        if value is None:
            return default
        return int(value)
    except Exception:
        return default


def calc_file_hash(file_path):
    if not file_path or not os.path.isfile(file_path):
        return ""
    h = hashlib.sha1()
    try:
        with open(file_path, "rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return ""


def summarize_table(html_or_text):
    src = (html_or_text or "").strip()
    if not src:
        return ""
    no_tags = re.sub(r"<[^>]+>", " ", src)
    no_tags = re.sub(r"\s+", " ", no_tags).strip()
    if not no_tags:
        return ""
    return f"이 표는 다음 정보를 담고 있습니다: {no_tags[:450]}"


def build_image_caption(file_name, page_number, image_path=""):
    fn = file_name or "문서"
    caption = f"{fn}의 {page_number}페이지 이미지 설명"
    if image_path:
        caption += f" (경로: {os.path.basename(image_path)})"
    return caption


def metadata_base(post_id, channel_id, attachment_id, comment_id, source, file_name, file_hash):
    return {
        "post_id": str(post_id or ""),
        "chunk_id": 0,
        "chunk_index": 0,
        "type": "text",
        "channel_id": str(channel_id or ""),
        "attachment_id": str(attachment_id or ""),
        "comment_id": str(comment_id or ""),
        "source": str(source or ""),
        "file_name": str(file_name or ""),
        "page_number": 0,
        "element_id": "",
        "original_content": "",
        "img_path": "",
        "doc_version": DOC_VERSION,
        "file_hash": str(file_hash or ""),
        "amount_total": 0,
        "amount_subtotal": 0,
        "amount_vat": 0,
        "currency": "",
        "amount_candidates": "",
    }


def build_context_prefix(meta):
    parts = []
    if meta.get("file_name"):
        parts.append(meta["file_name"])
    if meta.get("page_number"):
        parts.append(f"{meta['page_number']}페이지")
    return f"[{' / '.join(parts)}]\n" if parts else ""


def append_text_chunks(records, text, base_meta, chunk_prefix=""):
    body = (text or "").strip()
    if not body:
        return 0

    # 각 청크 앞에 문서명+페이지 컨텍스트를 붙여 임베딩 — 검색 정확도 향상
    # text 필드에는 원본만 저장하고, 임베딩은 컨텍스트 포함 텍스트로 생성
    ctx_prefix = build_context_prefix(base_meta)
    chunks = text_splitter.split_text(body)
    if not chunks:
        return 0

    embed_inputs = [f"{ctx_prefix}{c}" if ctx_prefix else c for c in chunks]
    vectors = embed_model.encode(embed_inputs, batch_size=16, show_progress_bar=False)
    for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
        m = dict(base_meta)
        m["chunk_id"] = i
        m["chunk_index"] = i
        if chunk_prefix:
            m["element_id"] = f"{chunk_prefix}-{i}"
        records.append({
            "vector": vector.tolist(),
            "text": chunk,
            "metadata": m,
        })
    return len(chunks)


def parse_amount_to_int(value):
    if value is None:
        return 0
    s = re.sub(r"[^\d]", "", str(value))
    if not s:
        return 0
    try:
        return int(s)
    except Exception:
        return 0


def extract_amount_candidates(text):
    if not text:
        return []
    vals = []
    seen = set()
    for m in AMOUNT_RE.finditer(text):
        n = parse_amount_to_int(m.group(1))
        if n <= 0:
            continue
        if n in seen:
            continue
        seen.add(n)
        vals.append(n)
    return vals


def find_labeled_amount(text, labels):
    if not text:
        return 0
    for label in labels:
        # 라벨과 금액 사이에 공백/문장부호가 섞여도 찾을 수 있게 허용
        pattern = re.compile(rf"{label}[\s:：\-]*([0-9][0-9,\s]{{2,}})(?:\s*원)?", re.IGNORECASE)
        m = pattern.search(text)
        if not m:
            continue
        n = parse_amount_to_int(m.group(1))
        if n > 0:
            return n
    return 0


def extract_amount_fields(text):
    src = text or ""
    total = find_labeled_amount(src, [r"합\s*계", r"총\s*액", r"총\s*금\s*액", r"견\s*적\s*금\s*액", r"청\s*구\s*금\s*액"])
    subtotal = find_labeled_amount(src, [r"소\s*계", r"공\s*급\s*가\s*액", r"공\s*급\s*가", r"공\s*급\s*금\s*액"])
    vat = find_labeled_amount(src, [r"부\s*가\s*가\s*치\s*세", r"부\s*가\s*세", "VAT"])
    candidates = extract_amount_candidates(src)

    if total <= 0 and subtotal > 0 and vat > 0:
        total = subtotal + vat
    if total <= 0 and candidates:
        total = max(candidates)

    currency = "KRW" if ("원" in src or "KRW" in src.upper() or "VAT" in src.upper()) else ""
    return {
        "amount_total": total if total > 0 else 0,
        "amount_subtotal": subtotal if subtotal > 0 else 0,
        "amount_vat": vat if vat > 0 else 0,
        "currency": currency,
        "amount_candidates": ",".join(str(x) for x in candidates[:20]),
    }


def apply_amount_meta(meta, text):
    fields = extract_amount_fields(text)
    meta["amount_total"] = fields["amount_total"]
    meta["amount_subtotal"] = fields["amount_subtotal"]
    meta["amount_vat"] = fields["amount_vat"]
    meta["currency"] = fields["currency"]
    meta["amount_candidates"] = fields["amount_candidates"]
    return meta


def format_amount_won(value):
    n = parse_amount_to_int(value)
    if n <= 0:
        return "미확인"
    return f"{n:,}원"


def load_pdf_fallback_text(file_path):
    try:
        pages = []
        with pdfplumber.open(file_path) as pdf:
            for idx, page in enumerate(pdf.pages):
                # layout=True preserves reading order for multi-column/slide layouts
                text = (page.extract_text(layout=True) or "").strip()
                if not text:
                    text = (page.extract_text() or "").strip()

                table_texts = []
                try:
                    for table in (page.extract_tables() or []):
                        rows = []
                        for row in table:
                            row_text = " | ".join(cell or "" for cell in row)
                            if row_text.strip():
                                rows.append(row_text)
                        if rows:
                            table_texts.append("\n".join(rows))
                except Exception:
                    pass

                combined = (text + ("\n" + "\n\n".join(table_texts) if table_texts else "")).strip()
                if combined:
                    pages.append({"page_number": idx + 1, "text": combined})
        return pages
    except Exception as e:
        print(f"[RAG] pdfplumber PDF 읽기 실패 ({file_path}): {e}", file=sys.stderr)
        return []


def ocr_pdf_with_gemma(file_path):
    try:
        from pdf2image import convert_from_path
    except Exception as e:
        print(f"[RAG] pdf2image 로드 실패 (Gemma OCR fallback 불가): {e}", file=sys.stderr)
        return []

    try:
        images = convert_from_path(file_path, dpi=170)
    except Exception as e:
        print(f"[RAG] PDF 이미지 변환 실패 (Gemma OCR): {e}", file=sys.stderr)
        return []

    pages = images[:max(1, OCR_MAX_PAGES)]
    extracted_pages = []
    if not pages:
        return extracted_pages

    print(f"[RAG] Gemma OCR fallback 시작: model={OCR_MODEL}, pages={len(pages)}", flush=True)
    for i, image in enumerate(pages, 1):
        if i == 1 or i % 5 == 0 or i == len(pages):
            print(f"[RAG] Gemma OCR 진행: {i}/{len(pages)}", flush=True)
        try:
            buf = io.BytesIO()
            image.save(buf, format="JPEG", quality=85)
            img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            payload = {
                "model": OCR_MODEL,
                "stream": False,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are an OCR engine. Extract all visible text as faithfully as possible. "
                            "Return only extracted text without explanations."
                        ),
                    },
                    {
                        "role": "user",
                        "content": "Extract all text from this page. Keep line breaks when possible.",
                        "images": [img_b64],
                    },
                ],
                "options": {
                    "temperature": 0,
                },
            }
            res = requests.post(OLLAMA_CHAT_URL, json=payload, timeout=240)
            if res.status_code != 200:
                print(f"[RAG] Gemma OCR 호출 실패 (page={i}): HTTP {res.status_code}", file=sys.stderr)
                continue
            data = res.json() if res.content else {}
            text = ((data.get("message") or {}).get("content") or "").strip()
            if text:
                extracted_pages.append({"page_number": i, "text": text})
        except Exception as e:
            print(f"[RAG] Gemma OCR 처리 실패 (page={i}): {e}", file=sys.stderr)

    print(f"[RAG] Gemma OCR fallback 완료: 추출 페이지 {len(extracted_pages)}/{len(pages)}", flush=True)
    return extracted_pages


def ocr_pdf_with_tesseract(file_path):
    try:
        from pdf2image import convert_from_path
    except Exception as e:
        print(f"[RAG] pdf2image 로드 실패 (Tesseract OCR fallback 불가): {e}", file=sys.stderr)
        return []

    try:
        images = convert_from_path(file_path, dpi=220)
    except Exception as e:
        print(f"[RAG] PDF 이미지 변환 실패 (Tesseract OCR): {e}", file=sys.stderr)
        return []

    pages = images[:max(1, OCR_MAX_PAGES)]
    extracted_pages = []
    if not pages:
        return extracted_pages

    print(f"[RAG] Tesseract OCR fallback 시작: lang={OCR_LANG}, pages={len(pages)}", flush=True)
    for i, image in enumerate(pages, 1):
        if i == 1 or i % 5 == 0 or i == len(pages):
            print(f"[RAG] Tesseract OCR 진행: {i}/{len(pages)}", flush=True)
        try:
            text = (pytesseract.image_to_string(image, lang=OCR_LANG) or "").strip()
            if not text and OCR_LANG != "eng":
                text = (pytesseract.image_to_string(image, lang="eng") or "").strip()
            if text:
                extracted_pages.append({"page_number": i, "text": text})
        except Exception as e:
            print(f"[RAG] Tesseract OCR 처리 실패 (page={i}): {e}", file=sys.stderr)

    print(f"[RAG] Tesseract OCR fallback 완료: 추출 페이지 {len(extracted_pages)}/{len(pages)}", flush=True)
    return extracted_pages


def load_pdf_elements(file_path):
    def _parse_unstructured(partition_pdf, strategy, infer_table, extract_images):
        print(f"[RAG] PDF 파싱 시작 (Unstructured {strategy}): {os.path.basename(file_path)}", flush=True)
        started_at = time.time()
        stop_event = threading.Event()

        def _heartbeat():
            while not stop_event.wait(10):
                elapsed = int(time.time() - started_at)
                print(f"[RAG] PDF 파싱 진행중: {os.path.basename(file_path)} ({elapsed}s 경과)", flush=True)
                if elapsed >= max(10, PDF_PARSE_TIMEOUT_SEC):
                    print(
                        f"[RAG] PDF 파싱 권장시간({PDF_PARSE_TIMEOUT_SEC}s) 초과: {os.path.basename(file_path)}",
                        flush=True,
                    )
                    break

        hb = threading.Thread(target=_heartbeat, daemon=True)
        hb.start()
        try:
            kwargs = {
                "filename": file_path,
                "strategy": strategy,
                "infer_table_structure": infer_table,
                "extract_images_in_pdf": extract_images,
            }
            langs = [x.strip() for x in str(OCR_LANG).replace("+", ",").split(",") if x.strip()]
            if langs:
                kwargs["languages"] = langs
            elements = partition_pdf(**kwargs)
        finally:
            stop_event.set()
            hb.join(timeout=0.1)

        parsed = []
        for el in elements:
            metadata = getattr(el, "metadata", None)
            page_number = safe_int(getattr(metadata, "page_number", None), default=0)
            category = str(getattr(el, "category", "Text") or "Text")
            text = (getattr(el, "text", "") or "").strip()

            html = ""
            image_path = ""
            if metadata is not None:
                html = (getattr(metadata, "text_as_html", "") or "").strip()
                image_path = (getattr(metadata, "image_path", "") or "").strip()

            parsed.append({
                "category": category,
                "page_number": page_number,
                "text": text,
                "html": html,
                "image_path": image_path,
            })

        if parsed:
            elapsed = time.time() - started_at
            print(
                f"[RAG] PDF 파싱 완료 (Unstructured {strategy}): {os.path.basename(file_path)} / elements={len(parsed)} / {elapsed:.1f}s",
                flush=True,
            )
        return parsed

    try:
        from unstructured.partition.pdf import partition_pdf  # optional
        requested = PDF_PARSE_STRATEGY or "fast"
        if requested in ("off", "fallback", "none"):
            raise RuntimeError("Unstructured PDF 파싱 비활성화 설정")

        if requested == "auto":
            strategies = [("fast", False, False), ("hi_res", True, False)]
        elif requested == "hi_res":
            strategies = [("hi_res", True, False), ("fast", False, False)]
        else:
            # default: fast
            strategies = [("fast", False, False)]

        for strategy, infer_table, extract_images in strategies:
            try:
                parsed = _parse_unstructured(partition_pdf, strategy, infer_table, extract_images)
                if parsed:
                    return parsed
            except Exception as e:
                print(
                    f"[RAG] Unstructured PDF 파싱 실패 ({os.path.basename(file_path)}, strategy={strategy}): {e}",
                    flush=True,
                )
    except Exception as e:
        print(f"[RAG] Unstructured PDF 파싱 실패, fallback 사용 ({os.path.basename(file_path)}): {e}", flush=True)

    fallback_pages = load_pdf_fallback_text(file_path)
    if not fallback_pages:
        # 스캔본 등으로 pypdf 텍스트 추출이 실패하면, Tesseract OCR을 우선 시도
        fallback_pages = ocr_pdf_with_tesseract(file_path)
    if not fallback_pages:
        # Tesseract도 실패하면 Gemma 비전 OCR으로 마지막 fallback
        fallback_pages = ocr_pdf_with_gemma(file_path)
    return [{
        "category": "Text",
        "page_number": p["page_number"],
        "text": p["text"],
        "html": "",
        "image_path": "",
    } for p in fallback_pages]


def ingest_pdf(records, *, post_id, channel_id, attachment_id, comment_id, pdf_path, file_name):
    if not pdf_path or not os.path.isfile(pdf_path):
        if pdf_path:
            print(f"[RAG] PDF 파일 없음: {pdf_path}", file=sys.stderr)
        return 0

    file_hash = calc_file_hash(pdf_path)
    source_name = file_name or os.path.basename(pdf_path)
    print(f"[RAG] PDF 학습 시작: {os.path.basename(pdf_path)}", flush=True)
    elements = load_pdf_elements(pdf_path)
    if not elements:
        print(f"[RAG] PDF 학습 건너뜀(추출 요소 없음): {os.path.basename(pdf_path)}", flush=True)
        return 0

    split_records = {"text": [], "table": [], "image": []}
    split_base_dir = build_file_training_dir(post_id, comment_id, attachment_id, source_name)
    amount_signal_texts = []

    # 슬라이드/페이지 단위로 텍스트 요소를 병합: 제목과 내용이 같은 청크에 포함되도록
    from collections import defaultdict
    page_text_buckets = defaultdict(list)  # page_number → [text fragments]

    local_chunks = 0
    for idx, el in enumerate(elements):
        category = (el.get("category") or "Text").lower()
        page_number = safe_int(el.get("page_number"), default=0)
        text = (el.get("text") or "").strip()
        html = (el.get("html") or "").strip()
        image_path = (el.get("image_path") or "").strip()

        if "table" in category:
            content = summarize_table(html or text)
            if not content:
                continue
            amount_signal_texts.append((html or text or content))
            split_records["table"].append({
                "post_id": str(post_id or ""),
                "comment_id": str(comment_id or ""),
                "attachment_id": str(attachment_id or ""),
                "source": source_name,
                "file_name": source_name,
                "type": "table",
                "page_number": page_number,
                "element_id": f"tbl-{page_number}-{idx}",
                "search_content": content,
                "original_content": html or text,
                "file_hash": file_hash,
                "saved_at": DOC_VERSION,
            })
            meta = metadata_base(
                post_id=post_id,
                channel_id=channel_id,
                attachment_id=attachment_id,
                comment_id=comment_id,
                source=source_name,
                file_name=source_name,
                file_hash=file_hash,
            )
            meta["type"] = "table"
            meta["page_number"] = page_number
            meta["original_content"] = html or text
            meta["element_id"] = f"tbl-{page_number}-{idx}"
            apply_amount_meta(meta, f"{content}\n{html or text}")
            local_chunks += append_text_chunks(records, content, meta, chunk_prefix=meta["element_id"])
            continue

        if "image" in category:
            caption = build_image_caption(source_name, page_number, image_path)
            split_records["image"].append({
                "post_id": str(post_id or ""),
                "comment_id": str(comment_id or ""),
                "attachment_id": str(attachment_id or ""),
                "source": source_name,
                "file_name": source_name,
                "type": "image",
                "page_number": page_number,
                "element_id": f"img-{page_number}-{idx}",
                "search_content": caption,
                "img_path": image_path,
                "file_hash": file_hash,
                "saved_at": DOC_VERSION,
            })
            meta = metadata_base(
                post_id=post_id,
                channel_id=channel_id,
                attachment_id=attachment_id,
                comment_id=comment_id,
                source=source_name,
                file_name=source_name,
                file_hash=file_hash,
            )
            meta["type"] = "image"
            meta["page_number"] = page_number
            meta["img_path"] = image_path
            meta["element_id"] = f"img-{page_number}-{idx}"
            apply_amount_meta(meta, caption)
            local_chunks += append_text_chunks(records, caption, meta, chunk_prefix=meta["element_id"])
            continue

        content = normalize_text(text)
        if not content:
            continue
        # 같은 페이지의 텍스트 요소를 버킷에 누적 (나중에 페이지 단위로 병합 처리)
        page_text_buckets[page_number].append(content)

    # 페이지 단위로 병합된 텍스트를 청킹 — 제목과 내용이 함께 임베딩됨
    for page_number, fragments in sorted(page_text_buckets.items()):
        merged = "\n".join(fragments)
        amount_signal_texts.append(merged)
        split_records["text"].append({
            "post_id": str(post_id or ""),
            "comment_id": str(comment_id or ""),
            "attachment_id": str(attachment_id or ""),
            "source": source_name,
            "file_name": source_name,
            "type": "text",
            "page_number": page_number,
            "element_id": f"txt-p{page_number}",
            "search_content": merged,
            "file_hash": file_hash,
            "saved_at": DOC_VERSION,
        })
        meta = metadata_base(
            post_id=post_id,
            channel_id=channel_id,
            attachment_id=attachment_id,
            comment_id=comment_id,
            source=source_name,
            file_name=source_name,
            file_hash=file_hash,
        )
        meta["type"] = "text"
        meta["page_number"] = page_number
        meta["element_id"] = f"txt-p{page_number}"
        apply_amount_meta(meta, merged)
        local_chunks += append_text_chunks(records, merged, meta, chunk_prefix=meta["element_id"])

    # 금액 질의 대응 강화를 위한 요약 청크 생성
    merged_amount_text = "\n".join(amount_signal_texts).strip()
    amount_fields = extract_amount_fields(merged_amount_text)
    if (
        amount_fields["amount_total"] > 0
        or amount_fields["amount_subtotal"] > 0
        or amount_fields["amount_vat"] > 0
        or amount_fields["amount_candidates"]
    ):
        amount_summary = (
            f"[견적 금액 요약]\n"
            f"문서: {source_name}\n"
            f"소계: {format_amount_won(amount_fields['amount_subtotal'])}\n"
            f"부가세: {format_amount_won(amount_fields['amount_vat'])}\n"
            f"합계: {format_amount_won(amount_fields['amount_total'])}\n"
            f"키워드: 견적, 금액, 소계, 부가세, 합계, 총액, VAT"
        )
        meta = metadata_base(
            post_id=post_id,
            channel_id=channel_id,
            attachment_id=attachment_id,
            comment_id=comment_id,
            source=source_name,
            file_name=source_name,
            file_hash=file_hash,
        )
        meta["type"] = "amount_summary"
        meta["page_number"] = 0
        meta["element_id"] = "amount-summary"
        meta["amount_total"] = amount_fields["amount_total"]
        meta["amount_subtotal"] = amount_fields["amount_subtotal"]
        meta["amount_vat"] = amount_fields["amount_vat"]
        meta["currency"] = amount_fields["currency"] or "KRW"
        meta["amount_candidates"] = amount_fields["amount_candidates"]
        local_chunks += append_text_chunks(records, amount_summary, meta, chunk_prefix=meta["element_id"])

    persist_split_results(split_base_dir, split_records)
    print(f"[RAG] PDF 학습 완료: {os.path.basename(pdf_path)} ({local_chunks}청크)", flush=True)
    print(f"[RAG] 분리 저장 완료: {split_base_dir}", flush=True)
    return local_chunks


def load_word(file_path):
    try:
        loader = Docx2txtLoader(file_path)
        docs = loader.load()
        text = "\n".join(doc.page_content for doc in docs if doc.page_content)
        return text.strip()
    except Exception as e:
        print(f"[RAG] Word 읽기 실패 ({file_path}): {e}", file=sys.stderr)
        return ""


def ingest_word(records, *, post_id, channel_id, attachment_id, comment_id, word_path, file_name):
    if not word_path or not os.path.isfile(word_path):
        if word_path:
            print(f"[RAG] Word 파일 없음: {word_path}", file=sys.stderr)
        return 0

    text = load_word(word_path)
    if not text:
        return 0

    source_name = file_name or os.path.basename(word_path)
    file_hash = calc_file_hash(word_path)

    meta = metadata_base(
        post_id=post_id,
        channel_id=channel_id,
        attachment_id=attachment_id,
        comment_id=comment_id,
        source=source_name,
        file_name=source_name,
        file_hash=file_hash,
    )
    meta["type"] = "word"
    meta["page_number"] = 0
    meta["element_id"] = f"word-{attachment_id or post_id or comment_id}"

    count = append_text_chunks(records, text, meta, chunk_prefix=meta["element_id"])
    print(f"[RAG] Word 학습 완료: {os.path.basename(word_path)} ({count}청크)", flush=True)
    return count


def ingest_plain_text(records, *, post_id, channel_id, comment_id, content, source_type):
    body = (content or "").strip()
    if not body:
        return 0

    meta = metadata_base(
        post_id=post_id,
        channel_id=channel_id,
        attachment_id="",
        comment_id=comment_id,
        source=source_type,
        file_name="",
        file_hash="",
    )
    meta["type"] = source_type
    meta["page_number"] = 0
    meta["element_id"] = f"{source_type}-{post_id or comment_id}"

    return append_text_chunks(records, body, meta, chunk_prefix=meta["element_id"])


def count_training_steps(posts, comments):
    # 각 본문 1단계 + 첨부문서 개수 + 최종 저장 1단계
    steps = 1
    for post in posts:
        steps += 1
        steps += len(post.get("pdfs", []) or [])
        steps += len(post.get("words", []) or [])
    for comment in comments:
        steps += 1
        steps += len(comment.get("pdfs", []) or [])
        steps += len(comment.get("words", []) or [])
    return max(steps, 1)


class ProgressTracker:
    def __init__(self, total_steps):
        self.total_steps = max(1, int(total_steps))
        self.done_steps = 0
        self.last_percent_mark = 0

    def _emit(self, label=""):
        percent = int((self.done_steps * 100) / self.total_steps)
        percent_mark = min(100, (percent // 10) * 10)
        if percent_mark >= 10 and percent_mark > self.last_percent_mark:
            suffix = f" ({label})" if label else ""
            print(f"[RAG] 학습 진행률: {percent_mark}%{suffix}", flush=True)
            self.last_percent_mark = percent_mark

    def step(self, count=1, label=""):
        self.done_steps = min(self.total_steps, self.done_steps + max(0, int(count)))
        self._emit(label=label)

    def complete(self, label="완료"):
        self.done_steps = self.total_steps
        self._emit(label=label)


# ─── 학습 실행 ───────────────────────────────────────────────
records = []
total_chunks = 0
progress = ProgressTracker(count_training_steps(posts, comments))

for post in posts:
    post_id = post.get("id", "unknown")
    channel_id = post.get("channel_id", "")

    # 게시글 본문
    count = ingest_plain_text(
        records,
        post_id=post_id,
        channel_id=channel_id,
        comment_id="",
        content=post.get("content") or "",
        source_type="manual_text",
    )
    total_chunks += count
    if count:
        print(f"[RAG] post={post_id} text → {count}청크", flush=True)
    progress.step(label="게시글 본문")

    # PDF 첨부
    for pdf_info in post.get("pdfs", []):
        total_chunks += ingest_pdf(
            records,
            post_id=post_id,
            channel_id=channel_id,
            attachment_id=pdf_info.get("id") or "",
            comment_id="",
            pdf_path=pdf_info.get("path") or "",
            file_name=pdf_info.get("file_name") or "",
        )
        progress.step(label="게시글 PDF")

    # Word 첨부
    for word_info in post.get("words", []):
        total_chunks += ingest_word(
            records,
            post_id=post_id,
            channel_id=channel_id,
            attachment_id=word_info.get("id") or "",
            comment_id="",
            word_path=word_info.get("path") or "",
            file_name=word_info.get("file_name") or "",
        )
        progress.step(label="게시글 Word")

for comment in comments:
    comment_id = comment.get("id", "unknown")
    post_id = comment.get("post_id", "")
    channel_id = comment.get("channel_id", "")

    # 댓글 본문
    count = ingest_plain_text(
        records,
        post_id=post_id,
        channel_id=channel_id,
        comment_id=comment_id,
        content=comment.get("content") or "",
        source_type="comment",
    )
    total_chunks += count
    if count:
        print(f"[RAG] comment={comment_id} post={post_id} text → {count}청크", flush=True)
    progress.step(label="댓글 본문")

    # 댓글 PDF
    for pdf_info in comment.get("pdfs", []):
        total_chunks += ingest_pdf(
            records,
            post_id=post_id,
            channel_id=channel_id,
            attachment_id=pdf_info.get("id") or "",
            comment_id=comment_id,
            pdf_path=pdf_info.get("path") or "",
            file_name=pdf_info.get("file_name") or "",
        )
        progress.step(label="댓글 PDF")

    # 댓글 Word
    for word_info in comment.get("words", []):
        total_chunks += ingest_word(
            records,
            post_id=post_id,
            channel_id=channel_id,
            attachment_id=word_info.get("id") or "",
            comment_id=comment_id,
            word_path=word_info.get("path") or "",
            file_name=word_info.get("file_name") or "",
        )
        progress.step(label="댓글 Word")


if records:
    table.add(records)
    print(f"[RAG] 저장 완료 — {total_chunks}청크 / {len(posts)}개 게시글 / {len(comments)}개 댓글", flush=True)
else:
    print("[RAG] 저장할 레코드 없음", flush=True)
progress.step(label="저장")
progress.complete()
