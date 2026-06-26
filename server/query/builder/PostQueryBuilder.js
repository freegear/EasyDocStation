class PostQueryBuilder {
  build(intent) {
    return {
      channelId: intent.channelId,
      from: new Date(intent.dateRange.from),
      to: new Date(intent.dateRange.to),
      limit: 200,
      order: 'created_at_asc',
    }
  }
}

module.exports = PostQueryBuilder
