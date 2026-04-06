const Record = require('../../index')
const { runElasticsearch, uniqueSuffix, waitForDbHealth } = require('./helpers/e2eEnv')

const describeEs = runElasticsearch() ? describe : describe.skip

describeEs('e2e: Elasticsearch', () => {
  let db
  const suf = uniqueSuffix()

  beforeAll(async () => {
    db = Record.connect('elasticsearch', {
      node: process.env.ES_URL || 'http://127.0.0.1:9200',
      requestTimeout: 60000,
      sniffOnStart: false,
    })
    await waitForDbHealth(() => db.healthCheck(), { label: 'Elasticsearch' })
  })

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close()
    }
  })

  it('healthCheck and CRUD', async () => {
    const modelName = `e2eEsItem${suf}`
    const Item = db.model(
      modelName,
      { title: 'string', n: 'number' },
      { required: ['title'], timestamps: true }
    )

    const row = await Item.create({ title: `es-${suf}`, n: 1 })
    expect(row.id).toBeTruthy()

    const found = await Item.find(row.id)
    expect(found.title).toBe(`es-${suf}`)

    const updated = await Item.update(row.id, { n: 11 })
    expect(updated.n).toBe(11)

    await Item.delete(row.id, { hardDelete: true })
    expect(await Item.find(row.id)).toBeNull()
  })

  it('boolean field in document', async () => {
    const modelName = `e2eEsFlag${suf}`
    const Flag = db.model(
      modelName,
      { label: 'string', enabled: 'boolean' },
      { required: ['label'], timestamps: true }
    )
    const row = await Flag.create({ label: `esflag-${suf}`, enabled: true })
    expect(row.enabled === true || row.enabled === 1).toBe(true)
    const found = await Flag.find(row.id)
    expect(found.enabled === true || found.enabled === 1).toBe(true)
    await Flag.update(row.id, { enabled: false })
    const off = await Flag.find(row.id)
    expect(off.enabled === false || off.enabled === 0).toBe(true)
    await Flag.delete(row.id, { hardDelete: true })
  })
})
