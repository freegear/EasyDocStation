function readBoolFlag(name, defaultVal = false) {
  const val = process.env[name]
  if (val === undefined || val === null) return defaultVal
  return !['0', 'false', 'no', ''].includes(String(val).toLowerCase())
}

const flags = {
  // Stage 1: 참여자 사전 등록 UI 활성화
  USE_SPEAKER_REGISTRATION: readBoolFlag('USE_SPEAKER_REGISTRATION', true),
  // Stage 2: Voice embedding 기반 화자 자동 매칭
  USE_VOICE_EMBEDDING: readBoolFlag('USE_VOICE_EMBEDDING', false),
  // Stage 3: 화자 수동 보정 UI 활성화
  USE_SPEAKER_CORRECTION: readBoolFlag('USE_SPEAKER_CORRECTION', true),
  // Stage 4: 커스텀 diarization 모델 사용 (MODEL_PATH 필요)
  USE_CUSTOM_MODEL: readBoolFlag('USE_CUSTOM_MODEL', false),
}

module.exports = flags
