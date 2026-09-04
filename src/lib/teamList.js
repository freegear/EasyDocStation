export function buildTeamList(data, unreadCounts = {}) {
  const teams = Array.isArray(data) ? data : []

  return teams.map(team => ({
    ...team,
    channels: (Array.isArray(team?.channels) ? team.channels : []).map(channel => ({
      ...channel,
      unread: unreadCounts?.[channel.id] ?? 0,
    })),
    // Direct messages are loaded by the dedicated DM API. Space-list loading must
    // not depend on access to the space member directory.
    directMessages: Array.isArray(team?.directMessages) ? team.directMessages : [],
    icon: team?.icon || '🏢',
  }))
}
