/**
 * Attachments Example
 * Demonstrates Rails Active Storage-like functionality with has_one_attached and has_many_attached
 */

const Record = require('../index')
const fs = require('fs').promises

// Connect to database
const db = Record.connect('psql', {
  host: 'localhost',
  database: 'myapp',
  user: 'postgres',
  password: 'password',
})

// Define Project Model (has tokens for authentication)
const Project = db.model('Project', {
  name: 'string',
  projectId: 'string', // UUID for Aerekos Storage
  secret: 'string', // Secret key for Aerekos Storage
  defaultBucketId: 'string', // Default bucket ID
}, {
  required: ['name', 'projectId', 'secret'],
  unique: ['projectId'],
  timestamps: true,
})

// Define User Model with attachments
const User = db.model('User', {
  name: 'string',
  email: 'string',
  projectId: 'string', // Foreign key to Project
}, {
  required: ['name', 'email', 'projectId'],
  timestamps: true,
  belongsTo: ['Project'],
})

// Setup attachments AFTER model definition
// has_one_attached :avatar
User.hasOneAttached('avatar', {
  bucketId: null, // Will use defaultBucketId from project
  // projectId and secret will be resolved from User's project
})

// has_many_attached :documents
User.hasManyAttached('documents', {
  bucketId: null, // Will use defaultBucketId from project
})

// Usage Examples

async function examples() {
  // Create a project
  const project = await Project.create({
    name: 'My Project',
    projectId: 'project-uuid-here',
    secret: 'project-secret-key',
    defaultBucketId: 'bucket-uuid-here',
  })

  // Create a user
  const user = await User.create({
    name: 'John Doe',
    email: 'john@example.com',
    projectId: project.id,
  })

  // Set project credentials on user model (for attachments)
  User.__projectId = project.projectId
  User.__secret = project.secret
  User.__defaultBucketId = project.defaultBucketId

  // ============================================
  // has_one_attached :avatar
  // ============================================

  // Attach a file (single attachment)
  const avatarBuffer = await fs.readFile('./path/to/avatar.jpg')
  await user.avatar.attach(avatarBuffer, {
    filename: 'avatar.jpg',
    contentType: 'image/jpeg',
  })

  // Check if attached
  const hasAvatar = user.avatar.attached()
  console.log('Has avatar:', hasAvatar) // true

  // Get attachment metadata
  const avatarMetadata = user.avatar.get()
  console.log('Avatar metadata:', avatarMetadata)
  // {
  //   fileId: 'uuid',
  //   bucketId: 'bucket-uuid',
  //   originalFilename: 'avatar.jpg',
  //   contentType: 'image/jpeg',
  //   size: 12345,
  //   uploadedAt: '2024-01-01T00:00:00.000Z'
  // }

  // Get signed URL for download
  const avatarUrl = await user.avatar.url({ ttlSeconds: 3600 })
  console.log('Avatar URL:', avatarUrl)

  // Download file
  const avatarData = await user.avatar.download({ asBuffer: true })
  console.log('Avatar downloaded:', avatarData.length, 'bytes')

  // Get full metadata from storage
  const fullMetadata = await user.avatar.metadata()
  console.log('Full metadata:', fullMetadata)

  // Detach (delete) file
  await user.avatar.detach()
  console.log('Avatar detached')

  // ============================================
  // has_many_attached :documents
  // ============================================

  // Attach multiple files
  const doc1Buffer = await fs.readFile('./path/to/doc1.pdf')
  const doc2Buffer = await fs.readFile('./path/to/doc2.pdf')

  await user.documents.attach([doc1Buffer, doc2Buffer], {
    filename: 'document.pdf',
    contentType: 'application/pdf',
  })

  // Or attach one at a time
  await user.documents.attach(doc1Buffer, {
    filename: 'another-doc.pdf',
    contentType: 'application/pdf',
  })

  // Check if any attached
  const hasDocuments = user.documents.attached()
  console.log('Has documents:', hasDocuments) // true

  // Get all attachments
  const documents = user.documents.get()
  console.log('Documents:', documents)
  // [
  //   { fileId: 'uuid1', bucketId: '...', originalFilename: 'document.pdf', ... },
  //   { fileId: 'uuid2', bucketId: '...', originalFilename: 'document.pdf', ... },
  //   { fileId: 'uuid3', bucketId: '...', originalFilename: 'another-doc.pdf', ... }
  // ]

  // Count attachments
  const docCount = user.documents.count()
  console.log('Document count:', docCount) // 3

  // Get URLs for all documents
  const documentUrls = await user.documents.urls({ ttlSeconds: 3600 })
  console.log('Document URLs:', documentUrls)
  // [
  //   { fileId: 'uuid1', url: 'https://...', originalFilename: '...', ... },
  //   { fileId: 'uuid2', url: 'https://...', originalFilename: '...', ... },
  //   ...
  // ]

  // Detach specific file(s)
  await user.documents.detach(documents[0].fileId) // Remove first document
  await user.documents.detach([documents[1].fileId, documents[2].fileId]) // Remove multiple

  // Purge all documents
  await user.documents.purge()

  // ============================================
  // Advanced: Per-attachment bucket
  // ============================================

  // Use different bucket for specific attachment
  User.hasOneAttached('profilePicture', {
    bucketId: 'specific-bucket-uuid',
    projectId: project.projectId,
    secret: project.secret,
  })

  const user2 = await User.create({
    name: 'Jane Doe',
    email: 'jane@example.com',
    projectId: project.id,
  })

  await user2.profilePicture.attach(avatarBuffer, {
    filename: 'profile.jpg',
    contentType: 'image/jpeg',
  })

  // ============================================
  // Advanced: Using pre-configured storage service
  // ============================================

  const AerekosStorage = require('../aerekos-storage/aerekosSdk')
  const storageService = new AerekosStorage({
    projectId: project.projectId,
    secret: project.secret,
    apiBase: 'https://storage.aerekos.com',
  })

  User.hasOneAttached('logo', {
    service: storageService, // Use pre-configured service
    bucketId: 'logo-bucket-uuid',
  })

  const user3 = await User.create({
    name: 'Company',
    email: 'company@example.com',
    projectId: project.id,
  })

  await user3.logo.attach(avatarBuffer, {
    filename: 'logo.png',
    contentType: 'image/png',
  })
}

// Run examples if this file is executed directly
if (require.main === module) {
  examples().catch(console.error)
}

module.exports = { User, Project, db }

