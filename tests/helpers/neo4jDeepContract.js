/** Neo4j graph adapter — expand beyond basic CRUD. */
async function runNeo4jDeepContract(db, suffix) {
  const s = String(suffix).replace(/[^a-zA-Z0-9_]/g, '_')

  if (typeof db.getPoolStats === 'function') {
    db.getPoolStats()
  }

  expect((await db.healthCheck()).healthy).toBe(true)

  const N = db.model(`NeoDeep${s}`, { title: 'string', score: 'number' }, { required: ['title'], timestamps: true })

  const a = await N.create({ title: `a-${s}`, score: 1 })
  const b = await N.create({ title: `b-${s}`, score: 2 })
  expect(a.id).toBeTruthy()

  const byTitle = await N.findBy({ title: `a-${s}` })
  expect(byTitle.id).toBe(a.id)

  const all = await N.findAll({ limit: 20 })
  expect(all.length).toBeGreaterThanOrEqual(2)

  if (typeof N.count === 'function') {
    const c = await N.count({})
    expect(c).toBeGreaterThanOrEqual(2)
  }

  const u = await N.update(b.id, { score: 99 })
  expect(u.score).toBe(99)

  const qb = await N.query().where('score', '>=', 1).limit(10).findAll()
  expect(Array.isArray(qb)).toBe(true)

  await N.batch.bulkDelete([a.id, b.id], { hardDelete: true })
}

module.exports = { runNeo4jDeepContract }
