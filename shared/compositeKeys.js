/**
 * Composite Keys Manager
 * Provides support for composite primary keys
 */
class CompositeKeysManager {
  constructor(modelApi) {
    this.modelApi = modelApi
    this.compositeKeys = new Map() // Map of model names to their composite key definitions
  }

  /**
   * Define composite key for a model
   */
  defineCompositeKey(modelName, fields) {
    if (!Array.isArray(fields) || fields.length < 2) {
      throw new Error('Composite key must have at least 2 fields')
    }

    this.compositeKeys.set(modelName, {
      fields,
      separator: '::', // Default separator for composite key string representation
    })
  }

  /**
   * Generate composite key value
   */
  generateCompositeKey(modelName, record) {
    const keyDef = this.compositeKeys.get(modelName)
    if (!keyDef) {
      return null
    }

    const values = keyDef.fields.map(field => {
      const value = record[field]
      if (value == null) {
        throw new Error(`Composite key field '${field}' is required`)
      }
      return String(value)
    })

    return values.join(keyDef.separator)
  }

  /**
   * Parse composite key
   */
  parseCompositeKey(modelName, compositeKey) {
    const keyDef = this.compositeKeys.get(modelName)
    if (!keyDef) {
      return null
    }

    const values = compositeKey.split(keyDef.separator)
    if (values.length !== keyDef.fields.length) {
      throw new Error(`Invalid composite key format for ${modelName}`)
    }

    const result = {}
    keyDef.fields.forEach((field, index) => {
      result[field] = values[index]
    })

    return result
  }

  /**
   * Build where clause for composite key
   */
  buildWhereClause(modelName, compositeKey) {
    const keyDef = this.compositeKeys.get(modelName)
    if (!keyDef) {
      return null
    }

    const parsed = this.parseCompositeKey(modelName, compositeKey)
    const where = {}

    keyDef.fields.forEach(field => {
      where[field] = parsed[field]
    })

    return where
  }

  /**
   * Find by composite key
   */
  async findByCompositeKey(modelName, compositeKey) {
    const where = this.buildWhereClause(modelName, compositeKey)
    if (!where) {
      throw new Error(`No composite key defined for ${modelName}`)
    }

    return this.modelApi.findBy(where)
  }

  /**
   * Update by composite key
   */
  async updateByCompositeKey(modelName, compositeKey, changes) {
    const where = this.buildWhereClause(modelName, compositeKey)
    if (!where) {
      throw new Error(`No composite key defined for ${modelName}`)
    }

    return this.modelApi.updateBy(where, changes)
  }

  /**
   * Delete by composite key
   */
  async deleteByCompositeKey(modelName, compositeKey) {
    const where = this.buildWhereClause(modelName, compositeKey)
    if (!where) {
      throw new Error(`No composite key defined for ${modelName}`)
    }

    return this.modelApi.deleteBy(where)
  }
}

module.exports = CompositeKeysManager

