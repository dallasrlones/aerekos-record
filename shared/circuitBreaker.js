/**
 * Circuit Breaker
 * Provides circuit breaker pattern for resilience
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeout = options.resetTimeout || 60000 // 1 minute
    this.monitoringWindow = options.monitoringWindow || 60000 // 1 minute
    this.state = 'CLOSED' // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureTime = null
    this.lastStateChange = Date.now()
    this.failures = [] // Track failures in time window
  }

  /**
   * Get current state
   */
  getState() {
    return this.state
  }

  /**
   * Check if circuit is open
   */
  isOpen() {
    return this.state === 'OPEN'
  }

  /**
   * Check if circuit is closed
   */
  isClosed() {
    return this.state === 'CLOSED'
  }

  /**
   * Check if circuit is half-open
   */
  isHalfOpen() {
    return this.state === 'HALF_OPEN'
  }

  /**
   * Record success
   */
  recordSuccess() {
    this.successCount++
    this.failures = this.failures.filter(
      f => Date.now() - f < this.monitoringWindow
    )

    if (this.state === 'HALF_OPEN') {
      // If we get a success in half-open, close the circuit
      this.state = 'CLOSED'
      this.failureCount = 0
      this.successCount = 0
      this.lastStateChange = Date.now()
    }
  }

  /**
   * Record failure
   */
  recordFailure() {
    const now = Date.now()
    this.failureCount++
    this.lastFailureTime = now
    this.failures.push(now)

    // Clean old failures outside monitoring window
    this.failures = this.failures.filter(
      f => now - f < this.monitoringWindow
    )

    // Check if we should open the circuit
    if (this.failures.length >= this.failureThreshold) {
      if (this.state === 'CLOSED' || this.state === 'HALF_OPEN') {
        this.state = 'OPEN'
        this.lastStateChange = now
      }
    }
  }

  /**
   * Check if we should attempt (for half-open state)
   */
  shouldAttempt() {
    if (this.state === 'CLOSED') {
      return true
    }

    if (this.state === 'OPEN') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime
      if (timeSinceLastFailure >= this.resetTimeout) {
        // Transition to half-open
        this.state = 'HALF_OPEN'
        this.lastStateChange = Date.now()
        return true
      }
      return false
    }

    if (this.state === 'HALF_OPEN') {
      return true
    }

    return false
  }

  /**
   * Execute function with circuit breaker
   */
  async execute(fn, fallback = null) {
    if (!this.shouldAttempt()) {
      if (fallback) {
        return fallback()
      }
      throw new Error('Circuit breaker is OPEN')
    }

    try {
      const result = await fn()
      this.recordSuccess()
      return result
    } catch (error) {
      this.recordFailure()
      if (fallback) {
        return fallback(error)
      }
      throw error
    }
  }

  /**
   * Reset circuit breaker
   */
  reset() {
    this.state = 'CLOSED'
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureTime = null
    this.lastStateChange = Date.now()
    this.failures = []
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      failuresInWindow: this.failures.length,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
      timeSinceLastFailure: this.lastFailureTime 
        ? Date.now() - this.lastFailureTime 
        : null,
    }
  }
}

module.exports = CircuitBreaker

