/**
 * Query Builder
 * Fluent API for building complex queries
 */
class QueryBuilder {
  constructor(modelApi) {
    this.modelApi = modelApi
    this.query = {
      where: {},
      order: null,
      limit: null,
      offset: null,
      include: [],
      select: null,
      withDeleted: false,
    }
  }

  /**
   * Add where condition
   */
  where(field, operator, value) {
    if (arguments.length === 2) {
      // where(field, value) - equality
      this.query.where[field] = arguments[1]
    } else if (arguments.length === 3) {
      // where(field, operator, value)
      if (operator === '=' || operator === '==') {
        this.query.where[field] = value
      } else if (operator === '!=' || operator === '<>') {
        this.query.where[field] = { $ne: value }
      } else if (operator === '>') {
        this.query.where[field] = { $gt: value }
      } else if (operator === '>=') {
        this.query.where[field] = { gte: value }
      } else if (operator === '<') {
        this.query.where[field] = { $lt: value }
      } else if (operator === '<=') {
        this.query.where[field] = { lte: value }
      } else if (operator === 'in' || operator === 'IN') {
        this.query.where[field] = Array.isArray(value) ? value : [value]
      } else if (operator === 'notIn' || operator === 'not in') {
        this.query.where[field] = { $nin: Array.isArray(value) ? value : [value] }
      } else if (operator === 'like' || operator === 'contains') {
        this.query.where[field] = { contains: value }
      } else if (operator === 'notLike' || operator === 'not like') {
        this.query.where[field] = { $nlike: value }
      } else {
        this.query.where[field] = { [operator]: value }
      }
    }
    return this
  }

  /**
   * Add where condition (alias)
   */
  andWhere(field, operator, value) {
    return this.where(field, operator, value)
  }

  /**
   * Add OR condition (requires custom handling per adapter)
   */
  orWhere(field, operator, value) {
    if (!this.query.where.$or) {
      this.query.where.$or = []
    }
    const condition = {}
    if (arguments.length === 2) {
      condition[field] = arguments[1]
    } else {
      condition[field] = { [operator]: value }
    }
    this.query.where.$or.push(condition)
    return this
  }

  /**
   * Where field is null
   */
  whereNull(field) {
    this.query.where[field] = null
    return this
  }

  /**
   * Where field is not null
   */
  whereNotNull(field) {
    this.query.where[field] = { $ne: null }
    return this
  }

  /**
   * Where field is in array
   */
  whereIn(field, values) {
    this.query.where[field] = Array.isArray(values) ? values : [values]
    return this
  }

  /**
   * Where field is not in array
   */
  whereNotIn(field, values) {
    this.query.where[field] = { $nin: Array.isArray(values) ? values : [values] }
    return this
  }

  /**
   * Where field contains value
   */
  whereContains(field, value) {
    this.query.where[field] = { contains: value }
    return this
  }

  /**
   * Where field is between two values
   */
  whereBetween(field, min, max) {
    this.query.where[field] = { gte: min, lte: max }
    return this
  }

  /**
   * Order by field
   */
  orderBy(field, direction = 'ASC') {
    if (this.query.order) {
      // Append to existing order
      const existing = Array.isArray(this.query.order) ? this.query.order : [this.query.order]
      existing.push(`${field} ${direction.toUpperCase()}`)
      this.query.order = existing
    } else {
      this.query.order = `${field} ${direction.toUpperCase()}`
    }
    return this
  }

  /**
   * Order by descending
   */
  orderByDesc(field) {
    return this.orderBy(field, 'DESC')
  }

  /**
   * Limit results
   */
  limit(count) {
    this.query.limit = count
    return this
  }

  /**
   * Offset results
   */
  offset(count) {
    this.query.offset = count
    return this
  }

  /**
   * Skip results (alias for offset)
   */
  skip(count) {
    return this.offset(count)
  }

  /**
   * Include associations
   */
  include(associations) {
    if (typeof associations === 'string') {
      this.query.include.push(associations)
    } else if (Array.isArray(associations)) {
      this.query.include.push(...associations)
    } else if (typeof associations === 'object') {
      this.query.include.push(associations)
    }
    return this
  }

  /**
   * Select specific fields
   */
  select(fields) {
    this.query.select = Array.isArray(fields) ? fields : [fields]
    return this
  }

  /**
   * Include soft-deleted records
   */
  withDeleted() {
    this.query.withDeleted = true
    return this
  }

  /**
   * Execute query - find all
   */
  async findAll() {
    return this.modelApi.findAll(this.query)
  }

  /**
   * Execute query - find one
   */
  async findOne() {
    const result = await this.modelApi.findAll({ ...this.query, limit: 1 })
    return result.length > 0 ? result[0] : null
  }

  /**
   * Execute query - count
   */
  async count() {
    return this.modelApi.count(this.query.where, { withDeleted: this.query.withDeleted })
  }

  /**
   * Execute query - exists
   */
  async exists() {
    const result = await this.findOne()
    return result !== null
  }

  /**
   * Get first result
   */
  async first() {
    return this.findOne()
  }

  /**
   * Get last result
   */
  async last() {
    const originalOrder = this.query.order
    // Reverse order
    if (typeof originalOrder === 'string') {
      const parts = originalOrder.split(' ')
      this.query.order = parts[1] === 'DESC' ? parts[0] + ' ASC' : parts[0] + ' DESC'
    }
    const result = await this.findOne()
    this.query.order = originalOrder
    return result
  }

  /**
   * Paginate results
   */
  async paginate(page = 1, perPage = 10) {
    const offset = (page - 1) * perPage
    this.query.limit = perPage
    this.query.offset = offset

    const [data, total] = await Promise.all([
      this.findAll(),
      this.count(),
    ])

    return {
      data,
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
        hasNextPage: page * perPage < total,
        hasPreviousPage: page > 1,
      },
    }
  }

  /**
   * Chunk results (process in batches)
   */
  async chunk(size, callback) {
    let offset = 0
    let hasMore = true

    while (hasMore) {
      this.query.limit = size
      this.query.offset = offset
      const results = await this.findAll()

      if (results.length === 0) {
        hasMore = false
        break
      }

      await callback(results)

      if (results.length < size) {
        hasMore = false
      } else {
        offset += size
      }
    }
  }

  /**
   * Reset query builder
   */
  reset() {
    this.query = {
      where: {},
      order: null,
      limit: null,
      offset: null,
      include: [],
      select: null,
      withDeleted: false,
    }
    return this
  }
}

module.exports = QueryBuilder

