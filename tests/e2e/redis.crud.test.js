const Record = require('../../index')
const { runRedis, uniqueSuffix } = require('./helpers/e2eEnv')

const describeRedis = runRedis() ? describe : describe.skip

describeRedis('e2e: Redis', () => {
  let db
  const suf = uniqueSuffix()

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

  it('healthCheck and CRUD', async () => {
    const modelName = `E2eRedisItem${suf}`
    const Item = db.model(
      modelName,
      { token: 'string', n: 'number' },
      { required: ['token'], timestamps: true }
    )

    const row = await Item.create({ token: `tok-${suf}`, n: 1 })
    expect(row.id).toBeTruthy()

    const found = await Item.findBy({ token: `tok-${suf}` })
    expect(found.id).toBe(row.id)

    const updated = await Item.update(row.id, { n: 7 })
    expect(updated.n).toBe(7)

    const del = await Item.delete(row.id, { hardDelete: true })
    expect(del).toBeTruthy()
    expect(await Item.find(row.id)).toBeNull()
  })
})
