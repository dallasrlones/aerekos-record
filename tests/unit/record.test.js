const Record = require('../../index')

describe('aerekos-record entry', () => {
  it('connect throws for unknown database type', () => {
    expect(() => Record.connect('unknown-db', {})).toThrow(/Unknown database type/)
  })

  it('exports expected factory functions', () => {
    expect(typeof Record.connect).toBe('function')
    expect(typeof Record.connectChroma).toBe('function')
    expect(typeof Record.createMultiDatabase).toBe('function')
    expect(typeof Record.createMigrations).toBe('function')
    expect(typeof Record.createRetry).toBe('function')
    expect(typeof Record.createCircuitBreaker).toBe('function')
  })

  it('adapters object exposes lazy loaders for known backends', () => {
    expect(typeof Record.adapters.sqlite).toBe('function')
    expect(typeof Record.adapters.psql).toBe('function')
    expect(typeof Record.adapters.mysql).toBe('function')
    expect(typeof Record.adapters.mariadb).toBe('function')
  })
})
