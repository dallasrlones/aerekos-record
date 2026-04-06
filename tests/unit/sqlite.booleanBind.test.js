const {
  normalizeSqliteBind,
  coerceBooleansForSqliteStorage,
} = require('../../sqlite/booleanBind')

describe('sqlite/booleanBind', () => {
  describe('normalizeSqliteBind', () => {
    it('maps booleans to 0/1', () => {
      expect(normalizeSqliteBind(true)).toBe(1)
      expect(normalizeSqliteBind(false)).toBe(0)
    })

    it('maps booleans inside arrays (e.g. IN clauses)', () => {
      expect(normalizeSqliteBind([true, false, 'x'])).toEqual([1, 0, 'x'])
    })

    it('passes through null, numbers, strings', () => {
      expect(normalizeSqliteBind(null)).toBe(null)
      expect(normalizeSqliteBind(0)).toBe(0)
      expect(normalizeSqliteBind('a')).toBe('a')
    })
  })

  describe('coerceBooleansForSqliteStorage', () => {
    it('converts only declared boolean fields', () => {
      const properties = { name: 'string', enabled: 'boolean', n: 'number' }
      const out = coerceBooleansForSqliteStorage(
        { name: 'x', enabled: true, n: 3, extra: false },
        properties
      )
      expect(out.name).toBe('x')
      expect(out.enabled).toBe(1)
      expect(out.n).toBe(3)
      expect(out.extra).toBe(false)
    })

    it('skips null/undefined boolean values', () => {
      const properties = { enabled: 'boolean' }
      expect(coerceBooleansForSqliteStorage({ enabled: null }, properties).enabled).toBe(null)
      const u = coerceBooleansForSqliteStorage({}, properties)
      expect(u).toEqual({})
    })
  })
})
