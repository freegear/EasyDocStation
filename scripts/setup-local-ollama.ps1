$ErrorActionPreference = "Stop"

$Model = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { "gemma4:e4b" }

Write-Host "[INFO] Local AgenticAI용 Ollama 설치를 시작합니다. (model=$Model)"

function Test-OllamaReady {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -Method Get -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Ensure-OllamaInstalled {
  if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host "[1/3] Ollama 이미 설치됨"
    return
  }

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "[1/3] winget으로 Ollama 설치"
    winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
    return
  }

  Write-Host "[1/3] winget을 찾을 수 없어 공식 설치 스크립트 실행"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://ollama.com/install.ps1 -useb | iex"
}

function Ensure-OllamaServer {
  Write-Host "[2/3] Ollama 서버 확인"
  if (Test-OllamaReady) {
    Write-Host "[INFO] Ollama 서버가 이미 실행 중입니다."
    return
  }

  try {
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 2
  } catch {
    Write-Warning "ollama serve 시작 시도 실패: $($_.Exception.Message)"
  }

  if (-not (Test-OllamaReady)) {
    Write-Warning "Ollama 서버 연결 실패. 모델 설치는 건너뜁니다."
    return
  }
}

function Ensure-Model {
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Warning "ollama 명령을 찾지 못했습니다. 모델 설치를 건너뜁니다."
    return
  }
  if (-not (Test-OllamaReady)) {
    Write-Warning "Ollama 서버가 준비되지 않아 모델 설치를 건너뜁니다."
    return
  }
  Write-Host "[3/3] 모델 설치: $Model"
  try {
    ollama pull $Model
  } catch {
    Write-Warning "모델 설치 실패: $($_.Exception.Message)"
  }
}

Ensure-OllamaInstalled
Ensure-OllamaServer
Ensure-Model

Write-Host "[DONE] Local AgenticAI용 Ollama 설치 단계가 완료되었습니다."
