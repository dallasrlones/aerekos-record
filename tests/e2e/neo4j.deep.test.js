const Record = require('../../index')
const { runNeo4j, uniqueSuffix, waitForDbHealth } = require('./helpers/e2eEnv')
const { runNeo4jDeepContract } = require('../helpers/neo4jDeepContract')

const describeNeo = runNeo4j() ? describe : describe.skip

describeNeo('e2e: Neo4j (deep contract)', () => {
  let db

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

  it('exercises findAll, count, query builder, batch delete', async () => {
    await runNeo4jDeepContract(db, uniqueSuffix())
  })
})
