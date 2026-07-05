import { MailIcon } from './mailIcons'

function resolveMailBrand(provider, host = '') {
  if (provider === 'gmail' || provider === 'naver' || provider === 'apple') return provider
  const h = String(host || '').toLowerCase()
  if (h.includes('gmail') || h.includes('googlemail')) return 'gmail'
  if (h.includes('icloud') || h.includes('me.com')) return 'apple'
  if (h.includes('naver')) return 'naver'
  return 'other'
}

export function ProviderLogo({ provider, host, size = 'md' }) {
  const brand = resolveMailBrand(provider, host)
  const boxClass = size === 'sm' ? 'h-5 w-5 rounded' : 'h-10 w-10 rounded-lg'
  const gmailClass = size === 'sm' ? 'h-3.5 w-4' : 'h-6 w-7'
  const appleClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-6 w-6'
  const mailClass = size === 'sm' ? 'h-3 w-3' : 'h-5 w-5'
  const naverTextClass = size === 'sm' ? 'text-[11px]' : 'text-lg'

  if (brand === 'gmail') {
    return (
      <span className={`flex ${boxClass} flex-shrink-0 items-center justify-center bg-white shadow-sm ring-1 ring-gray-200`}>
        <svg className={gmailClass} viewBox="0 0 28 22" aria-hidden="true">
          <path fill="#EA4335" d="M2.5 0h3L14 6.6 22.5 0h3v22h-5V8.5L14 13.5 7.5 8.5V22h-5V0z" />
          <path fill="#FBBC04" d="M2.5 0 14 8.9v4.6L2.5 4.6V0z" />
          <path fill="#34A853" d="M25.5 0 14 8.9v4.6L25.5 4.6V0z" />
          <path fill="#4285F4" d="M20.5 22V8.5l5-3.9V22h-5z" />
          <path fill="#C5221F" d="M2.5 22V4.6l5 3.9V22h-5z" />
        </svg>
      </span>
    )
  }
  if (brand === 'naver') {
    return (
      <span className={`flex ${boxClass} flex-shrink-0 items-center justify-center bg-[#03C75A] ${naverTextClass} font-black text-white shadow-sm`}>
        N
      </span>
    )
  }
  if (brand === 'apple') {
    return (
      <span className={`flex ${boxClass} flex-shrink-0 items-center justify-center bg-gray-950 text-white shadow-sm`}>
        <svg className={appleClass} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M16.5 1.8c.1 1.3-.4 2.5-1.2 3.4-.8.9-2.1 1.6-3.3 1.5-.1-1.2.4-2.5 1.1-3.3.9-1 2.3-1.7 3.4-1.6zM20.4 17.1c-.5 1.1-.8 1.6-1.5 2.6-1 1.5-2.4 3.3-4.1 3.3-1.5 0-1.9-1-4-1s-2.6 1-4 1c-1.7 0-3-1.7-4-3.2-2.8-4.2-3.1-9.1-1.4-11.7 1.2-1.8 3-2.8 4.7-2.8 1.8 0 2.9 1 4.3 1 1.4 0 2.3-1 4.4-1 1.6 0 3.3.9 4.5 2.4-4 2.2-3.3 7.9.7 9.4z" />
        </svg>
      </span>
    )
  }
  return (
    <span className={`flex ${boxClass} flex-shrink-0 items-center justify-center bg-indigo-50 text-indigo-500 shadow-sm ring-1 ring-indigo-100`}>
      <MailIcon className={mailClass} />
    </span>
  )
}
