import { useState } from 'react'

export default function LanguageFlag({ lang, className = 'h-5 w-5' }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span className="inline-flex min-w-5 items-center justify-center text-[11px] font-bold leading-none">
        {lang.shortLabel}
      </span>
    )
  }

  return (
    <img
      src={lang.flagSrc}
      alt={lang.label}
      title={lang.label}
      className={`${className} inline-block rounded-[2px] object-cover shadow-sm ring-1 ring-black/10`}
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
