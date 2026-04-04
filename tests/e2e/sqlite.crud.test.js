const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { randomUUID } = require('node:crypto')
const Record = require('../../index')

describe('e2e: SQLite', () => {
  let dbPath
  let db

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `aerekos-record-e2e-${randomUUID()}.sqlite`)
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

  it('healthCheck reports healthy', async () => {
    const h = await db.healthCheck()
    expect(h.healthy).toBe(true)
  })

  it('performs CRUD on a model', async () => {
    const Widget = db.model(
      'Widget',
      { name: 'string', qty: 'number' },
      { required: ['name'], timestamps: true }
    )

    const w = await Widget.create({ name: 'Alpha', qty: 2 })
    expect(w.id).toBeTruthy()
    expect(w.name).toBe('Alpha')

    const found = await Widget.find(w.id)
    expect(found.name).toBe('Alpha')

    const listed = await Widget.findAll({ where: { name: 'Alpha' } })
    expect(listed.length).toBeGreaterThanOrEqual(1)

    const updated = await Widget.update(w.id, { qty: 5 })
    expect(updated.qty).toBe(5)

    const removed = await Widget.delete(w.id, { hardDelete: true })
    expect(removed).toBeTruthy()

    const gone = await Widget.find(w.id)
    expect(gone).toBeNull()
  })
})
