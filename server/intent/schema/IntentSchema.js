const ACTIONS = Object.freeze({
  SUMMARIZE: 'summarize',
})

const TARGETS = Object.freeze({
  POSTS: 'posts',
})

const SCOPES = Object.freeze({
  CURRENT_CHANNEL: 'current_channel',
})

function createEmptyIntent() {
  return {
    action: null,
    target: null,
    scope: SCOPES.CURRENT_CHANNEL,
    dateRange: null,
    author: null,
    keywords: [],
    confidence: 0,
  }
}

module.exports = {
  ACTIONS,
  TARGETS,
  SCOPES,
  createEmptyIntent,
}
