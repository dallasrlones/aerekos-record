const QueryBuilder = require('../../shared/queryBuilder')

function mockModel() {
  return {
    async findAll(q) {
      return [{ q }]
    },
    async count(where, opts) {
      return Object.keys(where || {}).length + (opts?.withDeleted ? 1 : 0)
    },
  }
}

describe('QueryBuilder', () => {
  it('chains where and forwards to findAll', async () => {
    const m = mockModel()
    const qb = new QueryBuilder(m)
    const rows = await qb.where('active', true).where('age', '>=', 18).findAll()
    expect(rows[0].q.where.active).toBe(true)
    expect(rows[0].q.where.age).toEqual({ gte: 18 })
  })

  it('paginate computes offset and returns pagination meta', async () => {
    const m = {
      async findAll(q) {
        return new Array(5).fill(null).map((_, i) => ({ id: i, q }))
      },
      async count() {
        return 23
      },
    }
    const qb = new QueryBuilder(m)
    const page = await qb.where('x', 1).paginate(2, 5)
    expect(page.data.length).toBe(5)
    expect(page.pagination.page).toBe(2)
    expect(page.pagination.perPage).toBe(5)
    expect(page.pagination.total).toBe(23)
    expect(page.pagination.totalPages).toBe(5)
  })
})
