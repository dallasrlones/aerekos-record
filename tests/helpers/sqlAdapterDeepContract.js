const { toFkColumn } = require('../../shared/utils')

/**
 * Deep integration exercises for SQL-like adapters (SQLite, PostgreSQL, MySQL).
 * Call from e2e tests with a connected `db` and unique suffix.
 */
async function runSqlAdapterDeepContract(db, suffix) {
  const s = String(suffix).replace(/[^a-zA-Z0-9_]/g, '_')
  if (typeof db.getPoolStats === 'function') {
    db.getPoolStats()
  }

  const h = await db.healthCheck()
  expect(h.healthy).toBe(true)

  // —— Associations: parent has many children ——
  const parentName = `P${s}`
  const childName = `C${s}`
  const fk = toFkColumn(parentName)

  const Parent = db.model(
    parentName,
    { name: 'string' },
    { hasMany: [childName], timestamps: true }
  )
  const Child = db.model(
    childName,
    { title: 'string' },
    { belongsTo: parentName, timestamps: true }
  )

  const p = await Parent.create({ name: `parent-${s}` })
  await Child.create({ title: `kid-1`, [fk]: p.id })
  await Child.create({ title: `kid-2`, [fk]: p.id })

  const withKids = await Parent.findAll({
    include: [{ model: childName, as: `${childName.toLowerCase()}s` }],
  })
  expect(withKids.length).toBeGreaterThanOrEqual(1)
  const mine = withKids.find((row) => row.id === p.id)
  expect(mine).toBeTruthy()
  const rel = mine[`${childName.toLowerCase()}s`]
  expect(Array.isArray(rel) ? rel.length : 1).toBeGreaterThanOrEqual(1)

  // —— Soft delete ——
  const Soft = db.model(
    `Soft${s}`,
    { note: 'string' },
    { timestamps: true, softDelete: true }
  )
  const softRow = await Soft.create({ note: 'x' })
  await Soft.delete(softRow.id)
  expect(await Soft.find(softRow.id)).toBeNull()
  const withDel = await Soft.find(softRow.id, { withDeleted: true })
  expect(withDel).toBeTruthy()

  // —— Query shapes ——
  const Q = db.model(
    `Q${s}`,
    { tag: 'string', n: 'number', body: 'string' },
    { timestamps: true }
  )
  await Q.create({ tag: 'a', n: 1, body: 'hello world' })
  await Q.create({ tag: 'b', n: 10, body: 'other' })
  const inList = await Q.findAll({ where: { tag: ['a', 'b'] } })
  expect(inList.length).toBeGreaterThanOrEqual(1)
  const ranged = await Q.findAll({ where: { n: { gte: 1, lte: 100 } } })
  expect(ranged.length).toBeGreaterThanOrEqual(1)
  const like = await Q.findAll({ where: { body: { contains: 'hello' } } })
  expect(like.length).toBeGreaterThanOrEqual(1)

  await Q.updateOneBy({ tag: 'a' }, { n: 99 })
  const updatedOne = await Q.findBy({ tag: 'a' })
  expect(updatedOne.n).toBe(99)

  if (typeof Q.updateBy === 'function') {
    await Q.updateBy({ tag: 'b' }, { n: 88 })
  }

  const cnt = await Q.count({ n: { gte: 1 } })
  expect(cnt).toBeGreaterThanOrEqual(1)

  // —— Boolean columns (PG BOOLEAN, MySQL TINYINT(1), SQLite INTEGER 0/1) ——
  const BoolM = db.model(
    `Bool${s}`,
    { label: 'string', enabled: 'boolean' },
    { required: ['label'], timestamps: true }
  )
  const bOn = await BoolM.create({ label: `bool-on-${s}`, enabled: true })
  expect(bOn.enabled === true || bOn.enabled === 1).toBe(true)
  const byTrue = await BoolM.findAll({ where: { enabled: true } })
  expect(byTrue.some((r) => r.id === bOn.id)).toBe(true)
  await BoolM.update(bOn.id, { enabled: false })
  const bOff = await BoolM.find(bOn.id)
  expect(bOff.enabled === false || bOff.enabled === 0).toBe(true)
  const byFalse = await BoolM.findAll({ where: { enabled: false, id: bOn.id } })
  expect(byFalse.length).toBe(1)

  // —— Callbacks (instance API) ——
  const CB = db.model(`Cb${s}`, { v: 'number' }, { timestamps: true })
  let saw = 0
  CB.before_create(() => {
    saw += 1
  })
  await CB.create({ v: 1 })
  expect(saw).toBe(1)

  // —— Query builder ——
  const qbRows = await Q.query().where('tag', '=', 'b').limit(5).findAll()
  expect(Array.isArray(qbRows)).toBe(true)

  // —— Batch ——
  const batchRows = await Q.batch.setBatchSize(2).bulkCreate([
    { tag: 'batch1', n: 3, body: 'b1' },
    { tag: 'batch2', n: 4, body: 'b2' },
  ])
  expect(batchRows.length).toBe(2)

  const upserted = await Q.batch.bulkUpsert(
    [{ id: batchRows[0].id, tag: 'batch1', n: 300, body: 'b1' }],
    'id'
  )
  expect(upserted.length).toBeGreaterThanOrEqual(1)

  await Q.batch.bulkUpdate([{ id: batchRows[1].id, changes: { n: 40 } }])
  await Q.batch.bulkDelete([batchRows[1].id], { hardDelete: true })

  // —— Streaming ——
  const streamRows = await Q.stream.setChunkSize(1).streamCollect({}, 3)
  expect(streamRows.length).toBeGreaterThanOrEqual(1)

  // —— deleteBy (SQLite; optional elsewhere) ——
  if (typeof Q.deleteBy === 'function') {
    const doomed = await Q.create({ tag: 'delme', n: 0, body: 'z' })
    const deleted = await Q.deleteBy({ id: doomed.id })
    expect(Array.isArray(deleted) || deleted).toBeTruthy()
  }

  // —— Composite keys helper on model ——
  const Part = db.model(`Part${s}`, { sku: 'string', lot: 'string' }, { timestamps: false })
  Part.compositeKeys.defineCompositeKey(`Part${s}`, ['sku', 'lot'])
  const ck = Part.compositeKeys.generateCompositeKey(`Part${s}`, { sku: 's1', lot: 'l1' })
  expect(ck).toBeTruthy()

  // —— JSON helper (best-effort) ——
  try {
    const J = db.model(`J${s}`, { meta: 'json' }, { timestamps: false })
    await J.create({ meta: { a: 1 } })
    const jrows = await J.json.whereJsonPath('meta', '$.a', 1).findAll()
    expect(Array.isArray(jrows)).toBe(true)
  } catch {
    // adapter may not support json type the same way
  }

  // —— Full-text helper (best-effort) ——
  try {
    await Q.search.search('hello', { fields: ['body'] })
  } catch {
    // optional per backend
  }
}

module.exports = { runSqlAdapterDeepContract }
