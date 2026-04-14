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
  site_admin:    'bg-red-100 text-red-600 border-red-200',
  team_admin:    'bg-orange-100 text-orange-600 border-orange-200',
  channel_admin: 'bg-blue-100 text-blue-600 border-blue-200',
  user:          'bg-gray-100 text-gray-400 border-gray-200',
}

export const ROLE_OPTIONS = [
  { value: 'site_admin',    label: '사이트 관리자' },
  { value: 'team_admin',    label: '팀 관리자' },
  { value: 'channel_admin', label: '채널 관리자' },
  { value: 'user',          label: '사용자' },
]
