const QueryBuilder = require('./queryBuilder')
const BatchOperationsManager = require('./batchOperations')
const StreamingManager = require('./streaming')
const FullTextSearchManager = require('./fullTextSearch')
const JSONSupportManager = require('./jsonSupport')
const ChangeStreamsManager = require('./changeStreams')
const GeospatialManager = require('./geospatial')
const CompositeKeysManager = require('./compositeKeys')
const { enhanceModelWithAttachments } = require('./attachmentEnhancer')
const enhanceModelWithEmbeddings = require('./embeddingEnhancer')

/**
 * Enhance model API with additional features
 */
function enhanceModel(modelApi, adapterInstance, registry = null) {
  // Store adapter reference for features that need it
  modelApi.__adapterInstance = adapterInstance

  // Query Builder
  modelApi.query = function() {
    return new QueryBuilder(this)
  }

  // Batch Operations
  modelApi.batch = new BatchOperationsManager(modelApi)

  // Streaming
  modelApi.stream = new StreamingManager(modelApi)

  // Full-Text Search
  modelApi.search = new FullTextSearchManager(modelApi)

  // JSON Support
  modelApi.json = new JSONSupportManager(modelApi)

  // Change Streams (MongoDB only)
  if (modelApi.__backend === 'mongodb') {
    modelApi.changes = new ChangeStreamsManager(modelApi)
  }

  // Geospatial (PostgreSQL/MongoDB)
  if (modelApi.__backend === 'psql' || modelApi.__backend === 'mongodb') {
    modelApi.geo = new GeospatialManager(modelApi)
  }

  // Composite Keys
  modelApi.compositeKeys = new CompositeKeysManager(modelApi)

  // Attachments (Active Storage-like)
  enhanceModelWithAttachments(modelApi, registry)

  // Embeddings (if configured)
  if (modelApi.__embeddingConfig) {
    enhanceModelWithEmbeddings(modelApi, adapterInstance, modelApi.__embeddingConfig)
  }

  return modelApi
}

module.exports = enhanceModel

