/**
 * Caching Manager
 * Provides caching layer integration with Redis/Memory cache
 */
class CachingManager {
  constructor(adapter, cacheAdapter = null) {
    this.adapter = adapter
    this.cacheAdapter = cacheAdapter // Redis adapter or memory cache
    this.defaultTTL = 3600 // 1 hour default
    this.cachePrefix = 'aerekos_record:'
    this.enabled = true
  }

  /**
   * Enable/disable caching
   */
  enable(enabled = true) {
    this.enabled = enabled
    return this
  }

  /**
   * Set cache TTL
   */
  setTTL(seconds) {
    this.defaultTTL = seconds
    return this
  }

  /**
   * Set cache prefix
   */
  setPrefix(prefix) {
    this.cachePrefix = prefix
    return this
  }

  /**
   * Generate cache key
   */
  cacheKey(modelName, operation, key) {
    return `${this.cachePrefix}${modelName}:${operation}:${key}`
  }

  /**
   * Get from cache
   */
  async get(key) {
    if (!this.enabled || !this.cacheAdapter) return null

    try {
      if (this.cacheAdapter.__backend === 'redis') {
        return await this.cacheAdapter.read(key)
      } else {
        // Memory cache or other
        return this.cacheAdapter.get ? await this.cacheAdapter.get(key) : null
      }
    } catch (error) {
      console.warn('Cache get error:', error)
      return null
    }
  }

  /**
   * Set cache
   */
  async set(key, value, ttl = null) {
    if (!this.enabled || !this.cacheAdapter) return

    try {
      const cacheTTL = ttl || this.defaultTTL
      if (this.cacheAdapter.__backend === 'redis') {
        await this.cacheAdapter.create(key, value, { ttl: cacheTTL })
      } else if (this.cacheAdapter.set) {
        await this.cacheAdapter.set(key, value, cacheTTL)
      }
    } catch (error) {
      console.warn('Cache set error:', error)
    }
  }

  /**
   * Delete from cache
   */
  async delete(key) {
    if (!this.enabled || !this.cacheAdapter) return

    try {
      if (this.cacheAdapter.__backend === 'redis') {
        await this.cacheAdapter.delete(key)
      } else if (this.cacheAdapter.delete) {
        await this.cacheAdapter.delete(key)
      }
    } catch (error) {
      console.warn('Cache delete error:', error)
    }
  }

  /**
   * Clear cache for a model
   */
  async clearModel(modelName) {
    if (!this.enabled || !this.cacheAdapter) return

    try {
      const pattern = `${this.cachePrefix}${modelName}:*`
      if (this.cacheAdapter.__backend === 'redis') {
        // Redis - get all keys matching pattern and delete
        const keys = await this.cacheAdapter.client.keys(pattern)
        if (keys.length > 0) {
          await this.cacheAdapter.client.del(keys)
        }
      }
    } catch (error) {
      console.warn('Cache clear error:', error)
    }
  }

  /**
   * Clear all cache
   */
  async clearAll() {
    if (!this.enabled || !this.cacheAdapter) return

    try {
      const pattern = `${this.cachePrefix}*`
      if (this.cacheAdapter.__backend === 'redis') {
        const keys = await this.cacheAdapter.client.keys(pattern)
        if (keys.length > 0) {
          await this.cacheAdapter.client.del(keys)
        }
      }
    } catch (error) {
      console.warn('Cache clear all error:', error)
    }
  }

  /**
   * Wrap a function with caching
   */
  async wrap(key, fn, ttl = null) {
    if (!this.enabled || !this.cacheAdapter) {
      return fn()
    }

    // Try cache first
    const cached = await this.get(key)
    if (cached !== null) {
      return cached
    }

    // Execute function
    const result = await fn()

    // Cache result
    await this.set(key, result, ttl)

    return result
  }
}

/**
 * Simple in-memory cache implementation
 */
class MemoryCache {
  constructor() {
    this.cache = new Map()
    this.timers = new Map()
  }

  get(key) {
    const item = this.cache.get(key)
    if (!item) return null

    // Check if expired
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.cache.delete(key)
      if (this.timers.has(key)) {
        clearTimeout(this.timers.get(key))
        this.timers.delete(key)
      }
      return null
    }

    return item.value
  }

  set(key, value, ttl = null) {
    const item = {
      value,
      expiresAt: ttl ? Date.now() + (ttl * 1000) : null,
    }

    this.cache.set(key, item)

    // Set timer for expiration
    if (ttl) {
      if (this.timers.has(key)) {
        clearTimeout(this.timers.get(key))
      }
      const timer = setTimeout(() => {
        this.cache.delete(key)
        this.timers.delete(key)
      }, ttl * 1000)
      this.timers.set(key, timer)
    }
  }

  delete(key) {
    this.cache.delete(key)
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key))
      this.timers.delete(key)
    }
  }

  clear() {
    this.timers.forEach(timer => clearTimeout(timer))
    this.timers.clear()
    this.cache.clear()
  }
}

module.exports = { CachingManager, MemoryCache }

