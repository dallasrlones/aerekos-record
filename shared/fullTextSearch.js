/**
 * Full-Text Search Manager
 * Provides advanced search capabilities across databases
 */
class FullTextSearchManager {
  constructor(modelApi) {
    this.modelApi = modelApi
    this.searchFields = []
  }

  /**
   * Configure searchable fields
   */
  setSearchFields(fields) {
    this.searchFields = Array.isArray(fields) ? fields : [fields]
    return this
  }

  /**
   * Search across multiple fields
   */
  async search(query, options = {}) {
    const backend = this.modelApi.__backend || 'unknown'
    const fields = options.fields || this.searchFields
    const limit = options.limit || 10
    const offset = options.offset || 0

    switch (backend) {
      case 'elasticsearch':
        return this.searchElasticsearch(query, fields, { limit, offset, ...options })
      case 'psql':
        return this.searchPostgreSQL(query, fields, { limit, offset })
      case 'mongodb':
        return this.searchMongoDB(query, fields, { limit, offset })
      case 'neo4j':
        return this.searchNeo4j(query, fields, { limit, offset })
      default:
        // Fallback to simple contains search
        return this.searchFallback(query, fields, { limit, offset })
    }
  }

  /**
   * Elasticsearch full-text search
   */
  async searchElasticsearch(query, fields, options) {
    const indexName = this.modelApi.__indexName || this.modelApi.__collectionName
    const client = this.modelApi.__adapterInstance?.client || this.modelApi.__client

    if (!client) {
      throw new Error('Elasticsearch client not available')
    }

    // Support custom fuzziness and other Elasticsearch options
    const fuzziness = options.fuzziness !== undefined ? options.fuzziness : 'AUTO'
    const queryType = options.queryType || 'multi_match'
    const operator = options.operator || 'or'
    const minimumShouldMatch = options.minimumShouldMatch
    const boost = options.boost

    let searchQuery

    if (queryType === 'fuzzy') {
      // Use fuzzy query for typo tolerance
      searchQuery = {
        bool: {
          should: fields.map(field => ({
            fuzzy: {
              [field]: {
                value: query,
                fuzziness: fuzziness,
                max_expansions: options.maxExpansions || 50,
                prefix_length: options.prefixLength || 0,
                transpositions: options.transpositions !== false,
              },
            },
          })),
          minimum_should_match: minimumShouldMatch || 1,
        },
      }
    } else if (queryType === 'match') {
      // Use match query (supports fuzziness)
      searchQuery = {
        bool: {
          should: fields.map(field => ({
            match: {
              [field]: {
                query: query,
                operator: operator,
                fuzziness: fuzziness,
                boost: boost,
              },
            },
          })),
          minimum_should_match: minimumShouldMatch || 1,
        },
      }
    } else {
      // Default: multi_match query
      searchQuery = {
        multi_match: {
          query: query,
          fields: fields,
          type: options.matchType || 'best_fields',
          fuzziness: fuzziness,
          operator: operator,
          minimum_should_match: minimumShouldMatch,
          boost: boost,
          prefix_length: options.prefixLength || 0,
          max_expansions: options.maxExpansions || 50,
          transpositions: options.transpositions !== false,
        },
      }
    }

    const result = await client.search({
      index: indexName,
      query: searchQuery,
      size: options.limit,
      from: options.offset,
      ...(options.sort && { sort: options.sort }),
      ...(options.highlight && {
        highlight: {
          fields: fields.reduce((acc, field) => {
            acc[field] = {}
            return acc
          }, {}),
        },
      }),
    })

    return result.hits.hits.map(hit => ({
      id: hit._id,
      ...hit._source,
      _score: hit._score,
      ...(hit.highlight && { _highlight: hit.highlight }),
    }))
  }

  /**
   * Elasticsearch fuzzy search (convenience method)
   */
  async fuzzySearch(query, fields, options = {}) {
    return this.searchElasticsearch(query, fields, {
      ...options,
      queryType: 'fuzzy',
      fuzziness: options.fuzziness || 'AUTO',
    })
  }

  /**
   * PostgreSQL full-text search
   */
  async searchPostgreSQL(query, fields, options) {
    const tableName = this.modelApi.__tableName || this.modelApi.__collectionName
    const pool = this.modelApi.__adapterInstance?.pool || this.modelApi.__pool

    if (!pool) {
      throw new Error('PostgreSQL pool not available')
    }

    // Build tsvector search
    const searchFields = fields.map(f => `COALESCE(${f}, '')`).join(" || ' ' || ")
    const sql = `
      SELECT *, ts_rank(to_tsvector('english', ${searchFields}), plainto_tsquery('english', $1)) as rank
      FROM ${tableName}
      WHERE to_tsvector('english', ${searchFields}) @@ plainto_tsquery('english', $1)
      ORDER BY rank DESC
      LIMIT $2 OFFSET $3
    `

    const result = await pool.query(sql, [query, options.limit, options.offset])
    return result.rows
  }

  /**
   * MongoDB text search
   */
  async searchMongoDB(query, fields, options) {
    const collectionName = this.modelApi.__collectionName
    const getCollection = this.modelApi.__adapterInstance?.getCollection

    if (!getCollection) {
      throw new Error('MongoDB collection access not available')
    }

    const collection = await getCollection(collectionName)
    
    // MongoDB text search requires text index
    const searchQuery = {
      $text: { $search: query },
    }

    const results = await collection.find(searchQuery)
      .sort({ score: { $meta: 'textScore' } })
      .limit(options.limit)
      .skip(options.offset)
      .toArray()

    return results.map(doc => {
      const { _id, ...rest } = doc
      return { id: _id.toString(), ...rest }
    })
  }

  /**
   * Neo4j full-text search
   */
  async searchNeo4j(query, fields, options) {
    const label = this.modelApi.__label || this.modelApi.__name.toUpperCase()
    const runQuery = this.modelApi.__adapterInstance?.runQuery

    if (!runQuery) {
      throw new Error('Neo4j query runner not available')
    }

    // Build CONTAINS conditions for each field
    const conditions = fields.map((field, idx) => {
      const paramKey = `search_${idx}`
      return `n.${field} CONTAINS $${paramKey}`
    }).join(' OR ')

    const params = fields.reduce((acc, field, idx) => {
      acc[`search_${idx}`] = query
      return acc
    }, {})

    const cypher = `
      MATCH (n:${label})
      WHERE ${conditions}
      RETURN n
      LIMIT $limit
      SKIP $offset
    `

    params.limit = options.limit
    params.offset = options.offset

    const result = await runQuery(cypher, params)
    return result.records.map(r => {
      const node = r.get('n').properties
      return { id: node.id, ...node }
    })
  }

  /**
   * Fallback search (simple contains)
   */
  async searchFallback(query, fields, options) {
    const conditions = {}
    fields.forEach(field => {
      conditions[field] = { contains: query }
    })

    // Use OR logic - find records matching any field
    return this.modelApi.findAll({
      where: conditions,
      limit: options.limit,
      offset: options.offset,
    })
  }
}

module.exports = FullTextSearchManager

