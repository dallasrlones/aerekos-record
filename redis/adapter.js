const { createClient } = require('redis')
const { randomUUID } = require('node:crypto')
const {
  TYPE_COERCERS,
  OMIT_FROM_OUTPUT_TYPES,
  isObject,
  nowIso,
  toFkColumn,
  normalizeWhere,
  pickWritableFields,
  stripOutput,
  applySelect,
  coerceAndEncrypt,
  CallbackChain,
  validateRequired,
} = require('../shared/utils')
const enhanceModel = require('../shared/modelEnhancer')

const DEFAULT_CONNECTION = {
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT) || 10000,
    reconnectStrategy: (retries) => {
      if (retries > 10) return new Error('Too many retries')
      return Math.min(retries * 50, 1000)
    },
  },
  password: process.env.REDIS_PASSWORD,
  // Connection pool configuration (Redis uses single connection by default)
  // For connection pooling, use Redis Cluster or multiple clients
}

const buildRedisKey = (prefix, id) => `${prefix}:${id}`

const buildRedisPattern = (prefix, where) => {
  if (!where || Object.keys(where).length === 0) {
    return `${prefix}:*`
  }
  // Redis doesn't support complex queries, so we'll use pattern matching
  // For complex queries, we'd need to scan all keys (not ideal but works)
  return `${prefix}:*`
}

const normalizeIncludes = (includes, selfName) => {
  if (!includes) return []
  const list = Array.isArray(includes) ? includes : [includes]
  return list
    .map((item) => {
      if (typeof item === 'string') {
        return { model: item, as: `${item.toLowerCase()}s`, where: {} }
      }
      if (isObject(item) && typeof item.model === 'string') {
        const as = item.as || `${item.model.toLowerCase()}s`
        return { model: item.model, as, where: item.where || {}, select: item.select }
      }
      return null
    })
    .filter(Boolean)
}

const redisAdapter = (connectionSettings = {}) => {
  const cfg = { ...DEFAULT_CONNECTION, ...connectionSettings }
  const client = createClient(cfg)
  let connected = false
  const registry = new Map()

  const ensureConnection = async () => {
    if (!connected) {
      await client.connect()
      connected = true
    }
  }

  const buildInstance = (modelApi, docData) => {
    const data = { ...docData }
    const associations = modelApi.__associationFactories.reduce((acc, makeAssoc) => {
      const proxy = makeAssoc(modelApi, data)
      return { ...acc, ...proxy }
    }, {})
    const instance = {
      ...stripOutput(data, modelApi.__properties),
      toJSON() {
        return stripOutput({ ...data }, modelApi.__properties)
      },
      ...associations,
    }
    // Apply attachments if any
    if (modelApi.__attachmentFactories && modelApi.__attachmentFactories.length > 0) {
      const attachments = modelApi.__attachmentFactories.reduce((acc, factory) => {
        const proxy = factory(instance)
        return { ...acc, ...proxy }
      }, {})
      Object.assign(instance, attachments)
    }
    return instance
  }

  const registerAssociations = (modelName, settings) => {
    const factories = []
    const parentFk = (name) => toFkColumn(name)

    const addHasMany = (target) => {
      if (typeof target === 'string') {
        factories.push((self, doc) => {
          const targetModel = registry.get(target)
          if (!targetModel) return {}
          const fkName = parentFk(self.__name)
          return {
            [targetModel.__collectionName]: {
              async findAll({ where = {}, order, limit, offset, withDeleted } = {}) {
                const merged = { ...where, [fkName]: doc.id }
                return targetModel.findAll({ where: merged, order, limit, offset, withDeleted })
              },
              async create(attrs) {
                const merged = { ...attrs, [fkName]: doc.id }
                return targetModel.create(merged)
              },
              async count(where = {}) {
                const merged = { ...where, [fkName]: doc.id }
                return targetModel.count(merged)
              },
            },
          }
        })
      }
    }

    const addHasOne = (target) => {
      if (typeof target === 'string') {
        factories.push((self, doc) => {
          const targetModel = registry.get(target)
          if (!targetModel) return {}
          const fkName = parentFk(self.__name)
          const key = targetModel.__singularName.toLowerCase()
          return {
            [key]: {
              async get({ withDeleted } = {}) {
                return targetModel.findBy({ [fkName]: doc.id }, { withDeleted })
              },
              async set(attrsOrId) {
                if (isObject(attrsOrId)) {
                  const attrs = { ...attrsOrId, [fkName]: doc.id }
                  return targetModel.create(attrs)
                }
                return targetModel.updateBy({ id: attrsOrId }, { [fkName]: doc.id })
              },
            },
          }
        })
      }
    }

    const addBelongsTo = (target) => {
      if (typeof target === 'string') {
        factories.push((self, doc) => {
          const targetModel = registry.get(target)
          if (!targetModel) return {}
          const fkName = parentFk(targetModel.__singularName)
          return {
            parent: async ({ withDeleted } = {}) => {
              const parentId = doc[fkName]
              if (!parentId) return null
              return targetModel.find(parentId, { withDeleted })
            },
          }
        })
      }
    }

    if (Array.isArray(settings?.hasMany)) settings.hasMany.forEach(addHasMany)
    if (Array.isArray(settings?.hasOne)) settings.hasOne.forEach(addHasOne)
    if (settings?.belongsTo) addBelongsTo(settings.belongsTo)

    return factories
  }

  const model = (name, properties = {}, settings = {}) => {
    const keyPrefix = `${String(name).trim().toLowerCase()}s`
    const singularName = String(name).trim()
    const collectionName = keyPrefix
    const softDeleteEnabled = Boolean(settings.softDelete)
    const timestampsEnabled = settings.timestamps !== false

    const __associationFactories = registerAssociations(singularName, settings)
    
    // Initialize Rails-style callback chain
    const callbacks = new CallbackChain()
    
    // Register callbacks from settings
    if (settings.callbacks) {
      Object.entries(settings.callbacks).forEach(([name, callback]) => {
        if (Array.isArray(callback)) {
          callback.forEach(cb => {
            if (typeof cb === 'function') {
              callbacks.add(name, cb)
            } else if (isObject(cb) && cb.fn) {
              callbacks.add(name, cb.fn, { if: cb.if, unless: cb.unless })
            }
          })
        } else if (typeof callback === 'function') {
          callbacks.add(name, callback)
        } else if (isObject(callback) && callback.fn) {
          callbacks.add(name, callback.fn, { if: callback.if, unless: callback.unless })
        }
      })
    }

    const api = {
      __name: singularName,
      __keyPrefix: keyPrefix,
      __collectionName: collectionName,
      __singularName: singularName,
      __modelName: singularName,
      __properties: properties,
      __associationFactories,
      __backend: 'redis',
      __callbacks: callbacks,
      __embeddingConfig: settings.embeddings || null,

      // Rails-style callback registration methods
      before_validation(callback, options = {}) {
        callbacks.add('before_validation', callback, options)
        return this
      },
      before_validation_on_create(callback, options = {}) {
        callbacks.add('before_validation_on_create', callback, options)
        return this
      },
      before_validation_on_update(callback, options = {}) {
        callbacks.add('before_validation_on_update', callback, options)
        return this
      },
      after_validation(callback, options = {}) {
        callbacks.add('after_validation', callback, options)
        return this
      },
      after_validation_on_create(callback, options = {}) {
        callbacks.add('after_validation_on_create', callback, options)
        return this
      },
      after_validation_on_update(callback, options = {}) {
        callbacks.add('after_validation_on_update', callback, options)
        return this
      },
      before_save(callback, options = {}) {
        callbacks.add('before_save', callback, options)
        return this
      },
      after_save(callback, options = {}) {
        callbacks.add('after_save', callback, options)
        return this
      },
      around_save(callback, options = {}) {
        callbacks.add('around_save', callback, options)
        return this
      },
      before_create(callback, options = {}) {
        callbacks.add('before_create', callback, options)
        return this
      },
      after_create(callback, options = {}) {
        callbacks.add('after_create', callback, options)
        return this
      },
      around_create(callback, options = {}) {
        callbacks.add('around_create', callback, options)
        return this
      },
      before_update(callback, options = {}) {
        callbacks.add('before_update', callback, options)
        return this
      },
      after_update(callback, options = {}) {
        callbacks.add('after_update', callback, options)
        return this
      },
      around_update(callback, options = {}) {
        callbacks.add('around_update', callback, options)
        return this
      },
      before_destroy(callback, options = {}) {
        callbacks.add('before_destroy', callback, options)
        return this
      },
      after_destroy(callback, options = {}) {
        callbacks.add('after_destroy', callback, options)
        return this
      },
      around_destroy(callback, options = {}) {
        callbacks.add('around_destroy', callback, options)
        return this
      },
      after_commit(callback, options = {}) {
        callbacks.add('after_commit', callback, options)
        return this
      },
      after_rollback(callback, options = {}) {
        callbacks.add('after_rollback', callback, options)
        return this
      },
      skip_callback(name) {
        callbacks.skip(name)
        return this
      },

      // Redis-specific: Set TTL for a record
      async setTTL(id, seconds) {
        await ensureConnection()
        const key = buildRedisKey(keyPrefix, id)
        await client.expire(key, seconds)
        return true
      },

      // Redis-specific: Get TTL for a record
      async getTTL(id) {
        await ensureConnection()
        const key = buildRedisKey(keyPrefix, id)
        const ttl = await client.ttl(key)
        return ttl > 0 ? ttl : null
      },

      async create(attrs, options = {}) {
        await ensureConnection()
        
        const isNewRecord = true
        let prepared = pickWritableFields(attrs || {}, properties)
        
        // Rails validation callbacks
        await callbacks.run('before_validation', api, prepared)
        await callbacks.run('before_validation_on_create', api, prepared)
        
        // Validate required fields
        validateRequired(prepared, settings.required || [], singularName)
        
        await callbacks.run('after_validation_on_create', api, prepared)
        await callbacks.run('after_validation', api, prepared)
        
        // Rails save callbacks
        await callbacks.run('before_save', api, prepared)
        await callbacks.run('before_create', api, prepared)
        
        const coerced = await coerceAndEncrypt(prepared, properties)
        const id = randomUUID()
        if (timestampsEnabled) {
          coerced.createdAt = nowIso()
          coerced.updatedAt = nowIso()
        }
        coerced.id = id
        
        const performCreate = async () => {
          const key = buildRedisKey(keyPrefix, id)
          const value = JSON.stringify(coerced)
          await client.set(key, value)
          
          // Set TTL if provided
          if (options.ttl && typeof options.ttl === 'number') {
            await client.expire(key, options.ttl)
          }
          
          return buildInstance(api, coerced)
        }
        
        let instance
        if (callbacks.callbacks.around_create.length > 0 || callbacks.callbacks.around_save.length > 0) {
          instance = await callbacks.runAround('around_create', api, coerced, async () => {
            return await callbacks.runAround('around_save', api, coerced, performCreate)
          })
        } else {
          instance = await performCreate()
        }
        
        await callbacks.run('after_create', api, instance)
        await callbacks.run('after_save', api, instance)
        
        return instance
      },

      async find(id, { withDeleted } = {}) {
        await ensureConnection()
        const key = buildRedisKey(keyPrefix, id)
        const value = await client.get(key)
        if (!value) return null
        
        const doc = JSON.parse(value)
        if (softDeleteEnabled && !withDeleted && doc.deletedAt) {
          return null
        }
        return buildInstance(api, doc)
      },

      async findBy(where, { withDeleted } = {}) {
        await ensureConnection()
        // Redis doesn't support complex queries, so we scan all keys
        const pattern = buildRedisPattern(keyPrefix, where)
        const keys = await client.keys(pattern)
        
        for (const key of keys) {
          const value = await client.get(key)
          if (!value) continue
          
          const doc = JSON.parse(value)
          if (softDeleteEnabled && !withDeleted && doc.deletedAt) continue
          
          // Check if doc matches where conditions
          let matches = true
          for (const [k, v] of Object.entries(where || {})) {
            if (doc[k] !== v) {
              matches = false
              break
            }
          }
          
          if (matches) {
            return buildInstance(api, doc)
          }
        }
        
        return null
      },

      async findOneBy(where, opts = {}) {
        return this.findBy(where, opts)
      },

      async findAll({ where = {}, order, limit, offset, withDeleted, include, select } = {}) {
        await ensureConnection()
        const pattern = buildRedisPattern(keyPrefix, where)
        const keys = await client.keys(pattern)
        
        const docs = []
        for (const key of keys) {
          const value = await client.get(key)
          if (!value) continue
          
          const doc = JSON.parse(value)
          if (softDeleteEnabled && !withDeleted && doc.deletedAt) continue
          
          // Check if doc matches where conditions
          let matches = true
          for (const [k, v] of Object.entries(where || {})) {
            if (doc[k] !== v) {
              matches = false
              break
            }
          }
          
          if (matches) {
            docs.push(buildInstance(api, doc))
          }
        }
        
        // Apply sorting (simple in-memory sort)
        if (order) {
          const sortField = typeof order === 'string' ? order.split(' ')[0] : order[0]
          const sortDir = typeof order === 'string' && order.includes('DESC') ? -1 : 1
          docs.sort((a, b) => {
            if (a[sortField] < b[sortField]) return -1 * sortDir
            if (a[sortField] > b[sortField]) return 1 * sortDir
            return 0
          })
        }
        
        // Apply offset and limit
        const start = offset || 0
        const end = limit ? start + limit : docs.length
        let instances = docs.slice(start, end)
        
        if (select) {
          instances = instances.map(inst => applySelect(inst, select))
        }
        
        // Handle includes
        const includes = normalizeIncludes(include, singularName)
        if (includes.length > 0) {
          const includeModels = includes
            .map((inc) => ({ ...inc, api: registry.get(inc.model) }))
            .filter((inc) => inc.api)
          
          const parentIds = instances.map(inst => inst.id)
          const childFetches = includeModels.map(async (inc) => {
            const fk = toFkColumn(singularName)
            const selectWithFk = inc.select ? Array.from(new Set([...(inc.select || []), fk])) : undefined
            const children = await inc.api.findAll({ where: { ...inc.where, [fk]: parentIds }, select: selectWithFk })
            return { as: inc.as, model: inc.model, children, fkName: fk, select: inc.select }
          })
          const childrenResults = await Promise.all(childFetches)
          
          const childrenByParent = {}
          childrenResults.forEach((bundle) => {
            const { fkName, select: childSelect } = bundle
            bundle.children.forEach((child) => {
              const pid = child[fkName]
              if (!childrenByParent[pid]) childrenByParent[pid] = {}
              if (!childrenByParent[pid][bundle.as]) childrenByParent[pid][bundle.as] = []
              const childOut = childSelect ? applySelect(child, childSelect) : child
              childrenByParent[pid][bundle.as].push(childOut)
            })
          })
          instances = instances.map((p) => ({ ...p, ...(childrenByParent[p.id] || {}) }))
        }
        
        return instances
      },

      async count(where = {}, { withDeleted } = {}) {
        await ensureConnection()
        const pattern = buildRedisPattern(keyPrefix, where)
        const keys = await client.keys(pattern)
        
        let count = 0
        for (const key of keys) {
          const value = await client.get(key)
          if (!value) continue
          
          const doc = JSON.parse(value)
          if (softDeleteEnabled && !withDeleted && doc.deletedAt) continue
          
          // Check if doc matches where conditions
          let matches = true
          for (const [k, v] of Object.entries(where || {})) {
            if (doc[k] !== v) {
              matches = false
              break
            }
          }
          
          if (matches) count++
        }
        
        return count
      },

      async update(id, changes, options = {}) {
        await ensureConnection()
        
        const existing = await this.find(id, { withDeleted: true })
        if (!existing) return null
        
        const isNewRecord = false
        let filtered = pickWritableFields(changes || {}, properties)
        
        // Rails validation callbacks
        await callbacks.run('before_validation', api, { ...existing, ...filtered })
        await callbacks.run('before_validation_on_update', api, { ...existing, ...filtered })
        
        const updated = { ...existing, ...filtered }
        validateRequired(updated, settings.required || [], singularName)
        
        await callbacks.run('after_validation_on_update', api, updated)
        await callbacks.run('after_validation', api, updated)
        
        // Rails save callbacks
        await callbacks.run('before_save', api, updated)
        await callbacks.run('before_update', api, updated)
        
        const coerced = await coerceAndEncrypt(filtered, properties, { isUpdate: true })
        if (timestampsEnabled) coerced.updatedAt = nowIso()
        
        const setKeys = Object.keys(coerced)
        if (setKeys.length === 0) return existing
        
        const performUpdate = async () => {
          const key = buildRedisKey(keyPrefix, id)
          const updatedDoc = { ...existing, ...coerced }
          const value = JSON.stringify(updatedDoc)
          await client.set(key, value)
          
          // Update TTL if provided
          if (options.ttl && typeof options.ttl === 'number') {
            await client.expire(key, options.ttl)
          }
          
          return buildInstance(api, updatedDoc)
        }
        
        let instance
        if (callbacks.callbacks.around_update.length > 0 || callbacks.callbacks.around_save.length > 0) {
          instance = await callbacks.runAround('around_update', api, updated, async () => {
            return await callbacks.runAround('around_save', api, updated, performUpdate)
          })
        } else {
          instance = await performUpdate()
        }
        
        await callbacks.run('after_update', api, instance)
        await callbacks.run('after_save', api, instance)
        
        return instance
      },

      async updateBy(where, changes, { withDeleted } = {}) {
        const docs = await this.findAll({ where, withDeleted })
        const updates = docs.map(doc => this.update(doc.id, changes))
        return Promise.all(updates)
      },

      async updateOneBy(where, changes, { withDeleted } = {}) {
        const doc = await this.findBy(where, { withDeleted })
        if (!doc) return null
        return this.update(doc.id, changes)
      },

      async delete(id, { hardDelete = false } = {}) {
        await ensureConnection()
        
        const existing = await this.find(id, { withDeleted: true })
        if (!existing) return false
        
        // Rails destroy callbacks
        await callbacks.run('before_destroy', api, existing)
        
        const performDelete = async () => {
          const key = buildRedisKey(keyPrefix, id)
          if (hardDelete || !softDeleteEnabled) {
            await client.del(key)
            return true
          }
          const updatedDoc = { ...existing, deletedAt: nowIso() }
          await client.set(key, JSON.stringify(updatedDoc))
          return true
        }
        
        let result
        if (callbacks.callbacks.around_destroy.length > 0) {
          result = await callbacks.runAround('around_destroy', api, existing, performDelete)
        } else {
          result = await performDelete()
        }
        
        await callbacks.run('after_destroy', api, existing)
        
        return result
      },
    }

    // Enhance model with additional features
    const enhancedApi = enhanceModel(api, { client, ensureConnection }, registry)
    
    registry.set(singularName, enhancedApi)
    return enhancedApi
  }

  const close = async () => {
    if (connected) {
      await client.quit()
      connected = false
    }
  }

  // Connection health check
  const healthCheck = async () => {
    try {
      await ensureConnection()
      const pong = await client.ping()
      return { 
        healthy: pong === 'PONG', 
        pool: getPoolStats() 
      }
    } catch (error) {
      return { healthy: false, error: error.message, pool: getPoolStats() }
    }
  }

  // Get pool statistics
  const getPoolStats = () => {
    return {
      connected: connected,
      // Note: Redis client uses single connection by default
      // For pooling, consider using Redis Cluster
    }
  }

  return { model, close, healthCheck, getPoolStats, client }
}

module.exports = redisAdapter

