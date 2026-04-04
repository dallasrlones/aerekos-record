/**
 * Sharding and Multi-Database Manager
 * Supports:
 * - Multiple database instances
 * - Sharding based on shard key
 * - Read replicas (read/write splitting)
 * - Failover/High availability
 */

class ShardingManager {
  constructor() {
    this.instances = new Map() // Map of instance names to adapter instances
    this.shardMappings = new Map() // Map of shard keys to instance names
    this.readReplicas = new Map() // Map of primary instance names to replica instances
    this.shardKeyExtractors = new Map() // Map of model names to shard key extractor functions
    this.defaultInstance = null
    this.routingStrategy = 'hash' // 'hash', 'range', 'custom'
  }

  /**
   * Add a database instance
   * @param {string} name - Instance name (e.g., 'shard1', 'primary', 'replica1')
   * @param {object} adapterInstance - Adapter instance from Record.connect()
   * @param {object} options - Options
   * @param {boolean} options.isDefault - Set as default instance
   * @param {boolean} options.isReadOnly - Mark as read-only replica
   * @param {string} options.primaryInstance - Name of primary instance this replica belongs to
   */
  addInstance(name, adapterInstance, options = {}) {
    this.instances.set(name, {
      adapter: adapterInstance,
      isReadOnly: options.isReadOnly || false,
      primaryInstance: options.primaryInstance || null,
      weight: options.weight || 1, // For load balancing
      healthy: true,
      lastHealthCheck: null,
    })

    if (options.isDefault || this.instances.size === 1) {
      this.defaultInstance = name
    }

    if (options.primaryInstance) {
      if (!this.readReplicas.has(options.primaryInstance)) {
        this.readReplicas.set(options.primaryInstance, [])
      }
      this.readReplicas.get(options.primaryInstance).push(name)
    }
  }

  /**
   * Configure sharding for a model
   * @param {string} modelName - Model name
   * @param {function|string} shardKeyExtractor - Function to extract shard key from record, or field name
   * @param {object} shardMapping - Map of shard keys to instance names
   */
  configureSharding(modelName, shardKeyExtractor, shardMapping = {}) {
    if (typeof shardKeyExtractor === 'string') {
      // Field name - extract value from record
      const fieldName = shardKeyExtractor
      this.shardKeyExtractors.set(modelName, (record) => record[fieldName])
    } else if (typeof shardKeyExtractor === 'function') {
      // Custom function
      this.shardKeyExtractors.set(modelName, shardKeyExtractor)
    }

    // Store shard mappings
    Object.entries(shardMapping).forEach(([shardKey, instanceName]) => {
      if (!this.shardMappings.has(modelName)) {
        this.shardMappings.set(modelName, new Map())
      }
      this.shardMappings.get(modelName).set(shardKey, instanceName)
    })
  }

  /**
   * Get instance for a shard key
   * @param {string} modelName - Model name
   * @param {*} shardKey - Shard key value
   * @returns {string} Instance name
   */
  getInstanceForShard(modelName, shardKey) {
    const modelMappings = this.shardMappings.get(modelName)
    if (modelMappings && modelMappings.has(shardKey)) {
      return modelMappings.get(shardKey)
    }

    // Use routing strategy if no explicit mapping
    if (this.routingStrategy === 'hash') {
      const instances = Array.from(this.instances.keys()).filter(name => {
        const instance = this.instances.get(name)
        return !instance.isReadOnly && instance.healthy
      })
      if (instances.length === 0) {
        return this.defaultInstance
      }
      const hash = this.hashString(String(shardKey))
      return instances[hash % instances.length]
    }

    return this.defaultInstance
  }

  /**
   * Get instance for read operation (can use replica)
   * @param {string} modelName - Model name
   * @param {*} shardKey - Shard key value (optional)
   * @param {boolean} preferReplica - Prefer read replica if available
   * @returns {string} Instance name
   */
  getInstanceForRead(modelName, shardKey = null, preferReplica = true) {
    const primaryInstance = shardKey 
      ? this.getInstanceForShard(modelName, shardKey)
      : this.defaultInstance

    if (preferReplica) {
      const replicas = this.readReplicas.get(primaryInstance) || []
      const healthyReplicas = replicas.filter(name => {
        const instance = this.instances.get(name)
        return instance && instance.healthy
      })
      
      if (healthyReplicas.length > 0) {
        // Round-robin or random selection
        const selected = healthyReplicas[Math.floor(Math.random() * healthyReplicas.length)]
        return selected
      }
    }

    return primaryInstance
  }

  /**
   * Get instance for write operation (must use primary)
   * @param {string} modelName - Model name
   * @param {*} shardKey - Shard key value (optional)
   * @returns {string} Instance name
   */
  getInstanceForWrite(modelName, shardKey = null) {
    return shardKey 
      ? this.getInstanceForShard(modelName, shardKey)
      : this.defaultInstance
  }

  /**
   * Extract shard key from record
   * @param {string} modelName - Model name
   * @param {object} record - Record object
   * @returns {*} Shard key value
   */
  extractShardKey(modelName, record) {
    const extractor = this.shardKeyExtractors.get(modelName)
    if (extractor) {
      return extractor(record)
    }
    return null
  }

  /**
   * Hash string to number
   * @param {string} str - String to hash
   * @returns {number} Hash value
   */
  hashString(str) {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32bit integer
    }
    return Math.abs(hash)
  }

  /**
   * Health check all instances
   * @returns {Promise<object>} Health status of all instances
   */
  async healthCheckAll() {
    const results = {}
    for (const [name, instance] of this.instances.entries()) {
      try {
        const health = await instance.adapter.healthCheck()
        instance.healthy = health.healthy
        instance.lastHealthCheck = new Date()
        results[name] = health
      } catch (error) {
        instance.healthy = false
        instance.lastHealthCheck = new Date()
        results[name] = { healthy: false, error: error.message }
      }
    }
    return results
  }

  /**
   * Get all healthy instances
   * @param {boolean} readOnly - Filter for read-only instances
   * @returns {Array<string>} Array of healthy instance names
   */
  getHealthyInstances(readOnly = false) {
    return Array.from(this.instances.entries())
      .filter(([name, instance]) => {
        return instance.healthy && (readOnly ? instance.isReadOnly : !instance.isReadOnly)
      })
      .map(([name]) => name)
  }

  /**
   * Close all instances
   */
  async closeAll() {
    const closePromises = Array.from(this.instances.values()).map(instance => 
      instance.adapter.close()
    )
    await Promise.all(closePromises)
    this.instances.clear()
    this.shardMappings.clear()
    this.readReplicas.clear()
    this.shardKeyExtractors.clear()
  }
}

module.exports = ShardingManager

