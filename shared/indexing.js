/**
 * Index Manager
 * Provides advanced indexing capabilities
 */
class IndexManager {
  constructor(adapter) {
    this.adapter = adapter
    this.indexes = new Map() // Map of model names to their indexes
    this.modelAdapters = new Map() // Map of model names to their adapter instances
  }

  /**
   * Register a model with its adapter instance
   */
  registerModel(modelName, modelApi) {
    this.modelAdapters.set(modelName, {
      api: modelApi,
      adapter: this.adapter, // Store reference to adapter
    })
  }

  /**
   * Define an index for a model
   * @param {string} modelName - Model name
   * @param {object|string|Array} indexDef - Index definition
   * @param {object} options - Index options
   */
  defineIndex(modelName, indexDef, options = {}) {
    if (!this.indexes.has(modelName)) {
      this.indexes.set(modelName, [])
    }

    const indexes = this.indexes.get(modelName)

    // Simple field name
    if (typeof indexDef === 'string') {
      indexes.push({
        fields: [indexDef],
        unique: options.unique || false,
        name: options.name || `${modelName}_${indexDef}_idx`,
        partial: options.where || null,
        type: options.type || 'btree', // btree, hash, gist, gin, etc.
      })
    }
    // Array of fields (composite index)
    else if (Array.isArray(indexDef)) {
      indexes.push({
        fields: indexDef,
        unique: options.unique || false,
        name: options.name || `${modelName}_${indexDef.join('_')}_idx`,
        partial: options.where || null,
        type: options.type || 'btree',
      })
    }
    // Object definition
    else if (typeof indexDef === 'object') {
      indexes.push({
        fields: indexDef.fields || [indexDef.field],
        unique: indexDef.unique || false,
        name: indexDef.name || `${modelName}_${(indexDef.fields || [indexDef.field]).join('_')}_idx`,
        partial: indexDef.where || null,
        type: indexDef.type || 'btree',
        ...indexDef,
      })
    }
  }

  /**
   * Create indexes for a model
   */
  async createIndexes(modelName, modelApi = null) {
    const modelInfo = modelApi 
      ? { api: modelApi, adapter: this.adapter }
      : this.modelAdapters.get(modelName)
    
    if (!modelInfo) {
      throw new Error(`Model ${modelName} not registered. Call registerModel() first or pass modelApi.`)
    }

    const indexes = this.indexes.get(modelName) || []
    const created = []

    for (const indexDef of indexes) {
      try {
        await this.createIndex(modelName, modelInfo.api, modelInfo.adapter, indexDef)
        created.push(indexDef.name)
      } catch (error) {
        console.error(`Failed to create index ${indexDef.name}:`, error)
        throw error
      }
    }

    return created
  }

  /**
   * Create a single index (database-specific)
   */
  async createIndex(modelName, modelApi, adapterInstance, indexDef) {
    const backend = modelApi.__backend || 'unknown'
    
    switch (backend) {
      case 'psql':
        return this.createPostgreSQLIndex(modelName, modelApi, adapterInstance, indexDef)
      case 'mongodb':
        return this.createMongoDBIndex(modelName, modelApi, adapterInstance, indexDef)
      case 'neo4j':
        return this.createNeo4jIndex(modelName, modelApi, adapterInstance, indexDef)
      case 'elasticsearch':
        return this.createElasticsearchIndex(modelName, modelApi, adapterInstance, indexDef)
      case 'redis':
        // Redis doesn't support indexes
        return Promise.resolve()
      default:
        throw new Error(`Index creation not supported for backend: ${backend}`)
    }
  }

  /**
   * Create PostgreSQL index
   */
  async createPostgreSQLIndex(modelName, modelApi, adapterInstance, indexDef) {
    const tableName = modelApi.__tableName || `${modelName.toLowerCase()}s`
    const pool = adapterInstance?.pool
    
    if (!pool) {
      throw new Error('PostgreSQL pool not available')
    }

    const fields = indexDef.fields.map(f => `"${f}"`).join(', ')
    const unique = indexDef.unique ? 'UNIQUE' : ''
    const type = indexDef.type || 'btree'
    const partial = indexDef.partial ? `WHERE ${indexDef.partial}` : ''

    const sql = `
      CREATE ${unique} INDEX IF NOT EXISTS "${indexDef.name}"
      ON "${tableName}" USING ${type} (${fields})
      ${partial}
    `

    await pool.query(sql)
  }

  /**
   * Create MongoDB index
   */
  async createMongoDBIndex(modelName, modelApi, adapterInstance, indexDef) {
    const collectionName = modelApi.__collectionName || `${modelName.toLowerCase()}s`
    
    // MongoDB adapter stores getCollection internally - we need to access it
    // The adapter instance should have a method to get collection
    // For now, we'll try to access it through the adapter's internal state
    // This is a limitation - MongoDB adapter needs to expose getCollection
    
    // Workaround: Use the model's internal adapter reference if available
    // Or we need to modify MongoDB adapter to expose getCollection
    throw new Error('MongoDB index creation requires adapter.getCollection() to be exposed. Use indexes in model settings for now.')
    const indexSpec = {}
    
    indexDef.fields.forEach(field => {
      indexSpec[field] = 1 // Ascending
    })

    const options = {
      unique: indexDef.unique || false,
      name: indexDef.name,
      partialFilterExpression: indexDef.partial || undefined,
    }

    await collection.createIndex(indexSpec, options)
  }

  /**
   * Create Neo4j index
   */
  async createNeo4jIndex(modelName, modelApi, adapterInstance, indexDef) {
    // Neo4j indexes are automatically created through model settings
    // Additional indexes can be created via Cypher queries
    // For now, recommend using model settings
    console.warn('Neo4j indexes should be defined in model settings. Use indexes: ["field"] in model definition.')
    return Promise.resolve()

    // Neo4j supports indexes on properties
    // For composite indexes, we create separate indexes or use a composite property
    for (const field of indexDef.fields) {
      const cypher = `
        CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.${field})
      `
      await runQuery(cypher, {}, { write: true })
    }
  }

  /**
   * Create Elasticsearch index mapping
   */
  async createElasticsearchIndex(modelName, modelApi, adapterInstance, indexDef) {
    const indexName = modelApi.__indexName || `${modelName.toLowerCase()}s`
    const client = adapterInstance?.client
    
    if (!client) {
      throw new Error('Elasticsearch client not available')
    }

    // Elasticsearch indexes are defined in mappings
    // This would typically be done during index creation
    // For now, we'll update the mapping
    const mapping = {}
    indexDef.fields.forEach(field => {
      mapping[field] = {
        type: indexDef.type === 'text' ? 'text' : 'keyword',
        index: true,
      }
    })

    try {
      await client.indices.putMapping({
        index: indexName,
        properties: mapping,
      })
    } catch (error) {
      // Index might not exist yet
      console.warn(`Could not update mapping for ${indexName}:`, error.message)
    }
  }

  /**
   * Drop an index
   */
  async dropIndex(modelName, indexName, modelApi = null) {
    const modelInfo = modelApi 
      ? { api: modelApi, adapter: this.adapter }
      : this.modelAdapters.get(modelName)
    
    if (!modelInfo) {
      throw new Error(`Model ${modelName} not registered. Call registerModel() first or pass modelApi.`)
    }

    const backend = modelInfo.api.__backend || 'unknown'
    
    switch (backend) {
      case 'psql':
        return this.dropPostgreSQLIndex(modelName, modelInfo.api, modelInfo.adapter, indexName)
      case 'mongodb':
        return this.dropMongoDBIndex(modelName, modelInfo.api, modelInfo.adapter, indexName)
      case 'neo4j':
        return this.dropNeo4jIndex(modelName, modelInfo.api, modelInfo.adapter, indexName)
      case 'elasticsearch':
        // Elasticsearch doesn't support dropping individual field indexes
        return Promise.resolve()
      default:
        throw new Error(`Index dropping not supported for backend: ${backend}`)
    }
  }

  async dropPostgreSQLIndex(modelName, modelApi, adapterInstance, indexName) {
    const pool = adapterInstance?.pool
    if (!pool) throw new Error('PostgreSQL pool not available')
    await pool.query(`DROP INDEX IF EXISTS "${indexName}"`)
  }

  async dropMongoDBIndex(modelName, modelApi, adapterInstance, indexName) {
    throw new Error('MongoDB index dropping requires adapter.getCollection() to be exposed.')
  }

  async dropNeo4jIndex(modelName, modelApi, adapterInstance, indexName) {
    // Neo4j indexes are managed through model settings
    console.warn('Neo4j indexes are managed through model settings. Cannot drop individual indexes.')
    return Promise.resolve()
  }

  async dropNeo4jIndex(modelName, modelApi, indexName) {
    // Neo4j indexes are automatically managed
    // This would need to be implemented based on Neo4j version
    return Promise.resolve()
  }

  /**
   * List all indexes for a model
   */
  async listIndexes(modelName, modelApi = null) {
    const modelInfo = modelApi 
      ? { api: modelApi, adapter: this.adapter }
      : this.modelAdapters.get(modelName)
    
    if (!modelInfo) {
      throw new Error(`Model ${modelName} not registered. Call registerModel() first or pass modelApi.`)
    }

    const backend = modelInfo.api.__backend || 'unknown'
    
    switch (backend) {
      case 'psql':
        return this.listPostgreSQLIndexes(modelName, modelInfo.api, modelInfo.adapter)
      case 'mongodb':
        return this.listMongoDBIndexes(modelName, modelInfo.api, modelInfo.adapter)
      case 'neo4j':
        return this.listNeo4jIndexes(modelName, modelInfo.api, modelInfo.adapter)
      default:
        return []
    }
  }

  async listPostgreSQLIndexes(modelName, modelApi, adapterInstance) {
    const tableName = modelApi.__tableName || `${modelName.toLowerCase()}s`
    const pool = adapterInstance?.pool
    if (!pool) throw new Error('PostgreSQL pool not available')
    const result = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = $1
    `, [tableName])
    return result.rows
  }

  async listMongoDBIndexes(modelName, modelApi, adapterInstance) {
    throw new Error('MongoDB index listing requires adapter.getCollection() to be exposed.')
  }

  async listNeo4jIndexes(modelName, modelApi, adapterInstance) {
    // Neo4j indexes are managed through constraints and indexes in model settings
    // Return empty array as Neo4j doesn't expose index listing easily
    return []
  }
}

module.exports = IndexManager

