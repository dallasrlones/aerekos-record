const Record = require('../../index')
const { runMongodb, uniqueSuffix } = require('./helpers/e2eEnv')
const { runMongoDeepContract } = require('../helpers/mongoDeepContract')

const describeMongo = runMongodb() ? describe : describe.skip

describeMongo('e2e: MongoDB (deep contract)', () => {
  let db

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

  it('exercises associations, soft delete, batch, stream, composite keys', async () => {
    await runMongoDeepContract(db, uniqueSuffix())
  })
})
