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

MAX_VECTOR_DISTANCE = 1.0

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


def normalize_id_list(values):
    if not isinstance(values, list):
        return []
    out = []
    seen = set()
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def sql_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def apply_channel_acl(search, allowed_channel_ids):
    allowed = normalize_id_list(allowed_channel_ids)
    if not allowed:
        return None
    clause = "metadata.channel_id IN (" + ", ".join(sql_quote(v) for v in allowed) + ")"
    try:
        return search.where(clause, prefilter=True)
    except TypeError:
        return search.where(clause)


def build_acl_clause(meta_subfields, allowed_channel_ids, scope_ctx):
    """스코프 인지형 ACL WHERE 절을 만든다 (UploadFolder.md 23.1).

    - 기존 게시글/댓글 청크: channel_id 로만 판정(기존 동작 보존).
    - 폴더 청크(access_scope 필드 보유): 모두/팀/채널/개인 + effective_security_level.
    스코프 필드가 없는 테이블(v2)에서는 채널 절만 반환해 라이브 검색을 그대로 유지한다.
    """
    allowed = normalize_id_list(allowed_channel_ids)
    parts = []
    if allowed:
        parts.append("metadata.channel_id IN (" + ", ".join(sql_quote(v) for v in allowed) + ")")

    has_scope = "access_scope" in (meta_subfields or [])
    if has_scope and scope_ctx:
        uid = str(scope_ctx.get("user_id") or "").strip()
        team_ids = normalize_id_list(scope_ctx.get("team_ids", []))
        sec = int(scope_ctx.get("security_level", 0) or 0)
        is_admin = bool(scope_ctx.get("is_site_admin"))


        scope_or = ["metadata.access_scope = 'all'"]
        if uid:
            scope_or.append("(metadata.access_scope = 'personal' AND metadata.owner_id = " + sql_quote(uid) + ")")
        if team_ids:
            scope_or.append("(metadata.access_scope = 'team' AND metadata.scope_team_id IN (" +
                            ", ".join(sql_quote(v) for v in team_ids) + "))")
        if allowed:
            scope_or.append("(metadata.access_scope = 'channel' AND metadata.scope_channel_id IN (" +
                            ", ".join(sql_quote(v) for v in allowed) + "))")
        folder_clause = "(" + " OR ".join(scope_or) + ")"
        # 보안등급: 폴더 청크에만 적용(비폴더 청크는 access_scope='' 로 통과)
        if not is_admin:
            folder_clause = "(" + folder_clause + " AND metadata.effective_security_level <= " + str(sec) + ")"
        parts.append(folder_clause)

    if not parts:
        return None
    return " OR ".join(parts)


def apply_acl(search, where_clause):
    if not where_clause:
        return None
    try:
        return search.where(where_clause, prefilter=True)
    except TypeError:
        return search.where(where_clause)


def with_folder_group_filter(where_clause, meta_subfields, folder_group_ids):
    """같은 폴더(folder_group_id) 형제 청크만 조회하도록 필터를 AND 결합한다 (UploadFolder.md 23.3).

    ACL(where_clause)은 그대로 유지한 채, folder_group_id ∈ (...) 조건을 함께 건다.
    스코프 필드가 없는 테이블(v2)에서는 folder_group_id 필드도 없으므로 원본 절을 반환한다.
    """
    groups = normalize_id_list(folder_group_ids)
    if not groups or "folder_group_id" not in (meta_subfields or []):
        return where_clause
    group_clause = "metadata.folder_group_id IN (" + ", ".join(sql_quote(v) for v in groups) + ")"
    if not where_clause:
        return group_clause
    return "(" + where_clause + ") AND " + group_clause


def with_target_filter(where_clause, meta_subfields, target_filter):
    """현재 게시글/댓글/이미지처럼 명시적으로 지정된 대상을 벡터 검색 전에 제한한다."""
    if not isinstance(target_filter, dict):
        return where_clause
    clauses = []
    field_map = {
        "post_id": "post_id",
        "comment_id": "comment_id",
        "attachment_id": "attachment_id",
        "channel_id": "channel_id",
    }
    for key, field in field_map.items():
        value = str(target_filter.get(key) or "").strip()
        if value and field in (meta_subfields or []):
            clauses.append("metadata." + field + " = " + sql_quote(value))
    types = target_filter.get("type")
    if not isinstance(types, list):
        types = [types] if types else []
    types = normalize_id_list(types)
    if types and "type" in (meta_subfields or []):
        clauses.append("metadata.type IN (" + ", ".join(sql_quote(v) for v in types) + ")")
    if not clauses:
        return where_clause
    target_clause = " AND ".join(clauses)
    return "(" + where_clause + ") AND " + target_clause if where_clause else target_clause


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
        allowed_channel_ids = normalize_id_list(payload.get("allowed_channel_ids", []))
        scope_ctx = payload.get("scope_context") or {}
        has_scope_ctx = bool(str(scope_ctx.get("user_id") or "").strip() or scope_ctx.get("team_ids"))
        folder_group_ids = normalize_id_list(payload.get("folder_group_ids", []))
        target_filter = payload.get("target_filter") or {}
        has_exact_target = any(
            str(target_filter.get(k) or "").strip()
            for k in ("post_id", "comment_id", "attachment_id")
        )
        include_status = bool(payload.get("include_status"))
        lancedb_path = cfg.get("lancedb_path", "")
        table_name = cfg.get("table_name") or cfg.get("rag_table_name") or "my_rag_table"

        def respond_search(results, ok=True, reason="ok"):
            if include_status:
                self._respond(200, {
                    "ok": bool(ok),
                    "reason": reason,
                    "table_name": table_name,
                    "results": results,
                })
            else:
                self._respond(200, results)

        if not query.strip() or not lancedb_path or (not allowed_channel_ids and not has_scope_ctx):
            respond_search([], True, "invalid_query_or_acl")
            return

        if not os.path.exists(lancedb_path):
            respond_search([], False, "lancedb_missing")
            return

        try:
            db = get_db(lancedb_path)
            tables = db.table_names() if hasattr(db, 'table_names') else db.list_tables()
            if table_name not in tables:
                respond_search([], False, "table_missing")
                return

            table = db.open_table(table_name)
            if len(table) <= 1:
                respond_search([], False, "empty_table")
                return

            meta_field = next((f for f in table.schema if f.name == "metadata"), None)
            meta_subfields = [sf.name for sf in meta_field.type] if meta_field else []

            query_vec = embed_model.encode(query, show_progress_bar=False).tolist()
            where_clause = build_acl_clause(meta_subfields, allowed_channel_ids, scope_ctx if has_scope_ctx else None)
            where_clause = with_target_filter(where_clause, meta_subfields, target_filter)
            # 형제 문서 확장(23.3): folder_group_id 필터를 ACL 위에 AND 결합
            where_clause = with_folder_group_filter(where_clause, meta_subfields, folder_group_ids)
            search = apply_acl(table.search(query_vec), where_clause)
            if search is None:
                respond_search([], True, "invalid_acl")
                return
            results = search.limit(limit).to_list()

            output = []
            for r in results:
                distance = float(r.get("_distance", 0))
                if distance >= MAX_VECTOR_DISTANCE and not has_exact_target:
                    continue
                meta = r.get("metadata") or {}
                output.append({
                    "text":  r["text"],
                    "score": distance,
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
                        "schema_version":    meta.get("schema_version", 1),
                        "document_kind":     meta.get("document_kind", ""),
                        "source_ext":        meta.get("source_ext", ""),
                        "converted_by":      meta.get("converted_by", ""),
                        "converted_format":  meta.get("converted_format", ""),
                        "parser_version":    meta.get("parser_version", ""),
                        "fallback_used":     meta.get("fallback_used", False),
                        "fallback_pipeline": meta.get("fallback_pipeline", ""),
                        "sheet_name":        meta.get("sheet_name", ""),
                        "row_range":         meta.get("row_range", ""),
                        "column_headers":    meta.get("column_headers", ""),
                        "slide_number":      meta.get("slide_number", 0),
                        "slide_title":       meta.get("slide_title", ""),
                        "xml_path":          meta.get("xml_path", ""),
                        "html_title":        meta.get("html_title", ""),
                        "heading_path":      meta.get("heading_path", ""),
                        "archive_id":        meta.get("archive_id", ""),
                        "archive_file_path": meta.get("archive_file_path", ""),
                        "inner_source_ext":  meta.get("inner_source_ext", ""),
                        "access_scope":            meta.get("access_scope", ""),
                        "scope_team_id":           meta.get("scope_team_id", ""),
                        "scope_channel_id":        meta.get("scope_channel_id", ""),
                        "dataset_id":              meta.get("dataset_id", ""),
                        "folder_document_id":      meta.get("folder_document_id", ""),
                        "folder_group_id":         meta.get("folder_group_id", ""),
                        "folder_path":             meta.get("folder_path", ""),
                        "relative_path":           meta.get("relative_path", ""),
                        "effective_security_level": meta.get("effective_security_level", 0),
                        "owner_id":                meta.get("owner_id", ""),
                    }
                })
            respond_search(output, True, "ok")

        except Exception as e:
            print(f"[RAG Server] 검색 오류: {e}", flush=True)
            if include_status:
                self._respond(200, {
                    "ok": False,
                    "reason": "search_error",
                    "table_name": table_name,
                    "error": str(e),
                    "results": [],
                })
            else:
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
