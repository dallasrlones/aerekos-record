const { Readable } = require('stream')

/**
 * Streaming Manager
 * Provides streaming capabilities for large result sets
 */
class StreamingManager {
  constructor(modelApi) {
    this.modelApi = modelApi
    this.chunkSize = 100 // Records per chunk
  }

  /**
   * Set chunk size
   */
  setChunkSize(size) {
    this.chunkSize = size
    return this
  }

  /**
   * Create a readable stream for query results
   */
  createStream(options = {}) {
    const chunkSize = options.chunkSize || this.chunkSize
    let offset = 0
    let hasMore = true

    const stream = new Readable({
      objectMode: true,
      async read() {
        if (!hasMore) {
          this.push(null) // End stream
          return
        }

        try {
          const results = await this.modelApi.findAll({
            ...options,
            limit: chunkSize,
            offset: offset,
          })

          if (results.length === 0) {
            hasMore = false
            this.push(null)
            return
          }

          // Push results
          for (const result of results) {
            this.push(result)
          }

          offset += results.length

          // Check if we have more
          if (results.length < chunkSize) {
            hasMore = false
            this.push(null)
          }
        } catch (error) {
          this.destroy(error)
        }
      },
    })

    return stream
  }

  /**
   * Stream results and process with callback
   */
  async stream(options, callback) {
    const stream = this.createStream(options)
    
    return new Promise((resolve, reject) => {
      stream.on('data', async (chunk) => {
        try {
          await callback(chunk)
        } catch (error) {
          stream.destroy(error)
          reject(error)
        }
      })

      stream.on('end', () => {
        resolve()
      })

      stream.on('error', (error) => {
        reject(error)
      })
    })
  }

  /**
   * Stream and collect results
   */
  async streamCollect(options, limit = null) {
    const results = []
    let count = 0

    await this.stream(options, (chunk) => {
      if (limit && count >= limit) {
        return
      }
      results.push(chunk)
      count++
    })

    return results
  }
}

module.exports = StreamingManager

