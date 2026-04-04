/**
 * Redis User Model Example
 * Demonstrates User model with Profile association and Redis-specific features
 */

const Record = require('../../index')

// Connect to Redis
const db = Record.connect('redis', {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  connectTimeout: 10000,
  reconnectStrategy: (retries) => {
    if (retries > 10) {
      return new Error('Too many retries')
    }
    return Math.min(retries * 50, 1000)
  },
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
  timestamps: true,
  softDelete: true,
  callbacks: {
    before_create: async (profile) => {
      console.log('Creating profile for user:', profile.userId)
    },
  },
})

// Define User Model (has one Profile)
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
  timestamps: true,
  softDelete: true,
  hasOne: ['Profile'],
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
    name: 'Mike Wilson',
    email: 'mike@example.com',
    password: 'secret123',
    age: 29,
    active: true,
    role: 'user',
  })
  console.log('Created user:', user)

  // Create profile for user
  const profile = await Profile.create({
    bio: 'Backend developer',
    avatar: '/avatars/mike.jpg',
    website: 'https://mikewilson.com',
    location: 'Austin, TX',
    userId: user.id,
  })
  console.log('Created profile:', profile)

  // Find user with profile
  const userWithProfile = await User.find(user.id)
  const userProfile = await userWithProfile.profile.get()
  console.log('User profile:', userProfile)

  // Redis-specific: Set TTL on user
  await User.setTTL(user.id, 3600) // Expire in 1 hour
  const ttl = await User.getTTL(user.id)
  console.log('User TTL:', ttl, 'seconds')

  // Query builder
  const activeUsers = await User.query()
    .where('active', true)
    .where('age', '>=', 18)
    .orderBy('name', 'ASC')
    .limit(10)
    .findAll()
  console.log('Active users:', activeUsers)

  // Find by email
  const foundUser = await User.findBy({ email: 'mike@example.com' })
  console.log('Found user:', foundUser)

  // Count users
  const count = await User.count({ active: true })
  console.log('Active users count:', count)

  // Batch operations
  const users = await User.batch.bulkCreate([
    { name: 'Alice', email: 'alice@example.com', password: 'pass1', active: true },
    { name: 'Bob', email: 'bob@example.com', password: 'pass2', active: true },
  ])
  console.log('Bulk created users:', users)

  // Set TTL on multiple users
  for (const u of users) {
    await User.setTTL(u.id, 7200) // 2 hours
  }

  // Stream users
  await User.stream.stream(
    { where: { active: true } },
    async (user) => {
      console.log('Processing user:', user.name)
    }
  )

  // Update user
  const updated = await User.update(user.id, {
    name: 'Mike Updated',
    age: 30,
  })
  console.log('Updated user:', updated)

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

