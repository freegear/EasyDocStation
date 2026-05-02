#!/usr/bin/env node
require('dotenv').config()

const { Pool } = require('pg')
const { getPostgresPoolOptions } = require('../runtimeDbConfig')
const { encryptSecret } = require('../lib/secrets')

const ENCRYPTED_PREFIX = 'enc:v1:'

function isEncrypted(value) {
  return String(value || '').startsWith(ENCRYPTED_PREFIX)
}

function normalizeSecret(value) {
  const text = String(value || '').trim()
  return text || null
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const pool = new Pool(getPostgresPoolOptions())
  const client = await pool.connect()

  try {
    const { rows } = await client.query(`
      SELECT id, username, email, kakaotalk_api_key, line_channel_access_token
      FROM users
      WHERE kakaotalk_api_key IS NOT NULL
         OR line_channel_access_token IS NOT NULL
      ORDER BY id ASC
    `)

    let scanned = 0
    let changedUsers = 0
    let changedKakao = 0
    let changedLine = 0

    if (!dryRun) await client.query('BEGIN')

    for (const user of rows) {
      scanned += 1
      const kakaoPlain = normalizeSecret(user.kakaotalk_api_key)
      const linePlain = normalizeSecret(user.line_channel_access_token)

      const nextKakao = kakaoPlain && !isEncrypted(kakaoPlain) ? encryptSecret(kakaoPlain) : user.kakaotalk_api_key
      const nextLine = linePlain && !isEncrypted(linePlain) ? encryptSecret(linePlain) : user.line_channel_access_token

      const willChangeKakao = nextKakao !== user.kakaotalk_api_key
      const willChangeLine = nextLine !== user.line_channel_access_token
      if (!willChangeKakao && !willChangeLine) continue

      changedUsers += 1
      if (willChangeKakao) changedKakao += 1
      if (willChangeLine) changedLine += 1

      if (!dryRun) {
        await client.query(
          `UPDATE users
           SET kakaotalk_api_key = $1,
               line_channel_access_token = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [nextKakao, nextLine, user.id]
        )
      }
    }

    if (!dryRun) await client.query('COMMIT')

    console.log(`[SNS Secret Migration] mode=${dryRun ? 'DRY_RUN' : 'EXECUTE'}`)
    console.log(`[SNS Secret Migration] scanned=${scanned} changed_users=${changedUsers} kakaotalk=${changedKakao} line=${changedLine}`)
    if (dryRun) {
      console.log('[SNS Secret Migration] No DB changes were written.')
    } else {
      console.log('[SNS Secret Migration] Completed successfully.')
    }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) {}
    console.error('[SNS Secret Migration] Failed:', err.message)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main()
