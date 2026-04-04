/**
 * Batch Operations Manager
 * Provides optimized bulk insert/update operations
 */
class BatchOperationsManager {
  constructor(modelApi) {
    this.modelApi = modelApi
    this.batchSize = 1000 // Default batch size
  }

  /**
   * Set batch size
   */
  setBatchSize(size) {
    this.batchSize = size
    return this
  }

  /**
   * Bulk create records
   */
  async bulkCreate(records, options = {}) {
    const batchSize = options.batchSize || this.batchSize
    const results = []

    // Process in batches
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)
      const batchResults = await Promise.all(
        batch.map(record => this.modelApi.create(record))
      )
      results.push(...batchResults)
    }

    return results
  }

  /**
   * Bulk update records
   */
  async bulkUpdate(updates, options = {}) {
    const batchSize = options.batchSize || this.batchSize
    const results = []

    // Process in batches
    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize)
      const batchResults = await Promise.all(
        batch.map(({ id, changes }) => this.modelApi.update(id, changes))
      )
      results.push(...batchResults.filter(Boolean))
    }

    return results
  }

  /**
   * Bulk delete records
   */
  async bulkDelete(ids, options = {}) {
    const batchSize = options.batchSize || this.batchSize
    const results = []

    // Process in batches
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize)
      const batchResults = await Promise.all(
        batch.map(id => this.modelApi.delete(id, options))
      )
      results.push(...batchResults)
    }

    return results
  }

  /**
   * Upsert (insert or update) records
   */
  async bulkUpsert(records, uniqueField = 'id', options = {}) {
    const batchSize = options.batchSize || this.batchSize
    const results = []

    // Process in batches
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)
      
      const batchResults = await Promise.all(
        batch.map(async (record) => {
          const uniqueValue = record[uniqueField]
          if (!uniqueValue) {
            // No unique field, create new
            return this.modelApi.create(record)
          }

          // Try to find existing
          const existing = await this.modelApi.findBy({ [uniqueField]: uniqueValue })
          if (existing) {
            // Update existing
            return this.modelApi.update(existing.id, record)
          } else {
            // Create new
            return this.modelApi.create(record)
          }
        })
      )
      
      results.push(...batchResults)
    }

    return results
  }
}

module.exports = BatchOperationsManager

