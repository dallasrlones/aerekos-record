/**
 * Adapters are lazy-loaded so consumers can install only the database drivers they use.
 * Each value is (connectionSettings) => adapter API, matching the underlying module export.
 */
const lazyAdapter = (relativePath) => {
  let cached
  return (connectionSettings) => {
    if (!cached) {
      cached = require(relativePath)
    }
    return cached(connectionSettings)
  }
}

const ADAPTERS = {
  neo4j: lazyAdapter('./neo4j/adapter'),
  mongodb: lazyAdapter('./mongodb/adapter'),
  psql: lazyAdapter('./psql/adapter'),
  postgresql: lazyAdapter('./psql/adapter'),
  postgres: lazyAdapter('./psql/adapter'),
  sqlite: lazyAdapter('./sqlite/adapter'),
  elasticsearch: lazyAdapter('./elasticsearch/adapter'),
  es: lazyAdapter('./elasticsearch/adapter'),
  redis: lazyAdapter('./redis/adapter'),
  mysql: lazyAdapter('./mysql/adapter'),
  mariadb: lazyAdapter('./mysql/adapter'),
}

const chromaAdapter = lazyAdapter('./chroma/adapter')

const MultiDatabaseManager = require('./shared/multiDb')
const MigrationManager = require('./shared/migrations')
const IndexManager = require('./shared/indexing')
const SeedingManager = require('./shared/seeding')
const QueryBuilder = require('./shared/queryBuilder')
const { CachingManager, MemoryCache } = require('./shared/caching')
const ObservabilityManager = require('./shared/observability')
const RetryManager = require('./shared/retry')
const CircuitBreaker = require('./shared/circuitBreaker')
// These are used via modelEnhancer, exported for advanced usage
const ChangeStreamsManager = require('./shared/changeStreams')
const GeospatialManager = require('./shared/geospatial')
const CompositeKeysManager = require('./shared/compositeKeys')
const PolymorphicAssociationsManager = require('./shared/polymorphicAssociations')
// Embedding providers
const { createEmbeddingProvider, registerProvider } = require('./shared/embeddings/providers')

/**
 * Connect to a database and return a model factory
 * 
 * @param {string} dbType - Database type: 'neo4j', 'mongodb', 'psql', 'elasticsearch', 'redis'
 * @param {object} connectionSettings - Connection settings for the database
 * @returns {object} Object with `model` function and `close` function
 * 
 * @example
 * const Record = require('aerekos-record')
 * 
 * // Connect to Neo4j
 * const neo = Record.connect('neo4j', {
 *   uri: 'neo4j://localhost:7687',
 *   user: 'neo4j',
 *   password: 'password'
 * })
 * 
 * // Define a model
 * const User = neo.model('User', {
 *   name: 'string',
 *   email: 'string',
 *   password: 'encrypted'
 * }, {
 *   required: ['email', 'password'],
 *   unique: ['email'],
 *   hasMany: ['Task'],
 *   timestamps: true,
 *   softDelete: true,
 *   callbacks: {
 *     before_create: async (user) => {
 *       console.log('Creating user:', user.email)
 *     }
 *   }
 * })
 * 
 * // Use the model
 * const user = await User.create({ name: 'John', email: 'john@example.com', password: 'secret' })
 * const users = await User.findAll({ where: { name: 'John' } })
 */
const connect = (dbType, connectionSettings = {}) => {
  const key = String(dbType || '').toLowerCase()
  const adapter = ADAPTERS[key]

  if (!adapter) {
    const supported = [...new Set(Object.keys(ADAPTERS))].sort().join(', ')
    throw new Error(`Unknown database type: ${dbType}. Supported types: ${supported}`)
  }

  return adapter(connectionSettings)
}

/**
 * Create a multi-database manager for sharding and read replicas
 * 
 * @example
 * const Record = require('aerekos-record')
 * 
 * const multiDb = Record.createMultiDatabase()
 * 
 * // Add multiple PostgreSQL instances
 * multiDb.addInstance('shard1', Record.connect('psql', { host: 'db1.example.com' }))
 * multiDb.addInstance('shard2', Record.connect('psql', { host: 'db2.example.com' }))
 * multiDb.addInstance('replica1', Record.connect('psql', { host: 'replica1.example.com' }), {
 *   isReadOnly: true,
 *   primaryInstance: 'shard1'
 * })
 * 
 * // Configure sharding
 * multiDb.configureSharding('User', 'organizationId', {
 *   'org-1': 'shard1',
 *   'org-2': 'shard2'
 * })
 * 
 * // Create model (works across all shards)
 * const User = multiDb.model('User', {
 *   name: 'string',
 *   organizationId: 'string'
 * })
 * 
 * // Use normally - automatically routes to correct shard
 * const user = await User.create({ name: 'John', organizationId: 'org-1' })
 */
const createMultiDatabase = () => {
  return new MultiDatabaseManager()
}

/**
 * Create a migration manager for database schema migrations
 * 
 * @param {object} adapter - Database adapter instance
 * @param {object} options - Migration options
 * @param {string} options.migrationsPath - Path to migration files
 * @param {string} options.migrationsTable - Table name for tracking migrations
 * @returns {MigrationManager} Migration manager instance
 * 
 * @example
 * const Record = require('aerekos-record')
 * 
 * const db = Record.connect('psql', { host: 'localhost', database: 'myapp' })
 * const migrations = Record.createMigrations(db, {
 *   migrationsPath: './migrations'
 * })
 * 
 * // Create a new migration
 * await migrations.createMigration('add_users_table')
 * 
 * // Run migrations
 * await migrations.migrate()
 * 
 * // Rollback last migration
 * await migrations.rollback({ steps: 1 })
 * 
 * // Check status
 * const status = await migrations.status()
 */
const createMigrations = (adapter, options = {}) => {
  return new MigrationManager(adapter, options)
}

/**
 * Create an index manager for advanced indexing
 * 
 * @param {object} adapter - Database adapter instance
 * @returns {IndexManager} Index manager instance
 * 
 * @example
 * const Record = require('aerekos-record')
 * 
 * const db = Record.connect('psql', { host: 'localhost', database: 'myapp' })
 * const indexes = Record.createIndexManager(db)
 * 
 * // Define indexes
 * indexes.defineIndex('User', 'email', { unique: true })
 * indexes.defineIndex('User', ['email', 'organizationId'], { name: 'user_org_email_idx' })
 * 
 * // Create indexes
 * const User = db.model('User', { email: 'string', organizationId: 'string' })
 * await indexes.createIndexes('User', User)
 */
const createIndexManager = (adapter) => {
  return new IndexManager(adapter)
}

/**
 * Create a seeding manager for database seeding
 */
const createSeeding = (adapter, options = {}) => {
  return new SeedingManager(adapter, options)
}

/**
 * Create a caching manager
 */
const createCaching = (adapter, cacheAdapter = null) => {
  return new CachingManager(adapter, cacheAdapter)
}

/**
 * Create an observability manager
 */
const createObservability = (options = {}) => {
  return new ObservabilityManager(options)
}

/**
 * Create a retry manager
 */
const createRetry = (options = {}) => {
  return new RetryManager(options)
}

/**
 * Create a circuit breaker
 */
const createCircuitBreaker = (options = {}) => {
  return new CircuitBreaker(options)
}

/**
 * Create a ChromaDB adapter for vector storage
 * 
 * @param {object} connectionSettings - ChromaDB connection settings
 * @param {string} connectionSettings.url - ChromaDB base URL
 * @param {string} connectionSettings.collection - Default collection name
 * @param {string} connectionSettings.tenant - Tenant name
 * @param {string} connectionSettings.database - Database name
 * @returns {object} ChromaDB adapter instance
 * 
 * @example
 * const Record = require('aerekos-record')
 * 
 * const chroma = Record.connectChroma({
 *   url: 'http://localhost:8000',
 *   collection: 'my-embeddings'
 * })
 * 
 * // Use with embeddings
 * const db = Record.connect('psql', { host: 'localhost' })
 * const chroma = Record.connectChroma({ url: 'http://localhost:8000' })
 * 
 * const Message = db.model('Message', {
 *   text: 'string',
 *   userId: 'string'
 * }, {
 *   embeddings: {
 *     fields: ['text'],
 *     provider: 'ollama',
 *     providerConfig: { url: 'http://localhost:11434', model: 'embeddinggemma:latest' },
 *     chromaAdapter: chroma
 *   }
 * })
 */
const connectChroma = (connectionSettings = {}) => {
  return chromaAdapter(connectionSettings)
}

module.exports = {
  connect,
  connectChroma,
  createMultiDatabase,
  createMigrations,
  createIndexManager,
  createSeeding,
  createCaching,
  createObservability,
  createRetry,
  createCircuitBreaker,
  // Export utilities
  MemoryCache,
  QueryBuilder,
  ChangeStreamsManager,
  GeospatialManager,
  CompositeKeysManager,
  PolymorphicAssociationsManager,
  // Embedding utilities
  createEmbeddingProvider,
  registerEmbeddingProvider: registerProvider,
  // Export adapters for advanced usage
  adapters: ADAPTERS,
}

