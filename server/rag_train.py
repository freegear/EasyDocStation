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
delete_post_ids = payload.get("delete_post_ids", [])
delete_comment_ids = payload.get("delete_comment_ids", [])

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
PDF_PARSE_STRATEGY = str(cfg.get("pdf_parse_strategy", os.getenv("EASYDOC_PDF_PARSE_STRATEGY", "auto"))).strip().lower()
PDF_PARSE_TIMEOUT_SEC = int(cfg.get("pdf_parse_timeout_sec", os.getenv("EASYDOC_PDF_PARSE_TIMEOUT_SEC", "180")))
AUTO_COMPLEX_TEXT_THRESHOLD = int(
    cfg.get(
        "auto_complex_text_threshold",
        os.getenv("EASYDOC_AUTO_COMPLEX_TEXT_THRESHOLD", "120"),
    )
)
OLLAMA_HOST   = os.getenv("OLLAMA_HOST", "127.0.0.1")
OLLAMA_PORT   = int(os.getenv("OLLAMA_PORT", "11434"))
OLLAMA_CHAT_URL = f"http://{OLLAMA_HOST}:{OLLAMA_PORT}/api/chat"
RAG_SERVER_HOST = os.getenv("RAG_SERVER_HOST", "127.0.0.1")
RAG_SERVER_PORT = int(os.getenv("RAG_SERVER_PORT", "5001"))
RAG_SERVER_EMBED_URL = f"http://{RAG_SERVER_HOST}:{RAG_SERVER_PORT}/embed"
EMBED_WITH_RAG_SERVER = str(
    cfg.get("embed_with_rag_server", os.getenv("EASYDOC_EMBED_WITH_RAG_SERVER", "1"))
).strip().lower() not in ("0", "false", "no", "off")
EMBED_SERVER_TIMEOUT_SEC = float(
    cfg.get("embed_server_timeout_sec", os.getenv("EASYDOC_EMBED_SERVER_TIMEOUT_SEC", "60"))
)
EMBED_SERVER_RETRIES = int(
    cfg.get("embed_server_retries", os.getenv("EASYDOC_EMBED_SERVER_RETRIES", "2"))
)
AMOUNT_RE = re.compile(r"(?<!\d)(\d{1,3}(?:,\d{3})+|\d{5,})(?:\s*원)?")

if not posts and not comments and not delete_ids and not delete_post_ids and not delete_comment_ids:
    print("[RAG] 학습할 데이터가 없습니다.")
    sys.exit(0)

# ─── 라이브러리 로드 ──────────────────────────────────────────
import pdfplumber
from langchain_community.document_loaders import Docx2txtLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
import lancedb
import requests
import pytesseract

_local_embed_model = None


def get_local_embed_model():
    global _local_embed_model
    if _local_embed_model is not None:
        return _local_embed_model
    import torch
    from sentence_transformers import SentenceTransformer
    model_name = "BAAI/bge-m3"
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"[RAG] (fallback) 로컬 임베딩 모델 로드 중: {model_name} (device={device}) ...", flush=True)
    _local_embed_model = SentenceTransformer(model_name, device=device)
    print(f"[RAG] (fallback) 로컬 임베딩 모델 로드 완료 (device={device})", flush=True)
    return _local_embed_model


def embed_texts(texts):
    if not texts:
        return []

    if EMBED_WITH_RAG_SERVER:
        payload = {
            "action": "embed",
            "texts": texts,
            "batch_size": 16,
        }
        last_err = None
        for attempt in range(max(1, EMBED_SERVER_RETRIES + 1)):
            try:
                res = requests.post(
                    RAG_SERVER_EMBED_URL,
                    json=payload,
                    timeout=EMBED_SERVER_TIMEOUT_SEC,
                )
                res.raise_for_status()
                data = res.json() if res.content else {}
                vecs = data.get("vectors") or []
                if len(vecs) != len(texts):
                    raise RuntimeError(f"vector count mismatch: got={len(vecs)} expected={len(texts)}")
                return vecs
            except Exception as e:
                last_err = e
                if attempt < max(1, EMBED_SERVER_RETRIES + 1) - 1:
                    time.sleep(0.5)
        print(f"[RAG] 임베딩 서버 호출 실패, 로컬 fallback 사용: {last_err}", flush=True)

    model = get_local_embed_model()
    vecs = model.encode(texts, batch_size=16, show_progress_bar=False)
    return vecs.tolist()

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

delete_post_targets = []
delete_post_targets.extend(delete_ids if isinstance(delete_ids, list) else [])
delete_post_targets.extend(delete_post_ids if isinstance(delete_post_ids, list) else [])
delete_post_targets = list(dict.fromkeys([str(v) for v in delete_post_targets if v is not None and str(v).strip() != ""]))

delete_comment_targets = list(dict.fromkeys([
    str(v) for v in (delete_comment_ids if isinstance(delete_comment_ids, list) else [])
    if v is not None and str(v).strip() != ""
]))

if delete_post_targets:
    for del_id in delete_post_targets:
        try:
            safe_id = str(del_id).replace("'", "''")
            table.delete(f"metadata.post_id = '{safe_id}'")
            print(f"[RAG] 기존 청크 삭제 완료: post_id={del_id}", flush=True)
        except Exception as e:
            print(f"[RAG] 청크 삭제 실패 (post_id={del_id}): {e}", file=sys.stderr)

if delete_comment_targets:
    for del_id in delete_comment_targets:
        try:
            safe_id = str(del_id).replace("'", "''")
            table.delete(f"metadata.comment_id = '{safe_id}'")
            print(f"[RAG] 기존 청크 삭제 완료: comment_id={del_id}", flush=True)
        except Exception as e:
            print(f"[RAG] 청크 삭제 실패 (comment_id={del_id}): {e}", file=sys.stderr)

if (delete_post_targets or delete_comment_targets) and (not posts and not comments):
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


def to_markdown_table(raw_text):
    src = (raw_text or "").strip()
    if not src:
        return ""

    lines = [ln.strip() for ln in src.splitlines() if ln.strip()]
    if not lines:
        return ""

    rows = []
    for ln in lines:
        if "|" in ln:
            cols = [c.strip() for c in ln.split("|") if c.strip()]
        else:
            cols = [c.strip() for c in re.split(r"\t+|\s{2,}", ln) if c.strip()]
        if cols:
            rows.append(cols)

    if not rows:
        return src
    if len(rows) == 1 or max(len(r) for r in rows) == 1:
        return src

    width = max(len(r) for r in rows)
    normalized = [r + [""] * (width - len(r)) for r in rows]
    header = normalized[0]
    body = normalized[1:]

    md_lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    for row in body:
        md_lines.append("| " + " | ".join(row) + " |")
    return "\n".join(md_lines)


def table_source_for_storage(html, text):
    html_src = (html or "").strip()
    if html_src:
        return html_src, "html"
    md = to_markdown_table(text)
    if md:
        return md, "markdown"
    return (text or "").strip(), "text"


def describe_image_with_gemma(image_path, source_name="", page_number=0):
    """Gemma 비전 모델로 이미지를 분석해 의미 있는 설명 텍스트를 반환한다."""
    fallback = f"{source_name or '문서'}의 {page_number}페이지 이미지"
    if not image_path or not os.path.isfile(image_path):
        return fallback
    try:
        with open(image_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode("utf-8")
        payload = {
            "model": OCR_MODEL,
            "stream": False,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "당신은 문서 이미지 분석 전문가입니다. "
                        "이미지에 포함된 모든 정보(텍스트, 차트, 다이어그램, 표, 아이콘, 수치 등)를 "
                        "빠짐없이 한국어로 상세히 설명하세요. "
                        "검색에 활용될 수 있도록 핵심 키워드와 수치를 반드시 포함하세요."
                    ),
                },
                {
                    "role": "user",
                    "content": "이 이미지의 내용을 상세히 설명해주세요.",
                    "images": [img_b64],
                },
            ],
            "options": {"temperature": 0},
        }
        res = requests.post(OLLAMA_CHAT_URL, json=payload, timeout=300)
        if res.status_code == 200:
            data = res.json() if res.content else {}
            description = ((data.get("message") or {}).get("content") or "").strip()
            if description:
                print(f"[RAG] Gemma 이미지 설명 완료 (page={page_number}): {len(description)}자", flush=True)
                return description
    except Exception as e:
        print(f"[RAG] Gemma 이미지 설명 실패 (page={page_number}): {e}", file=sys.stderr)
    return fallback


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
    vectors = embed_texts(embed_inputs)
    for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
        m = dict(base_meta)
        m["chunk_id"] = i
        m["chunk_index"] = i
        if chunk_prefix:
            m["element_id"] = f"{chunk_prefix}-{i}"
        records.append({
            "vector": list(vector),
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


_SKIP_ITEM_KEYWORDS = {
    '구분', '항목', '세부항목', '세부 항목', '단위', '개수', '단가', '공급가', '공급 가', '비고',
    '소계', '합계', '합 계', '기타', '구 분', '항 목', '세 부 항 목', '단 위', '개 수', '단 가',
    '공 급 가', '비 고', '소 계', '기 타', 'subtotal', 'total', 'item', 'qty', 'unit',
}

def is_currency_cell(text):
    """셀 값이 금액 형태인지 확인: 콤마 구분 숫자 또는 순수 5자리 이상 숫자.
    등록번호(837-39-01338), 전화번호(010-3417-0677) 등은 제외."""
    s = re.sub(r'[₩\s]', '', (text or "").strip())
    # 콤마 구분 숫자: 1,000 ~ 999,999,999,999
    if re.match(r'^\d{1,3}(,\d{3})+$', s):
        return True
    # 순수 5자리 이상 숫자 (하이픈 없음)
    if re.match(r'^\d{5,}$', s):
        return True
    return False


def extract_line_items(text):
    """파이프(|) 구분 테이블 행에서 항목명-금액 쌍을 추출"""
    items = []
    seen = set()
    skip_norm = {re.sub(r'\s+', '', k).lower() for k in _SKIP_ITEM_KEYWORDS}
    for line in (text or "").splitlines():
        parts = [p.strip() for p in line.split('|')]
        if len(parts) < 3:
            continue
        # 뒤쪽 열에서 금액 형태 셀만 추출 (등록번호·전화번호 제외)
        trailing_amounts = []
        for p in parts[-3:]:
            if is_currency_cell(p):
                n = parse_amount_to_int(p)
                if n >= 10000:   # 최소 1만원 이상 (개수/페이지 번호 제외)
                    trailing_amounts.append(n)
        if not trailing_amounts:
            continue
        item_amount = max(trailing_amounts)
        # 헤더/소계 행 스킵: 첫 열이 스킵 키워드면 제외
        first_cell = re.sub(r'\s+', '', parts[0]).lower()
        if first_cell in skip_norm:
            continue
        # 앞쪽 열에서 의미있는 항목명 찾기 (숫자 아닌 텍스트, 3자 이상)
        item_name = None
        for p in parts:
            cleaned = p.strip()
            if not cleaned or re.match(r'^[\d,.\s₩()]+$', cleaned):
                continue
            norm = re.sub(r'\s+', '', cleaned).lower()
            if norm in skip_norm:
                continue
            if len(cleaned) >= 3:
                item_name = cleaned
                if len(cleaned) > 6:  # 더 길고 구체적인 항목명 선호
                    break
        if not item_name:
            continue
        key = (item_name, item_amount)
        if key in seen:
            continue
        seen.add(key)
        items.append({'name': item_name, 'amount': item_amount})
    return items


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


def reconstruct_rows_from_words(page):
    """pdfplumber 단어 위치(bounding box)로 테이블 행을 재구성해 파이프 구분 텍스트 반환.
    extract_tables()가 테이블을 감지하지 못하는 다단 레이아웃 PDF에 대한 fallback."""
    try:
        words = page.extract_words(keep_blank_chars=False, x_tolerance=3, y_tolerance=3)
        if not words:
            return ""
        # Y 좌표(top)를 기준으로 행 그룹화: 근접한 단어는 같은 행으로
        Y_TOLERANCE = 4
        rows_by_y = {}
        for word in words:
            y_key = round(word['top'] / Y_TOLERANCE) * Y_TOLERANCE
            rows_by_y.setdefault(y_key, []).append(word)
        lines = []
        for y_key in sorted(rows_by_y):
            row_words = sorted(rows_by_y[y_key], key=lambda w: w['x0'])
            # 인접 단어를 컬럼으로 병합: X 간격이 좁으면 같은 셀, 넓으면 셀 구분
            cells = []
            current_cell = [row_words[0]['text']]
            prev_x1 = row_words[0]['x1']
            for w in row_words[1:]:
                gap = w['x0'] - prev_x1
                if gap > 15:          # 15pt 이상 간격 → 셀 구분
                    cells.append(" ".join(current_cell))
                    current_cell = [w['text']]
                else:
                    current_cell.append(w['text'])
                prev_x1 = w['x1']
            cells.append(" ".join(current_cell))
            if len(cells) >= 2:       # 2셀 이상인 행만 (단일 셀 줄은 이미 layout text에 포함)
                lines.append(" | ".join(cells))
        return "\n".join(lines)
    except Exception:
        return ""


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
                # 1차: pdfplumber 표 감지 (구조 헤더/소계 등)
                try:
                    for table in (page.extract_tables() or []):
                        rows = []
                        for row in table:
                            row_text = " | ".join(str(cell or "").strip() for cell in row)
                            if row_text.strip():
                                rows.append(row_text)
                        if rows:
                            table_texts.append("\n".join(rows))
                except Exception:
                    pass

                # 2차: 단어 위치 기반 행 재구성 — 항상 추가
                # extract_tables()가 불완전하게 감지하는 경우(특정 행 누락 등)를 보완
                word_rows = reconstruct_rows_from_words(page)
                if word_rows:
                    table_texts.append(word_rows)

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
    def _parse_unstructured(partition_pdf, strategy, infer_table, extract_images, target_pages=None):
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
            optional_keys = []
            if extract_images:
                image_out_dir = os.path.join(
                    os.path.dirname(file_path),
                    f".unstructured_images_{os.path.splitext(os.path.basename(file_path))[0]}",
                )
                os.makedirs(image_out_dir, exist_ok=True)
                # unstructured 버전별 인자 차이를 감안해 우선 전달하고, 미지원이면 아래에서 제거 후 재시도
                kwargs["extract_image_block_output_dir"] = image_out_dir
                optional_keys.append("extract_image_block_output_dir")
            langs = [x.strip() for x in str(OCR_LANG).replace("+", ",").split(",") if x.strip()]
            if langs:
                kwargs["languages"] = langs
                optional_keys.append("languages")
            if target_pages:
                page_list = sorted({safe_int(p, default=0) for p in target_pages if safe_int(p, default=0) > 0})
                if page_list:
                    kwargs["pages"] = page_list
                    optional_keys.append("pages")

            elements = None
            attempt_kwargs = dict(kwargs)
            removed_keys = []
            while True:
                try:
                    elements = partition_pdf(**attempt_kwargs)
                    break
                except TypeError as type_err:
                    removable = next((k for k in reversed(optional_keys) if k in attempt_kwargs), None)
                    if not removable:
                        raise type_err
                    attempt_kwargs.pop(removable, None)
                    removed_keys.append(removable)
            if removed_keys:
                print(
                    f"[RAG] Unstructured 인자 호환 보정({strategy}): 제거={removed_keys}",
                    flush=True,
                )
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
                if image_path and not os.path.isabs(image_path):
                    candidate = os.path.abspath(os.path.join(os.path.dirname(file_path), image_path))
                    if os.path.isfile(candidate):
                        image_path = candidate

            parsed.append({
                "category": category,
                "page_number": page_number,
                "text": text,
                "html": html,
                "image_path": image_path,
            })

        if target_pages:
            target_set = {safe_int(p, default=0) for p in target_pages if safe_int(p, default=0) > 0}
            parsed = [el for el in parsed if safe_int(el.get("page_number"), default=0) in target_set]

        if parsed:
            elapsed = time.time() - started_at
            print(
                f"[RAG] PDF 파싱 완료 (Unstructured {strategy}): {os.path.basename(file_path)} / elements={len(parsed)} / {elapsed:.1f}s",
                flush=True,
            )
        return parsed

    def _enrich_table_text(parsed):
        has_table = any("table" in (el.get("category") or "").lower() for el in parsed)
        if not has_table:
            return parsed
        try:
            plumber_pages = {}
            with pdfplumber.open(file_path) as _pdf:
                for _page in _pdf.pages:
                    wr = reconstruct_rows_from_words(_page)
                    if wr:
                        plumber_pages[_page.page_number] = wr
            for el in parsed:
                if "table" in (el.get("category") or "").lower():
                    page_no = el.get("page_number") or 0
                    supplement = plumber_pages.get(page_no, "")
                    if supplement:
                        el["text"] = (el.get("text") or "") + "\n" + supplement
        except Exception as _e:
            print(f"[RAG] pdfplumber 표 보강 실패: {_e}", file=sys.stderr)
        return parsed

    def _detect_complex_pages_from_fast(fast_parsed):
        page_stats = {}
        for el in fast_parsed:
            page_no = safe_int(el.get("page_number"), default=0)
            if page_no <= 0:
                continue
            st = page_stats.setdefault(page_no, {"text_len": 0, "has_table": False, "has_image": False})
            st["text_len"] += len((el.get("text") or "").strip())
            cat = (el.get("category") or "").lower()
            if "table" in cat:
                st["has_table"] = True
            if "image" in cat:
                st["has_image"] = True

        complex_pages = set()
        for page_no, st in page_stats.items():
            if st["has_table"] or st["has_image"] or st["text_len"] < AUTO_COMPLEX_TEXT_THRESHOLD:
                complex_pages.add(page_no)

        total_pages = 0
        try:
            with pdfplumber.open(file_path) as _pdf:
                total_pages = len(_pdf.pages)
                for idx, _page in enumerate(_pdf.pages, start=1):
                    if idx in complex_pages:
                        continue
                    st = page_stats.get(idx, {"text_len": 0, "has_table": False, "has_image": False})
                    has_image = bool(getattr(_page, "images", None))
                    has_table = False
                    try:
                        has_table = bool(_page.find_tables())
                    except Exception:
                        try:
                            tbs = _page.extract_tables() or []
                            has_table = any(tb for tb in tbs if tb)
                        except Exception:
                            has_table = False
                    if has_image or has_table or st["text_len"] < AUTO_COMPLEX_TEXT_THRESHOLD:
                        complex_pages.add(idx)
        except Exception as e:
            print(f"[RAG] AUTO 복잡 페이지 판별 보강 실패(pdfplumber): {e}", file=sys.stderr)

        complex_sorted = sorted(p for p in complex_pages if p > 0)
        denom = total_pages or max(page_stats.keys(), default=0)
        print(
            f"[RAG] AUTO 복잡 페이지 판별: {len(complex_sorted)}/{denom} pages (text<{AUTO_COMPLEX_TEXT_THRESHOLD} 또는 표/이미지)",
            flush=True,
        )
        return complex_sorted

    def _merge_auto_results(fast_parsed, hi_parsed, complex_pages):
        complex_set = set(complex_pages)
        hi_by_page = {}
        for el in hi_parsed:
            page_no = safe_int(el.get("page_number"), default=0)
            if page_no <= 0:
                continue
            hi_by_page.setdefault(page_no, []).append(el)

        merged = []
        injected = set()
        for el in fast_parsed:
            page_no = safe_int(el.get("page_number"), default=0)
            if page_no in complex_set:
                if page_no not in injected:
                    merged.extend(hi_by_page.get(page_no, []))
                    injected.add(page_no)
                continue
            merged.append(el)

        for page_no in sorted(complex_set):
            if page_no not in injected and hi_by_page.get(page_no):
                merged.extend(hi_by_page[page_no])

        return merged

    try:
        from unstructured.partition.pdf import partition_pdf  # optional
        requested = PDF_PARSE_STRATEGY or "auto"
        if requested in ("off", "fallback", "none"):
            raise RuntimeError("Unstructured PDF 파싱 비활성화 설정")

        if requested == "auto":
            try:
                fast_parsed = _parse_unstructured(partition_pdf, "fast", False, False)
                if fast_parsed:
                    fast_parsed = _enrich_table_text(fast_parsed)
                    complex_pages = _detect_complex_pages_from_fast(fast_parsed)
                    if not complex_pages:
                        print("[RAG] AUTO 전략: 복잡 페이지 없음, fast 결과 사용", flush=True)
                        return fast_parsed

                    hi_parsed = _parse_unstructured(
                        partition_pdf,
                        "hi_res",
                        True,
                        True,
                        target_pages=complex_pages,
                    )
                    hi_parsed = _enrich_table_text(hi_parsed)
                    merged = _merge_auto_results(fast_parsed, hi_parsed, complex_pages)
                    if merged:
                        print(
                            f"[RAG] AUTO 전략 적용 완료: fast={len(fast_parsed)}, hi_res_subset={len(hi_parsed)}, merged={len(merged)}",
                            flush=True,
                        )
                        return merged
            except Exception as e:
                print(f"[RAG] AUTO 전략 실패, 일반 전략 fallback: {e}", flush=True)
            strategies = [("hi_res", True, True), ("fast", False, False)]
        elif requested == "fast":
            strategies = [("fast", False, False)]
        else:
            # default: hi_res — 이미지 추출 활성화 (슬라이드 덱 이미지/표 감지)
            strategies = [("hi_res", True, True), ("fast", False, False)]

        for strategy, infer_table, extract_images in strategies:
            try:
                parsed = _parse_unstructured(partition_pdf, strategy, infer_table, extract_images)
                if parsed:
                    return _enrich_table_text(parsed)
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
            table_source, table_source_format = table_source_for_storage(html, text)
            content = summarize_table(html or text)
            if not content:
                continue
            amount_signal_texts.append((table_source or content))
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
                "original_content": table_source,
                "table_source_format": table_source_format,
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
            meta["original_content"] = table_source
            meta["element_id"] = f"tbl-{page_number}-{idx}"
            apply_amount_meta(meta, f"{content}\n{table_source}")
            local_chunks += append_text_chunks(records, content, meta, chunk_prefix=meta["element_id"])
            continue

        if "image" in category:
            if image_path and os.path.isfile(image_path):
                caption = describe_image_with_gemma(image_path, source_name, page_number)
            else:
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
        line_items = extract_line_items(merged_amount_text)
        item_lines = ""
        if line_items:
            item_lines = "\n세부 항목별 금액:\n" + "\n".join(
                f"- {it['name']}: {it['amount']:,}원" for it in line_items
            )
        amount_summary = (
            f"[견적 금액 요약]\n"
            f"문서: {source_name}\n"
            f"소계: {format_amount_won(amount_fields['amount_subtotal'])}\n"
            f"부가세: {format_amount_won(amount_fields['amount_vat'])}\n"
            f"합계: {format_amount_won(amount_fields['amount_total'])}\n"
            f"{item_lines}\n"
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


def load_txt_file(file_path):
    try:
        with open(file_path, "rb") as f:
            raw = f.read()
    except Exception as e:
        print(f"[RAG] TXT 읽기 실패 ({file_path}): {e}", file=sys.stderr)
        return ""

    for enc in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
        try:
            return raw.decode(enc).strip()
        except Exception:
            continue
    return raw.decode("latin-1", errors="ignore").strip()


def ingest_txt(records, *, post_id, channel_id, attachment_id, comment_id, txt_path, file_name):
    if not txt_path or not os.path.isfile(txt_path):
        if txt_path:
            print(f"[RAG] TXT 파일 없음: {txt_path}", file=sys.stderr)
        return 0

    text = load_txt_file(txt_path)
    if not text:
        return 0

    source_name = file_name or os.path.basename(txt_path)
    file_hash = calc_file_hash(txt_path)

    meta = metadata_base(
        post_id=post_id,
        channel_id=channel_id,
        attachment_id=attachment_id,
        comment_id=comment_id,
        source=source_name,
        file_name=source_name,
        file_hash=file_hash,
    )
    meta["type"] = "txt"
    meta["page_number"] = 0
    meta["element_id"] = f"txt-{attachment_id or post_id or comment_id}"

    count = append_text_chunks(records, text, meta, chunk_prefix=meta["element_id"])
    print(f"[RAG] TXT 학습 완료: {os.path.basename(txt_path)} ({count}청크)", flush=True)
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
        steps += len(post.get("txts", []) or [])
    for comment in comments:
        steps += 1
        steps += len(comment.get("pdfs", []) or [])
        steps += len(comment.get("words", []) or [])
        steps += len(comment.get("txts", []) or [])
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

    # TXT 첨부
    for txt_info in post.get("txts", []):
        total_chunks += ingest_txt(
            records,
            post_id=post_id,
            channel_id=channel_id,
            attachment_id=txt_info.get("id") or "",
            comment_id="",
            txt_path=txt_info.get("path") or "",
            file_name=txt_info.get("file_name") or "",
        )
        progress.step(label="게시글 TXT")

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

    # 댓글 TXT
    for txt_info in comment.get("txts", []):
        total_chunks += ingest_txt(
            records,
            post_id=post_id,
            channel_id=channel_id,
            attachment_id=txt_info.get("id") or "",
            comment_id=comment_id,
            txt_path=txt_info.get("path") or "",
            file_name=txt_info.get("file_name") or "",
        )
        progress.step(label="댓글 TXT")


if records:
    table.add(records)
    print(f"[RAG] 저장 완료 — {total_chunks}청크 / {len(posts)}개 게시글 / {len(comments)}개 댓글", flush=True)
else:
    print("[RAG] 저장할 레코드 없음", flush=True)
progress.step(label="저장")
progress.complete()
