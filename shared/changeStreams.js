const { EventEmitter } = require('events')

/**
 * Change Streams Manager
 * Provides real-time change notifications (MongoDB)
 */
class ChangeStreamsManager extends EventEmitter {
  constructor(modelApi) {
    super()
    this.modelApi = modelApi
    this.streams = new Map() // Track active streams
    this.enabled = false
  }

  /**
   * Check if change streams are supported
   */
  isSupported() {
    return this.modelApi.__backend === 'mongodb'
  }

  /**
   * Start watching for changes
   */
  async watch(options = {}) {
    if (!this.isSupported()) {
      throw new Error('Change streams are only supported for MongoDB')
    }

    const collectionName = this.modelApi.__collectionName
    const getCollection = this.modelApi.__adapterInstance?.getCollection

    if (!getCollection) {
      throw new Error('MongoDB collection access not available')
    }

    const collection = await getCollection(collectionName)

    // Build pipeline
    const pipeline = options.pipeline || []
    const watchOptions = {
      fullDocument: options.fullDocument || 'updateLookup',
      resumeAfter: options.resumeAfter,
      startAfter: options.startAfter,
      startAtOperationTime: options.startAtOperationTime,
    }

    // Create change stream
    const changeStream = collection.watch(pipeline, watchOptions)

    const streamId = `${collectionName}_${Date.now()}`
    this.streams.set(streamId, changeStream)

    // Handle change events
    changeStream.on('change', (change) => {
      this.handleChange(change)
    })

    changeStream.on('error', (error) => {
      this.emit('error', error)
    })

    changeStream.on('close', () => {
      this.streams.delete(streamId)
      this.emit('close', streamId)
    })

    this.enabled = true
    return changeStream
  }

  /**
   * Handle change event
   */
  handleChange(change) {
    const eventType = change.operationType
    const document = change.fullDocument || change.documentKey

    // Emit specific event types
    switch (eventType) {
      case 'insert':
        this.emit('insert', document)
        break
      case 'update':
        this.emit('update', {
          id: change.documentKey._id.toString(),
          document: change.fullDocument,
          updatedFields: change.updateDescription?.updatedFields,
          removedFields: change.updateDescription?.removedFields,
        })
        break
      case 'replace':
        this.emit('replace', change.fullDocument)
        break
      case 'delete':
        this.emit('delete', {
          id: change.documentKey._id.toString(),
        })
        break
      case 'invalidate':
        this.emit('invalidate')
        break
      default:
        this.emit('change', change)
    }

    // Emit generic change event
    this.emit('change', {
      type: eventType,
      document,
      change,
    })
  }

  /**
   * Watch for inserts
   */
  async watchInserts(callback) {
    const stream = await this.watch({
      pipeline: [{ $match: { operationType: 'insert' } }],
    })

    stream.on('change', (change) => {
      callback(change.fullDocument)
    })

    return stream
  }

  /**
   * Watch for updates
   */
  async watchUpdates(callback) {
    const stream = await this.watch({
      pipeline: [{ $match: { operationType: 'update' } }],
      fullDocument: 'updateLookup',
    })

    stream.on('change', (change) => {
      callback({
        id: change.documentKey._id.toString(),
        document: change.fullDocument,
        updatedFields: change.updateDescription?.updatedFields,
        removedFields: change.updateDescription?.removedFields,
      })
    })

    return stream
  }

  /**
   * Watch for deletes
   */
  async watchDeletes(callback) {
    const stream = await this.watch({
      pipeline: [{ $match: { operationType: 'delete' } }],
    })

    stream.on('change', (change) => {
      callback({
        id: change.documentKey._id.toString(),
      })
    })

    return stream
  }

  /**
   * Watch specific fields
   */
  async watchFields(fields, callback) {
    const fieldMatches = fields.map(field => ({
      'updateDescription.updatedFields': { $exists: true },
      [`updateDescription.updatedFields.${field}`]: { $exists: true },
    }))

    const stream = await this.watch({
      pipeline: [
        {
          $match: {
            $or: [
              { operationType: 'insert' },
              { operationType: 'update', $or: fieldMatches },
            ],
          },
        },
      ],
      fullDocument: 'updateLookup',
    })

    stream.on('change', (change) => {
      callback(change)
    })

    return stream
  }

  /**
   * Close all streams
   */
  async closeAll() {
    const closePromises = Array.from(this.streams.values()).map(stream => {
      return new Promise((resolve) => {
        stream.close(() => resolve())
      })
    })

    await Promise.all(closePromises)
    this.streams.clear()
    this.enabled = false
  }

  /**
   * Close a specific stream
   */
  async close(streamId) {
    const stream = this.streams.get(streamId)
    if (stream) {
      return new Promise((resolve) => {
        stream.close(() => {
          this.streams.delete(streamId)
          resolve()
        })
      })
    }
  }
}

module.exports = ChangeStreamsManager

