const axios = require('axios')
const http = require('http')
const https = require('https')

// HTTP agents with keep-alive (like business-brain chromaService)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, timeout: 65000 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, timeout: 65000 })
const client = axios.create({ timeout: 60000, httpAgent, httpsAgent })

/**
 * ChromaDB Adapter
 * Based on business-brain chromaService.js patterns
 */
function createChromaAdapter(connectionSettings = {}) {
  const baseUrl = connectionSettings.url || process.env.CHROMA_BASE_URL
  const defaultCollection = connectionSettings.collection || process.env.CHROMA_COLLECTION || 'aerekos-record'
  const tenant = connectionSettings.tenant || process.env.CHROMA_TENANT || 'default_tenant'
  const database = connectionSettings.database || process.env.CHROMA_DATABASE || 'default_database'
  const debugChroma = Boolean(
    connectionSettings.logQueries ||
      connectionSettings.debug ||
      process.env.AEREKOS_DEBUG_CHROMA === '1'
  )

  const dlog = (...args) => {
    if (debugChroma) console.log(...args)
  }

  /**
   * Retry helper (based on business-brain chromaService withRetry)
   */
  async function withRetry(reqFn, label = 'chroma', maxRetries = 2) {
    let attempt = 0
    let lastErr

    while (attempt <= maxRetries) {
      const start = Date.now()
      try {
        return await reqFn()
      } catch (e) {
        lastErr = e
        const code = e.code || e.cause?.code || ''
        const retriable =
          ['ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH'].includes(code) ||
          !e.response ||
          e.response.status >= 500
        const dur = Date.now() - start
        if (debugChroma) {
          console.warn(`[${label}] error code=${code} status=${e.response?.status} durMs=${dur} msg=${e.message}`)
        }

        if (!retriable || attempt === maxRetries) break

        const backoff = Math.min(150 * Math.pow(2, attempt) + Math.floor(Math.random() * 100), 1500)
        await new Promise((r) => setTimeout(r, backoff))
        attempt += 1
      }
    }

    throw lastErr
  }

  if (!baseUrl) {
    throw new Error('ChromaDB URL required. Set url in connectionSettings or CHROMA_BASE_URL env var')
  }

  /**
   * Ensure collection exists (based on business-brain ensureCollection)
   */
  async function ensureCollection(collectionName = defaultCollection) {
    let collectionId = collectionName
    
    try {
      dlog('[chroma] ensureCollection list...')
      const list = await withRetry(() => 
        client.get(`${baseUrl}/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections`), 
        'chroma-list'
      )
      
      let found = (list.data || []).find(c => c.name === collectionName)
      
      if (!found) {
        dlog('[chroma] creating collection', collectionName)
        await withRetry(() => 
          client.post(`${baseUrl}/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections`, {
            name: collectionName,
            metadata: { "hnsw:space": 'cosine', dimension: 1024 }
          }), 
          'chroma-create'
        )
        
        const list2 = await withRetry(() => 
          client.get(`${baseUrl}/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections`), 
          'chroma-list'
        )
        found = (list2.data || []).find(c => c.name === collectionName)
      }
      
      collectionId = found?.id || collectionName
    } catch (e) {
      console.warn('[chroma] ensureCollection failed:', e.message || e)
    }
    
    return collectionId
  }

  /**
   * Add embedding to Chroma (based on business-brain addEmbedding)
   */
  async function addEmbedding(id, embedding, metadata = {}, collectionName = defaultCollection) {
    const collectionId = await ensureCollection(collectionName)
    
    // Clean metadata (whitelist approach like business-brain)
    const cleanMeta = (() => {
      const safe = {}
      const src = metadata || {}
      
      // Whitelist only fields known to work reliably in Chroma metadata
      if (src.userID != null) safe.userID = String(src.userID)
      if (src.text != null) safe.text = String(src.text)
      if (src.timestamp != null) safe.timestamp = String(src.timestamp)
      if (src.conversationID != null) safe.conversationID = String(src.conversationID)
      if (src.messageID != null) safe.messageID = String(src.messageID)
      if (src.recordId != null) safe.recordId = String(src.recordId)
      if (src.modelName != null) safe.modelName = String(src.modelName)
      if (src.fieldName != null) safe.fieldName = String(src.fieldName)
      if (src.chunkIndex != null) safe.chunkIndex = String(src.chunkIndex)
      if (src.type != null) safe.type = String(src.type)
      
      // Allow custom metadata fields (stringify them)
      Object.keys(src).forEach(key => {
        if (!['userID', 'text', 'timestamp', 'conversationID', 'messageID', 'recordId', 'modelName', 'fieldName', 'chunkIndex', 'type'].includes(key)) {
          try {
            safe[key] = String(src[key])
          } catch {}
        }
      })
      
      return safe
    })()
    
    dlog('[chroma] addEmbedding', { id, collectionId, metaKeys: Object.keys(cleanMeta || {}) })
    
    try {
      await withRetry(() => 
        client.post(`${baseUrl}/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${encodeURIComponent(collectionId)}/add`, {
          ids: [id],
          embeddings: [embedding],
          metadatas: [cleanMeta],
          documents: [cleanMeta.text || ''],
        }), 
        'chroma-add'
      )
    } catch (e) {
      if (debugChroma) {
        console.warn('[chroma] addEmbedding failed', e.response?.status, e.response?.data || e.message)
      }
      
      // Best-effort retry with minimal metadata
      try {
        const minimal = { 
          userID: String(cleanMeta.userID || ''), 
          text: String(cleanMeta.text || ''),
          recordId: String(cleanMeta.recordId || '')
        }
        await withRetry(() => 
          client.post(`${baseUrl}/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${encodeURIComponent(collectionId)}/add`, {
            ids: [id],
            embeddings: [embedding],
            metadatas: [minimal],
            documents: [minimal.text],
          }), 
          'chroma-add-min'
        )
        dlog('[chroma] addEmbedding retried with minimal metadata')
      } catch (e2) {
        console.warn('[chroma] addEmbedding retry failed', e2.response?.status, e2.response?.data || e2.message)
        throw e2
      }
    }
  }

  /**
   * Query similar embeddings (based on business-brain querySimilar)
   */
  async function querySimilar(embedding, topK = 5, filters = {}, collectionName = defaultCollection) {
    const collectionId = await ensureCollection(collectionName)
    
    const body = {
      query_embeddings: [embedding],
      n_results: Math.max(Number(topK) || 5, 50), // Request more for better recall
      include: ["metadatas", "distances", "documents"],
    }
    
    dlog('[chroma] querySimilar request', { collectionId, topK, filters })
    
    try {
      const r = await withRetry(() => 
        client.post(`${baseUrl}/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${encodeURIComponent(collectionId)}/query`, body), 
        'chroma-query'
      )
      
      const ids = r.data?.ids?.[0] || []
      const distances = r.data?.distances?.[0] || []
      const metadatas = r.data?.metadatas?.[0] || []
      
      dlog('[chroma] querySimilar ok', { count: ids.length })
      
      let rows = ids.map((id, i) => ({ 
        id, 
        score: distances[i], 
        distance: distances[i], // Alias for clarity
        metadata: metadatas[i] || {},
        document: r.data?.documents?.[0]?.[i] || ''
      }))
      
      // Client-side filter (like business-brain)
      if (Object.keys(filters).length > 0) {
        rows = rows.filter(r => {
          const meta = r.metadata || {}
          return Object.keys(filters).every(key => {
            const filterValue = filters[key]
            const metaValue = meta[key]
            
            if (filterValue === undefined || filterValue === null) return true
            if (metaValue === undefined || metaValue === null) return false
            
            return String(metaValue) === String(filterValue)
          })
        })
      }
      
      // Sort by distance ascending (smaller is closer)
      rows.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
      
      return rows.slice(0, Number(topK) || 5)
    } catch (e) {
      if (e?.response?.status === 422 || e?.response?.status === 400) {
        dlog('[chroma] 422 on query, response:', e.response?.data)

        // Fallback: query without where, then client-filter
        const fallback = { ...body }
        dlog('[chroma] fallback query (no where)')
        
        const r2 = await withRetry(() => 
          client.post(`${baseUrl}/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${encodeURIComponent(collectionId)}/query`, fallback), 
          'chroma-query-fb'
        )
        
        const ids = r2.data?.ids?.[0] || []
        const distances = r2.data?.distances?.[0] || []
        const metadatas = r2.data?.metadatas?.[0] || []
        
        let rows = ids.map((id, i) => ({ 
          id, 
          score: distances[i], 
          distance: distances[i],
          metadata: metadatas[i] || {},
          document: r2.data?.documents?.[0]?.[i] || ''
        }))
        
        // Client-side filter
        if (Object.keys(filters).length > 0) {
          rows = rows.filter(r => {
            const meta = r.metadata || {}
            return Object.keys(filters).every(key => {
              const filterValue = filters[key]
              const metaValue = meta[key]
              
              if (filterValue === undefined || filterValue === null) return true
              if (metaValue === undefined || metaValue === null) return false
              
              return String(metaValue) === String(filterValue)
            })
          })
        }
        
        rows.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
        return rows.slice(0, Number(topK) || 5)
      }
      
      console.error('[chroma] querySimilar error', e.response?.status, e.response?.data || e.message)
      throw e
    }
  }

  /**
   * Delete embeddings by IDs
   */
  async function deleteByIds(ids, collectionName = defaultCollection) {
    if (!ids || ids.length === 0) return
    
    const collectionId = await ensureCollection(collectionName)
    await withRetry(() => 
      client.post(`${baseUrl}/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${encodeURIComponent(collectionId)}/delete`, {
        ids: Array.isArray(ids) ? ids : [ids]
      }), 
      'chroma-del-ids'
    )
  }

  /**
   * Delete embeddings by filters
   */
  async function deleteByFilters(filters, collectionName = defaultCollection) {
    const collectionId = await ensureCollection(collectionName)
    
    // Build Chroma where clause
    const where = {}
    Object.keys(filters).forEach(key => {
      where[key] = { "$eq": String(filters[key]) }
    })
    
    await withRetry(() => 
      client.post(`${baseUrl}/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${encodeURIComponent(collectionId)}/delete`, {
        where
      }), 
      'chroma-del-filters'
    )
  }

  /**
   * Health check
   */
  async function healthCheck() {
    const paths = ['/api/v1/heartbeat', '/api/v2/heartbeat']
    for (const p of paths) {
      try {
        await client.get(`${baseUrl}${p}`, { timeout: 8000 })
        return { status: 'healthy', url: baseUrl }
      } catch (e) {
        // try next API version
      }
    }
    return { status: 'unhealthy', url: baseUrl, error: 'heartbeat failed on v1 and v2' }
  }

  return {
    ensureCollection,
    addEmbedding,
    querySimilar,
    deleteByIds,
    deleteByFilters,
    healthCheck,
    // Expose connection info
    __baseUrl: baseUrl,
    __tenant: tenant,
    __database: database,
    __defaultCollection: defaultCollection,
  }
}

module.exports = createChromaAdapter

