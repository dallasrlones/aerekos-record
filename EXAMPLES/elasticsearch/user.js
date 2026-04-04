/**
 * Elasticsearch User Model Example
 * Demonstrates User model with Profile association and Elasticsearch-specific features
 */

const Record = require('../../index')

// Connect to Elasticsearch
const db = Record.connect('elasticsearch', {
  node: process.env.ES_NODE || 'http://localhost:9200',
  maxRetries: 3,
  requestTimeout: 60000,
  maxSockets: 10,
  keepAlive: true,
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

// Define User Model (has one Profile, has many Posts)
const User = db.model('User', {
  name: 'string',
  email: 'string',
  password: 'encrypted',
  age: 'number',
  active: 'boolean',
  role: 'string',
  tags: 'string', // Array stored as string
  bio: 'string', // For full-text search
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
  // Ensure index exists
  await User.findAll({ limit: 1 })
  await Profile.findAll({ limit: 1 })

  // Create a user
  const user = await User.create({
    name: 'Sarah Johnson',
    email: 'sarah@example.com',
    password: 'secret123',
    age: 32,
    active: true,
    role: 'user',
    tags: JSON.stringify(['designer', 'ui', 'ux']),
    bio: 'UI/UX designer passionate about creating beautiful user experiences',
  })
  console.log('Created user:', user)

  // Create profile for user
  const profile = await Profile.create({
    bio: 'Creative designer',
    avatar: '/avatars/sarah.jpg',
    website: 'https://sarahjohnson.com',
    location: 'Portland, OR',
    userId: user.id,
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
    .orderBy('name', 'ASC')
    .limit(10)
    .findAll()
  console.log('Active users:', activeUsers)

  // Full-text search (Elasticsearch specialty)
  User.search.setSearchFields(['name', 'email', 'bio'])
  
  // Basic search with automatic fuzziness
  const searchResults = await User.search.search('designer', {
    fields: ['name', 'bio'],
    limit: 10,
  })
  console.log('Search results:', searchResults)
  // Results include _score for relevance

  // Fuzzy search - handles typos automatically
  const fuzzyResults = await User.search.fuzzySearch('desginer', {
    fields: ['name', 'bio'],
    fuzziness: 'AUTO', // AUTO, 0, 1, 2, or '0..2' for range
    limit: 10,
  })
  console.log('Fuzzy search (handles typos):', fuzzyResults)

  // Custom fuzziness level
  const customFuzzy = await User.search.search('desginer', {
    fields: ['name', 'bio'],
    fuzziness: 2, // Allow up to 2 character differences
    queryType: 'multi_match',
    limit: 10,
  })
  console.log('Custom fuzziness:', customFuzzy)

  // Advanced fuzzy search with options
  const advancedFuzzy = await User.search.search('desginer', {
    fields: ['name', 'bio'],
    queryType: 'fuzzy',
    fuzziness: 'AUTO',
    prefixLength: 2, // First 2 characters must match exactly
    maxExpansions: 50, // Maximum number of variations to check
    transpositions: true, // Allow character transpositions (ab -> ba)
    limit: 10,
  })
  console.log('Advanced fuzzy search:', advancedFuzzy)

  // Match query with fuzziness
  const matchFuzzy = await User.search.search('designer', {
    fields: ['name', 'bio'],
    queryType: 'match',
    fuzziness: 1,
    operator: 'or', // or 'and'
    boost: 2.0, // Boost relevance score
    limit: 10,
  })
  console.log('Match query with fuzziness:', matchFuzzy)

  // Search with highlighting
  const highlighted = await User.search.search('designer', {
    fields: ['name', 'bio'],
    highlight: true,
    limit: 10,
  })
  console.log('Search with highlighting:', highlighted)
  // Results include _highlight field with matched terms

  // Advanced search with multiple terms
  const multiSearch = await User.search.search('UI UX designer', {
    fields: ['name', 'bio'],
    matchType: 'best_fields', // best_fields, most_fields, cross_fields, phrase, phrase_prefix
    operator: 'or',
    minimumShouldMatch: '75%', // At least 75% of terms must match
    limit: 20,
  })
  console.log('Multi-term search:', multiSearch)

  // Search with sorting
  const sortedSearch = await User.search.search('designer', {
    fields: ['name', 'bio'],
    sort: [
      { _score: { order: 'desc' } },
      { createdAt: { order: 'desc' } },
    ],
    limit: 10,
  })
  console.log('Sorted search:', sortedSearch)

  // Batch operations
  const users = await User.batch.bulkCreate([
    { name: 'Alice', email: 'alice@example.com', password: 'pass1', active: true, bio: 'Developer' },
    { name: 'Bob', email: 'bob@example.com', password: 'pass2', active: true, bio: 'Designer' },
  ])
  console.log('Bulk created users:', users)

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

  // Update user
  const updated = await User.update(user.id, {
    bio: 'Senior UI/UX designer with 10+ years experience',
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

