const { MongoClient, ObjectId } = require('mongodb')
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
  uri: process.env.MONGO_URI || 'mongodb://localhost:27017',
  database: process.env.MONGO_DB || 'test',
  options: {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    // Pool configuration
    maxPoolSize: parseInt(process.env.MONGO_POOL_MAX) || 10, // Maximum number of connections in the connection pool
    minPoolSize: parseInt(process.env.MONGO_POOL_MIN) || 0, // Minimum number of connections in the connection pool
    maxIdleTimeMS: parseInt(process.env.MONGO_POOL_MAX_IDLE_TIME) || 30000, // Close connections after 30 seconds of inactivity
    serverSelectionTimeoutMS: parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT) || 30000, // How long to try selecting a server
    connectTimeoutMS: parseInt(process.env.MONGO_CONNECT_TIMEOUT) || 30000, // How long to wait for initial connection
  },
}

const buildMongoQuery = (where, softDeleteEnabled, withDeleted) => {
  const query = { ...where }
  if (softDeleteEnabled && !withDeleted) {
    query.deletedAt = null
  }
  // Convert id to ObjectId if present
  if (query.id) {
    query._id = ObjectId.isValid(query.id) ? new ObjectId(query.id) : query.id
    delete query.id
  }
  return query
}

const buildSort = (order) => {
  if (!order) return null
  if (typeof order === 'string') {
    const parts = order.split(' ')
    const field = parts[0]
    const direction = parts[1] === 'DESC' || parts[1] === 'desc' ? -1 : 1
    return { [field]: direction }
  }
  if (Array.isArray(order)) {
    const sort = {}
    order.forEach((item) => {
      if (typeof item === 'string') {
        const parts = item.split(' ')
        const field = parts[0]
        const direction = parts[1] === 'DESC' || parts[1] === 'desc' ? -1 : 1
        sort[field] = direction
      }
    })
    return sort
  }
  return order
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

const mongodbAdapter = (connectionSettings = {}) => {
  const cfg = { ...DEFAULT_CONNECTION, ...connectionSettings }
  let client = null
  let db = null
  const registry = new Map()
  let connectPromise = null

  const getDb = async () => {
    if (db) return db
    if (connectPromise) return connectPromise
    
    connectPromise = (async () => {
      if (!client) {
        client = new MongoClient(cfg.uri, cfg.options)
        await client.connect()
      }
      db = client.db(cfg.database)
      connectPromise = null
      return db
    })()
    
    return connectPromise
  }

  const getCollection = async (name) => {
    const database = await getDb()
    return database.collection(name)
  }

  const buildInstance = (modelApi, docData) => {
    const data = { ...docData }
    // Convert _id to id
    if (data._id) {
      data.id = data._id.toString()
      delete data._id
    }
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
    const collectionName = `${String(name).trim().toLowerCase()}s`
    const singularName = String(name).trim()
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
      __collectionName: collectionName,
      __singularName: singularName,
      __modelName: singularName,
      __properties: properties,
      __associationFactories,
      __backend: 'mongodb',
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

      async create(attrs) {
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
        coerced._id = id
        coerced.id = id
        
        const performCreate = async () => {
          const collection = await getCollection(collectionName)
          await collection.insertOne(coerced)
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
        const collection = await getCollection(collectionName)
        const query = buildMongoQuery({ id }, softDeleteEnabled, withDeleted)
        const doc = await collection.findOne(query)
        return doc ? buildInstance(api, doc) : null
      },

      async findBy(where, { withDeleted } = {}) {
        const collection = await getCollection(collectionName)
        const query = buildMongoQuery(where, softDeleteEnabled, withDeleted)
        const doc = await collection.findOne(query)
        return doc ? buildInstance(api, doc) : null
      },

      async findOneBy(where, opts = {}) {
        return this.findBy(where, opts)
      },

      async findAll({ where = {}, order, limit, offset, withDeleted, include, select } = {}) {
        const collection = await getCollection(collectionName)
        const query = buildMongoQuery(where, softDeleteEnabled, withDeleted)
        const sort = buildSort(order)
        
        let cursor = collection.find(query)
        if (sort) cursor = cursor.sort(sort)
        if (Number.isFinite(offset)) cursor = cursor.skip(offset)
        if (Number.isFinite(limit)) cursor = cursor.limit(limit)
        
        const docs = await cursor.toArray()
        let instances = docs.map(doc => buildInstance(api, doc))
        
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
        const collection = await getCollection(collectionName)
        const query = buildMongoQuery(where, softDeleteEnabled, withDeleted)
        return collection.countDocuments(query)
      },

      async update(id, changes) {
        const existing = await this.find(id)
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
          const collection = await getCollection(collectionName)
          await collection.updateOne({ _id: ObjectId.isValid(id) ? new ObjectId(id) : id }, { $set: coerced })
          return await this.find(id)
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
        const filtered = pickWritableFields(changes || {}, properties)
        const coerced = await coerceAndEncrypt(filtered, properties, { isUpdate: true })
        if (timestampsEnabled) coerced.updatedAt = nowIso()
        
        const collection = await getCollection(collectionName)
        const query = buildMongoQuery(where, softDeleteEnabled, withDeleted)
        await collection.updateMany(query, { $set: coerced })
        
        return this.findAll({ where, withDeleted })
      },

      async updateOneBy(where, changes, { withDeleted } = {}) {
        const filtered = pickWritableFields(changes || {}, properties)
        const coerced = await coerceAndEncrypt(filtered, properties, { isUpdate: true })
        if (timestampsEnabled) coerced.updatedAt = nowIso()
        
        const collection = await getCollection(collectionName)
        const query = buildMongoQuery(where, softDeleteEnabled, withDeleted)
        await collection.updateOne(query, { $set: coerced })
        
        return this.findBy(where, { withDeleted })
      },

      async delete(id, { hardDelete = false } = {}) {
        const existing = await this.find(id, { withDeleted: true })
        if (!existing) return false
        
        // Rails destroy callbacks
        await callbacks.run('before_destroy', api, existing)
        
        const performDelete = async () => {
          const collection = await getCollection(collectionName)
          if (hardDelete || !softDeleteEnabled) {
            await collection.deleteOne({ _id: ObjectId.isValid(id) ? new ObjectId(id) : id })
            return true
          }
          await collection.updateOne(
            { _id: ObjectId.isValid(id) ? new ObjectId(id) : id },
            { $set: { deletedAt: nowIso() } }
          )
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
    const enhancedApi = enhanceModel(api, { getCollection, getDb, client }, registry)
    
    registry.set(singularName, enhancedApi)
    return enhancedApi
  }

  const close = async () => {
    if (client) {
      await client.close()
      client = null
      db = null
    }
  }

  // Connection health check
  const healthCheck = async () => {
    try {
      const database = await getDb()
      await database.admin().ping()
      return { healthy: true, pool: getPoolStats() }
    } catch (error) {
      return { healthy: false, error: error.message, pool: getPoolStats() }
    }
  }

  // Get pool statistics
  const getPoolStats = () => {
    if (!client) return null
    // MongoDB driver doesn't expose pool stats directly, but we can check connection status
    return {
      connected: client.topology?.isConnected() || false,
      // Note: MongoDB driver manages pool internally, these are approximate
    }
  }

  return { model, close, healthCheck, getPoolStats, client: () => client }
}

module.exports = mongodbAdapter

