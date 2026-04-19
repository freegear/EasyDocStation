#!/usr/bin/env python3
"""
RAG 영구 검색 서버
임베딩 모델을 한 번만 로드하고 HTTP 요청을 처리합니다.
서브프로세스를 매번 띄우는 방식 대신 이 서버를 사용하면
검색당 1~2초의 모델 로드 시간을 절약할 수 있습니다.

사용: python3 rag_server.py [PORT]  (기본값 5001)
"""

import sys
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5001

# ── 임베딩 모델 한 번만 로드 ───────────────────────────────────
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

device = resolve_device()
print(f"[RAG Server] 임베딩 모델 로드 중 (device={device})...", flush=True)
embed_model = SentenceTransformer("BAAI/bge-m3", device=device)
print("[RAG Server] 임베딩 모델 로드 완료", flush=True)
_embed_lock = threading.Lock()

# DB 연결 캐시 (모델만 캐시, 테이블은 매번 열어 최신 데이터 반영)
_db_cache = {}

def get_db(lancedb_path):
    if lancedb_path not in _db_cache:
        _db_cache[lancedb_path] = lancedb.connect(lancedb_path)
    return _db_cache[lancedb_path]


class RagHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # 액세스 로그 억제

    def do_GET(self):
        # 헬스체크
        self._respond(200, {"status": "ok"})

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except Exception as e:
            self._respond(400, {"error": str(e)})
            return

        action = str(payload.get("action") or "").strip().lower()
        if self.path == '/embed' or action == 'embed':
            texts = payload.get("texts") or []
            if not isinstance(texts, list):
                self._respond(400, {"error": "texts must be a list"})
                return
            if not texts:
                self._respond(200, {"vectors": []})
                return
            try:
                batch_size = int(payload.get("batch_size", 16))
            except Exception:
                batch_size = 16
            if batch_size <= 0:
                batch_size = 16
            try:
                with _embed_lock:
                    vectors = embed_model.encode(
                        [str(t or "") for t in texts],
                        batch_size=batch_size,
                        show_progress_bar=False,
                    )
                self._respond(200, {"vectors": vectors.tolist()})
            except Exception as e:
                print(f"[RAG Server] 임베딩 오류: {e}", flush=True)
                self._respond(500, {"error": str(e)})
            return

        cfg          = payload.get("config", {})
        query        = payload.get("query", "")
        limit        = int(payload.get("limit", 5))
        lancedb_path = cfg.get("lancedb_path", "")

        if not query.strip() or not lancedb_path:
            self._respond(200, [])
            return

        if not os.path.exists(lancedb_path):
            self._respond(200, [])
            return

        try:
            db = get_db(lancedb_path)
            tables = db.table_names() if hasattr(db, 'table_names') else db.list_tables()
            if "my_rag_table" not in tables:
                self._respond(200, [])
                return

            table = db.open_table("my_rag_table")
            if len(table) <= 1:
                self._respond(200, [])
                return

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
            self._respond(200, output)

        except Exception as e:
            print(f"[RAG Server] 검색 오류: {e}", flush=True)
            self._respond(500, {"error": str(e)})

    def _respond(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), RagHandler)
    print(f"[RAG Server] 포트 {PORT} 에서 시작됨", flush=True)
    sys.stdout.flush()
    server.serve_forever()
