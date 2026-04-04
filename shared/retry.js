/**
 * Retry Manager
 * Provides automatic retry with exponential backoff
 */
class RetryManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3
    this.initialDelay = options.initialDelay || 1000 // 1 second
    this.maxDelay = options.maxDelay || 30000 // 30 seconds
    this.multiplier = options.multiplier || 2
    this.retryableErrors = options.retryableErrors || [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
    ]
  }

  /**
   * Check if error is retryable
   */
  isRetryable(error) {
    if (!error) return false

    const errorCode = error.code || error.name || ''
    const errorMessage = error.message || ''

    // Check error code
    if (this.retryableErrors.some(code => 
      errorCode.includes(code) || errorMessage.includes(code)
    )) {
      return true
    }

    // Check for connection errors
    if (errorMessage.includes('connection') || 
        errorMessage.includes('timeout') ||
        errorMessage.includes('network')) {
      return true
    }

    return false
  }

  /**
   * Calculate delay for retry attempt
   */
  calculateDelay(attempt) {
    const delay = Math.min(
      this.initialDelay * Math.pow(this.multiplier, attempt),
      this.maxDelay
    )
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.3 * delay
    return delay + jitter
  }

  /**
   * Retry a function with exponential backoff
   */
  async retry(fn, options = {}) {
    const maxRetries = options.maxRetries || this.maxRetries
    let lastError

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error

        // Don't retry on last attempt
        if (attempt >= maxRetries) {
          break
        }

        // Check if error is retryable
        if (!this.isRetryable(error)) {
          throw error
        }

        // Calculate delay
        const delay = this.calculateDelay(attempt)

        // Wait before retry
        await this.sleep(delay)

        // Log retry attempt
        if (options.onRetry) {
          options.onRetry(attempt + 1, error, delay)
        }
      }
    }

    throw lastError
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

module.exports = RetryManager

