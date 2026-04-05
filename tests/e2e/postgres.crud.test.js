const Record = require('../../index')
const { runPostgres, uniqueSuffix } = require('./helpers/e2eEnv')
const { runSqlAdapterDeepContract } = require('../helpers/sqlAdapterDeepContract')

function pgConnectionSettings() {
  if (process.env.E2E_POSTGRES_URL) {
    return { connectionString: process.env.E2E_POSTGRES_URL }
  }
  if (runPostgres()) {
    return {
      host: process.env.PG_HOST || '127.0.0.1',
      port: Number(process.env.PG_PORT) || 5432,
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD || 'postgres',
      database: process.env.PG_DATABASE || 'aerekos_record_test',
    }
  }
  return null
}

const settings = pgConnectionSettings()
const describePg = settings ? describe : describe.skip

describePg('e2e: PostgreSQL', () => {
  let db
  const tableSuffix = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  beforeAll(async () => {
    db = Record.connect('psql', settings)
    const health = await db.healthCheck()
    if (!health.healthy) {
      throw new Error(`PostgreSQL not reachable: ${health.error || 'unknown'}`)
    }
  })

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close()
    }
  })

  it('creates a model with unique suffix to avoid collisions', async () => {
    const modelName = `E2eItem_${tableSuffix}`
    const Item = db.model(
      modelName,
      { title: 'string', n: 'number' },
      { required: ['title'], unique: ['title'], timestamps: true }
    )

    const row = await Item.create({ title: `hello-${tableSuffix}`, n: 1 })
    expect(row.id).toBeTruthy()

    const again = await Item.findBy({ title: `hello-${tableSuffix}` })
    expect(again.id).toBe(row.id)

    await Item.delete(row.id, { hardDelete: true })
  })

  it('deep SQL adapter contract', async () => {
    await runSqlAdapterDeepContract(db, `pg_${uniqueSuffix()}`)
  })
})
