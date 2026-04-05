const { toFkColumn } = require('../../shared/utils')

/** MongoDB-oriented deep exercises (overlaps with SQL contract where APIs match). */
async function runMongoDeepContract(db, suffix) {
  const s = String(suffix).replace(/[^a-zA-Z0-9_]/g, '_')

  if (typeof db.getPoolStats === 'function') {
    db.getPoolStats()
  }

  expect((await db.healthCheck()).healthy).toBe(true)

  const parentName = `MP${s}`
  const childName = `MC${s}`
  const fk = toFkColumn(parentName)

  const Parent = db.model(parentName, { name: 'string' }, { hasMany: [childName], timestamps: true })
  const Child = db.model(childName, { title: 'string' }, { belongsTo: parentName, timestamps: true })

  const p = await Parent.create({ name: `mp-${s}` })
  await Child.create({ title: 'c', [fk]: p.id })

  const withKids = await Parent.findAll({
    include: [{ model: childName, as: `${childName.toLowerCase()}s` }],
  })
  expect(withKids.length).toBeGreaterThanOrEqual(1)

  const Soft = db.model(`MSoft${s}`, { note: 'string' }, { timestamps: true, softDelete: true })
  const sr = await Soft.create({ note: 'z' })
  await Soft.delete(sr.id)
  expect(await Soft.find(sr.id)).toBeNull()

  const Q = db.model(`MQ${s}`, { tag: 'string', n: 'number' }, { timestamps: true })
  await Q.create({ tag: 't1', n: 5 })
  await Q.updateOneBy({ tag: 't1' }, { n: 50 })
  const one = await Q.findBy({ tag: 't1' })
  expect(one.n).toBe(50)

  await Q.batch.bulkCreate([
    { tag: 'b1', n: 1 },
    { tag: 'b2', n: 2 },
  ])
  const streamed = await Q.stream.setChunkSize(2).streamCollect({}, 10)
  expect(streamed.length).toBeGreaterThanOrEqual(1)

  const Part = db.model(`MPart${s}`, { sku: 'string', lot: 'string' }, { timestamps: false })
  Part.compositeKeys.defineCompositeKey(`MPart${s}`, ['sku', 'lot'])
  expect(Part.compositeKeys.generateCompositeKey(`MPart${s}`, { sku: 's', lot: 'l' })).toBeTruthy()

  if (typeof Q.changes === 'object' && Q.changes && typeof Q.changes.watch === 'function') {
    // optional: change streams API surface
    expect(Q.changes).toBeTruthy()
  }
  if (typeof Q.geo === 'object' && Q.geo) {
    expect(Q.geo).toBeTruthy()
  }
}

module.exports = { runMongoDeepContract }
