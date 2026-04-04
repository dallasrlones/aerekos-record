const { Pool } = require('pg')
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
  user: process.env.PG_USER || 'postgres',
  host: process.env.PG_HOST || 'localhost',
  database: process.env.PG_DATABASE || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  port: process.env.PG_PORT || 5432,
  // Pool configuration
  max: parseInt(process.env.PG_POOL_MAX) || 10, // Maximum number of clients in the pool
  min: parseInt(process.env.PG_POOL_MIN) || 2, // Minimum number of clients in the pool
  idleTimeoutMillis: parseInt(process.env.PG_POOL_IDLE_TIMEOUT) || 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: parseInt(process.env.PG_POOL_CONNECTION_TIMEOUT) || 2000, // Return an error after 2 seconds if connection cannot be established
}

const buildWhereClause = (where, softDeleteEnabled, withDeleted, tableAlias = '') => {
  const conditions = []
  const params = []
  let paramIndex = 1
  
  if (softDeleteEnabled && !withDeleted) {
    conditions.push(`${tableAlias ? tableAlias + '.' : ''}deleted_at IS NULL`)
  }
  
  Object.entries(where || {}).forEach(([key, val]) => {
    if (key === 'id') {
      conditions.push(`${tableAlias ? tableAlias + '.' : ''}id = $${paramIndex}`)
      params.push(val)
      paramIndex++
    } else if (Array.isArray(val)) {
      const placeholders = val.map(() => {
        params.push(val[params.length - paramIndex + 1])
        return `$${paramIndex++}`
      }).join(', ')
      conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} IN (${placeholders})`)
    } else if (isObject(val) && (val.gte != null || val.lte != null || val.$gt != null || val.$lt != null)) {
      if (val.gte != null) {
        conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} >= $${paramIndex}`)
        params.push(val.gte)
        paramIndex++
      }
      if (val.lte != null) {
        conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} <= $${paramIndex}`)
        params.push(val.lte)
        paramIndex++
      }
      if (val.$gt != null) {
        conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} > $${paramIndex}`)
        params.push(val.$gt)
        paramIndex++
      }
      if (val.$lt != null) {
        conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} < $${paramIndex}`)
        params.push(val.$lt)
        paramIndex++
      }
    } else if (isObject(val) && val.contains != null) {
      conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} ILIKE $${paramIndex}`)
      params.push(`%${val.contains}%`)
      paramIndex++
    } else {
      conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} = $${paramIndex}`)
      params.push(val)
      paramIndex++
    }
  })
  
  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

const buildOrderClause = (order) => {
  if (!order) return ''
  if (typeof order === 'string') {
    return `ORDER BY ${order}`
  }
  if (Array.isArray(order)) {
    return `ORDER BY ${order.join(', ')}`
  }
  return ''
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

const psqlAdapter = (connectionSettings = {}) => {
  const cfg = { ...DEFAULT_CONNECTION, ...connectionSettings }
  const pool = new Pool(cfg)
  const registry = new Map()

  const ensureTable = async (tableName, properties, settings) => {
    const client = await pool.connect()
    try {
      // Check if table exists
      const tableCheck = await client.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [tableName]
      )
      
      if (!tableCheck.rows[0].exists) {
        // Create table
        const columns = Object.entries(properties)
          .map(([key, type]) => {
            let sqlType = 'TEXT'
            if (type === 'number') sqlType = 'NUMERIC'
            else if (type === 'boolean') sqlType = 'BOOLEAN'
            else if (type === 'datetime') sqlType = 'TIMESTAMP'
            else if (type === 'encrypted') sqlType = 'TEXT'
            return `${key} ${sqlType}`
          })
          .join(', ')
        
        await client.query(`
          CREATE TABLE ${tableName} (
            id UUID PRIMARY KEY,
            ${columns},
            created_at TIMESTAMP,
            updated_at TIMESTAMP,
            deleted_at TIMESTAMP
          )
        `)
      }
      
      // Create indexes
      for (const field of settings?.indexes || []) {
        const indexName = `${tableName}_${field}_idx`
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${field})
        `)
      }
      
      // Create unique constraints
      for (const field of settings?.unique || []) {
        const constraintName = `${tableName}_${field}_unique`
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ${constraintName} ON ${tableName} (${field})
        `)
      }
    } finally {
      client.release()
    }
  }

  const buildInstance = (modelApi, rowData) => {
    const data = { ...rowData }
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
        factories.push((self, row) => {
          const targetModel = registry.get(target)
          if (!targetModel) return {}
          const fkName = parentFk(self.__name)
          return {
            [targetModel.__collectionName]: {
              async findAll({ where = {}, order, limit, offset, withDeleted } = {}) {
                const merged = { ...where, [fkName]: row.id }
                return targetModel.findAll({ where: merged, order, limit, offset, withDeleted })
              },
              async create(attrs) {
                const merged = { ...attrs, [fkName]: row.id }
                return targetModel.create(merged)
              },
              async count(where = {}) {
                const merged = { ...where, [fkName]: row.id }
                return targetModel.count(merged)
              },
            },
          }
        })
      }
    }

    const addHasOne = (target) => {
      if (typeof target === 'string') {
        factories.push((self, row) => {
          const targetModel = registry.get(target)
          if (!targetModel) return {}
          const fkName = parentFk(self.__name)
          const key = targetModel.__singularName.toLowerCase()
          return {
            [key]: {
              async get({ withDeleted } = {}) {
                return targetModel.findBy({ [fkName]: row.id }, { withDeleted })
              },
              async set(attrsOrId) {
                if (isObject(attrsOrId)) {
                  const attrs = { ...attrsOrId, [fkName]: row.id }
                  return targetModel.create(attrs)
                }
                return targetModel.updateBy({ id: attrsOrId }, { [fkName]: row.id })
              },
            },
          }
        })
      }
    }

    const addBelongsTo = (target) => {
      if (typeof target === 'string') {
        factories.push((self, row) => {
          const targetModel = registry.get(target)
          if (!targetModel) return {}
          const fkName = parentFk(targetModel.__singularName)
          return {
            parent: async ({ withDeleted } = {}) => {
              const parentId = row[fkName]
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
    const tableName = `${String(name).trim().toLowerCase()}s`
    const singularName = String(name).trim()
    const collectionName = tableName
    const softDeleteEnabled = Boolean(settings.softDelete)
    const timestampsEnabled = settings.timestamps !== false

    const schemaPromise = ensureTable(tableName, properties, settings).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('Schema ensure failed for', tableName, e)
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
      __tableName: tableName,
      __collectionName: collectionName,
      __singularName: singularName,
      __modelName: singularName,
      __properties: properties,
      __associationFactories,
      __backend: 'psql',
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
          coerced.created_at = nowIso()
          coerced.updated_at = nowIso()
        }
        coerced.id = id
        
        const performCreate = async () => {
          const columns = Object.keys(coerced).join(', ')
          const placeholders = Object.keys(coerced).map((_, i) => `$${i + 1}`).join(', ')
          const values = Object.values(coerced)
          
          const result = await pool.query(
            `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders}) RETURNING *`,
            values
          )
          return buildInstance(api, result.rows[0])
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
        const { whereClause, params } = buildWhereClause({ id }, softDeleteEnabled, withDeleted)
        const result = await pool.query(`SELECT * FROM ${tableName} ${whereClause} LIMIT 1`, params)
        return result.rows.length ? buildInstance(api, result.rows[0]) : null
      },

      async findBy(where, { withDeleted } = {}) {
        await schemaPromise
        const { whereClause, params } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const result = await pool.query(`SELECT * FROM ${tableName} ${whereClause} LIMIT 1`, params)
        return result.rows.length ? buildInstance(api, result.rows[0]) : null
      },

      async findOneBy(where, opts = {}) {
        return this.findBy(where, opts)
      },

      async findAll({ where = {}, order, limit, offset, withDeleted, include, select } = {}) {
        await schemaPromise
        const { whereClause, params } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const orderClause = buildOrderClause(order)
        const limitClause = Number.isFinite(limit) ? `LIMIT ${limit}` : ''
        const offsetClause = Number.isFinite(offset) ? `OFFSET ${offset}` : ''
        
        let query = `SELECT * FROM ${tableName} ${whereClause} ${orderClause} ${offsetClause} ${limitClause}`
        const result = await pool.query(query, params)
        let instances = result.rows.map(row => buildInstance(api, row))
        
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
        const { whereClause, params } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const result = await pool.query(`SELECT COUNT(*) FROM ${tableName} ${whereClause}`, params)
        return parseInt(result.rows[0].count, 10)
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
        if (timestampsEnabled) coerced.updated_at = nowIso()
        
        const setKeys = Object.keys(coerced)
        if (setKeys.length === 0) return existing
        
        const performUpdate = async () => {
          const setClause = setKeys.map((key, i) => `${key} = $${i + 1}`).join(', ')
          const values = Object.values(coerced)
          const result = await pool.query(
            `UPDATE ${tableName} SET ${setClause} WHERE id = $${setKeys.length + 1} RETURNING *`,
            [...values, id]
          )
          return result.rows.length ? buildInstance(api, result.rows[0]) : null
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
        if (timestampsEnabled) coerced.updated_at = nowIso()
        
        const { whereClause, params: whereParams } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const setKeys = Object.keys(coerced)
        if (setKeys.length === 0) {
          return this.findAll({ where, withDeleted })
        }
        
        const setClause = setKeys.map((key, i) => `${key} = $${i + 1}`).join(', ')
        const values = Object.values(coerced)
        const result = await pool.query(
          `UPDATE ${tableName} SET ${setClause} ${whereClause} RETURNING *`,
          [...values, ...whereParams]
        )
        return result.rows.map(row => buildInstance(api, row))
      },

      async updateOneBy(where, changes, { withDeleted } = {}) {
        await schemaPromise
        const filtered = pickWritableFields(changes || {}, properties)
        const coerced = await coerceAndEncrypt(filtered, properties, { isUpdate: true })
        if (timestampsEnabled) coerced.updated_at = nowIso()
        
        const { whereClause, params: whereParams } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const setKeys = Object.keys(coerced)
        if (setKeys.length === 0) {
          return this.findBy(where, { withDeleted })
        }
        
        const setClause = setKeys.map((key, i) => `${key} = $${i + 1}`).join(', ')
        const values = Object.values(coerced)
        const result = await pool.query(
          `UPDATE ${tableName} SET ${setClause} ${whereClause} LIMIT 1 RETURNING *`,
          [...values, ...whereParams]
        )
        return result.rows.length ? buildInstance(api, result.rows[0]) : null
      },

      async delete(id, { hardDelete = false } = {}) {
        await schemaPromise
        
        const existing = await this.find(id, { withDeleted: true })
        if (!existing) return false
        
        // Rails destroy callbacks
        await callbacks.run('before_destroy', api, existing)
        
        const performDelete = async () => {
          if (hardDelete || !softDeleteEnabled) {
            await pool.query(`DELETE FROM ${tableName} WHERE id = $1`, [id])
            return true
          }
          await pool.query(`UPDATE ${tableName} SET deleted_at = $1 WHERE id = $2`, [nowIso(), id])
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
    const enhancedApi = enhanceModel(api, { pool }, registry)
    
    registry.set(singularName, enhancedApi)
    return enhancedApi
  }

  const close = async () => {
    await pool.end()
  }

  // Connection health check
  const healthCheck = async () => {
    try {
      const client = await pool.connect()
      await client.query('SELECT 1')
      client.release()
      return { healthy: true, pool: getPoolStats() }
    } catch (error) {
      return { healthy: false, error: error.message, pool: getPoolStats() }
    }
  }

  // Get pool statistics
  const getPoolStats = () => {
    return {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount
    }
  }

  return { model, close, healthCheck, getPoolStats, pool }
}

module.exports = psqlAdapter

