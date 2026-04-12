#!/usr/bin/env python3
"""
RAG 학습 스크립트
표준 입력으로 JSON을 받아 텍스트 게시글 및 PDF 파일을 임베딩 후 LanceDB에 저장합니다.

입력 JSON 형식:
{
  "config": {
    "lancedb_path": "...",
    "chunk_size": 800,
    "chunk_overlap": 100,
    "vector_size": 1024
  },
  "posts": [
    {
      "id": "post-uuid",
      "content": "게시글 텍스트",
      "source": "post",
      "pdfs": ["/path/to/file.pdf"]   // PDF 첨부파일 경로 목록
    }
  ]
}
"""

import sys
import json
import os

# ─── 입력 파싱 ────────────────────────────────────────────────
try:
    payload = json.loads(sys.stdin.read())
except Exception as e:
    print(f"[ERROR] 입력 JSON 파싱 실패: {e}", file=sys.stderr)
    sys.exit(1)

cfg   = payload.get("config", {})
posts = payload.get("posts", [])

LANCEDB_PATH  = cfg.get("lancedb_path",  "/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB")
CHUNK_SIZE    = int(cfg.get("chunk_size",   800))
CHUNK_OVERLAP = int(cfg.get("chunk_overlap", 100))
VECTOR_SIZE   = int(cfg.get("vector_size",  1024))

if not posts:
    print("[RAG] 학습할 데이터가 없습니다.")
    sys.exit(0)

# ─── 라이브러리 로드 ──────────────────────────────────────────
from pypdf import PdfReader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
import lancedb
import pyarrow as pa

# ─── 임베딩 모델 로드 (BGE-M3 + Mac MPS 가속) ────────────────
import torch
MODEL_NAME = "BAAI/bge-m3"
device = 'mps' if torch.backends.mps.is_available() else 'cpu'
print(f"[RAG] 임베딩 모델 로드 중: {MODEL_NAME} (device={device}) ...", flush=True)
embed_model = SentenceTransformer(MODEL_NAME, device=device)
print(f"[RAG] 임베딩 모델 로드 완료 (device={device})", flush=True)

# ─── LanceDB 연결 ─────────────────────────────────────────────
os.makedirs(LANCEDB_PATH, exist_ok=True)
db = lancedb.connect(LANCEDB_PATH)

# 테이블이 없으면 VECTOR_SIZE 에 맞춰 생성
TABLE_NAME = "my_rag_table"

# 테이블이 없거나 스키마가 다르면 올바른 스키마로 재생성
# metadata 구조: {"post_id": str, "chunk_id": int, "type": str}
def ensure_table(vector_size):
    init_data = [{
        "vector": [0.0] * vector_size,
        "text": "__init__",
        "metadata": {"post_id": "", "chunk_id": 0, "type": "system"}
    }]
    existing = db.table_names() if hasattr(db, 'table_names') else db.list_tables()
    if TABLE_NAME not in existing:
        tbl = db.create_table(TABLE_NAME, data=init_data)
        print(f"[RAG] 테이블 생성 완료 (dim={vector_size})")
        return tbl
    # 기존 테이블 스키마 확인
    tbl = db.open_table(TABLE_NAME)
    meta_field = next((f for f in tbl.schema if f.name == "metadata"), None)
    meta_subfields = [sf.name for sf in meta_field.type] if meta_field else []
    vec_size = tbl.schema.field("vector").type.list_size
    # chunk_id / type 필드가 없거나 vector 크기가 다르면 재생성
    if "chunk_id" not in meta_subfields or "type" not in meta_subfields or vec_size != vector_size:
        print(f"[RAG] 스키마 불일치 → 테이블 재생성 (dim={vector_size})")
        tbl = db.create_table(TABLE_NAME, data=init_data, mode="overwrite")
    return tbl

table = ensure_table(VECTOR_SIZE)

# ─── 텍스트 분할기 ───────────────────────────────────────────
text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE,
    chunk_overlap=CHUNK_OVERLAP,
    separators=["\n\n", "\n", ".", " "],  # 단락 → 줄바꿈 → 마침표 순으로 분할
    length_function=len,
)

# ─── PDF 텍스트 추출 ──────────────────────────────────────────
def load_pdf(file_path):
    try:
        reader = PdfReader(file_path)
        text = ""
        for page in reader.pages:
            extracted = page.extract_text()
            if extracted:
                text += extracted + "\n"
        return text.strip()
    except Exception as e:
        print(f"[RAG] PDF 읽기 실패 ({file_path}): {e}", file=sys.stderr)
        return ""

# ─── 학습 실행 ───────────────────────────────────────────────
total_chunks = 0
records = []

for post in posts:
    post_id = post.get("id", "unknown")
    texts_to_train = []  # (text, source_label) 튜플 목록

    # 게시글 본문 (텍스트 학습)
    content = (post.get("content") or "").strip()
    if content:
        texts_to_train.append((content, "manual_text"))

    # PDF 첨부파일 학습 (13.3.1)
    for pdf_path in post.get("pdfs", []):
        if os.path.isfile(pdf_path):
            pdf_text = load_pdf(pdf_path)
            if pdf_text:
                texts_to_train.append((pdf_text, "pdf"))
                print(f"[RAG] PDF 추출 완료: {os.path.basename(pdf_path)} ({len(pdf_text)}자)")
        else:
            print(f"[RAG] PDF 파일 없음: {pdf_path}", file=sys.stderr)

    for raw_text, data_type in texts_to_train:
        chunks = text_splitter.split_text(raw_text)
        if not chunks:
            continue

        vectors = embed_model.encode(chunks, batch_size=16, show_progress_bar=False)

        for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
            records.append({
                "vector": vector.tolist(),
                "text": chunk,
                "metadata": {
                    "post_id": post_id,
                    "chunk_id": i,
                    "type": data_type      # "manual_text" 또는 "pdf"
                }
            })
        total_chunks += len(chunks)
        print(f"[RAG] post={post_id} type={data_type} → {len(chunks)}청크", flush=True)

# ─── LanceDB에 저장 ───────────────────────────────────────────
if records:
    table.add(records)
    print(f"[RAG] 저장 완료 — {total_chunks}청크 / {len(posts)}개 게시글")
else:
    print("[RAG] 저장할 레코드 없음")
