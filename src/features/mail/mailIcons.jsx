export function MailIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M3 8l8.2 5.47a1.5 1.5 0 001.6 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

export function MenuIcon({ type, filled }) {
  const paths = {
    all: 'M4 6h16M4 12h16M4 18h16',
    star: 'M11.48 3.5l2.12 4.3 4.74.69-3.43 3.34.81 4.72-4.24-2.23-4.24 2.23.81-4.72-3.43-3.34 4.74-.69 2.12-4.3z',
    draft: 'M5 4h9l5 5v11H5V4zM14 4v5h5M8 14h8M8 17h5',
    search: 'M11 5a6 6 0 104.24 10.24L20 20',
    sent: 'M4 12l16-8-5 16-3-7-8-1z',
    trash: 'M6 7h12M10 7V5h4v2m-6 0l1 13h6l1-13',
    todo: 'M5 13l4 4L19 7',
    inbox: 'M4 5h16v11l-3 3H7l-3-3V5zM4 14h5l1.5 2h3L15 14h5',
    folder: 'M3 6h7l2 2h9v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z',
    back: 'M15 6l-6 6 6 6',
    refresh: 'M4 4v6h6M20 20v-6h-6M5 15a7 7 0 0011.9 3.9M19 9A7 7 0 007.1 5.1',
    settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2m12 0h2M12 4v2m0 12v2m-5.66-13.66l1.42 1.42m8.48 8.48l1.42 1.42m0-11.32l-1.42 1.42m-8.48 8.48l-1.42 1.42',
    reply: 'M9 14l-5-5 5-5v3h6a5 5 0 015 5v2',
    forward: 'M15 14l5-5-5-5v3H9a5 5 0 00-5 5v2',
    archive: 'M4 7h16M5 7l1 13h12l1-13M9 11h6',
    ai: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.4 6.4L22 12l-6.6 2.6L13 21l-2.4-6.4L4 12l6.6-2.6L13 3z',
    chevronRight: 'M9 5l7 7-7 7',
    chevronDown: 'M6 9l6 6 6-6',
    tag: 'M3 7l0 5.17a2 2 0 00.59 1.42l6.83 6.83a2 2 0 002.82 0l4.17-4.17a2 2 0 000-2.82L10.58 6.6A2 2 0 009.17 6L4 6a1 1 0 00-1 1zM7 10h.01',
    board: 'M4 5h16v10H4V5zm4 14h8M8 9h8M8 12h5',
    note: 'M5 4h14v16H5V4zm3 4h8M8 12h8M8 16h5',
  }

  const fillFolder = filled && type === 'folder'
  return (
    <svg className="w-4 h-4 flex-shrink-0" fill={fillFolder ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={paths[type] || paths.folder} />
    </svg>
  )
}

export function ToolbarButton({ icon, label, primary = false, onClick, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-bold transition-all ${
        primary
          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500'
          : 'border border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900'
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <MenuIcon type={icon} />
      <span>{label}</span>
    </button>
  )
}
