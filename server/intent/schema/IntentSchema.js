const ACTIONS = Object.freeze({
  SUMMARIZE: 'summarize',
  LOCATE: 'locate',
})

const TARGETS = Object.freeze({
  POSTS: 'posts',
  DOCUMENTS: 'documents',
  RESOURCES: 'resources',
  ATTACHMENTS: 'attachments',
  DIAGRAM: 'diagram',
  IMAGE: 'image',
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
    matchMode: null,
    confidence: 0,
  }
}

module.exports = {
  ACTIONS,
  TARGETS,
  SCOPES,
  createEmptyIntent,
}
