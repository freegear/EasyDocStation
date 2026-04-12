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

cfg      = payload.get("config", {})
posts    = payload.get("posts", [])
comments = payload.get("comments", [])

LANCEDB_PATH  = cfg.get("lancedb_path",  "/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB")
CHUNK_SIZE    = int(cfg.get("chunk_size",   800))
CHUNK_OVERLAP = int(cfg.get("chunk_overlap", 100))
VECTOR_SIZE   = int(cfg.get("vector_size",  1024))

if not posts and not comments:
    print("[RAG] 학습할 데이터가 없습니다.")
    sys.exit(0)

# ─── 라이브러리 로드 ──────────────────────────────────────────
from pypdf import PdfReader
from langchain_community.document_loaders import Docx2txtLoader
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
# metadata 구조: {"post_id": str, "chunk_id": int, "type": str, "channel_id": str, "attachment_id": str, "comment_id": str}
def ensure_table(vector_size):
    init_data = [{
        "vector": [0.0] * vector_size,
        "text": "__init__",
        "metadata": {
            "post_id": "", 
            "chunk_id": 0, 
            "type": "system", 
            "channel_id": "",
            "attachment_id": "",
            "comment_id": ""
        }
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
    # 필수 필드가 없거나 vector 크기가 다르면 재생성
    required = ["channel_id", "chunk_id", "type", "attachment_id", "comment_id"]
    needs_recreate = False
    for r in required:
        if r not in meta_subfields:
            needs_recreate = True
            break
    
    if needs_recreate or vec_size != vector_size:
        print(f"[RAG] 스키마 불일치 → 테이블 재생성 (필드 업데이트, dim={vector_size})")
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

# ─── Word 텍스트 추출 (Docx2txtLoader) ───────────────────────
def load_word(file_path):
    try:
        loader = Docx2txtLoader(file_path)
        docs = loader.load()
        text = "\n".join(doc.page_content for doc in docs if doc.page_content)
        return text.strip()
    except Exception as e:
        print(f"[RAG] Word 읽기 실패 ({file_path}): {e}", file=sys.stderr)
        return ""

# ─── 학습 실행 ───────────────────────────────────────────────
total_chunks = 0
records = []

for post in posts:
    post_id    = post.get("id", "unknown")
    channel_id = post.get("channel_id", "")
    texts_to_train = []  # (text, source_label) 튜플 목록

    # 게시글 본문 (텍스트 학습)
    content = (post.get("content") or "").strip()
    if content:
        texts_to_train.append((content, "manual_text"))

    # PDF 첨부파일 학습
    for pdf_info in post.get("pdfs", []):
        pdf_id   = pdf_info.get("id")
        pdf_path = pdf_info.get("path")
        if pdf_path and os.path.isfile(pdf_path):
            pdf_text = load_pdf(pdf_path)
            if pdf_text:
                chunks = text_splitter.split_text(pdf_text)
                if chunks:
                    vectors = embed_model.encode(chunks, batch_size=16, show_progress_bar=False)
                    for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
                        records.append({
                            "vector": vector.tolist(),
                            "text": chunk,
                            "metadata": {
                                "post_id":       post_id,
                                "chunk_id":      i,
                                "type":          "pdf",
                                "channel_id":    channel_id,
                                "attachment_id": pdf_id or "",
                                "comment_id":    "",
                            }
                        })
                    total_chunks += len(chunks)
                print(f"[RAG] PDF 추출/학습 완료: {os.path.basename(pdf_path)} ({len(pdf_text)}자)")
        elif pdf_path:
            print(f"[RAG] PDF 파일 없음: {pdf_path}", file=sys.stderr)

    # Word 첨부파일 학습 (.docx / .doc)
    for word_info in post.get("words", []):
        word_id   = word_info.get("id")
        word_path = word_info.get("path")
        if word_path and os.path.isfile(word_path):
            word_text = load_word(word_path)
            if word_text:
                chunks = text_splitter.split_text(word_text)
                if chunks:
                    vectors = embed_model.encode(chunks, batch_size=16, show_progress_bar=False)
                    for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
                        records.append({
                            "vector": vector.tolist(),
                            "text": chunk,
                            "metadata": {
                                "post_id":       post_id,
                                "chunk_id":      i,
                                "type":          "word",
                                "channel_id":    channel_id,
                                "attachment_id": word_id or "",
                                "comment_id":    "",
                            }
                        })
                    total_chunks += len(chunks)
                print(f"[RAG] Word 추출/학습 완료: {os.path.basename(word_path)} ({len(word_text)}자)")
        elif word_path:
            print(f"[RAG] Word 파일 없음: {word_path}", file=sys.stderr)

    # 게시글 본문 (텍스트 학습)
    content = (post.get("content") or "").strip()
    if content:
        chunks = text_splitter.split_text(content)
        if chunks:
            vectors = embed_model.encode(chunks, batch_size=16, show_progress_bar=False)
            for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
                records.append({
                    "vector": vector.tolist(),
                    "text": chunk,
                    "metadata": {
                        "post_id":       post_id,
                        "chunk_id":      i,
                        "type":          "manual_text",
                        "channel_id":    channel_id,
                        "attachment_id": "",
                        "comment_id":    "",
                    }
                })
            total_chunks += len(chunks)
        print(f"[RAG] post={post_id} text → {len(chunks)}청크", flush=True)

# ─── 댓글 학습 ───────────────────────────────────────────────
for comment in comments:
    comment_id = comment.get("id", "unknown")
    post_id    = comment.get("post_id", "")
    channel_id = comment.get("channel_id", "")
    content    = (comment.get("content") or "").strip()

    # PDF 첨부파일 학습
    for pdf_info in comment.get("pdfs", []):
        pdf_id   = pdf_info.get("id")
        pdf_path = pdf_info.get("path")
        if pdf_path and os.path.isfile(pdf_path):
            pdf_text = load_pdf(pdf_path)
            if pdf_text:
                chunks = text_splitter.split_text(pdf_text)
                if chunks:
                    vectors = embed_model.encode(chunks, batch_size=16, show_progress_bar=False)
                    for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
                        records.append({
                            "vector": vector.tolist(),
                            "text": chunk,
                            "metadata": {
                                "post_id":       post_id,
                                "chunk_id":      i,
                                "type":          "comment_pdf",
                                "channel_id":    channel_id,
                                "attachment_id": pdf_id or "",
                                "comment_id":    comment_id,
                            }
                        })
                    total_chunks += len(chunks)
                print(f"[RAG] comment={comment_id} PDF 학습 완료: {os.path.basename(pdf_path)}", flush=True)
        elif pdf_path:
            print(f"[RAG] comment={comment_id} PDF 파일 없음: {pdf_path}", file=sys.stderr)

    # Word 첨부파일 학습
    for word_info in comment.get("words", []):
        word_id   = word_info.get("id")
        word_path = word_info.get("path")
        if word_path and os.path.isfile(word_path):
            word_text = load_word(word_path)
            if word_text:
                chunks = text_splitter.split_text(word_text)
                if chunks:
                    vectors = embed_model.encode(chunks, batch_size=16, show_progress_bar=False)
                    for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
                        records.append({
                            "vector": vector.tolist(),
                            "text": chunk,
                            "metadata": {
                                "post_id":       post_id,
                                "chunk_id":      i,
                                "type":          "comment_word",
                                "channel_id":    channel_id,
                                "attachment_id": word_id or "",
                                "comment_id":    comment_id,
                            }
                        })
                    total_chunks += len(chunks)
                print(f"[RAG] comment={comment_id} Word 학습 완료: {os.path.basename(word_path)}", flush=True)
        elif word_path:
            print(f"[RAG] comment={comment_id} Word 파일 없음: {word_path}", file=sys.stderr)

    # 텍스트 내용 학습
    if not content:
        continue

    chunks = text_splitter.split_text(content)
    if not chunks:
        continue

    vectors = embed_model.encode(chunks, batch_size=16, show_progress_bar=False)

    for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
        records.append({
            "vector": vector.tolist(),
            "text": chunk,
            "metadata": {
                "post_id":       post_id,
                "chunk_id":      i,
                "type":          "comment",
                "channel_id":    channel_id,
                "attachment_id": "",
                "comment_id":    comment_id,
            }
        })
    total_chunks += len(chunks)
    print(f"[RAG] comment={comment_id} post={post_id} → {len(chunks)}청크", flush=True)

# ─── LanceDB에 저장 ───────────────────────────────────────────
if records:
    table.add(records)
    print(f"[RAG] 저장 완료 — {total_chunks}청크 / {len(posts)}개 게시글 / {len(comments)}개 댓글")
else:
    print("[RAG] 저장할 레코드 없음")
