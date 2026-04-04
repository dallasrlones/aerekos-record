/**
 * Base class for embedding providers
 */
class BaseEmbeddingProvider {
  constructor(config = {}) {
    this.config = config
  }

  /**
   * Generate embedding for text
   * @param {string|string[]} text - Text or array of texts to embed
   * @returns {Promise<number[]|number[][]>} Embedding vector(s)
   */
  async embed(text) {
    throw new Error('embed() must be implemented by provider')
  }

  /**
   * Get dimensions for this provider/model
   * @returns {number} Vector dimensions
   */
  getDimensions() {
    throw new Error('getDimensions() must be implemented by provider')
  }
}

module.exports = BaseEmbeddingProvider

