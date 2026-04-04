const AerekosStorage = require('../aerekos-storage/aerekosSdk')
const { randomUUID } = require('node:crypto')

/**
 * Attachment Manager
 * Provides Rails Active Storage-like functionality with has_one_attached and has_many_attached
 */
class AttachmentManager {
  constructor(modelApi, attachmentName, options = {}) {
    this.modelApi = modelApi
    this.attachmentName = attachmentName
    this.options = {
      bucketId: options.bucketId || null, // Can be per-model or per-attachment
      projectId: options.projectId || null, // From model or options
      secret: options.secret || null, // From model or options
      service: options.service || null, // Pre-configured storage service
      ...options,
    }
    this.storage = null
  }

  /**
   * Get or create storage service
   */
  async getStorage(record = null) {
    if (this.storage) {
      return this.storage
    }

    // Use provided service or create new one
    if (this.options.service) {
      this.storage = this.options.service
      return this.storage
    }

    // Get project credentials from model, options, or record's project
    let projectId = this.options.projectId || this.modelApi.__projectId
    let secret = this.options.secret || this.modelApi.__secret

    // If not set, try to get from record's project association
    if ((!projectId || !secret) && record) {
      try {
        // Try to get project from belongsTo association
        if (record.project && typeof record.project.get === 'function') {
          const project = await record.project.get()
          if (project) {
            projectId = projectId || project.projectId
            secret = secret || project.secret
          }
        }
      } catch (error) {
        // Ignore errors, will throw below if still missing
      }
    }

    if (!projectId || !secret) {
      throw new Error(`Project credentials required for attachment '${this.attachmentName}'. Set projectId and secret in model settings, attachment options, or ensure record has a project association.`)
    }

    this.storage = new AerekosStorage({
      projectId,
      secret,
      apiBase: this.options.apiBase,
      chunkSize: this.options.chunkSize,
    })

    return this.storage
  }

  /**
   * Get bucket ID for this attachment
   */
  async getBucketId(record) {
    // Check options first
    if (this.options.bucketId) {
      return this.options.bucketId
    }

    // Check if bucketId is stored on the record
    const bucketIdField = `${this.attachmentName}BucketId`
    if (record[bucketIdField]) {
      return record[bucketIdField]
    }

    // Use default bucket from model
    if (this.modelApi.__defaultBucketId) {
      return this.modelApi.__defaultBucketId
    }

    // Try to get from record's project association
    if (record) {
      try {
        if (record.project && typeof record.project.get === 'function') {
          const project = await record.project.get()
          if (project && project.defaultBucketId) {
            return project.defaultBucketId
          }
        }
      } catch (error) {
        // Ignore errors
      }
    }

    throw new Error(`Bucket ID required for attachment '${this.attachmentName}'. Set bucketId in attachment options, model settings, or ensure record's project has defaultBucketId.`)
  }

  /**
   * Get attachment metadata field name
   */
  getMetadataField() {
    return `${this.attachmentName}Attachment`
  }

  /**
   * Attach a file (has_one_attached)
   */
  async attach(record, fileData, options = {}) {
    const bucketId = await this.getBucketId(record)
    const storage = await this.getStorage(record)

    const fileId = options.fileId || randomUUID()
    const originalFilename = options.filename || options.originalFilename || fileId
    const contentType = options.contentType || 'application/octet-stream'

    // Upload file
    const uploadResult = await storage.uploadFile(bucketId, fileId, fileData, {
      contentType,
      originalFilename,
      ttlSeconds: options.ttlSeconds || 3600,
      useChunkedUpload: options.useChunkedUpload,
      fileSize: options.fileSize,
    })

    // Get file metadata
    const metadata = await storage.fetchBucketItem(bucketId, uploadResult.fileId)

    // Store attachment metadata on record
    const metadataField = this.getMetadataField()
    const attachmentData = {
      fileId: uploadResult.fileId,
      bucketId,
      originalFilename: metadata.originalFilename || originalFilename,
      contentType: metadata.contentType || contentType,
      size: metadata.size || metadata.originalSize || 0,
      uploadedAt: metadata.uploadedAt || new Date().toISOString(),
      ...options.metadata,
    }

    // Update record with attachment info
    const updateData = {
      [metadataField]: JSON.stringify(attachmentData),
    }

    // Also store bucketId if not already set
    const bucketIdField = `${this.attachmentName}BucketId`
    if (!record[bucketIdField]) {
      updateData[bucketIdField] = bucketId
    }

    await this.modelApi.update(record.id, updateData)

    return attachmentData
  }

  /**
   * Detach file (has_one_attached)
   */
  async detach(record) {
    const attachment = this.getAttachment(record)
    if (!attachment) {
      return null
    }

    const storage = await this.getStorage(record)
    await storage.deleteFile(attachment.bucketId, attachment.fileId)

    // Clear attachment metadata
    const metadataField = this.getMetadataField()
    const bucketIdField = `${this.attachmentName}BucketId`
    
    await this.modelApi.update(record.id, {
      [metadataField]: null,
      [bucketIdField]: null,
    })

    return true
  }

  /**
   * Get attachment metadata
   */
  getAttachment(record) {
    const metadataField = this.getMetadataField()
    const attachmentData = record[metadataField]

    if (!attachmentData) {
      return null
    }

    try {
      return typeof attachmentData === 'string' ? JSON.parse(attachmentData) : attachmentData
    } catch {
      return attachmentData
    }
  }

  /**
   * Check if attached
   */
  attached(record) {
    return this.getAttachment(record) !== null
  }

  /**
   * Get signed URL for download
   */
  async url(record, options = {}) {
    const attachment = this.getAttachment(record)
    if (!attachment) {
      return null
    }

    const storage = await this.getStorage(record)
    const signedUrlData = await storage.createSignedUrl(
      attachment.bucketId,
      attachment.fileId,
      'GET',
      {
        ttlSeconds: options.ttlSeconds || 3600,
      }
    )

    return signedUrlData.signedUrl
  }

  /**
   * Download file
   */
  async download(record, options = {}) {
    const attachment = this.getAttachment(record)
    if (!attachment) {
      return null
    }

    const storage = await this.getStorage(record)
    return storage.downloadFile(attachment.bucketId, attachment.fileId, options)
  }

  /**
   * Get file metadata
   */
  async metadata(record) {
    const attachment = this.getAttachment(record)
    if (!attachment) {
      return null
    }

    const storage = await this.getStorage(record)
    return storage.fetchBucketItem(attachment.bucketId, attachment.fileId)
  }
}

/**
 * Multiple Attachments Manager (has_many_attached)
 */
class AttachmentsManager {
  constructor(modelApi, attachmentName, options = {}) {
    this.modelApi = modelApi
    this.attachmentName = attachmentName
    this.options = {
      bucketId: options.bucketId || null,
      projectId: options.projectId || null,
      secret: options.secret || null,
      service: options.service || null,
      ...options,
    }
    this.storage = null
  }

  async getStorage(record = null) {
    if (this.storage) {
      return this.storage
    }

    if (this.options.service) {
      this.storage = this.options.service
      return this.storage
    }

    let projectId = this.options.projectId || this.modelApi.__projectId
    let secret = this.options.secret || this.modelApi.__secret

    // Try to get from record's project association
    if ((!projectId || !secret) && record) {
      try {
        if (record.project && typeof record.project.get === 'function') {
          const project = await record.project.get()
          if (project) {
            projectId = projectId || project.projectId
            secret = secret || project.secret
          }
        }
      } catch (error) {
        // Ignore errors
      }
    }

    if (!projectId || !secret) {
      throw new Error(`Project credentials required for attachments '${this.attachmentName}'. Set projectId and secret in model settings, attachment options, or ensure record has a project association.`)
    }

    this.storage = new AerekosStorage({
      projectId,
      secret,
      apiBase: this.options.apiBase,
      chunkSize: this.options.chunkSize,
    })

    return this.storage
  }

  async getBucketId(record) {
    if (this.options.bucketId) {
      return this.options.bucketId
    }

    const bucketIdField = `${this.attachmentName}BucketId`
    if (record[bucketIdField]) {
      return record[bucketIdField]
    }

    if (this.modelApi.__defaultBucketId) {
      return this.modelApi.__defaultBucketId
    }

    // Try to get from record's project association
    if (record) {
      try {
        if (record.project && typeof record.project.get === 'function') {
          const project = await record.project.get()
          if (project && project.defaultBucketId) {
            return project.defaultBucketId
          }
        }
      } catch (error) {
        // Ignore errors
      }
    }

    throw new Error(`Bucket ID required for attachments '${this.attachmentName}'. Set bucketId in attachment options, model settings, or ensure record's project has defaultBucketId.`)
  }

  getAttachmentsField() {
    return `${this.attachmentName}Attachments`
  }

  /**
   * Attach multiple files
   */
  async attach(record, fileDataArray, options = {}) {
    const bucketId = await this.getBucketId(record)
    const storage = await this.getStorage(record)

    const attachments = []
    const fileDataList = Array.isArray(fileDataArray) ? fileDataArray : [fileDataArray]

    for (const fileData of fileDataList) {
      const fileId = options.fileId || randomUUID()
      const originalFilename = options.filename || options.originalFilename || fileId
      const contentType = options.contentType || 'application/octet-stream'

      const uploadResult = await storage.uploadFile(bucketId, fileId, fileData, {
        contentType,
        originalFilename,
        ttlSeconds: options.ttlSeconds || 3600,
        useChunkedUpload: options.useChunkedUpload,
        fileSize: options.fileSize,
      })

      const metadata = await storage.fetchBucketItem(bucketId, uploadResult.fileId)

      attachments.push({
        fileId: uploadResult.fileId,
        bucketId,
        originalFilename: metadata.originalFilename || originalFilename,
        contentType: metadata.contentType || contentType,
        size: metadata.size || metadata.originalSize || 0,
        uploadedAt: metadata.uploadedAt || new Date().toISOString(),
      })
    }

    // Get existing attachments
    const existingAttachments = this.getAttachments(record) || []
    const allAttachments = [...existingAttachments, ...attachments]

    // Update record
    const attachmentsField = this.getAttachmentsField()
    const bucketIdField = `${this.attachmentName}BucketId`

    const updateData = {
      [attachmentsField]: JSON.stringify(allAttachments),
    }

    if (!record[bucketIdField]) {
      updateData[bucketIdField] = bucketId
    }

    await this.modelApi.update(record.id, updateData)

    return attachments
  }

  /**
   * Detach file(s)
   */
  async detach(record, fileIds = null) {
    const attachments = this.getAttachments(record)
    if (!attachments || attachments.length === 0) {
      return []
    }

    const storage = await this.getStorage(record)
    const fileIdsToRemove = fileIds 
      ? (Array.isArray(fileIds) ? fileIds : [fileIds])
      : attachments.map(a => a.fileId)

    // Delete files
    const deleted = []
    for (const attachment of attachments) {
      if (fileIdsToRemove.includes(attachment.fileId)) {
        await storage.deleteFile(attachment.bucketId, attachment.fileId)
        deleted.push(attachment.fileId)
      }
    }

    // Update record
    const remainingAttachments = attachments.filter(
      a => !fileIdsToRemove.includes(a.fileId)
    )

    const attachmentsField = this.getAttachmentsField()
    await this.modelApi.update(record.id, {
      [attachmentsField]: remainingAttachments.length > 0 
        ? JSON.stringify(remainingAttachments) 
        : null,
    })

    return deleted
  }

  /**
   * Get all attachments
   */
  getAttachments(record) {
    const attachmentsField = this.getAttachmentsField()
    const attachmentsData = record[attachmentsField]

    if (!attachmentsData) {
      return []
    }

    try {
      const parsed = typeof attachmentsData === 'string' 
        ? JSON.parse(attachmentsData) 
        : attachmentsData
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /**
   * Check if any attached
   */
  attached(record) {
    const attachments = this.getAttachments(record)
    return attachments.length > 0
  }

  /**
   * Get URLs for all attachments
   */
  async urls(record, options = {}) {
    const attachments = this.getAttachments(record)
    if (attachments.length === 0) {
      return []
    }

    const storage = await this.getStorage(record)
    const urls = []

    for (const attachment of attachments) {
      const signedUrlData = await storage.createSignedUrl(
        attachment.bucketId,
        attachment.fileId,
        'GET',
        { ttlSeconds: options.ttlSeconds || 3600 }
      )
      urls.push({
        fileId: attachment.fileId,
        url: signedUrlData.signedUrl,
        ...attachment,
      })
    }

    return urls
  }

  /**
   * Purge all attachments
   */
  async purge(record) {
    return this.detach(record)
  }
}

module.exports = { AttachmentManager, AttachmentsManager }

