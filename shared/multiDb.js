const ShardingManager = require('./sharding')

/**
 * Multi-Database Manager
 * Creates a unified interface for multiple database instances with sharding support
 */
class MultiDatabaseManager {
  constructor() {
    this.shardingManager = new ShardingManager()
    this.modelRegistries = new Map() // Map of model names to their registries across instances
  }

  /**
   * Add a database instance
   */
  addInstance(name, adapterInstance, options = {}) {
    this.shardingManager.addInstance(name, adapterInstance, options)
  }

  /**
   * Configure sharding for a model
   */
  configureSharding(modelName, shardKeyExtractor, shardMapping = {}) {
    this.shardingManager.configureSharding(modelName, shardKeyExtractor, shardMapping)
  }

  /**
   * Create a model that works across multiple instances
   * @param {string} name - Model name
   * @param {object} properties - Model properties
   * @param {object} settings - Model settings
   * @returns {object} Model API with sharding support
   */
  model(name, properties = {}, settings = {}) {
    const instances = Array.from(this.shardingManager.instances.keys())
    if (instances.length === 0) {
      throw new Error('No database instances configured. Use addInstance() first.')
    }

    // Create model on all instances
    const modelInstances = new Map()
    instances.forEach(instanceName => {
      const instance = this.shardingManager.instances.get(instanceName)
      const modelApi = instance.adapter.model(name, properties, settings)
      modelInstances.set(instanceName, modelApi)
    })

    // Store model registry
    this.modelRegistries.set(name, modelInstances)

    // Create unified API that routes to appropriate instance
    return this.createShardedModelAPI(name, modelInstances, settings)
  }

  /**
   * Create a sharded model API that routes queries to appropriate instances
   */
  createShardedModelAPI(modelName, modelInstances, settings) {
    const getModelForWrite = (shardKey) => {
      const instanceName = this.shardingManager.getInstanceForWrite(modelName, shardKey)
      return modelInstances.get(instanceName)
    }

    const getModelForRead = (shardKey, preferReplica = true) => {
      const instanceName = this.shardingManager.getInstanceForRead(modelName, shardKey, preferReplica)
      return modelInstances.get(instanceName)
    }

    const extractShardKey = (record) => {
      return this.shardingManager.extractShardKey(modelName, record)
    }

    // Get first model instance for metadata
    const firstModel = Array.from(modelInstances.values())[0]

    return {
      ...firstModel,
      __modelName: modelName,
      __instances: modelInstances,
      __shardingManager: this.shardingManager,

      async create(attrs, options = {}) {
        const shardKey = extractShardKey(attrs) || options.shardKey
        const model = getModelForWrite(shardKey)
        return model.create(attrs, options)
      },

      async find(id, options = {}) {
        // Try all instances if shard key not provided
        if (options.shardKey) {
          const model = getModelForRead(options.shardKey, options.preferReplica !== false)
          return model.find(id, options)
        }

        // Search across all instances
        const searchPromises = Array.from(modelInstances.values()).map(model => 
          model.find(id, options).catch(() => null)
        )
        const results = await Promise.all(searchPromises)
        return results.find(r => r !== null) || null
      },

      async findBy(where, options = {}) {
        if (options.shardKey) {
          const model = getModelForRead(options.shardKey, options.preferReplica !== false)
          return model.findBy(where, options)
        }

        // Search across all instances
        const searchPromises = Array.from(modelInstances.values()).map(model => 
          model.findBy(where, options).catch(() => null)
        )
        const results = await Promise.all(searchPromises)
        return results.find(r => r !== null) || null
      },

      async findAll(options = {}) {
        if (options.shardKey) {
          const model = getModelForRead(options.shardKey, options.preferReplica !== false)
          return model.findAll(options)
        }

        // Search across all instances and merge results
        const searchPromises = Array.from(modelInstances.values()).map(model => 
          model.findAll(options).catch(() => [])
        )
        const results = await Promise.all(searchPromises)
        return results.flat()
      },

      async count(where = {}, options = {}) {
        if (options.shardKey) {
          const model = getModelForRead(options.shardKey, options.preferReplica !== false)
          return model.count(where, options)
        }

        // Count across all instances and sum
        const countPromises = Array.from(modelInstances.values()).map(model => 
          model.count(where, options).catch(() => 0)
        )
        const counts = await Promise.all(countPromises)
        return counts.reduce((sum, count) => sum + count, 0)
      },

      async update(id, changes, options = {}) {
        // Find record first to determine shard
        let shardKey = options.shardKey
        if (!shardKey) {
          const found = await this.find(id, { shardKey: null })
          if (found) {
            shardKey = extractShardKey(found)
          }
        }

        if (!shardKey) {
          throw new Error(`Cannot determine shard for update. Provide shardKey in options.`)
        }

        const model = getModelForWrite(shardKey)
        return model.update(id, changes, options)
      },

      async delete(id, options = {}) {
        // Find record first to determine shard
        let shardKey = options.shardKey
        if (!shardKey) {
          const found = await this.find(id, { shardKey: null })
          if (found) {
            shardKey = extractShardKey(found)
          }
        }

        if (!shardKey) {
          throw new Error(`Cannot determine shard for delete. Provide shardKey in options.`)
        }

        const model = getModelForWrite(shardKey)
        return model.delete(id, options)
      },

      // Bulk operations across all shards
      async findAllShards(options = {}) {
        const results = await Promise.all(
          Array.from(modelInstances.values()).map(model => 
            model.findAll(options).catch(() => [])
          )
        )
        return results.flat()
      },

      async countAllShards(where = {}, options = {}) {
        const counts = await Promise.all(
          Array.from(modelInstances.values()).map(model => 
            model.count(where, options).catch(() => 0)
          )
        )
        return counts.reduce((sum, count) => sum + count, 0)
      },
    }
  }

  /**
   * Health check all instances
   */
  async healthCheckAll() {
    return this.shardingManager.healthCheckAll()
  }

  /**
   * Close all instances
   */
  async closeAll() {
    await this.shardingManager.closeAll()
    this.modelRegistries.clear()
  }
}

module.exports = MultiDatabaseManager

