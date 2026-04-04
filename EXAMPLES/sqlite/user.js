/**
 * SQLite User Model Example
 * Demonstrates User model with Profile association and SQLite-specific features
 */

const Record = require('../../index')

// Connect to SQLite
const db = Record.connect('sqlite', {
  database: process.env.SQLITE_DATABASE || './database.sqlite',
  readonly: false,
  fileMustExist: false,
  timeout: 5000,
  verbose: false,
})

// Define Profile Model (belongs to User)
const Profile = db.model('Profile', {
  bio: 'string',
  avatar: 'string',
  website: 'string',
  location: 'string',
  userId: 'string', // Foreign key to User
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
  // Create a user
  const user = await User.create({
    name: 'John Smith',
    email: 'john@example.com',
    password: 'secret123',
    age: 35,
    active: true,
    role: 'admin',
  })
  console.log('Created user:', user)

  // Create profile for user
  const profile = await Profile.create({
    bio: 'Senior developer',
    avatar: '/avatars/john.jpg',
    website: 'https://johnsmith.com',
    location: 'Seattle, WA',
    userId: user.id,
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

  // Batch operations
  const users = await User.batch.bulkCreate([
    { name: 'Alice', email: 'alice@example.com', password: 'pass1', active: true },
    { name: 'Bob', email: 'bob@example.com', password: 'pass2', active: true },
  ])
  console.log('Bulk created users:', users)

  // Transactions (SQLite)
  const transaction = db.db.transaction((users) => {
    const results = []
    for (const userData of users) {
      const stmt = db.db.prepare('INSERT INTO users (id, name, email, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      const id = require('crypto').randomUUID()
      const now = new Date().toISOString()
      stmt.run(id, userData.name, userData.email, userData.password, now, now)
      results.push({ id, ...userData })
    }
    return results
  })

  const transactionResults = transaction([
    { name: 'Transaction User 1', email: 'tx1@example.com', password: 'pass' },
    { name: 'Transaction User 2', email: 'tx2@example.com', password: 'pass' },
  ])
  console.log('Transaction results:', transactionResults)

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

  // Database stats
  const stats = await db.getPoolStats()
  console.log('Database stats:', stats)

  // Close connection
  await db.close()
}

// Run examples if this file is executed directly
if (require.main === module) {
  examples().catch(console.error)
}

module.exports = { User, Profile, db }

