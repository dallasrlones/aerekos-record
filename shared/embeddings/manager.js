const { createEmbeddingProvider } = require('./providers')
const { chunkText, chunkTextSmart } = require('./chunking')

/**
 * Embedding Manager
 * Handles embedding generation, storage, and similarity search
 */
class EmbeddingManager {
  constructor(modelApi, adapterInstance, embeddingConfig = {}) {
    this.modelApi = modelApi
    this.adapterInstance = adapterInstance
    this.config = embeddingConfig
    
    // Initialize provider
    const providerType = embeddingConfig.provider || 'ollama'
    const providerConfig = embeddingConfig.providerConfig || {}
    this.provider = createEmbeddingProvider(providerType, providerConfig)
    
    // Initialize Chroma adapter if provided
    this.chromaAdapter = embeddingConfig.chromaAdapter || null
    
    // Embedding configuration
    this.fields = embeddingConfig.fields || []
    this.autoGenerate = embeddingConfig.autoGenerate !== false // Default true
    this.chunkSize = embeddingConfig.chunkSize || 1500
    this.chunkOverlap = embeddingConfig.chunkOverlap || 200
    this.chunkingStrategy = embeddingConfig.chunkingStrategy || 'simple' // 'simple' or 'smart'
    this.collectionName = embeddingConfig.collection || (modelApi.__modelName || modelApi.__name || 'model').toLowerCase()
    
    // Metadata configuration
    this.metadataFields = embeddingConfig.metadataFields || [] // Fields to include in metadata
    this.customMetadata = embeddingConfig.customMetadata || {} // Custom metadata to always include
  }

  /**
   * Generate embedding for text
   */
  async generateEmbedding(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('Text must be a non-empty string')
    }
    
    return await this.provider.embed(text)
  }

  /**
   * Generate embeddings for multiple texts
   */
  async generateEmbeddings(texts) {
    if (!Array.isArray(texts)) {
      throw new Error('Texts must be an array')
    }
    
    return Promise.all(texts.map(text => this.generateEmbedding(text)))
  }

  /**
   * Chunk text and generate embeddings for each chunk
   */
  async chunkAndEmbed(text, options = {}) {
    const chunkSize = options.chunkSize || this.chunkSize
    const overlap = options.overlap || this.chunkOverlap
    const strategy = options.strategy || this.chunkingStrategy
    
    let chunks
    if (strategy === 'smart') {
      chunks = chunkTextSmart(text, chunkSize, overlap, {
        preserveSentences: options.preserveSentences !== false,
        preserveParagraphs: options.preserveParagraphs === true,
      })
    } else {
      chunks = chunkText(text, chunkSize, overlap)
    }
    
    const embeddings = await this.generateEmbeddings(chunks)
    
    return chunks.map((chunk, index) => ({
      chunk,
      embedding: embeddings[index],
      chunkIndex: index,
    }))
  }

  /**
   * Store embedding in Chroma
   */
  async storeEmbedding(recordId, fieldName, text, embedding, metadata = {}) {
    if (!this.chromaAdapter) {
      throw new Error('Chroma adapter not configured. Set chromaAdapter in embedding config')
    }
    
    const embeddingId = `${recordId}:${fieldName}:${Date.now()}`
    
    // Build metadata
    const fullMetadata = {
      recordId: String(recordId),
      modelName: this.modelApi.__modelName || this.modelApi.__name || 'model',
      fieldName: String(fieldName),
      text: String(text).slice(0, 1000), // Limit text length
      timestamp: new Date().toISOString(),
      ...this.customMetadata,
      ...metadata,
    }
    
    // Include model fields in metadata if specified
    if (this.metadataFields.length > 0 && this.modelApi.__adapterInstance) {
      // Try to get record to include fields
      try {
        const record = await this.modelApi.find(recordId)
        if (record) {
          this.metadataFields.forEach(field => {
            if (record[field] != null) {
              fullMetadata[field] = String(record[field])
            }
          })
        }
      } catch (e) {
        // Record might not exist yet, that's ok
      }
    }
    
    await this.chromaAdapter.addEmbedding(embeddingId, embedding, fullMetadata, this.collectionName)
    
    return embeddingId
  }

  /**
   * Store chunked embeddings
   */
  async storeChunkedEmbeddings(recordId, fieldName, text, options = {}) {
    const chunked = await this.chunkAndEmbed(text, options)
    
    const embeddingIds = []
    for (const { chunk, embedding, chunkIndex } of chunked) {
      const embeddingId = await this.storeEmbedding(recordId, fieldName, chunk, embedding, {
        chunkIndex,
        isChunk: true,
      })
      embeddingIds.push(embeddingId)
    }
    
    return embeddingIds
  }

  /**
   * Find similar records
   */
  async findSimilar(queryText, options = {}) {
    if (!this.chromaAdapter) {
      throw new Error('Chroma adapter not configured')
    }
    
    const {
      limit = 5,
      fieldName = null,
      filters = {},
      threshold = null, // Distance threshold
      returnRecords = true, // Return model instances or just embedding results
    } = options
    
    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(queryText)
    
    // Build filters
    const chromaFilters = {
      modelName: this.modelApi.__modelName || this.modelApi.__name || 'model',
      ...filters,
    }
    
    if (fieldName) {
      chromaFilters.fieldName = String(fieldName)
    }
    
    // Query Chroma
    const results = await this.chromaAdapter.querySimilar(
      queryEmbedding,
      limit * 2, // Get more for threshold filtering
      chromaFilters,
      this.collectionName
    )
    
    // Apply threshold if specified
    let filtered = results
    if (threshold != null) {
      filtered = results.filter(r => r.distance <= threshold)
    }
    
    // Limit results
    filtered = filtered.slice(0, limit)
    
    // Return records if requested
    if (returnRecords && this.modelApi.__adapterInstance) {
      const recordIds = [...new Set(filtered.map(r => r.metadata.recordId).filter(Boolean))]
      
      if (recordIds.length > 0) {
        const records = await Promise.all(
          recordIds.map(id => 
            this.modelApi.find(id).catch(() => null)
          )
        )
        
        // Map results back to records with scores
        return filtered.map(result => {
          const record = records.find(r => r && String(r.id) === String(result.metadata.recordId))
          if (!record) return null
          
          return {
            record,
            score: 1 - result.distance, // Convert distance to similarity score
            distance: result.distance,
            metadata: result.metadata,
          }
        }).filter(Boolean)
      }
    }
    
    return filtered
  }

  /**
   * Delete embeddings for a record
   */
  async deleteEmbeddings(recordId, fieldName = null) {
    if (!this.chromaAdapter) {
      throw new Error('Chroma adapter not configured')
    }
    
    const filters = {
      recordId: String(recordId),
      modelName: this.modelApi.__modelName || this.modelApi.__name || 'model',
    }
    
    if (fieldName) {
      filters.fieldName = String(fieldName)
    }
    
    await this.chromaAdapter.deleteByFilters(filters, this.collectionName)
  }

  /**
   * Get embedding dimensions
   */
  getDimensions() {
    return this.provider.getDimensions()
  }
}

module.exports = EmbeddingManager

