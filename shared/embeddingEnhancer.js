const EmbeddingManager = require('./embeddings/manager')

/**
 * Enhance model with embedding capabilities
 */
function enhanceModelWithEmbeddings(modelApi, adapterInstance, embeddingConfig = {}) {
  // Only enhance if embedding config is provided
  if (!embeddingConfig || Object.keys(embeddingConfig).length === 0) {
    return modelApi
  }
  
  // Create embedding manager
  const embeddingManager = new EmbeddingManager(modelApi, adapterInstance, embeddingConfig)
  
  // Add embedding methods to model API
  modelApi.embeddings = embeddingManager
  
  // Add convenience methods
  modelApi.generateEmbedding = async function(text) {
    return await embeddingManager.generateEmbedding(text)
  }
  
  modelApi.findSimilar = async function(queryText, options = {}) {
    return await embeddingManager.findSimilar(queryText, options)
  }
  
  // Hook into create/update to auto-generate embeddings
  if (embeddingConfig.autoGenerate !== false && embeddingConfig.chromaAdapter) {
    const originalCreate = modelApi.create
    const originalUpdate = modelApi.update
    
    modelApi.create = async function(data, options = {}) {
      const record = await originalCreate.call(this, data, options)
      
      // Auto-generate embeddings for configured fields
      if (embeddingConfig.fields && embeddingConfig.fields.length > 0) {
        try {
          await Promise.all(
            embeddingConfig.fields.map(async (fieldConfig) => {
              const fieldName = typeof fieldConfig === 'string' ? fieldConfig : fieldConfig.field
              const fieldValue = record[fieldName]
              
              if (fieldValue && typeof fieldValue === 'string' && fieldValue.trim()) {
                const config = typeof fieldConfig === 'object' ? fieldConfig : {}
                const shouldChunk = config.chunk !== false && fieldValue.length > (config.chunkSize || embeddingConfig.chunkSize || 1500)
                
                if (shouldChunk) {
                  await embeddingManager.storeChunkedEmbeddings(
                    record.id,
                    fieldName,
                    fieldValue,
                    {
                      chunkSize: config.chunkSize || embeddingConfig.chunkSize,
                      overlap: config.chunkOverlap || embeddingConfig.chunkOverlap,
                      strategy: config.chunkingStrategy || embeddingConfig.chunkingStrategy,
                    }
                  )
                } else {
                  const embedding = await embeddingManager.generateEmbedding(fieldValue)
                  await embeddingManager.storeEmbedding(record.id, fieldName, fieldValue, embedding)
                }
              }
            })
          )
        } catch (e) {
          console.warn('[embeddingEnhancer] Failed to generate embeddings:', e.message)
          // Don't fail the create if embedding fails
        }
      }
      
      return record
    }
    
    modelApi.update = async function(id, data, options = {}) {
      const record = await originalUpdate.call(this, id, data, options)
      
      // Re-generate embeddings for updated fields
      if (embeddingConfig.fields && embeddingConfig.fields.length > 0) {
        try {
          // Delete old embeddings for updated fields
          const updatedFields = Object.keys(data)
          await Promise.all(
            updatedFields.map(async (fieldName) => {
              const fieldConfig = embeddingConfig.fields.find(
                f => (typeof f === 'string' ? f : f.field) === fieldName
              )
              
              if (fieldConfig) {
                // Delete old embeddings
                await embeddingManager.deleteEmbeddings(record.id, fieldName)
                
                // Generate new embeddings
                const fieldValue = record[fieldName]
                if (fieldValue && typeof fieldValue === 'string' && fieldValue.trim()) {
                  const config = typeof fieldConfig === 'object' ? fieldConfig : {}
                  const shouldChunk = config.chunk !== false && fieldValue.length > (config.chunkSize || embeddingConfig.chunkSize || 1500)
                  
                  if (shouldChunk) {
                    await embeddingManager.storeChunkedEmbeddings(
                      record.id,
                      fieldName,
                      fieldValue,
                      {
                        chunkSize: config.chunkSize || embeddingConfig.chunkSize,
                        overlap: config.chunkOverlap || embeddingConfig.chunkOverlap,
                        strategy: config.chunkingStrategy || embeddingConfig.chunkingStrategy,
                      }
                    )
                  } else {
                    const embedding = await embeddingManager.generateEmbedding(fieldValue)
                    await embeddingManager.storeEmbedding(record.id, fieldName, fieldValue, embedding)
                  }
                }
              }
            })
          )
        } catch (e) {
          console.warn('[embeddingEnhancer] Failed to update embeddings:', e.message)
        }
      }
      
      return record
    }
  }
  
  return modelApi
}

module.exports = enhanceModelWithEmbeddings

