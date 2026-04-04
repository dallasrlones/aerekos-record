const neo4j = require('neo4j-driver')
const { randomUUID } = require('node:crypto')
const {
  TYPE_COERCERS,
  OMIT_FROM_OUTPUT_TYPES,
  isObject,
  nowIso,
  toUpperLabel,
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
  uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
  user: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'neo4j',
  database: process.env.NEO4J_DATABASE || undefined,
  logQueries: false,
  // Pool configuration (passed to neo4j.driver)
  maxConnectionLifetime: parseInt(process.env.NEO4J_MAX_CONNECTION_LIFETIME) || 3600000, // 1 hour
  maxConnectionPoolSize: parseInt(process.env.NEO4J_MAX_POOL_SIZE) || 100,
  connectionAcquisitionTimeout: parseInt(process.env.NEO4J_CONNECTION_ACQUISITION_TIMEOUT) || 60000, // 60 seconds
}

const buildWhereClause = (alias, where, softDeleteEnabled, withDeleted) => {
  const conditions = []
  const params = {}
  if (softDeleteEnabled && !withDeleted) {
    conditions.push(`${alias}.deletedAt IS NULL`)
  }
  Object.entries(where || {}).forEach(([key, val], idx) => {
    const paramKey = `${alias}_${key}_${idx}`
    if (Array.isArray(val)) {
      conditions.push(`${alias}.${key} IN $${paramKey}`)
      params[paramKey] = val
    } else if (isObject(val) && (val.gte != null || val.lte != null || val.$gt != null || val.$lt != null)) {
      if (val.gte != null) {
        const pk = `${paramKey}_gte`
        conditions.push(`${alias}.${key} >= $${pk}`)
        params[pk] = val.gte
      }
      if (val.lte != null) {
        const pk = `${paramKey}_lte`
        conditions.push(`${alias}.${key} <= $${pk}`)
        params[pk] = val.lte
      }
      if (val.$gt != null) {
        const pk = `${paramKey}_gt`
        conditions.push(`${alias}.${key} > $${pk}`)
        params[pk] = val.$gt
      }
      if (val.$lt != null) {
        const pk = `${paramKey}_lt`
        conditions.push(`${alias}.${key} < $${pk}`)
        params[pk] = val.$lt
      }
    } else if (isObject(val) && val.contains != null) {
      const pk = `${paramKey}_contains`
      conditions.push(`${alias}.${key} CONTAINS $${pk}`)
      params[pk] = String(val.contains)
    } else {
      conditions.push(`${alias}.${key} = $${paramKey}`)
      params[paramKey] = val
    }
  })
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return { whereClause, params }
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

const createConstraintStatements = (label, properties, settings) => {
  const stmts = []
  stmts.push({
    cypher: `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`,
    params: {},
  })
  for (const field of settings?.unique || []) {
    stmts.push({
      cypher: `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.${field} IS UNIQUE`,
      params: {},
    })
  }
  for (const field of settings?.indexes || []) {
    stmts.push({
      cypher: `CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.${field})`,
      params: {},
    })
  }
  return stmts
}

const neo4jAdapter = (connectionSettings = {}) => {
  const cfg = { ...DEFAULT_CONNECTION, ...connectionSettings }
  const driverConfig = {
    maxConnectionLifetime: cfg.maxConnectionLifetime,
    maxConnectionPoolSize: cfg.maxConnectionPoolSize,
    connectionAcquisitionTimeout: cfg.connectionAcquisitionTimeout,
  }
  const driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password), driverConfig)
  const registry = new Map()

  const runQuery = async (cypher, params = {}, { write = false } = {}) => {
    if (cfg.logQueries) {
      // eslint-disable-next-line no-console
      console.log('[neo4j] query', { cypher, params })
    }
    const session = driver.session({ 
      defaultAccessMode: write ? neo4j.session.WRITE : neo4j.session.READ, 
      database: cfg.database 
    })
    try {
      const res = await session.run(cypher, params)
      return res
    } finally {
      await session.close()
    }
  }

  const ensureSchema = async (label, properties, settings) => {
    const statements = createConstraintStatements(label, properties, settings)
    for (const { cypher, params } of statements) {
      await runQuery(cypher, params, { write: true })
    }
  }

  const buildInstance = (modelApi, nodeData) => {
    const data = { ...nodeData }
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
        factories.push((self, node) => {
          const targetModel = registry.get(target)
          if (!targetModel) return {}
          const fkName = parentFk(self.__name)
          return {
            [targetModel.__collectionName]: {
              async findAll({ where = {}, order, limit, offset, withDeleted } = {}) {
                const merged = { ...where, [fkName]: node.id }
                return targetModel.findAll({ where: merged, order, limit, offset, withDeleted })
              },
              async create(attrs, { edgeType, edgeProps, direction = 'out' } = {}) {
                const merged = { ...attrs, [fkName]: node.id }
                const created = await targetModel.create(merged)
                if (edgeType) {
                  await self.edges.createEdge({ 
                    fromId: node.id, 
                    toId: created.id, 
                    type: edgeType, 
                    toModel: targetModel.__singularName, 
                    properties: edgeProps, 
                    direction 
                  })
                }
                return created
              },
              async count(where = {}) {
                const merged = { ...where, [fkName]: node.id }
                return targetModel.count(merged)
              },
            },
          }
        })
      } else if (typeof target === 'function') {
        factories.push((self, node) => {
          const service = target
          const fkName = parentFk(self.__name)
          const key = `${String(target.name || 'association')}`
          return {
            [key]: {
              async findAll({ where = {}, ...rest } = {}) {
                return service.findAll({ where: { ...where, [fkName]: node.id }, ...rest })
              },
              async create(attrs) {
                return service.create({ ...attrs, [fkName]: node.id })
              },
              async count(where = {}) {
                return service.count({ ...where, [fkName]: node.id })
              },
            },
          }
        })
      }
    }

    const addHasOne = (target) => {
      if (typeof target === 'string') {
        factories.push((self, node) => {
          const targetModel = registry.get(target)
          if (!targetModel) return {}
          const fkName = parentFk(self.__name)
          const key = targetModel.__singularName.toLowerCase()
          return {
            [key]: {
              async get({ withDeleted } = {}) {
                return targetModel.findBy({ [fkName]: node.id }, { withDeleted })
              },
              async set(attrsOrId) {
                if (isObject(attrsOrId)) {
                  const attrs = { ...attrsOrId, [fkName]: node.id }
                  return targetModel.create(attrs)
                }
                return targetModel.updateBy({ id: attrsOrId }, { [fkName]: node.id })
              },
            },
          }
        })
      }
    }

    const addBelongsTo = (target) => {
      if (typeof target === 'string') {
        factories.push((self, node) => {
          const targetModel = registry.get(target)
          if (!targetModel) return {}
          const fkName = parentFk(targetModel.__singularName)
          return {
            parent: async ({ withDeleted } = {}) => {
              const parentId = node[fkName]
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
    const label = toUpperLabel(name)
    const singularName = String(name).trim()
    const collectionName = `${singularName.toLowerCase()}s`
    const softDeleteEnabled = Boolean(settings.softDelete)
    const timestampsEnabled = settings.timestamps !== false

    const schemaPromise = ensureSchema(label, properties, settings).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('Schema ensure failed for', label, e)
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

    const rowsToInstances = (records, alias = 'n') => {
      return records.map((r) => {
        const node = r.get(alias).properties
        return buildInstance(api, node)
      })
    }

    const api = {
      __name: singularName,
      __label: label,
      __properties: properties,
      __collectionName: collectionName,
      __singularName: singularName,
      __modelName: singularName,
      __associationFactories,
      __backend: 'neo4j',
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
          coerced.createdAt = nowIso()
          coerced.updatedAt = nowIso()
        }
        coerced.id = id
        
        // Around callbacks wrap the actual DB operation
        const performCreate = async () => {
          const cypher = `CREATE (n:${label} $props) RETURN n`
          const res = await runQuery(cypher, { props: coerced }, { write: true })
          const [instance] = rowsToInstances(res.records)
          return instance
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
        const where = { id }
        const { whereClause, params } = buildWhereClause('n', where, softDeleteEnabled, withDeleted)
        const cypher = `MATCH (n:${label}) ${whereClause} RETURN n LIMIT 1`
        const res = await runQuery(cypher, params)
        const [instance] = rowsToInstances(res.records)
        return instance || null
      },

      async findBy(where, { withDeleted } = {}) {
        await schemaPromise
        const safeWhere = normalizeWhere(where)
        const { whereClause, params } = buildWhereClause('n', safeWhere, softDeleteEnabled, withDeleted)
        const cypher = `MATCH (n:${label}) ${whereClause} RETURN n LIMIT 1`
        const res = await runQuery(cypher, params)
        const [instance] = rowsToInstances(res.records)
        return instance || null
      },

      async findOneBy(where, opts = {}) {
        return this.findBy(where, opts)
      },

      async findAll({ where = {}, order, limit, offset, withDeleted, include, select } = {}) {
        await schemaPromise
        const safeWhere = normalizeWhere(where)
        const { whereClause, params } = buildWhereClause('n', safeWhere, softDeleteEnabled, withDeleted)
        const orderClause = order ? `ORDER BY ${Array.isArray(order) ? order.join(', ') : String(order)}` : ''
        const limitClause = Number.isFinite(limit) ? `LIMIT ${Number(limit)}` : ''
        const skipClause = Number.isFinite(offset) ? `SKIP ${Number(offset)}` : ''
        const includes = normalizeIncludes(include, singularName)

        if (!includes.length) {
          const cypher = `MATCH (n:${label}) ${whereClause} RETURN n ${orderClause} ${skipClause} ${limitClause}`
          const res = await runQuery(cypher, params)
          const rows = rowsToInstances(res.records)
          return select ? rows.map((r) => applySelect(r, select)) : rows
        }

        // Handle includes with FK relationships
        const includeModels = includes
          .map((inc) => ({ ...inc, api: registry.get(inc.model) }))
          .filter((inc) => inc.api)
        
        const cypherParents = `MATCH (n:${label}) ${whereClause} WITH n ${orderClause} ${skipClause} ${limitClause} RETURN collect(n) as parents`
        const parentsRes = await runQuery(cypherParents, params)
        const parentNodes = parentsRes.records[0]?.get('parents') || []
        const parentIds = parentNodes.map((n) => n.properties.id)
        if (!parentIds.length) return []

        let parents = parentNodes.map((n) => buildInstance(api, n.properties))
        if (select) parents = parents.map((p) => applySelect(p, select))
        
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
        return parents.map((p) => ({ ...p, ...(childrenByParent[p.id] || {}) }))
      },

      async count(where = {}, { withDeleted } = {}) {
        await schemaPromise
        const safeWhere = normalizeWhere(where)
        const { whereClause, params } = buildWhereClause('n', safeWhere, softDeleteEnabled, withDeleted)
        const cypher = `MATCH (n:${label}) ${whereClause} RETURN count(n) AS c`
        const res = await runQuery(cypher, params)
        const record = res.records[0]
        return record ? Number(record.get('c')) : 0
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
        
        // Validate required fields (only check if they're being changed)
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
        
        // Around callbacks wrap the actual DB operation
        const performUpdate = async () => {
          const setClause = setKeys.map((k) => `n.${k} = $props.${k}`).join(', ')
          const cypher = `MATCH (n:${label} { id: $id }) SET ${setClause} RETURN n`
          const res = await runQuery(cypher, { id, props: coerced }, { write: true })
          const [instance] = rowsToInstances(res.records)
          return instance || null
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
        const safeWhere = normalizeWhere(where)
        const filtered = pickWritableFields(changes || {}, properties)
        const coerced = await coerceAndEncrypt(filtered, properties, { isUpdate: true })
        if (timestampsEnabled) coerced.updatedAt = nowIso()
        
        const { whereClause, params } = buildWhereClause('n', safeWhere, softDeleteEnabled, withDeleted)
        const setKeys = Object.keys(coerced)
        if (setKeys.length === 0) {
          const cypher = `MATCH (n:${label}) ${whereClause} RETURN n`
          const res = await runQuery(cypher, params)
          return rowsToInstances(res.records)
        }
        const setClause = setKeys.map((k) => `n.${k} = $props.${k}`).join(', ')
        const cypher = `MATCH (n:${label}) ${whereClause} SET ${setClause} RETURN n`
        const res = await runQuery(cypher, { ...params, props: coerced }, { write: true })
        return rowsToInstances(res.records)
      },

      async updateOneBy(where, changes, { withDeleted } = {}) {
        await schemaPromise
        const safeWhere = normalizeWhere(where)
        const filtered = pickWritableFields(changes || {}, properties)
        const coerced = await coerceAndEncrypt(filtered, properties, { isUpdate: true })
        if (timestampsEnabled) coerced.updatedAt = nowIso()
        
        const { whereClause, params } = buildWhereClause('n', safeWhere, softDeleteEnabled, withDeleted)
        const setKeys = Object.keys(coerced)
        if (setKeys.length === 0) {
          const cypher = `MATCH (n:${label}) ${whereClause} WITH n LIMIT 1 RETURN n`
          const res = await runQuery(cypher, params)
          const [instance] = rowsToInstances(res.records)
          return instance || null
        }
        const setClause = setKeys.map((k) => `n.${k} = $props.${k}`).join(', ')
        const cypher = `MATCH (n:${label}) ${whereClause} WITH n LIMIT 1 SET ${setClause} RETURN n`
        const res = await runQuery(cypher, { ...params, props: coerced }, { write: true })
        const [instance] = rowsToInstances(res.records)
        return instance || null
      },

      async delete(id, { hardDelete = false } = {}) {
        await schemaPromise
        
        const existing = await this.find(id, { withDeleted: true })
        if (!existing) return false
        
        // Rails destroy callbacks
        await callbacks.run('before_destroy', api, existing)
        
        const performDelete = async () => {
          if (hardDelete || !softDeleteEnabled) {
            const cypher = `MATCH (n:${label} { id: $id }) DETACH DELETE n`
            await runQuery(cypher, { id }, { write: true })
            return true
          }
          const cypher = `MATCH (n:${label} { id: $id }) SET n.deletedAt = $deletedAt RETURN n`
          const res = await runQuery(cypher, { id, deletedAt: nowIso() }, { write: true })
          const [instance] = rowsToInstances(res.records)
          return Boolean(instance)
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

    // Neo4j-specific edge utilities
    api.edges = {
      async createEdge({ fromId, toId, type, toModel, properties = {}, direction = 'out' }) {
        const toLabel = toUpperLabel(toModel)
        const relType = String(type || '').trim().toUpperCase()
        let relPattern
        if (direction === 'in') {
          relPattern = `(a)<-[r:${relType} $props]-(b)`
        } else if (direction === 'both') {
          relPattern = `(a)-[r:${relType} $props]-(b)`
        } else {
          relPattern = `(a)-[r:${relType} $props]->(b)`
        }
        const cypher = `MATCH (a:${label} { id: $fromId }), (b:${toLabel} { id: $toId }) CREATE ${relPattern} RETURN r`
        const res = await runQuery(cypher, { fromId, toId, props: properties }, { write: true })
        return res.records.length ? res.records[0].get('r').properties : null
      },
      async createEdges(edges = []) {
        const created = []
        for (const e of edges) {
          // eslint-disable-next-line no-await-in-loop
          const r = await api.edges.createEdge(e)
          created.push(r)
        }
        return created
      },
      async findByEdge({ type, toModel, fromWhere = {}, toWhere = {}, edgeWhere = {}, direction = 'out', returnTarget = 'to' }) {
        const toLabel = toUpperLabel(toModel)
        const relType = String(type || '').trim().toUpperCase()
        const a = 'a'
        const b = 'b'
        const r = 'r'
        const arrowPattern = direction === 'in' ? `<-[${r}:${relType}]-` : direction === 'both' ? `-[${r}:${relType}]-` : `-[${r}:${relType}]->`
        const aWhere = buildWhereClause(a, fromWhere, false, true)
        const bWhere = buildWhereClause(b, toWhere, false, true)
        const rWhere = buildWhereClause(r, edgeWhere, false, true)
        const cypher = `MATCH (${a}:${label}) ${aWhere.whereClause} MATCH (${b}:${toLabel}) ${bWhere.whereClause} MATCH (${a})${arrowPattern}(${b}) ${rWhere.whereClause} RETURN ${returnTarget === 'from' ? a : returnTarget === 'edge' ? r : returnTarget === 'both' ? `${a}, ${b}` : b} LIMIT 1`
        const params = { ...aWhere.params, ...bWhere.params, ...rWhere.params }
        const res = await runQuery(cypher, params)
        if (!res.records.length) return null
        if (returnTarget === 'both') {
          const toModelApi = registry.get(toModel)
          return {
            from: buildInstance(api, res.records[0].get(a).properties),
            to: toModelApi ? buildInstance(toModelApi, res.records[0].get(b).properties) : res.records[0].get(b).properties,
          }
        }
        if (returnTarget === 'from') return buildInstance(api, res.records[0].get(a).properties)
        if (returnTarget === 'edge') return res.records[0].get(r).properties
        const toModelApi = registry.get(toModel)
        return toModelApi ? buildInstance(toModelApi, res.records[0].get(b).properties) : res.records[0].get(b).properties
      },
      async findByEdges(args) {
        const { type, toModel, fromWhere = {}, toWhere = {}, edgeWhere = {}, direction = 'out', returnTarget = 'to' } = args || {}
        const toLabel = toUpperLabel(toModel)
        const relType = String(type || '').trim().toUpperCase()
        const a = 'a'
        const b = 'b'
        const r = 'r'
        const arrowPattern = direction === 'in' ? `<-[${r}:${relType}]-` : direction === 'both' ? `-[${r}:${relType}]-` : `-[${r}:${relType}]->`
        const aWhere = buildWhereClause(a, fromWhere, false, true)
        const bWhere = buildWhereClause(b, toWhere, false, true)
        const rWhere = buildWhereClause(r, edgeWhere, false, true)
        const cypher = `MATCH (${a}:${label}) ${aWhere.whereClause} MATCH (${b}:${toLabel}) ${bWhere.whereClause} MATCH (${a})${arrowPattern}(${b}) ${rWhere.whereClause} RETURN ${returnTarget === 'from' ? a : returnTarget === 'edge' ? r : returnTarget === 'both' ? `${a}, ${b}` : b}`
        const params = { ...aWhere.params, ...bWhere.params, ...rWhere.params }
        const queryRes = await runQuery(cypher, params)
        if (returnTarget === 'both') {
          const toModelApi = registry.get(toModel)
          return queryRes.records.map((rec) => ({
            from: buildInstance(api, rec.get(a).properties),
            to: toModelApi ? buildInstance(toModelApi, rec.get(b).properties) : rec.get(b).properties,
          }))
        }
        if (returnTarget === 'from') return queryRes.records.map((rec) => buildInstance(api, rec.get(a).properties))
        if (returnTarget === 'edge') return queryRes.records.map((rec) => rec.get(r).properties)
        const toModelApi = registry.get(toModel)
        return queryRes.records.map((rec) => (toModelApi ? buildInstance(toModelApi, rec.get(b).properties) : rec.get(b).properties))
      },
      async updateEdgeBy({ type, toModel, fromWhere = {}, toWhere = {}, edgeChanges = {}, direction = 'out' }) {
        const toLabel = toUpperLabel(toModel)
        const relType = String(type || '').trim().toUpperCase()
        const a = 'a'
        const b = 'b'
        const r = 'r'
        const arrowPattern = direction === 'in' ? `<-[${r}:${relType}]-` : direction === 'both' ? `-[${r}:${relType}]-` : `-[${r}:${relType}]->`
        const aWhere = buildWhereClause(a, fromWhere, false, true)
        const bWhere = buildWhereClause(b, toWhere, false, true)
        const setKeys = Object.keys(edgeChanges || {})
        if (!setKeys.length) return null
        const setClause = setKeys.map((k) => `${r}.${k} = $props.${k}`).join(', ')
        const cypher = `MATCH (${a}:${label}) ${aWhere.whereClause} MATCH (${b}:${toLabel}) ${bWhere.whereClause} MATCH (${a})${arrowPattern}(${b}) WITH ${r}, ${a}, ${b} LIMIT 1 SET ${setClause} RETURN ${r}`
        const params = { ...aWhere.params, ...bWhere.params, props: edgeChanges }
        const queryRes = await runQuery(cypher, params, { write: true })
        return queryRes.records.length ? queryRes.records[0].get(r).properties : null
      },
      async updateEdgesBy({ type, toModel, fromWhere = {}, toWhere = {}, edgeChanges = {}, direction = 'out' }) {
        const toLabel = toUpperLabel(toModel)
        const relType = String(type || '').trim().toUpperCase()
        const a = 'a'
        const b = 'b'
        const r = 'r'
        const arrowPattern = direction === 'in' ? `<-[${r}:${relType}]-` : direction === 'both' ? `-[${r}:${relType}]-` : `-[${r}:${relType}]->`
        const aWhere = buildWhereClause(a, fromWhere, false, true)
        const bWhere = buildWhereClause(b, toWhere, false, true)
        const setKeys = Object.keys(edgeChanges || {})
        if (!setKeys.length) return []
        const setClause = setKeys.map((k) => `${r}.${k} = $props.${k}`).join(', ')
        const cypher = `MATCH (${a}:${label}) ${aWhere.whereClause} MATCH (${b}:${toLabel}) ${bWhere.whereClause} MATCH (${a})${arrowPattern}(${b}) SET ${setClause} RETURN ${r}`
        const params = { ...aWhere.params, ...bWhere.params, props: edgeChanges }
        const queryRes = await runQuery(cypher, params, { write: true })
        return queryRes.records.map((rec) => rec.get(r).properties)
      },
      async deleteEdge({ type, toModel, fromWhere = {}, toWhere = {}, direction = 'out' }) {
        const toLabel = toUpperLabel(toModel)
        const relType = String(type || '').trim().toUpperCase()
        const a = 'a'
        const b = 'b'
        const r = 'r'
        const arrowPattern = direction === 'in' ? `<-[${r}:${relType}]-` : direction === 'both' ? `-[${r}:${relType}]-` : `-[${r}:${relType}]->`
        const aWhere = buildWhereClause(a, fromWhere, false, true)
        const bWhere = buildWhereClause(b, toWhere, false, true)
        const cypher = `MATCH (${a}:${label}) ${aWhere.whereClause} MATCH (${b}:${toLabel}) ${bWhere.whereClause} MATCH (${a})${arrowPattern}(${b}) WITH ${r} LIMIT 1 DELETE ${r}`
        const params = { ...aWhere.params, ...bWhere.params }
        await runQuery(cypher, params, { write: true })
        return true
      },
      async deleteEdgesBy({ type, toModel, fromWhere = {}, toWhere = {}, direction = 'out' }) {
        const toLabel = toUpperLabel(toModel)
        const relType = String(type || '').trim().toUpperCase()
        const a = 'a'
        const b = 'b'
        const r = 'r'
        const arrowPattern = direction === 'in' ? `<-[${r}:${relType}]-` : direction === 'both' ? `-[${r}:${relType}]-` : `-[${r}:${relType}]->`
        const aWhere = buildWhereClause(a, fromWhere, false, true)
        const bWhere = buildWhereClause(b, toWhere, false, true)
        const cypher = `MATCH (${a}:${label}) ${aWhere.whereClause} MATCH (${b}:${toLabel}) ${bWhere.whereClause} MATCH (${a})${arrowPattern}(${b}) DELETE ${r}`
        const params = { ...aWhere.params, ...bWhere.params }
        await runQuery(cypher, params, { write: true })
        return true
      },
    }

    // Enhance model with additional features
    const enhancedApi = enhanceModel(api, { runQuery, driver }, registry)
    
    registry.set(singularName, enhancedApi)
    return enhancedApi
  }

  const close = async () => {
    await driver.close()
  }

  // Connection health check
  const healthCheck = async () => {
    try {
      const session = driver.session()
      await session.run('RETURN 1')
      await session.close()
      return { healthy: true, pool: getPoolStats() }
    } catch (error) {
      return { healthy: false, error: error.message, pool: getPoolStats() }
    }
  }

  // Get pool statistics
  const getPoolStats = () => {
    // Neo4j driver doesn't expose pool stats directly
    return {
      // Note: Neo4j driver manages pool internally
      // You can check driver.constructor.name to verify driver type
    }
  }

  return { model, close, healthCheck, getPoolStats, driver }
}

module.exports = neo4jAdapter

