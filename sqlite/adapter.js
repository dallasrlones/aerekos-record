const Database = require('better-sqlite3')
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
  database: process.env.SQLITE_DATABASE || './database.sqlite',
  // SQLite options
  readonly: process.env.SQLITE_READONLY === 'true' || false,
  fileMustExist: process.env.SQLITE_FILE_MUST_EXIST === 'true' || false,
  timeout: parseInt(process.env.SQLITE_TIMEOUT) || 5000,
  // Set to a function in connectionSettings to enable SQL logging (better-sqlite3 API)
  verbose: null,
}

const buildWhereClause = (where, softDeleteEnabled, withDeleted, tableAlias = '') => {
  const conditions = []
  const params = []
  let paramIndex = 0
  
  if (softDeleteEnabled && !withDeleted) {
    conditions.push(`${tableAlias ? tableAlias + '.' : ''}deleted_at IS NULL`)
  }
  
  Object.entries(where || {}).forEach(([key, val]) => {
    if (val === null) {
      const col =
        key === 'id'
          ? `${tableAlias ? tableAlias + '.' : ''}id`
          : `${tableAlias ? tableAlias + '.' : ''}${key}`
      conditions.push(`${col} IS NULL`)
      return
    }
    if (key === 'id') {
      conditions.push(`${tableAlias ? tableAlias + '.' : ''}id = ?`)
      params.push(val)
      paramIndex++
    } else if (Array.isArray(val)) {
      const placeholders = val.map(() => '?').join(', ')
      conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} IN (${placeholders})`)
      params.push(...val)
      paramIndex += val.length
    } else if (isObject(val) && (val.gte != null || val.lte != null || val.$gt != null || val.$lt != null)) {
      if (val.gte != null) {
        conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} >= ?`)
        params.push(val.gte)
        paramIndex++
      }
      if (val.lte != null) {
        conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} <= ?`)
        params.push(val.lte)
        paramIndex++
      }
      if (val.$gt != null) {
        conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} > ?`)
        params.push(val.$gt)
        paramIndex++
      }
      if (val.$lt != null) {
        conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} < ?`)
        params.push(val.$lt)
        paramIndex++
      }
    } else if (isObject(val) && val.contains != null) {
      conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} LIKE ?`)
      params.push(`%${val.contains}%`)
      paramIndex++
    } else {
      conditions.push(`${tableAlias ? tableAlias + '.' : ''}${key} = ?`)
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

const sqliteAdapter = (connectionSettings = {}) => {
  const cfg = { ...DEFAULT_CONNECTION, ...connectionSettings }
  const dbOptions = {
    readonly: cfg.readonly,
    fileMustExist: cfg.fileMustExist,
    timeout: cfg.timeout,
  }
  // better-sqlite3 only accepts verbose as a logger function, not a boolean
  if (typeof cfg.verbose === 'function') {
    dbOptions.verbose = cfg.verbose
  }
  const db = new Database(cfg.database, dbOptions)

  // Enable foreign keys
  db.pragma('foreign_keys = ON')

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL')

  const registry = new Map()

  // Enable query logging if configured
  if (cfg.logQueries) {
    const originalPrepare = db.prepare.bind(db)
    db.prepare = function(sql) {
      console.log('[sqlite] query', sql)
      return originalPrepare(sql)
    }
  }

  const ensureTable = async (tableName, properties, settings) => {
    const columns = []
    const indexes = []
    const uniqueConstraints = []

    // Add id column
    columns.push('id TEXT PRIMARY KEY')

    // Add properties as columns
    Object.entries(properties || {}).forEach(([key, type]) => {
      let sqlType = 'TEXT'
      if (type === 'number') sqlType = 'REAL'
      else if (type === 'boolean') sqlType = 'INTEGER'
      else if (type === 'datetime') sqlType = 'TEXT'
      else if (type === 'encrypted') sqlType = 'TEXT'
      else sqlType = 'TEXT'

      columns.push(`${key} ${sqlType}`)
    })

    // Add timestamps if enabled
    if (settings.timestamps !== false) {
      columns.push('created_at TEXT')
      columns.push('updated_at TEXT')
    }

    // Add soft delete if enabled
    if (settings.softDelete) {
      columns.push('deleted_at TEXT')
    }

    // Add foreign keys
    if (settings.belongsTo) {
      const fkName = toFkColumn(settings.belongsTo)
      columns.push(`${fkName} TEXT`)
    }

    // Create table
    const createTableSql = `CREATE TABLE IF NOT EXISTS "${tableName}" (${columns.join(', ')})`
    db.exec(createTableSql)

    // Create indexes
    if (settings.indexes && Array.isArray(settings.indexes)) {
      settings.indexes.forEach((field) => {
        const indexName = `${tableName}_${field}_idx`
        const indexSql = `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${tableName}" ("${field}")`
        db.exec(indexSql)
      })
    }

    // Create unique constraints
    if (settings.unique && Array.isArray(settings.unique)) {
      settings.unique.forEach((field) => {
        const constraintName = `${tableName}_${field}_unique`
        const uniqueSql = `CREATE UNIQUE INDEX IF NOT EXISTS "${constraintName}" ON "${tableName}" ("${field}")`
        db.exec(uniqueSql)
      })
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
        }
      })
    }

    const api = {
      __name: singularName,
      __singularName: singularName,
      __modelName: singularName,
      __tableName: tableName,
      __collectionName: collectionName,
      __properties: properties,
      __backend: 'sqlite',
      __adapter: { db },
      __associationFactories,
      __buildInstance: buildInstance,
      __embeddingConfig: settings.embeddings || null,

      async create(attrs, options = {}) {
        await schemaPromise
        const writableAttrs = pickWritableFields(attrs, properties)
        await callbacks.run('before_validation', writableAttrs)
        await callbacks.run('before_validation_on_create', writableAttrs)
        
        // Validate required fields
        validateRequired(writableAttrs, settings.required || [])
        
        await callbacks.run('after_validation', writableAttrs)
        await callbacks.run('after_validation_on_create', writableAttrs)
        await callbacks.run('before_save', writableAttrs)
        await callbacks.run('before_create', writableAttrs)

        const id = randomUUID()
        const now = nowIso()
        
        const coerced = await coerceAndEncrypt(writableAttrs, properties)
        
        const insertData = {
          id,
          ...coerced,
        }

        if (timestampsEnabled) {
          insertData.created_at = now
          insertData.updated_at = now
        }

        if (settings.belongsTo) {
          const fkName = toFkColumn(settings.belongsTo)
          if (attrs[fkName]) {
            insertData[fkName] = attrs[fkName]
          }
        }

        const columns = Object.keys(insertData)
        const placeholders = columns.map(() => '?').join(', ')
        const values = columns.map(col => insertData[col])

        const insertSql = `INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`
        const stmt = db.prepare(insertSql)
        stmt.run(...values)

        const instance = buildInstance(this, insertData)
        await callbacks.run('after_create', instance)
        await callbacks.run('after_save', instance)

        return instance
      },

      async find(id, options = {}) {
        await schemaPromise
        const { withDeleted = false } = options
        const where = { id }
        const { whereClause, params } = buildWhereClause(where, softDeleteEnabled, withDeleted)
        const sql = `SELECT * FROM "${tableName}" ${whereClause} LIMIT 1`
        const stmt = db.prepare(sql)
        const row = stmt.get(...params)
        return row ? buildInstance(this, row) : null
      },

      async findBy(where, options = {}) {
        await schemaPromise
        const { withDeleted = false } = options
        const normalized = normalizeWhere(where)
        const { whereClause, params } = buildWhereClause(normalized, softDeleteEnabled, withDeleted)
        const sql = `SELECT * FROM "${tableName}" ${whereClause} LIMIT 1`
        const stmt = db.prepare(sql)
        const row = stmt.get(...params)
        return row ? buildInstance(this, row) : null
      },

      async findAll(options = {}) {
        await schemaPromise
        const {
          where = {},
          order,
          limit,
          offset,
          select,
          include,
          withDeleted = false,
        } = options

        const normalized = normalizeWhere(where)
        const { whereClause, params } = buildWhereClause(normalized, softDeleteEnabled, withDeleted)
        const orderClause = buildOrderClause(order)
        const limitClause = limit ? `LIMIT ${limit}` : ''
        const offsetClause = offset ? `OFFSET ${offset}` : ''

        const selectFields = select && Array.isArray(select) && select.length > 0
          ? select.map(f => `"${f}"`).join(', ')
          : '*'

        let sql = `SELECT ${selectFields} FROM "${tableName}" ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`.trim()
        const stmt = db.prepare(sql)
        const rows = stmt.all(...params)

        let results = rows.map(row => buildInstance(this, row))

        // Handle includes (eager loading)
        if (include && include.length > 0) {
          const normalizedIncludes = normalizeIncludes(include, singularName)
          for (const includeSpec of normalizedIncludes) {
            const targetModel = registry.get(includeSpec.model)
            if (!targetModel) continue

            const fkName = toFkColumn(singularName)
            const ids = results.map(r => r.id)
            if (ids.length === 0) continue

            const placeholders = ids.map(() => '?').join(', ')
            // Build IN clause for foreign key
            const includeWhereClause = `WHERE "${fkName}" IN (${placeholders})`
            const includeParams = ids
            
            const includeSql = `SELECT * FROM "${targetModel.__tableName}" ${includeWhereClause}`
            const includeStmt = db.prepare(includeSql)
            const includeRows = includeStmt.all(...includeParams)
            const includeResults = includeRows.map(row => buildInstance(targetModel, row))

            // Group by foreign key
            const grouped = includeResults.reduce((acc, item) => {
              const fkValue = item[fkName]
              if (!acc[fkValue]) acc[fkValue] = []
              acc[fkValue].push(item)
              return acc
            }, {})

            // Attach to results
            results.forEach(result => {
              const related = grouped[result.id] || []
              result[includeSpec.as] = related.length === 1 && includeSpec.model !== includeSpec.as ? related[0] : related
            })
          }
        }

        return results
      },

      async update(id, changes, options = {}) {
        await schemaPromise
        const existing = await this.find(id, options)
        if (!existing) return null

        const writableChanges = pickWritableFields(changes, properties)
        await callbacks.run('before_validation', { ...existing, ...writableChanges })
        await callbacks.run('before_validation_on_update', { ...existing, ...writableChanges })
        
        await callbacks.run('after_validation', { ...existing, ...writableChanges })
        await callbacks.run('after_validation_on_update', { ...existing, ...writableChanges })
        await callbacks.run('before_save', { ...existing, ...writableChanges })
        await callbacks.run('before_update', { ...existing, ...writableChanges })

        const coerced = await coerceAndEncrypt(writableChanges, properties)
        const updateData = { ...coerced }

        if (timestampsEnabled) {
          updateData.updated_at = nowIso()
        }

        const setClauses = Object.keys(updateData).map(key => `"${key}" = ?`).join(', ')
        const values = Object.values(updateData)
        values.push(id)

        const updateSql = `UPDATE "${tableName}" SET ${setClauses} WHERE id = ?`
        const stmt = db.prepare(updateSql)
        stmt.run(...values)

        const updated = await this.find(id, options)
        await callbacks.run('after_update', updated)
        await callbacks.run('after_save', updated)

        return updated
      },

      async updateBy(where, changes, options = {}) {
        await schemaPromise
        const normalized = normalizeWhere(where)
        const { whereClause, params } = buildWhereClause(normalized, softDeleteEnabled, false)
        
        const writableChanges = pickWritableFields(changes, properties)
        const coerced = await coerceAndEncrypt(writableChanges, properties)
        const updateData = { ...coerced }

        if (timestampsEnabled) {
          updateData.updated_at = nowIso()
        }

        const setClauses = Object.keys(updateData).map(key => `"${key}" = ?`).join(', ')
        const values = Object.values(updateData)
        values.push(...params)

        const updateSql = `UPDATE "${tableName}" SET ${setClauses} ${whereClause}`
        const stmt = db.prepare(updateSql)
        const result = stmt.run(...values)

        return { affectedRows: result.changes }
      },

      async delete(id, options = {}) {
        await schemaPromise
        const existing = await this.find(id, { withDeleted: true })
        if (!existing) return null

        await callbacks.run('before_destroy', existing)

        if (softDeleteEnabled) {
          const updateSql = `UPDATE "${tableName}" SET deleted_at = ? WHERE id = ?`
          const stmt = db.prepare(updateSql)
          stmt.run(nowIso(), id)
        } else {
          const deleteSql = `DELETE FROM "${tableName}" WHERE id = ?`
          const stmt = db.prepare(deleteSql)
          stmt.run(id)
        }

        await callbacks.run('after_destroy', existing)
        return existing
      },

      async count(where = {}, options = {}) {
        await schemaPromise
        const { withDeleted = false } = options
        const normalized = normalizeWhere(where)
        const { whereClause, params } = buildWhereClause(normalized, softDeleteEnabled, withDeleted)
        const sql = `SELECT COUNT(*) as count FROM "${tableName}" ${whereClause}`
        const stmt = db.prepare(sql)
        const result = stmt.get(...params)
        return result ? parseInt(result.count, 10) : 0
      },

      async updateOneBy(where, changes, options = {}) {
        await schemaPromise
        const normalized = normalizeWhere(where)
        const { whereClause, params: whereParams } = buildWhereClause(normalized, softDeleteEnabled, false)
        
        const writableChanges = pickWritableFields(changes, properties)
        const coerced = await coerceAndEncrypt(writableChanges, properties)
        const updateData = { ...coerced }

        if (timestampsEnabled) {
          updateData.updated_at = nowIso()
        }

        const setClauses = Object.keys(updateData).map(key => `"${key}" = ?`).join(', ')
        const values = Object.values(updateData)
        values.push(...whereParams)

        const updateSql = `UPDATE "${tableName}" SET ${setClauses} ${whereClause} LIMIT 1`
        const stmt = db.prepare(updateSql)
        stmt.run(...values)

        return this.findBy(where, options)
      },

      async deleteBy(where, options = {}) {
        await schemaPromise
        const normalized = normalizeWhere(where)
        const { whereClause, params } = buildWhereClause(normalized, softDeleteEnabled, false)
        
        // Find records to delete
        const findSql = `SELECT * FROM "${tableName}" ${whereClause}`
        const findStmt = db.prepare(findSql)
        const rows = findStmt.all(...params)
        
        const instances = rows.map(row => buildInstance(this, row))
        
        for (const instance of instances) {
          await callbacks.run('before_destroy', instance)
        }

        if (softDeleteEnabled) {
          const updateSql = `UPDATE "${tableName}" SET deleted_at = ? ${whereClause}`
          const updateStmt = db.prepare(updateSql)
          updateStmt.run(nowIso(), ...params)
        } else {
          const deleteSql = `DELETE FROM "${tableName}" ${whereClause}`
          const deleteStmt = db.prepare(deleteSql)
          deleteStmt.run(...params)
        }

        for (const instance of instances) {
          await callbacks.run('after_destroy', instance)
        }

        return instances
      },

      // Callback registration methods
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
    }

    // Enhance model with additional features
    const enhancedApi = enhanceModel(api, { db }, registry)
    
    registry.set(singularName, enhancedApi)
    return enhancedApi
  }

  // Connection health check
  const healthCheck = async () => {
    try {
      db.prepare('SELECT 1').get()
      return { healthy: true, database: cfg.database }
    } catch (error) {
      return { healthy: false, error: error.message, database: cfg.database }
    }
  }

  // Get database stats (SQLite doesn't have connection pooling)
  const getPoolStats = () => {
    return {
      database: cfg.database,
      readonly: cfg.readonly,
      // SQLite doesn't expose connection pool stats
    }
  }

  // Close database connection
  const close = async () => {
    db.close()
  }

  return {
    model,
    close,
    healthCheck,
    getPoolStats,
    db, // Expose database instance for advanced usage
  }
}

module.exports = sqliteAdapter

