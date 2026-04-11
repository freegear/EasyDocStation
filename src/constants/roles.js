export const ROLES = {
  SITE_ADMIN:    'site_admin',
  TEAM_ADMIN:    'team_admin',
  CHANNEL_ADMIN: 'channel_admin',
  USER:          'user',
}

export const ROLE_LABELS = {
  site_admin:    '사이트 관리자',
  team_admin:    '팀 관리자',
  channel_admin: '채널 관리자',
  user:          '사용자',
}

export const ROLE_BADGE = {
  site_admin:    'bg-red-500/15 text-red-400 border-red-500/25',
  team_admin:    'bg-orange-500/15 text-orange-400 border-orange-500/25',
  channel_admin: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  user:          'bg-white/8 text-white/40 border-white/10',
}

export const ROLE_OPTIONS = [
  { value: 'site_admin',    label: '사이트 관리자' },
  { value: 'team_admin',    label: '팀 관리자' },
  { value: 'channel_admin', label: '채널 관리자' },
  { value: 'user',          label: '사용자' },
]
