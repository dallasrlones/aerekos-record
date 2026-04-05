const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { randomUUID } = require('node:crypto')
const Record = require('../../index')

/**
 * Regression: WHERE col = NULL matches nothing in SQL; adapters must emit IS NULL.
 */
describe('SQLite findAll({ where: { field: null } })', () => {
  let dbPath
  let db

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `aerekos-null-${randomUUID()}.sqlite`)
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

  it('finds rows where an optional column is NULL', async () => {
    const T = db.model(
      'NullProbe',
      { label: 'string', optional: 'string' },
      { timestamps: false }
    )

    await T.create({ label: 'has-value', optional: 'x' })
    await T.create({ label: 'missing', optional: null })

    const nullOnes = await T.findAll({ where: { optional: null } })
    expect(nullOnes.some((r) => r.label === 'missing')).toBe(true)
    expect(nullOnes.every((r) => r.optional == null)).toBe(true)
  })
})
