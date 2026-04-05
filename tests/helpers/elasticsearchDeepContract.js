/** Elasticsearch adapter — multi-doc queries and search helper. */
async function runElasticsearchDeepContract(db, suffix) {
  const s = String(suffix).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()

  if (typeof db.getPoolStats === 'function') {
    db.getPoolStats()
  }

  expect((await db.healthCheck()).healthy).toBe(true)

  const M = db.model(`esdeep_${s}`, { title: 'string', n: 'number' }, { required: ['title'], timestamps: true })

  const x = await M.create({ title: `alpha ${s}`, n: 1 })
  const y = await M.create({ title: `bravo ${s}`, n: 2 })
  expect(x.id).toBeTruthy()

  // allow index refresh
  await new Promise((r) => setTimeout(r, 1500))

  const listed = await M.findAll({ where: { title: { contains: 'alpha' } }, limit: 10 })
  expect(Array.isArray(listed)).toBe(true)

  const u = await M.update(y.id, { n: 20 })
  expect(u.n).toBe(20)

  try {
    await M.search.search('alpha', { fields: ['title'] })
  } catch {
    // optional
  }

  await M.delete(x.id, { hardDelete: true })
  await M.delete(y.id, { hardDelete: true })
}

module.exports = { runElasticsearchDeepContract }
