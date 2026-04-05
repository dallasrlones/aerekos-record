const Record = require('../../index')
const { runElasticsearch, uniqueSuffix, waitForDbHealth } = require('./helpers/e2eEnv')
const { runElasticsearchDeepContract } = require('../helpers/elasticsearchDeepContract')

const describeEs = runElasticsearch() ? describe : describe.skip

describeEs('e2e: Elasticsearch (deep contract)', () => {
  let db

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

  it('exercises findAll with text-style where, update, search helper', async () => {
    await runElasticsearchDeepContract(db, uniqueSuffix())
  })
})
