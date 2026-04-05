const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { randomUUID } = require('node:crypto')
const Record = require('../../index')

function uncacheMigration(absPath) {
  try {
    delete require.cache[require.resolve(absPath)]
  } catch {
    // path not yet required
  }
}

describe('MigrationManager (SQLite)', () => {
  let dbPath
  let db
  let migrationsPath

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `aerekos-migr-${randomUUID()}.sqlite`)
    migrationsPath = path.join(os.tmpdir(), `aerekos-migr-dir-${randomUUID()}`)
    await fs.mkdir(migrationsPath, { recursive: true })
    db = Record.connect('sqlite', { database: dbPath })
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    if (db && typeof db.close === 'function') {
      await db.close()
    }
    try {
      await fs.unlink(dbPath)
    } catch {
      // ignore
    }
    await fs.rm(migrationsPath, { recursive: true, force: true })
  })

  async function writeMigration(version, name, orderFile) {
    const vf = JSON.stringify(String(version))
    const of = JSON.stringify(orderFile)
    const file = path.join(migrationsPath, `${version}_${name}.js`)
    await fs.writeFile(
      file,
      `
const fs = require('fs')
module.exports = {
  async up() { fs.appendFileSync(${of}, 'up:' + ${vf} + '\\n') },
  async down() { fs.appendFileSync(${of}, 'down:' + ${vf} + '\\n') },
}
`,
      'utf8'
    )
    return file
  }

  async function readOrder(orderFile) {
    try {
      return (await fs.readFile(orderFile, 'utf8')).trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  it('runs pending migrations in numeric version order (1, 2, 10 — not lexicographic)', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    await writeMigration('10', 'ten', orderFile)
    await writeMigration('2', 'two', orderFile)
    await writeMigration('1', 'one', orderFile)

    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.migrate()

    expect(await readOrder(orderFile)).toEqual(['up:1', 'up:2', 'up:10'])
  })

  it('reports applied versions sorted numerically', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    await writeMigration('10', 'ten', orderFile)
    await writeMigration('2', 'two', orderFile)
    await writeMigration('1', 'one', orderFile)

    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.migrate()
    const applied = await mgr.getAppliedMigrations()

    expect(applied).toEqual(['1', '2', '10'])
  })

  it('rollback({ steps }) undoes newest applied first', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    for (const v of ['1', '2', '3']) {
      await writeMigration(v, `m${v}`, orderFile)
    }

    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.migrate()
    await fs.writeFile(orderFile, '', 'utf8')
    for (const v of ['1', '2', '3']) {
      uncacheMigration(path.join(migrationsPath, `${v}_m${v}.js`))
    }

    await mgr.rollback({ steps: 2 })

    expect(await readOrder(orderFile)).toEqual(['down:3', 'down:2'])
    expect(await mgr.getAppliedMigrations()).toEqual(['1'])
  })

  it('rollback({ to }) undoes only migrations with version greater than to', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    for (const v of ['1', '2', '3']) {
      await writeMigration(v, `m${v}`, orderFile)
    }

    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.migrate()
    await fs.writeFile(orderFile, '', 'utf8')
    for (const v of ['1', '2', '3']) {
      uncacheMigration(path.join(migrationsPath, `${v}_m${v}.js`))
    }

    await mgr.rollback({ to: '1' })

    expect(await readOrder(orderFile)).toEqual(['down:3', 'down:2'])
    expect(await mgr.getAppliedMigrations()).toEqual(['1'])
  })

  it('migrate() with no pending returns a clear message', async () => {
    const mgr = Record.createMigrations(db, { migrationsPath })
    const first = await mgr.migrate()
    expect(first.applied.length).toBeGreaterThanOrEqual(0)
    const second = await mgr.migrate()
    expect(second.applied).toEqual([])
    expect(second.message).toMatch(/No pending/i)
  })

  it('migrate({ dryRun: true }) does not write migration rows', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    await writeMigration('1', 'one', orderFile)

    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.initialize()
    const before = await mgr.MigrationModel.findAll({})

    const result = await mgr.migrate({ dryRun: true })
    expect(result.applied.length).toBe(1)
    const after = await mgr.MigrationModel.findAll({})
    expect(after.length).toBe(before.length)
    expect(await readOrder(orderFile)).toEqual([])
  })

  it('migrate({ to }) applies only migrations up to that version', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    await writeMigration('1', 'a', orderFile)
    await writeMigration('2', 'b', orderFile)
    await writeMigration('3', 'c', orderFile)

    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.migrate({ to: '2' })
    expect(await readOrder(orderFile)).toEqual(['up:1', 'up:2'])
    expect(await mgr.getAppliedMigrations()).toEqual(['1', '2'])

    uncacheMigration(path.join(migrationsPath, '3_c.js'))
    await mgr.migrate()
    expect(await readOrder(orderFile)).toEqual(['up:1', 'up:2', 'up:3'])
  })

  it('status() marks applied vs pending', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    await writeMigration('1', 'a', orderFile)
    await writeMigration('2', 'b', orderFile)

    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.migrate({ to: '1' })

    const rows = await mgr.status()
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: '1', status: 'applied' }),
        expect.objectContaining({ version: '2', status: 'pending' }),
      ])
    )
  })

  it('createMigration writes a file with up/down stubs', async () => {
    const mgr = Record.createMigrations(db, { migrationsPath })
    const filepath = await mgr.createMigration('add_widgets')
    expect(filepath).toContain('add_widgets')
    const src = await fs.readFile(filepath, 'utf8')
    expect(src).toMatch(/async up/)
    expect(src).toMatch(/async down/)
    await fs.unlink(filepath)
  })

  it('getAllMigrations creates missing directory (ENOENT)', async () => {
    const nested = path.join(migrationsPath, 'deep', randomUUID())
    const mgr = Record.createMigrations(db, { migrationsPath: nested })
    const list = await mgr.getAllMigrations()
    expect(Array.isArray(list)).toBe(true)
    await fs.rm(path.dirname(nested), { recursive: true, force: true })
  })

  it('ignores non-matching .js filenames in migrations folder', async () => {
    await fs.writeFile(path.join(migrationsPath, 'junk.js'), 'module.exports = {}', 'utf8')
    await writeMigration('1', 'ok', path.join(migrationsPath, 'o.log'))

    const mgr = Record.createMigrations(db, { migrationsPath })
    const all = await mgr.getAllMigrations()
    expect(all.map((m) => m.version)).toEqual(['1'])
  })

  it('rollback() when nothing applied returns a message', async () => {
    const mgr = Record.createMigrations(db, { migrationsPath })
    const out = await mgr.rollback()
    expect(out.rolledBack).toEqual([])
    expect(out.message).toMatch(/No migrations/i)
  })

  it('migrate() throws when migration has no up()', async () => {
    await fs.writeFile(
      path.join(migrationsPath, '5_noup.js'),
      'module.exports = { async down() {} }',
      'utf8'
    )
    const mgr = Record.createMigrations(db, { migrationsPath })
    await expect(mgr.migrate()).rejects.toThrow(/must export an 'up' function/)
  })

  it('rollback() throws when migration has no down()', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    await fs.writeFile(
      path.join(migrationsPath, '7_nodown.js'),
      `
module.exports = {
  async up() {},
}
`,
      'utf8'
    )
    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.migrate()
    uncacheMigration(path.join(migrationsPath, '7_nodown.js'))
    await expect(mgr.rollback({ steps: 1 })).rejects.toThrow(/must export a 'down' function/)
  })

  it('rollback() throws when migration file is missing', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    await writeMigration('1', 'gone', orderFile)

    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.migrate()

    await fs.unlink(path.join(migrationsPath, '1_gone.js'))
    uncacheMigration(path.join(migrationsPath, '1_gone.js'))

    await expect(mgr.rollback({ steps: 1 })).rejects.toThrow(/file not found/)
  })

  it('re-applies rolled-back migrations on a second migrate()', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    await writeMigration('1', 'a', orderFile)

    const mgr = Record.createMigrations(db, { migrationsPath })
    await mgr.migrate()
    await fs.writeFile(orderFile, '', 'utf8')
    uncacheMigration(path.join(migrationsPath, '1_a.js'))
    await mgr.rollback({ steps: 1 })
    uncacheMigration(path.join(migrationsPath, '1_a.js'))
    await mgr.migrate()

    expect(await readOrder(orderFile)).toEqual(['down:1', 'up:1'])
  })

  it('getAllMigrations rejects non-directory paths', async () => {
    const filePath = path.join(os.tmpdir(), `aerekos-not-a-dir-${randomUUID()}.txt`)
    await fs.writeFile(filePath, 'x', 'utf8')
    const mgr = Record.createMigrations(db, { migrationsPath: filePath })
    await expect(mgr.getAllMigrations()).rejects.toThrow()
    await fs.unlink(filePath)
  })

  it('uses custom migrationsTable for tracking model', async () => {
    const orderFile = path.join(migrationsPath, 'order.log')
    await writeMigration('1', 'x', orderFile)

    const table = `custom_migrations_${randomUUID().replace(/-/g, '')}`
    const mgr = Record.createMigrations(db, { migrationsPath, migrationsTable: table })
    await mgr.migrate()

    const Custom = db.model(table, {
      version: 'string',
      name: 'string',
      appliedAt: 'datetime',
      rolledBackAt: 'datetime',
    }, { unique: ['version'], timestamps: false })
    const rows = await Custom.findAll({ where: { rolledBackAt: null } })
    expect(rows.some((r) => r.version === '1')).toBe(true)
  })
})
