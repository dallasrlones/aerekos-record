const BaseEmbeddingProvider = require('./base')
const OllamaProvider = require('./ollama')

/**
 * Factory for creating embedding providers
 */
const PROVIDERS = {
  ollama: OllamaProvider,
  // Future providers can be added here
  // openai: OpenAIProvider,
  // sentenceTransformers: SentenceTransformersProvider,
}

/**
 * Create an embedding provider
 * @param {string} providerType - Provider type: 'ollama', 'openai', etc.
 * @param {object} config - Provider configuration
 * @returns {BaseEmbeddingProvider} Provider instance
 */
function createEmbeddingProvider(providerType, config = {}) {
  const ProviderClass = PROVIDERS[providerType.toLowerCase()]
  
  if (!ProviderClass) {
    throw new Error(`Unknown embedding provider: ${providerType}. Supported: ${Object.keys(PROVIDERS).join(', ')}`)
  }
  
  return new ProviderClass(config)
}

/**
 * Register a custom provider
 * @param {string} name - Provider name
 * @param {class} ProviderClass - Provider class extending BaseEmbeddingProvider
 */
function registerProvider(name, ProviderClass) {
  if (!ProviderClass.prototype instanceof BaseEmbeddingProvider) {
    throw new Error('Provider must extend BaseEmbeddingProvider')
  }
  PROVIDERS[name.toLowerCase()] = ProviderClass
}

module.exports = {
  createEmbeddingProvider,
  registerProvider,
  PROVIDERS,
  BaseEmbeddingProvider,
}

