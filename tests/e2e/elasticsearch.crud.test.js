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
})
