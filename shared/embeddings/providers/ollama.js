const axios = require('axios')
const BaseEmbeddingProvider = require('./base')

/**
 * Ollama embedding provider
 * Based on business-brain embeddingService.js patterns
 */
class OllamaProvider extends BaseEmbeddingProvider {
  constructor(config = {}) {
    super(config)
    this.url = (config.url || process.env.OLLAMA_EMBEDDING_URL || '').replace(/\/$/, '')
    this.model = (config.model || process.env.OLLAMA_EMBED_MODEL || 'embeddinggemma:latest').trim()
    this.dimensions = config.dimensions || 1024
    this.timeout = config.timeout || 30000
  }

  /**
   * Generate embedding for text
   * Handles multiple request formats like business-brain embeddingService
   */
  async embed(text) {
    if (!this.url) {
      throw new Error('Ollama URL not configured. Set url in config or OLLAMA_EMBEDDING_URL env var')
    }

    const tryRequest = async (payload) => {
      const r = await axios.post(`${this.url}/api/embeddings`, payload, { timeout: this.timeout })
      const vec = r.data?.embedding || (Array.isArray(r.data?.embeddings) ? r.data.embeddings[0] : [])
      return Array.isArray(vec) ? vec : []
    }

    try {
      // Prefer 'prompt' first (works on some Ollama builds); then fall back to 'input'
      let vec = await tryRequest({ model: this.model, prompt: text })
      if (!vec || vec.length === 0) vec = await tryRequest({ model: this.model, input: text })
      if (!vec || vec.length === 0) vec = await tryRequest({ model: this.model, input: [text] })
      
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error(`empty embedding from model ${this.model}`)
      }
      
      return vec
    } catch (e) {
      const status = e?.response?.status
      const data = e?.response?.data
      console.warn('[OllamaProvider] embed failed:', status, data || e.message)
      
      // Fallback to zero vector (like business-brain)
      return Array.from({ length: this.dimensions }, () => 0)
    }
  }

  /**
   * Get dimensions for this provider/model
   */
  getDimensions() {
    return this.dimensions
  }
}

module.exports = OllamaProvider

