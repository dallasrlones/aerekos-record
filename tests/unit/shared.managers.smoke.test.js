const path = require('path')
const fs = require('fs/promises')
const os = require('os')
const { randomUUID } = require('node:crypto')
const Record = require('../../index')

describe('shared managers (SQLite-backed smoke)', () => {
  let dbPath
  let db

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `aerekos-sh-${randomUUID()}.sqlite`)
    db = Record.connect('sqlite', { database: dbPath })
  })

  afterAll(async () => {
    if (db?.close) await db.close()
    try {
      await fs.unlink(dbPath)
    } catch {
      // ignore
    }
  })

  it('IndexManager defineIndex (registration only on SQLite)', () => {
    const im = Record.createIndexManager(db)
    const suf = randomUUID().replace(/-/g, '')
    db.model(`Idx${suf}`, { a: 'string', b: 'string' }, { timestamps: false })
    im.defineIndex(`Idx${suf}`, 'a', { unique: false })
    im.defineIndex(`Idx${suf}`, ['a', 'b'], { name: `custom_${suf}` })
    im.defineIndex(`Idx${suf}`, { fields: ['a', 'b'], unique: true, name: `obj_${suf}`, type: 'btree' })
    expect((im.indexes.get(`Idx${suf}`) || []).length).toBeGreaterThanOrEqual(3)
  })

  it('MultiDatabaseManager routes create/find', async () => {
    const p1 = path.join(os.tmpdir(), `md1-${randomUUID()}.sqlite`)
    const p2 = path.join(os.tmpdir(), `md2-${randomUUID()}.sqlite`)
    const a = Record.connect('sqlite', { database: p1 })
    const b = Record.connect('sqlite', { database: p2 })
    const multi = Record.createMultiDatabase()
    multi.addInstance('one', a)
    multi.addInstance('two', b)
    multi.configureSharding('ShardUser', 'orgId', { o1: 'one', o2: 'two' })
    const U = multi.model('ShardUser', { name: 'string', orgId: 'string' }, { timestamps: true })
    const row = await U.create({ name: 'x', orgId: 'o1' })
    expect(row.id).toBeTruthy()
    const found = await U.find(row.id, { shardKey: 'o1' })
    expect(found.name).toBe('x')
    await a.close()
    await b.close()
    await fs.unlink(p1).catch(() => {})
    await fs.unlink(p2).catch(() => {})
  })

  it('ObservabilityManager + CachingManager + MemoryCache', async () => {
    const obs = Record.createObservability({ logQueries: false, slowQueryThreshold: 9999 })
    obs.logQuery('select', 'T', 'SELECT 1', [], 1)

    const cache = new Record.MemoryCache()
    const cm = Record.createCaching(db, cache)
    expect(cm).toBeTruthy()
  })

  it('PolymorphicAssociationsManager registers definitions', () => {
    const M = db.model(`Poly${randomUUID().replace(/-/g, '')}`, { x: 'string' }, { timestamps: false })
    const reg = new Map()
    const p = new Record.PolymorphicAssociationsManager(M, reg)
    p.definePolymorphicBelongsTo('Comment', 'commentable')
    p.definePolymorphicHasMany('Article', 'comments')
    expect(p.polymorphicAssociations.size).toBeGreaterThanOrEqual(1)
  })
})
