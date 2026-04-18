# RAGLLM.md

RAG와 LLM을 연동한 시스템을 구축하다.

# 0 RULE

# 0.1 500 라인 RULE
코드 파일은 500라인을 넘어서면 절대 안된다.
500라인을 넘어서는 경우 기능을 재분할 하여서 파일을 나눈다.

# 1. RAGLLM 구조

이 모듈을 따로 구현한다.
너무 한군데에 모여 있어서 운영이 안된다.

# 1.1 RAGLLM TOP 구조

3가지 포트가 있다. 
입력 : 파일을 입력하는 채널
출력 : Retrieval 채널
설정 : RAGLLM setting 채널

이다.

# 1.2 RAG 파이프라인의 5대 핵심 모듈

시스템을 다음 5개의 독립적인 모듈로 분리하여 설계하십시오. 
각 모듈은 서로의 구현 세부 사항을 몰라도 상호작용할 수 있도록 **추상화(Interface)**되어야 합니다.

# 1.2.1 모듈 명칭,역할,주요 구현 요소

Ingestion Engine,문서를 읽고 정제하여 벡터화,"Loader, Text Splitter, Embedding Model"
Vector Store,벡터 데이터 저장 및 관리,"LanceDB"
Retrieval Engine,질문과 관련된 데이터 검색,"Hybrid Search (Semantic + Keyword), Reranker"
Generation Engine,컨텍스트를 조합하여 답변 생성,"Prompt Template, LLM Client, Memory"
Evaluation Engine,RAG 성능 측정 및 피드백,"RAGAS, Arize Phoenix 등"

# 1.2.2 모듈화를 위한 기술적 설계 전략

# 1.2.2.1 인터페이스 기반 설계 (Strategy Pattern)

각 모듈을 클래스 형태로 만들고, Base 클래스(추상 클래스)를 정의하여 교체 가능하게 만듭니다.

# 1.2.2.2 의존성 주입 (Dependency Injection)

Main Orchestrator에서 필요한 모듈을 주입받아 사용하도록 합니다. 
이렇게 하면 VectorDBRetriever를 HybridRetriever로 교체하더라도 메인 로직을 수정할 필요가 없습니다.

# 1.2.2.3 파이프라인 관리 (LangChain )

직접 모든 것을 처음부터 구현하기보다는, LangChain의 LCEL (LangChain Expression Language)를 사용해서 구현한다.

# 1.2.3 추천하는 데이터 흐름 (Workflow)

Ingestion Pipeline: 비동기 작업(Celery, Redis Queue 등)으로 처리합니다. 문서 업로드 → 파싱 → 청킹(Chunking) → 임베딩 → DB 저장 과정을 별도 작업으로 분리하세요.

Query Pipeline: 사용자 질문 → 검색(Retriever) → 리랭킹(Reranker) → 프롬프트 생성(Prompt Factory) → LLM 응답 생성을 순차적으로 실행합니다.

State Management: 대화형 서비스라면 Session History를 관리하는 독립적인 모듈을 두어 이전 대화 맥락을 쉽게 불러올 수 있게 설계하세요.

# 1.2.4 확장성을 위한 팁

Reranking 모듈 추가: 검색 결과의 정확도를 높이기 위해, 검색된 데이터 중 상위 항목만 LLM에 전달하도록 Reranker 모듈을 중간에 끼워 넣으세요.

Eval-driven Development: Evaluation 모듈을 구축하여 변경 사항이 있을 때마다 답변의 정확도(Faithfulness, Answer Relevance)를 자동으로 테스트하는 환경을 만드세요.


# 1.3 입력 

입력은 파일을 전달한다. 
- 전달한 파일은 PDF , Image , OCR 대상 이미지
등으로 나눈다.

