from openai import OpenAI

# 1. 로컬 Ollama 서버로 연결 설정
client = OpenAI(
    base_url='http://localhost:11434/v1', # 로컬 API 엔드포인트
    api_key='ollama', # 로컬이므로 아무 값이나 입력해도 무관
)

# 2. API 호출
response = client.chat.completions.create(
  model="gemma4:e4b",
  messages=[
    {"role": "system", "content": "당신은 유능한 비서입니다."},
    {"role": "user", "content": "Gemma 4를 로컬 API로 호출하는 방법을 알려줘."}
  ]
)

print(response.choices[0].message.content)
