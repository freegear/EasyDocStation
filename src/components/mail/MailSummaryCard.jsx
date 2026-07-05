// 읽기 전용 메일 요약 카드 (MailService.md 24.4.3 / 24.11)
// 게시판(게시글)에서 메일 요약 + 본문 전체를 인라인 카드로 렌더한다.
// 메일 뷰어의 MailSummaryPanel 레이아웃을 미러링하되, 시간 편집/캘린더 등록 컨트롤은 제외한 정적 표시.
// 본문은 메일 뷰어와 동일하게 sandbox iframe으로 렌더(신뢰 불가 HTML → XSS 차단).
// 외부 라이브러리 없이 자체 컴포넌트로 구현(이 카드는 앱 고유 요약 스키마).

import { useState } from 'react'

const CARD_LABELS = {
  ko: {
    schedule: '일정', date: '날짜', time: '시간', location: '장소',
    participants: '참석 대상', notes: '비고', keyPoints: '중요 포인트',
    detail: '중요 내용 요약', actions: '액션 아이템 / 시간', noInfo: '확인된 내용 없음',
    from: '보낸 사람', sentAt: '날짜', openOriginal: '원본 메일 열기',
    body: '본문', noBody: '본문이 없습니다.',
  },
  en: {
    schedule: 'Schedule', date: 'Date', time: 'Time', location: 'Location',
    participants: 'Participants', notes: 'Notes', keyPoints: 'Key points',
    detail: 'Summary', actions: 'Action items / Time', noInfo: 'No confirmed information',
    from: 'From', sentAt: 'Date', openOriginal: 'Open original mail',
    body: 'Body', noBody: 'No content.',
  },
  ja: {
    schedule: '日程', date: '日付', time: '時間', location: '場所',
    participants: '参加対象', notes: '備考', keyPoints: '重要ポイント',
    detail: '重要内容の要約', actions: 'アクション項目 / 時間', noInfo: '確認できる内容なし',
    from: '送信者', sentAt: '日付', openOriginal: '元のメールを開く',
    body: '本文', noBody: '本文がありません。',
  },
}

function getCardLabels(lang) {
  return CARD_LABELS[lang] || CARD_LABELS.ko
}

function MailIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M3 8l8.2 5.47a1.5 1.5 0 001.6 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

function SummaryValue({ label, value, noInfo }) {
  const empty = !value || value === noInfo || value === '확인된 내용 없음'
  return (
    <div className="rounded-md border border-indigo-100 bg-white px-3 py-2">
      <div className="text-[11px] font-extrabold text-indigo-500">{label}</div>
      <div className={`mt-1 text-sm font-bold ${empty ? 'text-gray-400' : 'text-gray-800'}`}>{value || noInfo}</div>
    </div>
  )
}

// 딥링크 클릭 → URL 이동 없이 앱 내부 메일 화면으로 연다.
function openMailDeepLink(event, href, data) {
  event?.preventDefault?.()
  event?.stopPropagation?.()
  if (typeof window === 'undefined') return

  const dataMessageId = String(data?.messageId || data?.message_id || '').trim()
  const dataTenantId = String(data?.tenantId || data?.tenant_id || '').trim()
  if (dataMessageId && dataTenantId) {
    window.dispatchEvent(new CustomEvent('easy-mail-open-link', {
      detail: {
        messageId: dataMessageId,
        tenantId: dataTenantId,
        targetLanguage: data?.targetLanguage || '',
      },
    }))
    return
  }

  if (!href) return
  let url
  try {
    url = new URL(href, window.location.origin)
  } catch {
    return
  }
  const linkMessageId = url.searchParams.get('mailMessageId') || url.searchParams.get('messageId') || ''
  const linkTenantId = url.searchParams.get('mailTenantId') || url.searchParams.get('tenantId') || ''
  if (linkMessageId && linkTenantId) {
    window.dispatchEvent(new CustomEvent('easy-mail-open-link', {
      detail: {
        href: url.toString(),
        messageId: linkMessageId,
        tenantId: linkTenantId,
        targetLanguage: url.searchParams.get('mailTargetLanguage') || '',
      },
    }))
  }
}

// 메일 본문 전체 렌더 (MailService.md 24.11.1) — 메일 뷰어와 동일한 sandbox iframe + 자동 높이.
// body_html은 신뢰 불가 외부 HTML이므로 sandbox(스크립트 미실행)로만 렌더한다.
function MailBodyFrame({ bodyHtml, bodyText, noBodyLabel }) {
  const [height, setHeight] = useState(320)

  if (bodyHtml) {
    const srcDoc = `<base target="_blank"><style>html,body{overflow:hidden!important;margin:0;padding:0;}</style>${bodyHtml}`
    const handleLoad = (event) => {
      const iframe = event.currentTarget
      const resize = () => {
        try {
          const doc = iframe.contentDocument
          if (!doc) return
          if (doc.documentElement) doc.documentElement.style.overflow = 'hidden'
          if (doc.body) doc.body.style.overflow = 'hidden'
          const h = Math.max(
            80,
            doc.documentElement?.scrollHeight || 0,
            doc.body?.scrollHeight || 0,
            doc.documentElement?.offsetHeight || 0,
            doc.body?.offsetHeight || 0,
          )
          setHeight(h)
        } catch {
          setHeight(320)
        }
      }
      resize()
      window.setTimeout(resize, 250)
      window.setTimeout(resize, 1000)
    }
    return (
      <iframe
        title="mail-body"
        sandbox="allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
        srcDoc={srcDoc}
        scrolling="no"
        onLoad={handleLoad}
        style={{ height }}
        className="block w-full rounded-md border border-indigo-100 bg-white"
      />
    )
  }

  const text = String(bodyText || '').trim()
  return (
    <pre className="whitespace-pre-wrap break-words rounded-md border border-indigo-100 bg-white px-3 py-2 text-sm leading-7 text-gray-800">
      {text || noBodyLabel}
    </pre>
  )
}

export default function MailSummaryCard({ data }) {
  if (!data || typeof data !== 'object') return null
  const lang = data.targetLanguage || 'ko'
  const t = getCardLabels(lang)
  const summary = data.summary || null
  const schedule = summary?.schedule || {}
  const deepLink = data.deepLink || ''

  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 text-sm text-gray-800">
      {/* 메일 헤더 */}
      <header className="border-b border-indigo-100 pb-3">
        <div className="flex items-start gap-2">
          <MailIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-500" />
          <h3 className="text-base font-extrabold leading-6 text-gray-950">{data.subject || '(제목 없음)'}</h3>
        </div>
        <div className="mt-2 grid gap-0.5 text-xs text-gray-500">
          {data.from && (
            <div><span className="font-bold text-gray-600">{t.from}</span> {data.from}</div>
          )}
          {data.date && (
            <div><span className="font-bold text-gray-600">{t.sentAt}</span> {data.date}</div>
          )}
        </div>
      </header>

      {summary && (
        <>
          {/* 일정 */}
          <section className="mt-4">
            <h4 className="text-sm font-extrabold text-gray-950">{t.schedule}</h4>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <SummaryValue label={t.date} value={schedule.date} noInfo={t.noInfo} />
              <SummaryValue label={t.time} value={schedule.time} noInfo={t.noInfo} />
              <SummaryValue label={t.location} value={schedule.location} noInfo={t.noInfo} />
              <SummaryValue label={t.participants} value={schedule.participants} noInfo={t.noInfo} />
              <SummaryValue label={t.notes} value={schedule.notes} noInfo={t.noInfo} />
            </div>
          </section>

          {/* 중요 포인트 */}
          <section className="mt-5">
            <h4 className="text-sm font-extrabold text-gray-950">{t.keyPoints}</h4>
            <ul className="mt-2 space-y-1.5">
              {(summary.keyPoints || [t.noInfo]).map((item, index) => (
                <li key={`${item}-${index}`} className="flex gap-2 leading-6">
                  <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-400" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* 중요 내용 요약 */}
          <section className="mt-5">
            <h4 className="text-sm font-extrabold text-gray-950">{t.detail}</h4>
            <p className="mt-2 leading-7">{summary.summary || t.noInfo}</p>
          </section>

          {/* 액션 아이템 / 시간 (정적) */}
          <section className="mt-5">
            <h4 className="text-sm font-extrabold text-gray-950">{t.actions}</h4>
            <div className="mt-2 divide-y divide-indigo-100 rounded-md border border-indigo-100 bg-white">
              {(summary.actionItems || [{ task: t.noInfo, time: t.noInfo }]).map((item, index) => {
                const timeEmpty = !item.time || item.time === t.noInfo || item.time === '확인된 내용 없음'
                return (
                  <div key={`${item.task}-${index}`} className="grid gap-1 px-3 py-2 lg:grid-cols-[1fr_auto] lg:items-center">
                    <span className="font-bold text-gray-800">{item.task || t.noInfo}</span>
                    <span className={`text-xs font-extrabold lg:text-right ${timeEmpty ? 'text-gray-400' : 'text-indigo-600'}`}>
                      {item.time || t.noInfo}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}

      {/* 메일 본문 전체 (MailService.md 24.11) */}
      {(data.bodyHtml || data.bodyText) && (
        <section className="mt-5">
          <h4 className="text-sm font-extrabold text-gray-950">{t.body}</h4>
          <div className="mt-2">
            <MailBodyFrame bodyHtml={data.bodyHtml} bodyText={data.bodyText} noBodyLabel={t.noBody} />
          </div>
        </section>
      )}

      {/* 원본 메일 열기 */}
      {(deepLink || (data.messageId && data.tenantId)) && (
        <div className="mt-4 border-t border-indigo-100 pt-3">
          <button
            type="button"
            onClick={(event) => openMailDeepLink(event, deepLink, data)}
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm font-extrabold text-indigo-700 transition hover:bg-indigo-50"
          >
            <MailIcon className="h-4 w-4" />
            <span>{t.openOriginal}</span>
          </button>
        </div>
      )}
    </div>
  )
}
