const Record = require('../../index')
const { runMysql, uniqueSuffix, waitForDbHealth } = require('./helpers/e2eEnv')
const { runSqlAdapterDeepContract } = require('../helpers/sqlAdapterDeepContract')

const describeMysql = runMysql() ? describe : describe.skip

describeMysql('e2e: MySQL / MariaDB', () => {
  let db
  const suf = uniqueSuffix()

  beforeAll(async () => {
    db = Record.connect('mysql', {
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || 'root',
      database: process.env.MYSQL_DATABASE || 'aerekos_record_test',
    })
    await waitForDbHealth(() => db.healthCheck(), { label: 'MySQL' })
  })

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close()
    }
  })

  it('healthCheck and CRUD', async () => {
    const modelName = `E2eMysqlItem${suf}`
    const Item = db.model(
      modelName,
      { title: 'string', n: 'number' },
      { required: ['title'], timestamps: true }
    )

    const row = await Item.create({ title: `mysql-${suf}`, n: 1 })
    expect(row.id).toBeTruthy()

    const found = await Item.findBy({ title: `mysql-${suf}` })
    expect(found.id).toBe(row.id)

    const updated = await Item.update(row.id, { n: 99 })
    expect(updated.n).toBe(99)

    await Item.delete(row.id, { hardDelete: true })
    expect(await Item.find(row.id)).toBeNull()
  })

  it('deep SQL adapter contract', async () => {
    await runSqlAdapterDeepContract(db, `my_${uniqueSuffix()}`)
  })
})
