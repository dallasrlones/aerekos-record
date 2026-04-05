const { toFkColumn } = require('../../shared/utils')

/**
 * Deep exercises for the Redis adapter (key/value document style).
 */
async function runRedisDeepContract(db, suffix) {
  const s = String(suffix).replace(/[^a-zA-Z0-9_]/g, '_')

  if (typeof db.getPoolStats === 'function') {
    db.getPoolStats()
  }

  const h = await db.healthCheck()
  expect(h.healthy).toBe(true)

  const parentName = `RP${s}`
  const childName = `RC${s}`
  const fk = toFkColumn(parentName)

  const Parent = db.model(parentName, { name: 'string' }, { hasMany: [childName], timestamps: true })
  const Child = db.model(childName, { title: 'string' }, { belongsTo: parentName, timestamps: true })

  const p = await Parent.create({ name: `p-${s}` })
  await Child.create({ title: 'c1', [fk]: p.id })

  const kids = await Parent.findAll({
    include: [{ model: childName, as: `${childName.toLowerCase()}s` }],
  })
  expect(kids.length).toBeGreaterThanOrEqual(1)

  const R = db.model(`RItem${s}`, { k: 'string', n: 'number' }, { required: ['k'], timestamps: true })
  await R.create({ k: 'a', n: 1 })
  await R.create({ k: 'b', n: 2 })
  const listed = await R.findAll({ where: { k: 'a' }, limit: 10 })
  expect(listed.length).toBeGreaterThanOrEqual(1)
  const n = await R.count({ k: 'b' })
  expect(n).toBeGreaterThanOrEqual(1)

  const u = await R.update(listed[0].id, { n: 99 })
  expect(u.n).toBe(99)

  const qb = await R.query().where('k', '=', 'b').limit(5).findAll()
  expect(Array.isArray(qb)).toBe(true)

  const batch = await R.batch.bulkCreate([
    { k: 'b1', n: 1 },
    { k: 'b2', n: 2 },
  ])
  expect(batch.length).toBe(2)
  await R.batch.bulkUpdate([{ id: batch[0].id, changes: { n: 3 } }])
  await R.batch.bulkDelete([batch[1].id], { hardDelete: true })

  const chunks = await R.stream.setChunkSize(1).streamCollect({}, 4)
  expect(chunks.length).toBeGreaterThanOrEqual(1)

  await R.delete(listed[0].id, { hardDelete: true })
}

module.exports = { runRedisDeepContract }
