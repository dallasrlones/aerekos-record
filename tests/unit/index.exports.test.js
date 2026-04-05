const path = require('path')
const fs = require('fs/promises')
const os = require('os')
const { randomUUID } = require('node:crypto')
const Record = require('../../index')

describe('index.js exports (smoke)', () => {
  let dbPath
  let db

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `aerekos-idx-${randomUUID()}.sqlite`)
    db = Record.connect('sqlite', { database: dbPath })
  })

  afterAll(async () => {
    if (db?.close) await db.close()
    try {
      await fs.unlink(dbPath)
    } catch {
      // ignore
    }
  })

  it('wires every factory to a working instance', () => {
    expect(Record.createMultiDatabase()).toBeTruthy()
    expect(Record.createMigrations(db)).toBeTruthy()
    expect(Record.createIndexManager(db)).toBeTruthy()
    expect(Record.createSeeding(db, { seedsPath: './seeds' })).toBeTruthy()
    expect(Record.createCaching(db)).toBeTruthy()
    expect(Record.createObservability({ logQueries: false })).toBeTruthy()
    expect(Record.createRetry({ maxRetries: 1 })).toBeTruthy()
    expect(Record.createCircuitBreaker({ failureThreshold: 3, resetTimeout: 1000 })).toBeTruthy()
    expect(Record.MemoryCache).toBeTruthy()
    expect(Record.QueryBuilder).toBeTruthy()
    expect(Record.ChangeStreamsManager).toBeTruthy()
    expect(Record.GeospatialManager).toBeTruthy()
    expect(Record.CompositeKeysManager).toBeTruthy()
    expect(Record.PolymorphicAssociationsManager).toBeTruthy()
    expect(typeof Record.createEmbeddingProvider).toBe('function')
    expect(typeof Record.registerEmbeddingProvider).toBe('function')
  })

  it('connectChroma requires url', () => {
    expect(() => Record.connectChroma({})).toThrow(/URL required/i)
  })
})
