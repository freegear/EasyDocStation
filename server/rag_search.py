#!/usr/bin/env python3
"""
RAG 검색 스크립트
stdin: {"config": {...}, "query": "질문 텍스트", "limit": 3}
stdout: JSON 배열 — [{"text": "...", "score": float, "metadata": {...}}, ...]
"""

import sys
import json
import os
import platform

try:
    payload = json.loads(sys.stdin.read())
except Exception as e:
    print(json.dumps({"error": f"입력 파싱 실패: {e}"}))
    sys.exit(1)

cfg   = payload.get("config", {})
query = payload.get("query", "")
limit = int(payload.get("limit", 3))

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

LANCEDB_PATH = cfg.get("lancedb_path") or default_lancedb_path()
VECTOR_SIZE  = int(cfg.get("vector_size", 1024))

if not query.strip():
    print(json.dumps([]))
    sys.exit(0)

import torch
from sentence_transformers import SentenceTransformer
import lancedb

def resolve_device():
    forced = (os.getenv("EASYDOC_RAG_DEVICE", "auto") or "auto").strip().lower()
    if forced not in ("", "auto"):
        return forced
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"

# 임베딩 모델 로드
device = resolve_device()
embed_model = SentenceTransformer("BAAI/bge-m3", device=device)

# LanceDB 연결 및 검색
if not os.path.exists(LANCEDB_PATH):
    print(json.dumps([]))
    sys.exit(0)

db = lancedb.connect(LANCEDB_PATH)
tables = db.table_names() if hasattr(db, 'table_names') else db.list_tables()
if "my_rag_table" not in tables:
    print(json.dumps([]))
    sys.exit(0)

table = db.open_table("my_rag_table")
if len(table) <= 1:          # init 레코드만 있으면 skip
    print(json.dumps([]))
    sys.exit(0)

query_vec = embed_model.encode(query, show_progress_bar=False).tolist()
results   = table.search(query_vec).limit(limit).to_list()

output = []
for r in results:
    meta = r.get("metadata") or {}
    output.append({
        "text":  r["text"],
        "score": float(r.get("_distance", 0)),
        "metadata": {
            "post_id":          meta.get("post_id", ""),
            "chunk_id":         meta.get("chunk_id", 0),
            "chunk_index":      meta.get("chunk_index", meta.get("chunk_id", 0)),
            "type":             meta.get("type", ""),
            "channel_id":       meta.get("channel_id", ""),
            "attachment_id":    meta.get("attachment_id", ""),
            "comment_id":       meta.get("comment_id", ""),
            "source":           meta.get("source", ""),
            "file_name":        meta.get("file_name", ""),
            "page_number":      meta.get("page_number", 0),
            "element_id":       meta.get("element_id", ""),
            "original_content": meta.get("original_content", ""),
            "img_path":         meta.get("img_path", ""),
            "doc_version":      meta.get("doc_version", ""),
            "file_hash":        meta.get("file_hash", ""),
            "amount_total":     meta.get("amount_total", 0),
            "amount_subtotal":  meta.get("amount_subtotal", 0),
            "amount_vat":       meta.get("amount_vat", 0),
            "currency":         meta.get("currency", ""),
            "amount_candidates": meta.get("amount_candidates", ""),
        }
    })

print(json.dumps(output, ensure_ascii=False))
