import { useAuth } from '../contexts/AuthContext'
import { translations } from './index'

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override ?? base
  }

  const merged = { ...base }
  for (const key of Object.keys(override)) {
    const baseValue = base[key]
    const overrideValue = override[key]
    merged[key] = deepMerge(baseValue, overrideValue)
  }
  return merged
}

export function useT() {
  const { language } = useAuth()
  const lang = language || 'ko'
  const ko = translations.ko ?? {}
  const en = translations.en ?? {}
  const selected = translations[lang] ?? {}

  // ko를 기본으로, en 보강, 선택 언어 최종 적용
  // (선택 언어에 없는 키는 영어/한국어로 안전 폴백)
  return deepMerge(deepMerge(ko, en), selected)
}
