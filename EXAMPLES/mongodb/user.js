/**
 * MongoDB User Model Example
 * Demonstrates User model with Profile association and MongoDB-specific features
 */

const Record = require('../../index')

// Connect to MongoDB
const db = Record.connect('mongodb', {
  uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  database: process.env.MONGODB_DATABASE || 'myapp',
  options: {
    maxPoolSize: 10,
    minPoolSize: 2,
  },
})

// Define Profile Model (belongs to User)
const Profile = db.model('Profile', {
  bio: 'string',
  avatar: 'string',
  website: 'string',
  location: 'string',
  userId: 'string', // Foreign key to User
  preferences: 'string', // JSON-like object stored as string
}, {
  required: ['userId'],
  timestamps: true,
  softDelete: true,
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
  tags: 'string', // Array stored as string
  metadata: 'string', // JSON object stored as string
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
    before_create: async (user) => {
      console.log('Creating user:', user.email)
      if (!user.role) {
        user.role = 'user'
      }
    },
    after_create: async (user) => {
      console.log('User created:', user.id)
    },
  },
})

// Usage Examples

async function examples() {
  // Create a user
  const user = await User.create({
    name: 'Jane Doe',
    email: 'jane@example.com',
    password: 'secret123',
    age: 28,
    active: true,
    role: 'user',
    tags: JSON.stringify(['developer', 'nodejs']),
    metadata: JSON.stringify({ theme: 'dark', notifications: true }),
  })
  console.log('Created user:', user)

  // Create profile for user
  const profile = await Profile.create({
    bio: 'Full-stack developer',
    avatar: '/avatars/jane.jpg',
    website: 'https://janedoe.com',
    location: 'New York, NY',
    userId: user.id,
    preferences: JSON.stringify({ language: 'en', timezone: 'America/New_York' }),
  })
  console.log('Created profile:', profile)

  // Find user with profile
  const userWithProfile = await User.find(user.id)
  const userProfile = await userWithProfile.profile.get()
  console.log('User profile:', userProfile)

  // Query builder
  const activeUsers = await User.query()
    .where('active', true)
    .where('age', '>=', 18)
    .whereIn('role', ['user', 'admin'])
    .orderBy('name', 'ASC')
    .limit(10)
    .findAll()
  console.log('Active users:', activeUsers)

  // Full-text search (if text index is created)
  User.search.setSearchFields(['name', 'email'])
  const searchResults = await User.search.search('jane', {
    limit: 10,
  })
  console.log('Search results:', searchResults)

  // Change streams (MongoDB only)
  const changeStream = await User.changes.watch()
  
  changeStream.on('insert', (document) => {
    console.log('New user inserted:', document.name)
  })

  changeStream.on('update', ({ id, updatedFields }) => {
    console.log('User updated:', id, updatedFields)
  })

  changeStream.on('delete', ({ id }) => {
    console.log('User deleted:', id)
  })

  // Watch specific operations
  const insertStream = await User.changes.watchInserts((document) => {
    console.log('New user:', document.name)
  })

  // Geospatial queries (if location field exists)
  // Note: Requires geospatial index
  // const nearbyUsers = await User.geo.near(40.7128, -74.0060, 5000)

  // Batch operations
  const users = await User.batch.bulkCreate([
    { name: 'Alice', email: 'alice@example.com', password: 'pass1', active: true },
    { name: 'Bob', email: 'bob@example.com', password: 'pass2', active: true },
  ])
  console.log('Bulk created users:', users)

  // Bulk upsert
  const upserted = await User.batch.bulkUpsert([
    { email: 'alice@example.com', name: 'Alice Updated', active: true },
    { email: 'charlie@example.com', name: 'Charlie New', active: true },
  ], 'email')
  console.log('Upserted users:', upserted)

  // Stream users
  await User.stream.stream(
    { where: { active: true } },
    async (user) => {
      console.log('Processing user:', user.name)
    }
  )

  // Pagination
  const page = await User.query()
    .where('active', true)
    .paginate(1, 20)
  console.log('Page 1:', page.data)
  console.log('Pagination info:', page.pagination)

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

