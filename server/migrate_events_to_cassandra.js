/**
 * PostgreSQL calendar_events → Cassandra 마이그레이션 스크립트
 * 실행: node server/migrate_events_to_cassandra.js
 */
const { Pool } = require('pg')
const cassandra = require('cassandra-driver')
const { randomUUID } = require('crypto')
require('dotenv').config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const cassClient = new cassandra.Client({
  contactPoints: ['127.0.0.1'],
  localDataCenter: 'datacenter1',
  queryOptions: { prepare: true },
})
const keyspace = 'easydocstation'

async function migrate() {
  console.log('🔌 DB 연결 중...')
  await cassClient.connect()
  await cassClient.execute(`USE ${keyspace}`)

  // Cassandra 테이블 보장 (없으면 생성)
  await cassClient.execute(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      owner_id       int,
      id             text,
      title          text,
      color          text,
      all_day        boolean,
      start_dt       text,
      end_dt         text,
      repeat         text,
      invitees       text,
      memo           text,
      security_level int,
      remind_dt      text,
      remind_repeat  text,
      series_id      text,
      created_at     timestamp,
      updated_at     timestamp,
      PRIMARY KEY (owner_id, id)
    )
  `)
  await cassClient.execute(`
    CREATE TABLE IF NOT EXISTS calendar_invitations (
      invitee_id int,
      event_id   text,
      owner_id   int,
      PRIMARY KEY (invitee_id, event_id)
    )
  `)
  console.log('✅ Cassandra 테이블 확인 완료')

  // PostgreSQL에서 전체 이벤트 읽기
  const { rows } = await pool.query(
    'SELECT * FROM calendar_events ORDER BY id ASC'
  )
  console.log(`📦 PostgreSQL에서 ${rows.length}건 발견`)

  if (rows.length === 0) {
    console.log('이전할 데이터가 없습니다.')
    return
  }

  // PG id(정수) → Cassandra id(UUID) 매핑 테이블 (series_id 재사용을 위해)
  const idMap = new Map()

  let success = 0
  let failed  = 0

  for (const row of rows) {
    try {
      // 기존 series_id 유지, 없으면 null
      const seriesId = row.series_id || null

      // 정수 ID → UUID 변환 (or 재사용)
      const newId = randomUUID()
      idMap.set(row.id, newId)

      const now = row.created_at ? new Date(row.created_at) : new Date()
      const updatedAt = row.updated_at ? new Date(row.updated_at) : now

      await cassClient.execute(
        `INSERT INTO ${keyspace}.calendar_events
           (owner_id, id, title, color, all_day, start_dt, end_dt, repeat, invitees, memo,
            security_level, remind_dt, remind_repeat, series_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.owner_id,
          newId,
          row.title || '',
          row.color || '#4f46e5',
          row.all_day || false,
          typeof row.start_dt === 'object' ? JSON.stringify(row.start_dt) : (row.start_dt || '{}'),
          typeof row.end_dt   === 'object' ? JSON.stringify(row.end_dt)   : (row.end_dt   || '{}'),
          row.repeat || 'none',
          typeof row.invitees === 'object' ? JSON.stringify(row.invitees) : (row.invitees || '[]'),
          row.memo || '',
          row.security_level || 0,
          typeof row.remind_dt === 'object' ? JSON.stringify(row.remind_dt) : (row.remind_dt || '{}'),
          row.remind_repeat || 'none',
          seriesId,
          now,
          updatedAt,
        ],
        { prepare: true }
      )

      // 초대 테이블 기록
      let invitees = []
      try {
        invitees = typeof row.invitees === 'string'
          ? JSON.parse(row.invitees)
          : (row.invitees || [])
      } catch (_) {}

      for (const inv of invitees) {
        if (inv.id && inv.id !== row.owner_id) {
          await cassClient.execute(
            `INSERT INTO ${keyspace}.calendar_invitations (invitee_id, event_id, owner_id) VALUES (?,?,?)`,
            [inv.id, newId, row.owner_id], { prepare: true }
          )
        }
      }

      success++
      process.stdout.write(`\r  진행: ${success + failed}/${rows.length}`)
    } catch (err) {
      failed++
      console.error(`\n  ❌ id=${row.id} 실패:`, err.message)
    }
  }

  console.log(`\n\n✅ 완료 — 성공: ${success}건, 실패: ${failed}건`)

  if (failed === 0) {
    console.log('\n💡 마이그레이션 성공. PostgreSQL의 calendar_events 테이블은')
    console.log('   데이터 확인 후 직접 삭제하거나 보관하세요.')
    console.log('   (DROP TABLE calendar_events; — PostgreSQL에서 실행)')
  }
}

migrate()
  .catch(err => {
    console.error('❌ 마이그레이션 오류:', err)
    process.exit(1)
  })
  .finally(async () => {
    await pool.end()
    await cassClient.shutdown()
  })
