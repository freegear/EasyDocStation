CREATE TABLE IF NOT EXISTS easydocstation.posts (
    channel_id text,
    created_at timestamp,
    attachments_1 text,
    attachments_10 text,
    attachments_2 text,
    attachments_3 text,
    attachments_4 text,
    attachments_5 text,
    attachments_6 text,
    attachments_7 text,
    attachments_8 text,
    attachments_9 text,
    author_id int,
    child_post_id text,
    content text,
    id text,
    is_edited boolean,
    next_post_id text,
    parent_id text,
    prev_post_id text,
    security_level int,
    updated_at timestamp,
    PRIMARY KEY (channel_id, created_at)
) WITH ID = 70de9900-3661-11f1-acd9-9710f8215d28
    AND CLUSTERING ORDER BY (created_at DESC)
    AND additional_write_policy = '99p'
    AND allow_auto_snapshot = true
    AND bloom_filter_fp_chance = 0.01
    AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
    AND cdc = false
    AND comment = ''
    AND compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
    AND compression = {'chunk_length_in_kb': '16', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
    AND memtable = 'default'
    AND crc_check_chance = 1.0
    AND default_time_to_live = 0
    AND extensions = {}
    AND gc_grace_seconds = 864000
    AND incremental_backups = true
    AND max_index_interval = 2048
    AND memtable_flush_period_in_ms = 0
    AND min_index_interval = 128
    AND read_repair = 'BLOCKING'
    AND speculative_retry = '99p';
