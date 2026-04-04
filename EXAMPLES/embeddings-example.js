/**
 * Embeddings Example
 * 
 * This example demonstrates how to use embeddings with aerekos-record.
 * It shows:
 * - Setting up ChromaDB for vector storage
 * - Configuring Ollama for embedding generation
 * - Auto-generating embeddings on create/update
 * - Similarity search
 * - Chunking for long text
 */

const Record = require('../index')

async function main() {
  // 1. Connect to your primary database (e.g., PostgreSQL)
  const db = Record.connect('psql', {
    host: 'localhost',
    database: 'myapp',
    user: 'postgres',
    password: 'password'
  })

  // 2. Connect to ChromaDB for vector storage
  const chroma = Record.connectChroma({
    url: process.env.CHROMA_BASE_URL || 'http://localhost:8000',
    collection: 'messages', // Default collection name
    tenant: 'default_tenant',
    database: 'default_database'
  })

  // 3. Define a model with embeddings
  const Message = db.model('Message', {
    text: 'string',
    userId: 'string',
    conversationId: 'string',
    role: 'string', // 'user' or 'assistant'
  }, {
    timestamps: true,
    // Configure embeddings
    embeddings: {
      // Fields to embed
      fields: [
        {
          field: 'text',
          chunk: true, // Enable chunking for long text
          chunkSize: 1500,
          chunkOverlap: 200,
          chunkingStrategy: 'simple' // or 'smart'
        }
      ],
      // Embedding provider (Ollama)
      provider: 'ollama',
      providerConfig: {
        url: process.env.OLLAMA_EMBEDDING_URL || 'http://localhost:11434',
        model: process.env.OLLAMA_EMBED_MODEL || 'embeddinggemma:latest',
        dimensions: 1024
      },
      // Chroma adapter for vector storage
      chromaAdapter: chroma,
      // Collection name (defaults to model name)
      collection: 'messages',
      // Auto-generate embeddings on create/update
      autoGenerate: true,
      // Fields to include in metadata
      metadataFields: ['userId', 'conversationId', 'role'],
      // Custom metadata to always include
      customMetadata: {
        type: 'message'
      }
    }
  })

  // 4. Create messages (embeddings auto-generated)
  console.log('Creating messages...')
  
  const message1 = await Message.create({
    text: 'I love working with Node.js and building APIs',
    userId: 'user-123',
    conversationId: 'conv-1',
    role: 'user'
  })
  console.log('Created message 1:', message1.id)

  const message2 = await Message.create({
    text: 'JavaScript is my favorite programming language for backend development',
    userId: 'user-123',
    conversationId: 'conv-1',
    role: 'user'
  })
  console.log('Created message 2:', message2.id)

  const message3 = await Message.create({
    text: 'I enjoy building web applications with Express.js',
    userId: 'user-456',
    conversationId: 'conv-2',
    role: 'user'
  })
  console.log('Created message 3:', message3.id)

  // Wait a bit for embeddings to be generated
  await new Promise(resolve => setTimeout(resolve, 2000))

  // 5. Find similar messages
  console.log('\nFinding similar messages...')
  
  const similar = await Message.findSimilar('I like coding in JavaScript', {
    limit: 3,
    filters: {
      userId: 'user-123' // Filter by user
    }
  })
  
  console.log(`Found ${similar.length} similar messages:`)
  similar.forEach((result, index) => {
    console.log(`${index + 1}. Score: ${result.score.toFixed(3)}, Distance: ${result.distance.toFixed(3)}`)
    console.log(`   Text: ${result.record.text}`)
    console.log(`   User: ${result.record.userId}`)
  })

  // 6. Manual embedding generation
  console.log('\nGenerating embedding manually...')
  const embedding = await Message.generateEmbedding('This is a test message')
  console.log(`Generated embedding with ${embedding.length} dimensions`)

  // 7. Chunk and embed long text
  console.log('\nChunking and embedding long text...')
  const longText = `
    This is a very long text that will be chunked into smaller pieces.
    Each chunk will be embedded separately and stored in ChromaDB.
    This is useful for documents, articles, or any content that exceeds
    the maximum context length of the embedding model.
    The chunks will overlap slightly to maintain context between chunks.
    This ensures that semantic meaning is preserved across chunk boundaries.
  `.trim()

  const chunked = await Message.embeddings.chunkAndEmbed(longText, {
    chunkSize: 100,
    overlap: 20,
    strategy: 'smart'
  })
  
  console.log(`Chunked into ${chunked.length} pieces:`)
  chunked.forEach((chunk, index) => {
    console.log(`  Chunk ${index + 1}: ${chunk.chunk.slice(0, 50)}... (${chunk.embedding.length} dims)`)
  })

  // 8. Store chunked embeddings manually
  console.log('\nStoring chunked embeddings...')
  const embeddingIds = await Message.embeddings.storeChunkedEmbeddings(
    message1.id,
    'text',
    longText,
    {
      chunkSize: 100,
      overlap: 20
    }
  )
  console.log(`Stored ${embeddingIds.length} chunk embeddings`)

  // 9. Find similar with threshold
  console.log('\nFinding similar with distance threshold...')
  const similarWithThreshold = await Message.findSimilar('programming languages', {
    limit: 5,
    threshold: 0.3, // Maximum distance (lower = more similar)
    filters: {
      userId: 'user-123'
    }
  })
  console.log(`Found ${similarWithThreshold.length} messages within threshold`)

  // 10. Delete embeddings for a record
  console.log('\nDeleting embeddings...')
  await Message.embeddings.deleteEmbeddings(message1.id, 'text')
  console.log('Deleted embeddings for message1')

  // 11. Health check
  console.log('\nChromaDB health check...')
  const health = await chroma.healthCheck()
  console.log('ChromaDB status:', health.status)

  // Cleanup
  await db.close()
  console.log('\nDone!')
}

// Run example
if (require.main === module) {
  main().catch(console.error)
}

module.exports = main

