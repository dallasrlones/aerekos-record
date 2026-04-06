const Record = require('../../index')
const { runNeo4j, uniqueSuffix, waitForDbHealth } = require('./helpers/e2eEnv')

const describeNeo = runNeo4j() ? describe : describe.skip

describeNeo('e2e: Neo4j', () => {
  let db
  const suf = uniqueSuffix()

  beforeAll(async () => {
    db = Record.connect('neo4j', {
      uri: process.env.NEO4J_URI || 'bolt://127.0.0.1:7687',
      user: process.env.NEO4J_USER || 'neo4j',
      password: process.env.NEO4J_PASSWORD || 'testpassword',
      database: process.env.NEO4J_DATABASE || undefined,
    })
    await waitForDbHealth(() => db.healthCheck(), { label: 'Neo4j' })
  })

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close()
    }
  })

  it('healthCheck and CRUD', async () => {
    const modelName = `E2eNeoItem${suf}`
    const Item = db.model(
      modelName,
      { title: 'string', n: 'number' },
      { required: ['title'], timestamps: true }
    )

    const row = await Item.create({ title: `neo-${suf}`, n: 1 })
    expect(row.id).toBeTruthy()

    const found = await Item.findBy({ title: `neo-${suf}` })
    expect(found.id).toBe(row.id)

    const updated = await Item.update(row.id, { n: 3 })
    expect(updated.n).toBe(3)

    await Item.delete(row.id, { hardDelete: true })
    expect(await Item.find(row.id)).toBeNull()
  })

  it('boolean property on node', async () => {
    const modelName = `E2eNeoFlag${suf}`
    const Flag = db.model(
      modelName,
      { label: 'string', enabled: 'boolean' },
      { required: ['label'], timestamps: true }
    )
    const row = await Flag.create({ label: `nflag-${suf}`, enabled: true })
    expect(row.enabled).toBe(true)
    const found = await Flag.findBy({ label: `nflag-${suf}` })
    expect(found.enabled).toBe(true)
    await Flag.update(row.id, { enabled: false })
    const off = await Flag.find(row.id)
    expect(off.enabled).toBe(false)
    await Flag.delete(row.id, { hardDelete: true })
  })
})
