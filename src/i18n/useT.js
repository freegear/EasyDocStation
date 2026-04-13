import { useAuth } from '../contexts/AuthContext'
import { translations } from './index'

export function useT() {
  const { language } = useAuth()
  const lang = language || 'ko'
  // 언어 사전이 없으면 한국어로 폴백
  return translations[lang] ?? translations['ko']
}
