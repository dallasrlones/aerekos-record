/**
 * JSON/JSONB Support Manager
 * Provides enhanced JSON field operations
 */
class JSONSupportManager {
  constructor(modelApi) {
    this.modelApi = modelApi
  }

  /**
   * Query JSON field (PostgreSQL JSONB)
   */
  async queryJSON(field, path, operator, value) {
    const backend = this.modelApi.__backend || 'unknown'
    
    if (backend !== 'psql') {
      throw new Error('JSON querying currently only supported for PostgreSQL')
    }

    const tableName = this.modelApi.__tableName || this.modelApi.__collectionName
    const pool = this.modelApi.__adapterInstance?.pool || this.modelApi.__pool

    if (!pool) {
      throw new Error('PostgreSQL pool not available')
    }

    // Build JSON path query
    const jsonPath = Array.isArray(path) ? path.join('->') : path
    const sql = `
      SELECT *
      FROM ${tableName}
      WHERE ${field}->>'${jsonPath}' ${operator} $1
    `

    const result = await pool.query(sql, [value])
    return result.rows.map(row => {
      const { id, ...rest } = row
      return { id, ...rest }
    })
  }

  /**
   * Update JSON field
   */
  async updateJSON(id, field, path, value) {
    const backend = this.modelApi.__backend || 'unknown'
    
    if (backend !== 'psql') {
      // For other databases, update the whole field
      const record = await this.modelApi.find(id)
      const jsonData = record[field] || {}
      const updated = this.setNestedValue(jsonData, path, value)
      return this.modelApi.update(id, { [field]: updated })
    }

    const tableName = this.modelApi.__tableName || this.modelApi.__collectionName
    const pool = this.modelApi.__adapterInstance?.pool || this.modelApi.__pool

    if (!pool) {
      throw new Error('PostgreSQL pool not available')
    }

    // Build JSONB path update
    const jsonPath = Array.isArray(path) ? path.join(',') : path
    const sql = `
      UPDATE ${tableName}
      SET ${field} = jsonb_set(${field}, '{${jsonPath}}', $1::jsonb)
      WHERE id = $2
      RETURNING *
    `

    const result = await pool.query(sql, [JSON.stringify(value), id])
    return result.rows[0]
  }

  /**
   * Get JSON field value
   */
  async getJSON(id, field, path) {
    const record = await this.modelApi.find(id)
    if (!record) return null

    const jsonData = record[field]
    if (!jsonData) return null

    return this.getNestedValue(jsonData, path)
  }

  /**
   * Set nested value in object
   */
  setNestedValue(obj, path, value) {
    const keys = Array.isArray(path) ? path : path.split('.')
    const result = { ...obj }
    let current = result

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {}
      }
      current = current[key]
    }

    current[keys[keys.length - 1]] = value
    return result
  }

  /**
   * Get nested value from object
   */
  getNestedValue(obj, path) {
    const keys = Array.isArray(path) ? path : path.split('.')
    let current = obj

    for (const key of keys) {
      if (current == null || typeof current !== 'object') {
        return null
      }
      current = current[key]
    }

    return current
  }
}

module.exports = JSONSupportManager

