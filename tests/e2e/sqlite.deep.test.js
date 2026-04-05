const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { randomUUID } = require('node:crypto')
const Record = require('../../index')
const { runSqlAdapterDeepContract } = require('../helpers/sqlAdapterDeepContract')

describe('e2e: SQLite (deep contract)', () => {
  let dbPath
  let db

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `aerekos-record-deep-${randomUUID()}.sqlite`)
    db = Record.connect('sqlite', { database: dbPath })
  })

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close()
    }
    try {
      await fs.unlink(dbPath)
    } catch {
      // ignore
    }
  })

  it('exercises associations, soft delete, batch, stream, and helpers', async () => {
    await runSqlAdapterDeepContract(db, `d_${randomUUID().replace(/-/g, '')}`)
  })
})
