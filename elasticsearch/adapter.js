const { Client } = require('@elastic/elasticsearch')
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
  node: process.env.ES_URL || 'http://localhost:9200',
  auth: process.env.ES_USER && process.env.ES_PASSWORD ? {
    username: process.env.ES_USER,
    password: process.env.ES_PASSWORD,
  } : undefined,
  maxRetries: parseInt(process.env.ES_MAX_RETRIES) || 5,
  requestTimeout: parseInt(process.env.ES_REQUEST_TIMEOUT) || 60000,
  // Connection pool configuration
  sniffOnStart: process.env.ES_SNIFF_ON_START !== 'false',
  sniffInterval: parseInt(process.env.ES_SNIFF_INTERVAL) || false, // Disable sniffing by default
  maxSockets: parseInt(process.env.ES_MAX_SOCKETS) || 256, // Maximum number of sockets
  keepAlive: process.env.ES_KEEP_ALIVE !== 'false',
  keepAliveInterval: parseInt(process.env.ES_KEEP_ALIVE_INTERVAL) || 1000,
}

const buildElasticsearchQuery = (where) => {
  const searchKeys = Object.keys(where || {})
  
  if (searchKeys.length === 0) {
    return { match_all: {} }
  }
  
  const shouldUseTerm = (value) => {
    return typeof value === 'boolean' || typeof value === 'number' || 
           (typeof value === 'string' && value.length < 50 && !value.includes(' '))
  }
  
  if (searchKeys.length === 1) {
    const field = searchKeys[0]
    const value = where[field]
    if (isObject(value)) {
      if (value.gte != null || value.lte != null) {
        const range = {}
        if (value.gte != null) range.gte = value.gte
        if (value.lte != null) range.lte = value.lte
        return { range: { [field]: range } }
      }
      if (value.contains != null) {
        return { match: { [field]: value.contains } }
      }
    }
    if (shouldUseTerm(value)) {
      return { term: { [field]: value } }
    }
    return { match: { [field]: value } }
  }
  
  // Multiple fields - use bool query
  return {
    bool: {
      must: searchKeys.map(field => {
        const value = where[field]
        if (isObject(value)) {
          if (value.gte != null || value.lte != null) {
            const range = {}
            if (value.gte != null) range.gte = value.gte
            if (value.lte != null) range.lte = value.lte
            return { range: { [field]: range } }
          }
          if (value.contains != null) {
            return { match: { [field]: value.contains } }
          }
        }
        if (shouldUseTerm(value)) {
          return { term: { [field]: value } }
        }
        return { match: { [field]: value } }
      })
    }
  }
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

const elasticsearchAdapter = (connectionSettings = {}) => {
  const cfg = { ...DEFAULT_CONNECTION, ...connectionSettings }
  const client = new Client(cfg)
  const registry = new Map()

  const ensureIndex = async (indexName, properties, settings) => {
    try {
      const exists = await client.indices.exists({ index: indexName })
      if (!exists) {
        const mappings = {
          properties: {}
        }
        
        Object.entries(properties).forEach(([key, type]) => {
          let esType = 'text'
          if (type === 'number') esType = 'long'
          else if (type === 'boolean') esType = 'boolean'
          else if (type === 'datetime') esType = 'date'
          else if (type === 'encrypted') esType = 'keyword'
          
          mappings.properties[key] = { type: esType }
        })
        
        // Add standard fields
        mappings.properties.created_at = { type: 'date' }
        mappings.properties.updated_at = { type: 'date' }
        mappings.properties.deleted_at = { type: 'date' }
        
        await client.indices.create({
          index: indexName,
          mappings
        })
      }
    } catch (error) {
      const errorMsg = error.message || error.toString() || ''
      if (!errorMsg.includes('resource_already_exists_exception') && !errorMsg.includes('already_exists_exception')) {
        // eslint-disable-next-line no-console
        console.error('Index creation failed for', indexName, error)
      }
    }
  }

  const buildInstance = (modelApi, docData) => {
    const data = { ...docData }
    // Ensure id is present
    if (!data.id && data._id) {
      data.id = data._id
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
    const indexName = `${String(name).trim().toLowerCase()}s`
    const singularName = String(name).trim()
    const collectionName = indexName
    const softDeleteEnabled = Boolean(settings.softDelete)
    const timestampsEnabled = settings.timestamps !== false

    const schemaPromise = ensureIndex(indexName, properties, settings).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('Schema ensure failed for', indexName, e)
    })

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
      __indexName: indexName,
      __collectionName: collectionName,
      __singularName: singularName,
      __modelName: singularName,
      __properties: properties,
      __associationFactories,
      __backend: 'elasticsearch',
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
        await schemaPromise
        
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
          coerced.created_at = Date.now()
          coerced.updated_at = coerced.created_at
        }
        coerced.id = id
        
        const performCreate = async () => {
          const result = await client.index({
            index: indexName,
            id: id,
            document: coerced
          })
          await client.indices.refresh({ index: indexName })
          return buildInstance(api, { ...coerced, _id: result._id })
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
        await schemaPromise
        try {
          const result = await client.get({
            index: indexName,
            id: id
          })
          
          if (result.found) {
            const doc = { id: result._id, ...result._source }
            if (softDeleteEnabled && !withDeleted && doc.deleted_at) {
              return null
            }
            return buildInstance(api, doc)
          }
          return null
        } catch (error) {
          if (error.meta && error.meta.statusCode === 404) {
            return null
          }
          throw error
        }
      },

      async findBy(where, { withDeleted } = {}) {
        await schemaPromise
        const query = buildElasticsearchQuery(where)
        const result = await client.search({
          index: indexName,
          query: query,
          size: 1,
          sort: [{ created_at: { order: 'desc' } }]
        })
        
        if (result.hits.total.value === 0) {
          return null
        }
        
        const hit = result.hits.hits[0]
        const doc = { id: hit._id, ...hit._source }
        if (softDeleteEnabled && !withDeleted && doc.deleted_at) {
          return null
        }
        return buildInstance(api, doc)
      },

      async findOneBy(where, opts = {}) {
        return this.findBy(where, opts)
      },

      async findAll({ where = {}, order, limit, offset, withDeleted, include, select } = {}) {
        await schemaPromise
        const query = buildElasticsearchQuery(where)
        
        const sort = order ? (Array.isArray(order) ? order.map(o => {
          const parts = o.split(' ')
          return { [parts[0]]: { order: parts[1] === 'DESC' || parts[1] === 'desc' ? 'desc' : 'asc' } }
        }) : [{ [order]: { order: 'asc' } }]) : [{ created_at: { order: 'desc' } }]
        
        const result = await client.search({
          index: indexName,
          query: query,
          sort: sort,
          from: offset || 0,
          size: limit || 10
        })
        
        let instances = result.hits.hits
          .map(hit => {
            const doc = { id: hit._id, ...hit._source }
            if (softDeleteEnabled && !withDeleted && doc.deleted_at) {
              return null
            }
            return buildInstance(api, doc)
          })
          .filter(Boolean)
        
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
        await schemaPromise
        const query = buildElasticsearchQuery(where)
        const result = await client.count({
          index: indexName,
          query: query
        })
        return result.count
      },

      async update(id, changes) {
        await schemaPromise
        
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
        if (timestampsEnabled) coerced.updated_at = Date.now()
        
        const performUpdate = async () => {
          await client.update({
            index: indexName,
            id: id,
            doc: coerced
          })
          await client.indices.refresh({ index: indexName })
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
        await schemaPromise
        const filtered = pickWritableFields(changes || {}, properties)
        const coerced = await coerceAndEncrypt(filtered, properties, { isUpdate: true })
        if (timestampsEnabled) coerced.updated_at = Date.now()
        
        // Find all matching documents and update them
        const docs = await this.findAll({ where, withDeleted })
        const updates = docs.map(doc => 
          client.update({
            index: indexName,
            id: doc.id,
            doc: coerced
          })
        )
        await Promise.all(updates)
        await client.indices.refresh({ index: indexName })
        
        return this.findAll({ where, withDeleted })
      },

      async updateOneBy(where, changes, { withDeleted } = {}) {
        const doc = await this.findBy(where, { withDeleted })
        if (!doc) return null
        return this.update(doc.id, changes)
      },

      async delete(id, { hardDelete = false } = {}) {
        await schemaPromise
        
        const existing = await this.find(id, { withDeleted: true })
        if (!existing) return false
        
        // Rails destroy callbacks
        await callbacks.run('before_destroy', api, existing)
        
        const performDelete = async () => {
          if (hardDelete || !softDeleteEnabled) {
            await client.delete({
              index: indexName,
              id: id
            })
            await client.indices.refresh({ index: indexName })
            return true
          }
          await client.update({
            index: indexName,
            id: id,
            doc: { deleted_at: Date.now() }
          })
          await client.indices.refresh({ index: indexName })
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
    const enhancedApi = enhanceModel(api, { client }, registry)
    
    registry.set(singularName, enhancedApi)
    return enhancedApi
  }

  const close = async () => {
    // Elasticsearch client doesn't need explicit closing, but we can close it
    await client.close()
  }

  // Connection health check
  const healthCheck = async () => {
    try {
      // Root GET is lighter than cluster.health during node bootstrap (avoids long waits / resets).
      await client.transport.request({ method: 'GET', path: '/' })
      return {
        healthy: true,
        status: 'up',
        pool: getPoolStats(),
      }
    } catch (error) {
      return { healthy: false, error: error.message, pool: getPoolStats() }
    }
  }

  // Get pool statistics
  const getPoolStats = () => {
    // Elasticsearch client manages connections internally
    return {
      // Note: Elasticsearch client manages pool internally
    }
  }

  return { model, close, healthCheck, getPoolStats, client }
}

module.exports = elasticsearchAdapter

