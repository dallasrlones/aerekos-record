const mysql = require('mysql2/promise')
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
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'test',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.MYSQL_POOL_MAX, 10) || 10,
  connectTimeout: parseInt(process.env.MYSQL_CONNECT_TIMEOUT, 10) || 10000,
}

const quoteIdent = (name) => `\`${String(name).replace(/`/g, '``')}\``

const MYSQL_TS_KEYS = new Set(['created_at', 'updated_at', 'deleted_at'])

/** MySQL DATETIME rejects ISO-8601 with `T`/`Z`; store UTC wall time in DATETIME(3). */
const toMysqlDateTime = (value) => {
  if (value == null) return value
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return value
    return toMysqlDateTime(value.toISOString())
  }
  if (typeof value !== 'string') return value
  const s = value.trim()
  if (!s) return value
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) && !s.includes('T')) {
    return s.length > 23 ? s.slice(0, 23) : s
  }
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return value
  const pad = (n, len = 2) => String(n).padStart(len, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

const normalizeMysqlRowDatetimes = (row, properties) => {
  if (!row || typeof row !== 'object') return
  for (const key of Object.keys(row)) {
    const v = row[key]
    if (v == null) continue
    if (properties[key] === 'datetime' || MYSQL_TS_KEYS.has(key)) {
      row[key] = toMysqlDateTime(v)
    }
  }
}

const buildWhereClause = (where, softDeleteEnabled, withDeleted, tableAlias = '') => {
  const conditions = []
  const params = []
  const col = (k) => (tableAlias ? `${quoteIdent(tableAlias)}.${quoteIdent(k)}` : quoteIdent(k))

  if (softDeleteEnabled && !withDeleted) {
    conditions.push(`${col('deleted_at')} IS NULL`)
  }

  Object.entries(where || {}).forEach(([key, val]) => {
    if (key === 'id') {
      conditions.push(`${col('id')} = ?`)
      params.push(val)
    } else if (Array.isArray(val)) {
      const placeholders = val.map(() => '?').join(', ')
      conditions.push(`${col(key)} IN (${placeholders})`)
      params.push(...val)
    } else if (isObject(val) && (val.gte != null || val.lte != null || val.$gt != null || val.$lt != null)) {
      if (val.gte != null) {
        conditions.push(`${col(key)} >= ?`)
        params.push(val.gte)
      }
      if (val.lte != null) {
        conditions.push(`${col(key)} <= ?`)
        params.push(val.lte)
      }
      if (val.$gt != null) {
        conditions.push(`${col(key)} > ?`)
        params.push(val.$gt)
      }
      if (val.$lt != null) {
        conditions.push(`${col(key)} < ?`)
        params.push(val.$lt)
      }
    } else if (isObject(val) && val.contains != null) {
      conditions.push(`${col(key)} LIKE ?`)
      params.push(`%${val.contains}%`)
    } else {
      conditions.push(`${col(key)} = ?`)
      params.push(val)
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

const mysqlAdapter = (connectionSettings = {}) => {
  const cfg = { ...DEFAULT_CONNECTION, ...connectionSettings }
  const pool = mysql.createPool(cfg)
  const registry = new Map()

  const queryDb = async (sql, params = []) => {
    const [rows] = await pool.query(sql, params)
    return { rows: rows || [] }
  }

  const ensureTable = async (tableName, properties, settings) => {
    const qt = quoteIdent(tableName)
    const [existsRows] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
      [tableName]
    )
    const exists = Number(existsRows[0]?.c || 0) > 0

    if (!exists) {
      const columns = Object.entries(properties)
        .map(([key, type]) => {
          let sqlType = 'TEXT'
          if (type === 'number') sqlType = 'DECIMAL(30, 10)'
          else if (type === 'boolean') sqlType = 'TINYINT(1)'
          else if (type === 'datetime') sqlType = 'DATETIME(3)'
          else if (type === 'encrypted') sqlType = 'TEXT'
          return `${quoteIdent(key)} ${sqlType}`
        })
        .join(', ')

      await pool.query(`
        CREATE TABLE ${qt} (
          ${quoteIdent('id')} VARCHAR(36) PRIMARY KEY,
          ${columns},
          ${quoteIdent('created_at')} DATETIME(3) NULL,
          ${quoteIdent('updated_at')} DATETIME(3) NULL,
          ${quoteIdent('deleted_at')} DATETIME(3) NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
    }

    for (const field of settings?.indexes || []) {
      const indexName = `${tableName}_${field}_idx`.replace(/[^a-zA-Z0-9_]/g, '_')
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName)} ON ${qt} (${quoteIdent(field)})`
      )
    }

    for (const field of settings?.unique || []) {
      const constraintName = `${tableName}_${field}_unique`.replace(/[^a-zA-Z0-9_]/g, '_')
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(constraintName)} ON ${qt} (${quoteIdent(field)})`
      )
    }
  }

  const buildInstance = (modelApi, rowData) => {
    const data = { ...rowData }
    for (const [key, type] of Object.entries(modelApi.__properties || {})) {
      if (!(key in data) || data[key] == null) continue
      if (type === 'encrypted') continue
      const coercer = TYPE_COERCERS[type]
      if (coercer) data[key] = coercer(data[key])
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
    const qt = quoteIdent(tableName)
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
      __backend: 'mysql',
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
          coerced.created_at = toMysqlDateTime(nowIso())
          coerced.updated_at = toMysqlDateTime(nowIso())
        }
        coerced.id = id
        normalizeMysqlRowDatetimes(coerced, properties)

        const performCreate = async () => {
          const cols = Object.keys(coerced).map((k) => quoteIdent(k)).join(', ')
          const placeholders = Object.keys(coerced).map(() => '?').join(', ')
          const values = Object.values(coerced)

          await queryDb(`INSERT INTO ${qt} (${cols}) VALUES (${placeholders})`, values)
          const result = await queryDb(`SELECT * FROM ${qt} WHERE ${quoteIdent('id')} = ? LIMIT 1`, [id])
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
        const result = await queryDb(`SELECT * FROM ${qt} ${whereClause} LIMIT 1`, params)
        return result.rows.length ? buildInstance(api, result.rows[0]) : null
      },

      async findBy(where, { withDeleted } = {}) {
        await schemaPromise
        const { whereClause, params } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const result = await queryDb(`SELECT * FROM ${qt} ${whereClause} LIMIT 1`, params)
        return result.rows.length ? buildInstance(api, result.rows[0]) : null
      },

      async findOneBy(where, opts = {}) {
        return this.findBy(where, opts)
      },

      async findAll({ where = {}, order, limit, offset, withDeleted, include, select } = {}) {
        await schemaPromise
        const { whereClause, params } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const orderClause = buildOrderClause(order)
        let limitOffset = ''
        if (Number.isFinite(limit)) {
          limitOffset += ` LIMIT ${Number(limit)}`
        }
        if (Number.isFinite(offset)) {
          limitOffset += ` OFFSET ${Number(offset)}`
        }

        let query = `SELECT * FROM ${qt} ${whereClause} ${orderClause}${limitOffset}`
        const result = await queryDb(query, params)
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
        const result = await queryDb(`SELECT COUNT(*) AS cnt FROM ${qt} ${whereClause}`, params)
        return Number(result.rows[0]?.cnt ?? 0)
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
        if (timestampsEnabled) coerced.updated_at = toMysqlDateTime(nowIso())
        normalizeMysqlRowDatetimes(coerced, properties)

        const setKeys = Object.keys(coerced)
        if (setKeys.length === 0) return existing

        const performUpdate = async () => {
          const setClause = setKeys.map((key) => `${quoteIdent(key)} = ?`).join(', ')
          const values = Object.values(coerced)
          await queryDb(`UPDATE ${qt} SET ${setClause} WHERE ${quoteIdent('id')} = ?`, [...values, id])
          const result = await queryDb(`SELECT * FROM ${qt} WHERE ${quoteIdent('id')} = ? LIMIT 1`, [id])
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
        if (timestampsEnabled) coerced.updated_at = toMysqlDateTime(nowIso())
        normalizeMysqlRowDatetimes(coerced, properties)

        const { whereClause, params: whereParams } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const setKeys = Object.keys(coerced)
        if (setKeys.length === 0) {
          return this.findAll({ where, withDeleted })
        }

        const setClause = setKeys.map((key) => `${quoteIdent(key)} = ?`).join(', ')
        const values = Object.values(coerced)
        await queryDb(`UPDATE ${qt} SET ${setClause} ${whereClause}`, [...values, ...whereParams])
        return this.findAll({ where, withDeleted })
      },

      async updateOneBy(where, changes, { withDeleted } = {}) {
        await schemaPromise
        const filtered = pickWritableFields(changes || {}, properties)
        const coerced = await coerceAndEncrypt(filtered, properties, { isUpdate: true })
        if (timestampsEnabled) coerced.updated_at = toMysqlDateTime(nowIso())
        normalizeMysqlRowDatetimes(coerced, properties)

        const { whereClause, params: whereParams } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const setKeys = Object.keys(coerced)
        if (setKeys.length === 0) {
          return this.findBy(where, { withDeleted })
        }

        const setClause = setKeys.map((key) => `${quoteIdent(key)} = ?`).join(', ')
        const values = Object.values(coerced)
        await queryDb(`UPDATE ${qt} SET ${setClause} ${whereClause} LIMIT 1`, [...values, ...whereParams])
        return this.findBy(where, { withDeleted })
      },

      async delete(id, { hardDelete = false } = {}) {
        await schemaPromise
        
        const existing = await this.find(id, { withDeleted: true })
        if (!existing) return false
        
        // Rails destroy callbacks
        await callbacks.run('before_destroy', api, existing)
        
        const performDelete = async () => {
          if (hardDelete || !softDeleteEnabled) {
            await queryDb(`DELETE FROM ${qt} WHERE ${quoteIdent('id')} = ?`, [id])
            return true
          }
          await queryDb(`UPDATE ${qt} SET ${quoteIdent('deleted_at')} = ? WHERE ${quoteIdent('id')} = ?`, [
            toMysqlDateTime(nowIso()),
            id,
          ])
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

  const healthCheck = async () => {
    try {
      await queryDb('SELECT 1')
      return { healthy: true, pool: getPoolStats() }
    } catch (error) {
      return { healthy: false, error: error.message, pool: getPoolStats() }
    }
  }

  const getPoolStats = () => ({
    connectionLimit: pool.config?.connectionLimit,
  })

  return { model, close, healthCheck, getPoolStats, pool }
}

module.exports = mysqlAdapter

