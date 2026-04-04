/**
 * Advanced Features Examples
 * Demonstrates advanced features like migrations, seeding, caching, observability, etc.
 */

const Record = require('../index')

// Setup database connection
const db = Record.connect('psql', {
  host: 'localhost',
  database: 'myapp',
  user: 'postgres',
  password: 'password',
})

// ============================================
// MIGRATIONS
// ============================================
async function migrationExamples() {
  const migrations = Record.createMigrations(db, {
    migrationsPath: './migrations',
  })

  // Create a new migration
  await migrations.createMigration('add_users_table')

  // Run migrations
  const result = await migrations.migrate()
  console.log('Migrations applied:', result)

  // Check status
  const status = await migrations.status()
  console.log('Migration status:', status)

  // Rollback
  await migrations.rollback({ steps: 1 })
}

// ============================================
// SEEDING
// ============================================
async function seedingExamples() {
  const seeding = Record.createSeeding(db, {
    seedsPath: './seeds',
  })

  // Create seed file
  await seeding.createSeed('users')

  // Run seeds
  const results = await seeding.seed()
  console.log('Seeding results:', results)

  // Programmatic seeding
  seeding.registerSeeder('admin', async (db) => {
    const User = db.model('User', {
      name: 'string',
      email: 'string',
      password: 'encrypted',
    })
    await User.create({
      name: 'Admin',
      email: 'admin@example.com',
      password: 'admin123',
    })
  })

  await seeding.runSeeders(['admin'])
}

// ============================================
// CACHING
// ============================================
async function cachingExamples() {
  const redisCache = Record.connect('redis', {
    host: 'localhost',
    port: 6379,
  })

  const caching = Record.createCaching(db, redisCache)
  caching.setTTL(3600).setPrefix('myapp:')

  const User = db.model('User', {
    name: 'string',
    email: 'string',
  })

  // Cache wrap
  const user = await caching.wrap(
    caching.cacheKey('User', 'find', 'user-123'),
    () => User.find('user-123'),
    3600
  )

  // Manual cache operations
  await caching.set('user:123', user, 3600)
  const cached = await caching.get('user:123')
  await caching.delete('user:123')

  // Clear model cache
  await caching.clearModel('User')

  // Or use in-memory cache
  const { MemoryCache } = Record
  const memoryCache = new MemoryCache()
  const memCaching = Record.createCaching(db, memoryCache)
}

// ============================================
// OBSERVABILITY
// ============================================
async function observabilityExamples() {
  const observability = Record.createObservability({
    enabled: true,
    logQueries: true,
    logSlowQueries: true,
    slowQueryThreshold: 1000,
    traceEnabled: true,
  })

  // Metrics are automatically collected when integrated
  const metrics = observability.getMetrics()
  console.log('Query metrics:', metrics)

  // Get query log
  const log = observability.getQueryLog(100)
  console.log('Query log:', log)

  // Get slow queries
  const slowQueries = observability.getSlowQueries(10)
  console.log('Slow queries:', slowQueries)

  // Get errors
  const errors = observability.getErrors(50)
  console.log('Errors:', errors)
}

// ============================================
// RETRY & CIRCUIT BREAKER
// ============================================
async function resilienceExamples() {
  const retry = Record.createRetry({
    maxRetries: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    multiplier: 2,
  })

  const circuitBreaker = Record.createCircuitBreaker({
    failureThreshold: 5,
    resetTimeout: 60000,
  })

  const User = db.model('User', { name: 'string', email: 'string' })

  // Retry with exponential backoff
  const user = await retry.retry(async () => {
    return await User.find('user-123')
  }, {
    onRetry: (attempt, error, delay) => {
      console.log(`Retry attempt ${attempt} after ${delay}ms`)
    },
  })

  // Circuit breaker
  const result = await circuitBreaker.execute(
    async () => User.find('user-123'),
    async () => {
      // Fallback
      return { id: 'user-123', name: 'Fallback User' }
    }
  )

  // Check circuit state
  const stats = circuitBreaker.getStats()
  console.log('Circuit breaker stats:', stats)
}

// ============================================
// POLYMORPHIC ASSOCIATIONS
// ============================================
async function polymorphicExamples() {
  const Comment = db.model('Comment', {
    body: 'string',
    commentableType: 'string',
    commentableId: 'string',
  })

  const Post = db.model('Post', {
    title: 'string',
    content: 'string',
  })

  const Video = db.model('Video', {
    title: 'string',
    url: 'string',
  })

  // Note: Registry access depends on adapter implementation
  // For polymorphic associations, you may need to pass the registry manually
  // or access it through the adapter's internal structure
  const polymorphic = new Record.PolymorphicAssociationsManager(Comment, Comment.__registry || new Map())

  // Define associations
  polymorphic.definePolymorphicBelongsTo('Comment', 'commentable')
  polymorphic.definePolymorphicHasMany('Post', 'comments', {
    as: 'commentable',
    model: 'Comment',
  })
  polymorphic.definePolymorphicHasMany('Video', 'comments', {
    as: 'commentable',
    model: 'Comment',
  })

  // Create post
  const post = await Post.create({
    title: 'My Post',
    content: 'Post content',
  })

  // Create comment on post
  const comment = await Comment.create({
    body: 'Great post!',
    commentableType: 'Post',
    commentableId: post.id,
  })

  // Get polymorphic association
  const commentable = await polymorphic.getPolymorphicAssociation(
    'Comment',
    'commentable',
    comment
  )
  console.log('Commentable:', commentable)

  // Get all comments for post
  const comments = await polymorphic.getPolymorphicAssociation(
    'Post',
    'comments',
    post
  )
  console.log('Post comments:', comments)
}

// ============================================
// COMPOSITE KEYS
// ============================================
async function compositeKeyExamples() {
  const OrderItem = db.model('OrderItem', {
    orderId: 'string',
    productId: 'string',
    quantity: 'number',
    price: 'number',
  })

  // Define composite key
  OrderItem.compositeKeys.defineCompositeKey('OrderItem', ['orderId', 'productId'])

  // Generate composite key
  const record = { orderId: 'order-1', productId: 'prod-1', quantity: 5 }
  const compositeKey = OrderItem.compositeKeys.generateCompositeKey('OrderItem', record)
  console.log('Composite key:', compositeKey) // 'order-1::prod-1'

  // Parse composite key
  const parsed = OrderItem.compositeKeys.parseCompositeKey('OrderItem', compositeKey)
  console.log('Parsed:', parsed) // { orderId: 'order-1', productId: 'prod-1' }

  // Find by composite key
  const item = await OrderItem.compositeKeys.findByCompositeKey('OrderItem', compositeKey)

  // Update by composite key
  await OrderItem.compositeKeys.updateByCompositeKey('OrderItem', compositeKey, {
    quantity: 10,
  })
}

// ============================================
// SHARDING & MULTI-DATABASE
// ============================================
async function shardingExamples() {
  const multiDb = Record.createMultiDatabase()

  // Add shards
  multiDb.addInstance('shard1', Record.connect('psql', {
    host: 'db1.example.com',
    database: 'myapp',
  }))

  multiDb.addInstance('shard2', Record.connect('psql', {
    host: 'db2.example.com',
    database: 'myapp',
  }))

  // Add read replica
  multiDb.addInstance('replica1', Record.connect('psql', {
    host: 'replica1.example.com',
    database: 'myapp',
  }), {
    isReadOnly: true,
    primaryInstance: 'shard1',
  })

  // Configure sharding
  multiDb.configureSharding('User', 'organizationId', {
    'org-1': 'shard1',
    'org-2': 'shard2',
  })

  // Create model
  const User = multiDb.model('User', {
    name: 'string',
    email: 'string',
    organizationId: 'string',
  })

  // Automatically routes to correct shard
  const user = await User.create({
    name: 'John',
    email: 'john@example.com',
    organizationId: 'org-1', // Goes to shard1
  })

  // Reads can use replica
  const users = await User.findAll({
    where: { organizationId: 'org-1' },
    preferReplica: true,
  })
}

// Run all examples
async function runAll() {
  try {
    await migrationExamples()
    await seedingExamples()
    await cachingExamples()
    await observabilityExamples()
    await resilienceExamples()
    await polymorphicExamples()
    await compositeKeyExamples()
    await shardingExamples()
  } catch (error) {
    console.error('Error running examples:', error)
  }
}

if (require.main === module) {
  runAll().catch(console.error)
}

module.exports = {
  migrationExamples,
  seedingExamples,
  cachingExamples,
  observabilityExamples,
  resilienceExamples,
  polymorphicExamples,
  compositeKeyExamples,
  shardingExamples,
}

