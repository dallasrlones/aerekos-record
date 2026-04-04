const Record = require('../../index')
const { runMongodb, uniqueSuffix } = require('./helpers/e2eEnv')

const describeMongo = runMongodb() ? describe : describe.skip

describeMongo('e2e: MongoDB', () => {
  let db
  const suf = uniqueSuffix()

  beforeAll(async () => {
    db = Record.connect('mongodb', {
      uri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
      database: process.env.MONGO_DB || 'aerekos_record_test',
    })
    const health = await db.healthCheck()
    if (!health.healthy) {
      throw new Error(`MongoDB not reachable: ${health.error || 'unknown'}`)
    }
  })

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close()
    }
  })

  it('healthCheck and CRUD', async () => {
    const modelName = `E2eMongoItem${suf}`
    const Item = db.model(
      modelName,
      { title: 'string', n: 'number' },
      { required: ['title'], timestamps: true }
    )

    const row = await Item.create({ title: `mongo-${suf}`, n: 1 })
    expect(row.id).toBeTruthy()

    const found = await Item.findBy({ title: `mongo-${suf}` })
    expect(found.id).toBe(row.id)

    const updated = await Item.update(row.id, { n: 42 })
    expect(updated.n).toBe(42)

    await Item.delete(row.id, { hardDelete: true })
    expect(await Item.find(row.id)).toBeNull()
  })
})
