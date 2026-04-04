/**
 * PostgreSQL User Model Example
 * Demonstrates User model with Profile association and PostgreSQL-specific features
 */

const Record = require('../../index')

// Connect to PostgreSQL
const db = Record.connect('psql', {
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'myapp',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'password',
  max: 20, // Connection pool size
  min: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

// Define Profile Model (belongs to User)
const Profile = db.model('Profile', {
  bio: 'string',
  avatar: 'string',
  website: 'string',
  location: 'string',
  userId: 'string', // Foreign key to User
  settings: 'string', // JSONB stored as string
}, {
  required: ['userId'],
  unique: ['userId'], // One profile per user
  timestamps: true,
  softDelete: true,
  belongsTo: ['User'],
  callbacks: {
    before_create: async (profile) => {
      console.log('Creating profile for user:', profile.userId)
    },
  },
})

// Define User Model (has one Profile, has many Posts)
const User = db.model('User', {
  name: 'string',
  email: 'string',
  password: 'encrypted',
  age: 'number',
  active: 'boolean',
  role: 'string',
  metadata: 'string', // JSONB stored as string
}, {
  required: ['name', 'email', 'password'],
  unique: ['email'],
  indexes: ['email', 'role', 'active'],
  timestamps: true,
  softDelete: true,
  hasOne: ['Profile'],
  hasMany: ['Post', 'Comment'],
  belongsTo: ['Organization'],
  callbacks: {
    before_validation: async (user) => {
      if (user.email) {
        user.email = user.email.toLowerCase()
      }
    },
    before_validation_on_create: async (user) => {
      if (!user.role) {
        user.role = 'user'
      }
    },
    before_create: async (user) => {
      console.log('Creating user:', user.email)
    },
    after_create: async (user) => {
      console.log('User created:', user.id)
    },
    before_update: async (user) => {
      console.log('Updating user:', user.id)
    },
    after_save: async (user) => {
      console.log('User saved:', user.id)
    },
  },
})

// Usage Examples

async function examples() {
  // Ensure tables exist (auto-created on first model use)
  await User.findAll({ limit: 1 })
  await Profile.findAll({ limit: 1 })

  // Create a user
  const user = await User.create({
    name: 'John Smith',
    email: 'john@example.com',
    password: 'secret123',
    age: 35,
    active: true,
    role: 'admin',
    metadata: JSON.stringify({ theme: 'dark', preferences: { notifications: true } }),
  })
  console.log('Created user:', user)

  // Create profile for user
  const profile = await Profile.create({
    bio: 'Senior developer',
    avatar: '/avatars/john.jpg',
    website: 'https://johnsmith.com',
    location: 'Seattle, WA',
    userId: user.id,
    settings: JSON.stringify({ language: 'en', timezone: 'America/Los_Angeles' }),
  })
  console.log('Created profile:', profile)

  // Find user with profile
  const userWithProfile = await User.find(user.id)
  const userProfile = await userWithProfile.profile.get()
  console.log('User profile:', userProfile)

  // Query builder with complex queries
  const activeUsers = await User.query()
    .where('active', true)
    .where('age', '>=', 18)
    .where('age', '<=', 65)
    .whereIn('role', ['user', 'admin'])
    .whereNotNull('email')
    .orderBy('name', 'ASC')
    .orderBy('createdAt', 'DESC')
    .limit(10)
    .offset(0)
    .findAll()
  console.log('Active users:', activeUsers)

  // Advanced where conditions
  const users = await User.query()
    .where('name', 'like', '%John%')
    .whereBetween('age', 25, 40)
    .where('active', true)
    .findAll()

  // JSONB queries
  const usersWithTheme = await User.json.queryJSON(
    'metadata',
    'theme',
    '=',
    'dark'
  )
  console.log('Users with dark theme:', usersWithTheme)

  // Update JSONB field
  await User.json.updateJSON(
    user.id,
    'metadata',
    ['preferences', 'notifications'],
    false
  )

  // Full-text search (PostgreSQL)
  User.search.setSearchFields(['name', 'email'])
  const searchResults = await User.search.search('john', {
    limit: 10,
  })
  console.log('Search results:', searchResults)

  // Geospatial queries (if PostGIS is enabled)
  // const nearbyUsers = await User.geo.near(47.6062, -122.3321, 5000)

  // Composite keys example
  const OrderItem = db.model('OrderItem', {
    orderId: 'string',
    productId: 'string',
    quantity: 'number',
    price: 'number',
  })
  OrderItem.compositeKeys.defineCompositeKey('OrderItem', ['orderId', 'productId'])
  const compositeKey = OrderItem.compositeKeys.generateCompositeKey('OrderItem', {
    orderId: 'order-1',
    productId: 'prod-1',
  })
  console.log('Composite key:', compositeKey)

  // Batch operations
  const users = await User.batch.bulkCreate([
    { name: 'Alice', email: 'alice@example.com', password: 'pass1', active: true },
    { name: 'Bob', email: 'bob@example.com', password: 'pass2', active: true },
  ])
  console.log('Bulk created users:', users)

  // Bulk update
  await User.batch.bulkUpdate([
    { id: user.id, changes: { active: false } },
  ])

  // Transactions (PostgreSQL)
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    
    const newUser = await User.create({
      name: 'Transaction User',
      email: 'transaction@example.com',
      password: 'pass',
    })
    
    await Profile.create({
      userId: newUser.id,
      bio: 'Created in transaction',
    })
    
    await client.query('COMMIT')
    console.log('Transaction committed')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Transaction rolled back:', error)
  } finally {
    client.release()
  }

  // Pagination
  const page = await User.query()
    .where('active', true)
    .paginate(1, 20)
  console.log('Page 1:', page.data)
  console.log('Total pages:', page.pagination.totalPages)

  // Chunk processing
  await User.query()
    .where('active', true)
    .chunk(100, async (users) => {
      console.log(`Processing ${users.length} users`)
    })

  // Health check
  const health = await db.healthCheck()
  console.log('Database health:', health)

  // Pool stats
  const poolStats = await db.getPoolStats()
  console.log('Pool stats:', poolStats)

  // Close connection
  await db.close()
}

// Run examples if this file is executed directly
if (require.main === module) {
  examples().catch(console.error)
}

module.exports = { User, Profile, db }

