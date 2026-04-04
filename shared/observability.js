/**
 * Observability Manager
 * Provides query logging, metrics, and tracing
 */
class ObservabilityManager {
  constructor(options = {}) {
    this.enabled = options.enabled !== false
    this.logQueries = options.logQueries !== false
    this.logSlowQueries = options.logSlowQueries !== false
    this.slowQueryThreshold = options.slowQueryThreshold || 1000 // ms
    this.metrics = {
      queries: 0,
      slowQueries: 0,
      errors: 0,
      totalTime: 0,
      byOperation: {},
      byModel: {},
    }
    this.queryLog = []
    this.maxLogSize = options.maxLogSize || 1000
    this.traceEnabled = options.traceEnabled || false
  }

  /**
   * Enable/disable observability
   */
  enable(enabled = true) {
    this.enabled = enabled
    return this
  }

  /**
   * Log a query
   */
  logQuery(operation, modelName, query, params, duration, error = null) {
    if (!this.enabled) return

    const logEntry = {
      timestamp: new Date().toISOString(),
      operation,
      model: modelName,
      query: typeof query === 'string' ? query : JSON.stringify(query),
      params,
      duration,
      error: error ? error.message : null,
      slow: duration > this.slowQueryThreshold,
    }

    // Update metrics
    this.metrics.queries++
    this.metrics.totalTime += duration

    if (!this.metrics.byOperation[operation]) {
      this.metrics.byOperation[operation] = { count: 0, totalTime: 0 }
    }
    this.metrics.byOperation[operation].count++
    this.metrics.byOperation[operation].totalTime += duration

    if (!this.metrics.byModel[modelName]) {
      this.metrics.byModel[modelName] = { count: 0, totalTime: 0 }
    }
    this.metrics.byModel[modelName].count++
    this.metrics.byModel[modelName].totalTime += duration

    if (error) {
      this.metrics.errors++
    }

    if (logEntry.slow) {
      this.metrics.slowQueries++
      if (this.logSlowQueries) {
        console.warn(`[SLOW QUERY] ${operation} on ${modelName} took ${duration}ms`, query)
      }
    }

    // Add to log
    this.queryLog.push(logEntry)
    if (this.queryLog.length > this.maxLogSize) {
      this.queryLog.shift()
    }

    // Log query if enabled
    if (this.logQueries && !logEntry.slow) {
      console.log(`[QUERY] ${operation} on ${modelName} (${duration}ms)`)
    }
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      averageTime: this.metrics.queries > 0 
        ? this.metrics.totalTime / this.metrics.queries 
        : 0,
      byOperation: Object.entries(this.metrics.byOperation).reduce((acc, [op, stats]) => {
        acc[op] = {
          ...stats,
          averageTime: stats.count > 0 ? stats.totalTime / stats.count : 0,
        }
        return acc
      }, {}),
      byModel: Object.entries(this.metrics.byModel).reduce((acc, [model, stats]) => {
        acc[model] = {
          ...stats,
          averageTime: stats.count > 0 ? stats.totalTime / stats.count : 0,
        }
        return acc
      }, {}),
    }
  }

  /**
   * Get query log
   */
  getQueryLog(limit = null) {
    const log = limit ? this.queryLog.slice(-limit) : this.queryLog
    return log
  }

  /**
   * Get slow queries
   */
  getSlowQueries(limit = 100) {
    return this.queryLog
      .filter(entry => entry.slow)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, limit)
  }

  /**
   * Get errors
   */
  getErrors(limit = 100) {
    return this.queryLog
      .filter(entry => entry.error)
      .slice(-limit)
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      queries: 0,
      slowQueries: 0,
      errors: 0,
      totalTime: 0,
      byOperation: {},
      byModel: {},
    }
    this.queryLog = []
  }

  /**
   * Create a trace span
   */
  trace(operation, modelName, fn) {
    if (!this.traceEnabled) {
      return fn()
    }

    const start = Date.now()
    const span = {
      operation,
      model: modelName,
      start,
      end: null,
      duration: null,
    }

    return fn().then(
      (result) => {
        span.end = Date.now()
        span.duration = span.end - span.start
        this.logQuery(operation, modelName, null, null, span.duration)
        return result
      },
      (error) => {
        span.end = Date.now()
        span.duration = span.end - span.start
        this.logQuery(operation, modelName, null, null, span.duration, error)
        throw error
      }
    )
  }
}

module.exports = ObservabilityManager

