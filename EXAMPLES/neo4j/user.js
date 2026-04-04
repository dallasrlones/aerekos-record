/**
 * Neo4j User Model Example
 * Demonstrates User model with Profile association and Neo4j-specific features
 */

const Record = require('../../index')

// Connect to Neo4j
const db = Record.connect('neo4j', {
  uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
  user: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'password',
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
    after_create: async (profile) => {
      console.log('Profile created:', profile.id)
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
  indexes: ['email', 'role'],
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
    name: 'John Doe',
    email: 'john@example.com',
    password: 'secret123',
    age: 30,
    active: true,
    role: 'admin',
  })
  console.log('Created user:', user)

  // Create profile for user
  const profile = await Profile.create({
    bio: 'Software developer',
    avatar: '/avatars/john.jpg',
    website: 'https://johndoe.com',
    location: 'San Francisco, CA',
    userId: user.id,
  })
  console.log('Created profile:', profile)

  // Find user with profile
  const userWithProfile = await User.find(user.id)
  const userProfile = await userWithProfile.profile.get()
  console.log('User profile:', userProfile)

  // Update user
  const updated = await User.update(user.id, {
    name: 'John Updated',
    age: 31,
  })
  console.log('Updated user:', updated)

  // Query builder
  const activeUsers = await User.query()
    .where('active', true)
    .where('age', '>=', 18)
    .orderBy('name', 'ASC')
    .limit(10)
    .findAll()
  console.log('Active users:', activeUsers)

  // Find by email
  const foundUser = await User.findBy({ email: 'john@example.com' })
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

  // Stream users
  await User.stream.stream(
    { where: { active: true } },
    async (user) => {
      console.log('Processing user:', user.name)
    }
  )

  // Neo4j-specific: Create edge relationship
  const user1 = await User.create({ name: 'User 1', email: 'user1@example.com', password: 'pass' })
  const user2 = await User.create({ name: 'User 2', email: 'user2@example.com', password: 'pass' })
  
  // Create FOLLOWS edge
  await User.edges.createEdge({
    type: 'FOLLOWS',
    fromId: user1.id,
    toId: user2.id,
    properties: { since: new Date().toISOString() },
  })

  // Find users following user2
  const followers = await User.edges.findByEdges({
    type: 'FOLLOWS',
    toModel: 'User',
    toWhere: { id: user2.id },
    direction: 'in',
  })
  console.log('Followers:', followers)

  // Health check
  const health = await db.healthCheck()
  console.log('Database health:', health)

  // Close connection
  await db.close()
}

// Run examples if this file is executed directly
if (require.main === module) {
  examples().catch(console.error)
}

module.exports = { User, Profile, db }

