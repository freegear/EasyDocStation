CREATE TABLE IF NOT EXISTS easydocstation.calendar_events (
    owner_id int,
    id text,
    all_day boolean,
    color text,
    created_at timestamp,
    end_dt text,
    invitees text,
    memo text,
    remind_dt text,
    remind_repeat text,
    repeat text,
    security_level int,
    series_id text,
    start_dt text,
    title text,
    updated_at timestamp,
    PRIMARY KEY (owner_id, id)
) WITH ID = 8eae4b50-38fb-11f1-a00f-07aef13ce00b
    AND CLUSTERING ORDER BY (id ASC)
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
