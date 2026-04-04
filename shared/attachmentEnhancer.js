const { AttachmentManager, AttachmentsManager } = require('./attachments')

/**
 * Enhance model with attachment capabilities
 */
function enhanceModelWithAttachments(modelApi, registry) {
  // Store registry for access
  if (!modelApi.__attachmentRegistry) {
    modelApi.__attachmentRegistry = new Map()
    modelApi.__attachmentFactories = []
  }

  /**
   * Define has_one_attached
   */
  modelApi.hasOneAttached = function(attachmentName, options = {}) {
    const manager = new AttachmentManager(this, attachmentName, {
      ...options,
      projectId: options.projectId || this.__projectId,
      secret: options.secret || this.__secret,
    })
    
    this.__attachmentRegistry.set(attachmentName, {
      type: 'has_one',
      manager,
    })

    // Create factory function (similar to associations)
    this.__attachmentFactories.push((instance) => {
      return {
        [attachmentName]: {
          attach: async (fileData, attachOptions) => {
            return manager.attach(instance, fileData, attachOptions)
          },
          detach: async () => {
            return manager.detach(instance)
          },
          attached: () => {
            return manager.attached(instance)
          },
          url: async (urlOptions) => {
            return manager.url(instance, urlOptions)
          },
          download: async (downloadOptions) => {
            return manager.download(instance, downloadOptions)
          },
          metadata: async () => {
            return manager.metadata(instance)
          },
          get: () => {
            return manager.getAttachment(instance)
          },
        },
      }
    })

    return this
  }

  /**
   * Define has_many_attached
   */
  modelApi.hasManyAttached = function(attachmentName, options = {}) {
    const manager = new AttachmentsManager(this, attachmentName, {
      ...options,
      projectId: options.projectId || this.__projectId,
      secret: options.secret || this.__secret,
    })
    
    this.__attachmentRegistry.set(attachmentName, {
      type: 'has_many',
      manager,
    })

    // Create factory function
    this.__attachmentFactories.push((instance) => {
      return {
        [attachmentName]: {
          attach: async (fileDataArray, attachOptions) => {
            return manager.attach(instance, fileDataArray, attachOptions)
          },
          detach: async (fileIds) => {
            return manager.detach(instance, fileIds)
          },
          purge: async () => {
            return manager.purge(instance)
          },
          attached: () => {
            return manager.attached(instance)
          },
          urls: async (urlOptions) => {
            return manager.urls(instance, urlOptions)
          },
          get: () => {
            return manager.getAttachments(instance)
          },
          count: () => {
            return manager.getAttachments(instance).length
          },
        },
      }
    })

    return this
  }

  return modelApi
}

/**
 * Apply attachments to instance (called from buildInstance)
 */
function applyAttachmentsToInstance(modelApi, instance) {
  if (!modelApi.__attachmentFactories || modelApi.__attachmentFactories.length === 0) {
    return {}
  }

  const attachments = modelApi.__attachmentFactories.reduce((acc, factory) => {
    const proxy = factory(instance)
    return { ...acc, ...proxy }
  }, {})

  return attachments
}

module.exports = { enhanceModelWithAttachments, applyAttachmentsToInstance }

