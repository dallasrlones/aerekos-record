const Record = require('../../index')
const { runRedis, uniqueSuffix } = require('./helpers/e2eEnv')
const { runRedisDeepContract } = require('../helpers/redisDeepContract')

const describeRedis = runRedis() ? describe : describe.skip

describeRedis('e2e: Redis (deep contract)', () => {
  let db

  beforeAll(async () => {
    db = Record.connect('redis', {
      socket: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
      password: process.env.REDIS_PASSWORD || undefined,
    })
    const health = await db.healthCheck()
    if (!health.healthy) {
      throw new Error(`Redis not reachable: ${health.error || 'unknown'}`)
    }
  })

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close()
    }
  })

  it('exercises associations, batch, stream, and query builder', async () => {
    await runRedisDeepContract(db, uniqueSuffix())
  })
})
