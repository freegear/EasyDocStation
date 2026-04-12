#!/usr/bin/env python3
"""
RAG 검색 스크립트
stdin: {"config": {...}, "query": "질문 텍스트", "limit": 3}
stdout: JSON 배열 — [{"text": "...", "score": float, "metadata": {...}}, ...]
"""

import sys
import json

try:
    payload = json.loads(sys.stdin.read())
except Exception as e:
    print(json.dumps({"error": f"입력 파싱 실패: {e}"}))
    sys.exit(1)

cfg   = payload.get("config", {})
query = payload.get("query", "")
limit = int(payload.get("limit", 3))

LANCEDB_PATH = cfg.get("lancedb_path", "/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB")
VECTOR_SIZE  = int(cfg.get("vector_size", 1024))

if not query.strip():
    print(json.dumps([]))
    sys.exit(0)

import torch
from sentence_transformers import SentenceTransformer
import lancedb

# 임베딩 모델 로드
device = 'mps' if torch.backends.mps.is_available() else 'cpu'
embed_model = SentenceTransformer("BAAI/bge-m3", device=device)

# LanceDB 연결 및 검색
import os
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
    meta = r["metadata"]
    output.append({
        "text":     r["text"],
        "score":    float(r.get("_distance", 0)),
            "post_id":       meta.get("post_id", ""),
            "chunk_id":      meta.get("chunk_id", 0),
            "type":          meta.get("type", ""),
            "channel_id":    meta.get("channel_id", ""),
            "attachment_id": meta.get("attachment_id", ""),
            "comment_id":    meta.get("comment_id", ""),
        }
    })

print(json.dumps(output, ensure_ascii=False))
