const {
  isObject,
  toFkColumn,
  normalizeWhere,
  pickWritableFields,
  stripOutput,
  applySelect,
  validateRequired,
  TYPE_COERCERS,
} = require('../../shared/utils')

describe('shared/utils', () => {
  it('isObject distinguishes plain objects', () => {
    expect(isObject({})).toBe(true)
    expect(isObject(null)).toBeFalsy()
    expect(isObject([])).toBe(false)
  })

  it('toFkColumn lowercases model name for FK', () => {
    expect(toFkColumn('User')).toBe('user_id')
    expect(toFkColumn('BlogPost')).toBe('blogpost_id')
  })

  it('normalizeWhere returns object or empty object', () => {
    expect(normalizeWhere({ a: 1 })).toEqual({ a: 1 })
    expect(normalizeWhere(null)).toEqual({})
  })

  it('pickWritableFields filters to schema keys', () => {
    const picked = pickWritableFields(
      { name: 'x', extra: 1 },
      { name: 'string', email: 'string' }
    )
    expect(picked).toEqual({ name: 'x' })
  })

  it('stripOutput removes encrypted fields from view', () => {
    const out = stripOutput(
      { id: '1', email: 'a@b.com', password: 'hash' },
      { email: 'string', password: 'encrypted' }
    )
    expect(out.email).toBe('a@b.com')
    expect(out.password).toBeUndefined()
  })

  it('applySelect picks listed keys only', () => {
    expect(applySelect({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 })
    expect(applySelect({ a: 1 }, null)).toEqual({ a: 1 })
  })

  it('validateRequired throws with readable message', () => {
    expect(() =>
      validateRequired({ email: '' }, ['email', 'name'], 'User')
    ).toThrow(/missing required field/)
  })

  it('TYPE_COERCERS.string coerces', () => {
    expect(TYPE_COERCERS.string(42)).toBe('42')
    expect(TYPE_COERCERS.string(null)).toBeNull()
  })
})
