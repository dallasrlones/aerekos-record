const axios = require('axios');

// Try to load utils, fallback to inline if not available
let NotFoundError, ValidationError, BadRequestError, logger

try {
  const utils = require('../utils/errors')
  NotFoundError = utils.NotFoundError
  ValidationError = utils.ValidationError
  BadRequestError = utils.BadRequestError
} catch {
  NotFoundError = class NotFoundError extends Error {
    constructor(message) {
      super(message)
      this.name = 'NotFoundError'
    }
  }
  ValidationError = class ValidationError extends Error {
    constructor(message) {
      super(message)
      this.name = 'ValidationError'
    }
  }
  BadRequestError = class BadRequestError extends Error {
    constructor(message) {
      super(message)
      this.name = 'BadRequestError'
    }
  }
}

try {
  logger = require('../utils/logger')
} catch {
  logger = {
    async error(message, data = {}) {
      console.error(`[Aerekos Storage] ${message}`, data)
    },
    async warn(message, data = {}) {
      console.warn(`[Aerekos Storage] ${message}`, data)
    },
    async info(message, data = {}) {
      console.log(`[Aerekos Storage] ${message}`, data)
    },
  }
}

/**
 * Aerekos Storage SDK
 * 
 * Environment Variables:
 * - AEREKOS_STORAGE_API_BASE: Base URL for hosting service (default: https://storage.aerekos.com)
 * - AEREKOS_STORAGE_TOKEN: Full token (projectId:secret) - OR use separate PROJECT_ID and SECRET
 * - AEREKOS_STORAGE_PROJECT_ID: Project UUID (if not using full token)
 * - AEREKOS_STORAGE_SECRET: Project secret key (if not using full token)
 * - AEREKOS_STORAGE_CHUNK_SIZE: Chunk size for chunked uploads in bytes (default: 5MB)
 */
class AerekosStorage {
    constructor(config = {}) {
        // Get config from env vars or constructor
        this.apiBase = config.apiBase || process.env.AEREKOS_STORAGE_API_BASE || 'https://storage.aerekos.com';
        this.chunkSize = config.chunkSize || parseInt(process.env.AEREKOS_STORAGE_CHUNK_SIZE || '5242880', 10); // 5MB default
        
        // Support full token OR separate projectId/secret
        const fullToken = config.token || process.env.AEREKOS_STORAGE_TOKEN;
        
        if (fullToken) {
            // If full token provided, split it
            const [projectId, secret] = fullToken.split(':');
            if (!projectId || !secret) {
                throw new ValidationError('Invalid token format. Expected: projectId:secret');
            }
            this.projectId = projectId;
            this.secret = secret;
        } else {
            // Otherwise use separate projectId and secret
            this.projectId = config.projectId || process.env.AEREKOS_STORAGE_PROJECT_ID;
            this.secret = config.secret || process.env.AEREKOS_STORAGE_SECRET;
        }
        
        if (!this.projectId || !this.secret) {
            throw new ValidationError('Either AEREKOS_STORAGE_TOKEN (full token) or both AEREKOS_STORAGE_PROJECT_ID and AEREKOS_STORAGE_SECRET must be set');
        }
        
        this.token = `${this.projectId}:${this.secret}`;
    }
    
    /**
     * Create a signed URL for file operations
     * @param {string} bucketId - Bucket ID
     * @param {string} fileId - File ID (optional for PUT, will be generated)
     * @param {string} method - HTTP method (GET, PUT, DELETE)
     * @param {Object} options - Options
     * @param {number} options.ttlSeconds - Time to live in seconds (default: 3600)
     * @param {string} options.originalFilename - Original filename (for PUT)
     * @returns {Promise<Object>} Signed URL response
     */
    async createSignedUrl(bucketId, fileId = null, method = 'GET', options = {}) {
        const { ttlSeconds = 3600, originalFilename = null } = options;
        
        try {
            const response = await axios.post(
                `${this.apiBase}/api/projects/${this.projectId}/buckets/${bucketId}/signed-url`,
                {
                    fileId,
                    method: method.toUpperCase(),
                    ttlSeconds,
                    originalFilename
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 300000 // 5 minute timeout (300 seconds)
                }
            );
            
            return response.data;
        } catch (error) {
            // Handle different types of errors
            let errorMessage;
            if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
                errorMessage = 'Request timeout';
            } else if (error.response?.status) {
                errorMessage = `Request failed with status code ${error.response.status}`;
                if (error.response.status === 524) {
                    errorMessage += ' (Cloudflare timeout)';
                }
            } else if (error.message) {
                errorMessage = error.message;
            } else {
                errorMessage = 'Unknown error';
            }
            
            await logger.error('Aerekos SDK createSignedUrl error', {
                code: error.code,
                status: error.response?.status,
                bucketId,
                fileId,
                error: errorMessage
            });
            
            throw new BadRequestError(`Failed to create signed URL: ${errorMessage}`);
        }
    }
    
    /**
     * List all buckets for the project
     * @returns {Promise<Array>} Array of bucket objects with bucketId
     */
    async listBuckets() {
        try {
            const response = await axios.get(
                `${this.apiBase}/api/projects/${this.projectId}/buckets`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            return response.data.buckets || [];
        } catch (error) {
            await logger.error('Failed to list buckets', { error: error.response?.data?.message || error.message });
            throw new BadRequestError(`Failed to list buckets: ${error.response?.data?.message || error.message}`);
        }
    }
    
    /**
     * Delete a bucket and all its contents
     * @param {string} bucketId - Bucket ID to delete
     * @returns {Promise<Object>} Delete result
     */
    async deleteBucket(bucketId) {
        try {
            const response = await axios.delete(
                `${this.apiBase}/api/projects/${this.projectId}/buckets/${bucketId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            return {
                success: true,
                projectId: response.data.projectId,
                bucketId: response.data.bucketId || bucketId,
                message: response.data.message || 'Bucket deleted successfully'
            };
        } catch (error) {
            await logger.error('Failed to delete bucket', { bucketId, error: error.response?.data?.message || error.message });
            throw new BadRequestError(`Failed to delete bucket: ${error.response?.data?.message || error.message}`);
        }
    }
    
    /**
     * List items in a bucket with paging, sorting, and filtering
     * @param {string} bucketId - Bucket ID
     * @param {Object} options - List options
     * @param {number} options.limit - Number of items per page (default: 50, max: 1000)
     * @param {string} options.marker - Pagination marker (for next page)
     * @param {string} options.sortBy - Sort field (default: 'name')
     * @param {string} options.sortOrder - Sort order: 'asc' or 'desc' (default: 'asc')
     * @param {string} options.filter - Filter by filename pattern (optional)
     * @returns {Promise<Object>} List result with files array and pagination info
     */
    async listBucketItems(bucketId, options = {}) {
        const {
            limit = 50,
            marker = null,
            sortBy = 'name',
            sortOrder = 'asc',
            filter = null
        } = options;
        
        try {
            const params = new URLSearchParams();
            if (limit) params.append('limit', Math.min(limit, 1000).toString());
            if (marker) params.append('marker', marker);
            
            const response = await axios.get(
                `${this.apiBase}/api/projects/${this.projectId}/buckets/${bucketId}/files?${params.toString()}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            // Sort and filter client-side if server doesn't support it
            let files = response.data.files || [];
            
            // Apply client-side filtering if filter provided
            if (filter) {
                const filterRegex = new RegExp(filter.replace(/\*/g, '.*'), 'i');
                files = files.filter(file => 
                    filterRegex.test(file.originalFilename || file.fileId)
                );
            }
            
            // Apply client-side sorting if needed
            if (sortBy && sortOrder) {
                files.sort((a, b) => {
                    let aVal, bVal;
                    
                    switch (sortBy) {
                        case 'name':
                            aVal = (a.originalFilename || a.fileId || '').toLowerCase();
                            bVal = (b.originalFilename || b.fileId || '').toLowerCase();
                            break;
                        case 'size':
                            aVal = a.originalSize || 0;
                            bVal = b.originalSize || 0;
                            break;
                        case 'date':
                        case 'createdAt':
                        case 'uploadedAt':
                            aVal = new Date(a.uploadedAt || a.createdAt || 0).getTime();
                            bVal = new Date(b.uploadedAt || b.createdAt || 0).getTime();
                            break;
                        default:
                            aVal = a[sortBy] || '';
                            bVal = b[sortBy] || '';
                    }
                    
                    if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
                    if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
                    return 0;
                });
            }
            
            return {
                files,
                hasMore: response.data.hasMore || false,
                nextMarker: response.data.nextMarker || null,
                bucketId: response.data.bucketId,
                projectId: response.data.projectId
            };
        } catch (error) {
            await logger.error('Failed to list bucket items', { bucketId, error: error.response?.data?.message || error.message });
            throw new BadRequestError(`Failed to list bucket items: ${error.response?.data?.message || error.message}`);
        }
    }
    
    /**
     * Fetch a single bucket item (file metadata)
     * @param {string} bucketId - Bucket ID
     * @param {string} fileId - File ID
     * @returns {Promise<Object>} File metadata
     */
    async fetchBucketItem(bucketId, fileId) {
        try {
            const response = await axios.get(
                `${this.apiBase}/api/projects/${this.projectId}/buckets/${bucketId}/files/${fileId}/metadata`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            return response.data;
        } catch (error) {
            if (error.response?.status === 404) {
                await logger.error('File not found', { bucketId, fileId });
                throw new NotFoundError(`File not found: ${fileId}`);
            }
            await logger.error('Failed to fetch bucket item', { bucketId, fileId, error: error.response?.data?.message || error.message });
            throw new BadRequestError(`Failed to fetch bucket item: ${error.response?.data?.message || error.message}`);
        }
    }
    
    /**
     * Delete a bucket item (file)
     * @param {string} bucketId - Bucket ID
     * @param {string} fileId - File ID
     * @returns {Promise<Object>} Delete result
     */
    async deleteBucketItem(bucketId, fileId) {
        try {
            // Generate signed DELETE URL
            const signedUrlData = await this.createSignedUrl(bucketId, fileId, 'DELETE');
            
            const response = await axios.delete(signedUrlData.signedUrl);
            
            return {
                success: true,
                projectId: response.data.projectId,
                bucketId: response.data.bucketId,
                fileId: response.data.fileId,
                message: response.data.message || 'File deleted successfully'
            };
        } catch (error) {
            await logger.error('Failed to delete bucket item', { bucketId, fileId, error: error.response?.data?.message || error.message });
            throw new BadRequestError(`Failed to delete bucket item: ${error.response?.data?.message || error.message}`);
        }
    }
    
    /**
     * Create/upload a file
     * @param {string} bucketId - Bucket ID
     * @param {string} fileId - File ID (optional, will be generated if not provided)
     * @param {Buffer|Uint8Array|Blob|File|ReadableStream} fileData - File data or stream
     * @param {Object} options - Upload options
     * @param {string} options.contentType - Content type (default: application/octet-stream)
     * @param {string} options.originalFilename - Original filename
     * @param {number} options.ttlSeconds - TTL for signed URL (default: 3600)
     * @param {boolean} options.useChunkedUpload - Force chunked upload (default: auto-detect if > chunkSize)
     * @param {number} options.fileSize - File size in bytes (required for streams, optional for buffers)
     * @returns {Promise<Object>} Upload result
     */
    async createFile(bucketId, fileId, fileData, options = {}) {
        return this.uploadFile(bucketId, fileId, fileData, options);
    }
    
    /**
     * Upload a file (supports chunked uploads for large files up to 100GB+)
     * @param {string} bucketId - Bucket ID
     * @param {string} fileId - File ID (optional, will be generated if not provided)
     * @param {Buffer|Uint8Array|Blob|File|ReadableStream} fileData - File data or stream
     * @param {Object} options - Upload options
     * @param {string} options.contentType - Content type (default: application/octet-stream)
     * @param {string} options.originalFilename - Original filename
     * @param {number} options.ttlSeconds - TTL for signed URL (default: 3600)
     * @param {boolean} options.useChunkedUpload - Force chunked upload (default: auto-detect if > chunkSize)
     * @param {number} options.fileSize - File size in bytes (required for streams, optional for buffers)
     * @returns {Promise<Object>} Upload result
     */
    async uploadFile(bucketId, fileId, fileData, options = {}) {
        const {
            contentType = 'application/octet-stream',
            originalFilename = fileId,
            ttlSeconds = 3600,
            useChunkedUpload = null,
            fileSize = null
        } = options;
        
        // Handle different input types
        let buffer;
        let actualFileSize;
        
        if (fileData instanceof Buffer) {
            buffer = fileData;
            actualFileSize = buffer.length;
        } else if (fileData instanceof Uint8Array) {
            buffer = Buffer.from(fileData);
            actualFileSize = buffer.length;
        } else if (fileData instanceof Blob || fileData instanceof File) {
            const arrayBuffer = await fileData.arrayBuffer();
            buffer = Buffer.from(arrayBuffer);
            actualFileSize = buffer.length;
        } else if (fileData && typeof fileData.getReader === 'function') {
            // ReadableStream (browser)
            const reader = fileData.getReader();
            const chunks = [];
            let totalSize = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                totalSize += value.length;
            }
            buffer = Buffer.concat(chunks);
            actualFileSize = totalSize;
        } else {
            // Assume it's a Node.js stream or we need fileSize
            if (!fileSize) {
                throw new Error('fileSize option required when using streams');
            }
            actualFileSize = fileSize;
            // For streams, we'll handle chunked upload differently
            return this._uploadStreamChunked(bucketId, fileId, fileData, {
                contentType,
                originalFilename,
                ttlSeconds,
                fileSize: actualFileSize
            });
        }
        
        // Determine if we should use chunked upload
        const shouldChunk = useChunkedUpload !== null 
            ? useChunkedUpload 
            : actualFileSize > this.chunkSize;
        
        if (shouldChunk) {
            return this._uploadChunked(bucketId, fileId, buffer, {
                contentType,
                originalFilename,
                ttlSeconds
            });
        } else {
            return this._uploadSingle(bucketId, fileId, buffer, {
                contentType,
                originalFilename,
                ttlSeconds
            });
        }
    }
    
    /**
     * Upload file in a single request
     * @private
     */
    async _uploadSingle(bucketId, fileId, buffer, options) {
        const signedUrlData = await this.createSignedUrl(bucketId, fileId, 'PUT', {
            ttlSeconds: options.ttlSeconds,
            originalFilename: options.originalFilename
        });
        
        const response = await axios.put(signedUrlData.signedUrl, buffer, {
            headers: {
                'Content-Type': options.contentType,
                'X-Original-Filename': options.originalFilename
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        return {
            success: true,
            projectId: response.data.projectId,
            bucketId: response.data.bucketId,
            fileId: response.data.fileId,
            size: response.data.size,
            message: response.data.message || 'File uploaded successfully'
        };
    }
    
    /**
     * Upload file in chunks (supports 100GB+ files)
     * @private
     */
    async _uploadChunked(bucketId, fileId, buffer, options) {
        const totalChunks = Math.ceil(buffer.length / this.chunkSize);
        
        // Upload chunks sequentially to avoid overwhelming the server
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * this.chunkSize;
            const end = Math.min(start + this.chunkSize, buffer.length);
            const chunk = buffer.slice(start, end);
            
            // Generate signed URL for this chunk
            const signedUrlData = await this.createSignedUrl(bucketId, fileId, 'PUT', {
                ttlSeconds: options.ttlSeconds,
                originalFilename: options.originalFilename
            });
            
            // Upload chunk
            await axios.put(signedUrlData.signedUrl, chunk, {
                headers: {
                    'Content-Type': options.contentType,
                    'X-Original-Filename': options.originalFilename,
                    'X-Chunk-Index': chunkIndex.toString(),
                    'X-Total-Chunks': totalChunks.toString()
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
        }
        
        return {
            success: true,
            bucketId,
            fileId,
            totalChunks,
            message: 'File uploaded successfully'
        };
    }
    
    /**
     * Upload stream in chunks (for Node.js streams, supports 100GB+ files)
     * @private
     */
    async _uploadStreamChunked(bucketId, fileId, stream, options) {
        const { Readable } = require('stream');
        const totalChunks = Math.ceil(options.fileSize / this.chunkSize);
        let chunkIndex = 0;
        let buffer = Buffer.alloc(0);
        
        return new Promise((resolve, reject) => {
            stream.on('data', async (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                
                // When we have enough data for a chunk, upload it
                while (buffer.length >= this.chunkSize && chunkIndex < totalChunks) {
                    const chunkData = buffer.slice(0, this.chunkSize);
                    buffer = buffer.slice(this.chunkSize);
                    
                    try {
                        const signedUrlData = await this.createSignedUrl(bucketId, fileId, 'PUT', {
                            ttlSeconds: options.ttlSeconds,
                            originalFilename: options.originalFilename
                        });
                        await axios.put(signedUrlData.signedUrl, chunkData, {
                            headers: {
                                'Content-Type': options.contentType,
                                'X-Original-Filename': options.originalFilename,
                                'X-Chunk-Index': chunkIndex.toString(),
                                'X-Total-Chunks': totalChunks.toString()
                            },
                            maxContentLength: Infinity,
                            maxBodyLength: Infinity
                        });
                        chunkIndex++;
                    } catch (error) {
                        reject(error);
                        return;
                    }
                }
            });
            
            stream.on('end', async () => {
                // Upload remaining data as last chunk
                if (buffer.length > 0 && chunkIndex < totalChunks) {
                    try {
                        const signedUrlData = await this.createSignedUrl(bucketId, fileId, 'PUT', {
                            ttlSeconds: options.ttlSeconds,
                            originalFilename: options.originalFilename
                        });
                        await axios.put(signedUrlData.signedUrl, buffer, {
                            headers: {
                                'Content-Type': options.contentType,
                                'X-Original-Filename': options.originalFilename,
                                'X-Chunk-Index': chunkIndex.toString(),
                                'X-Total-Chunks': totalChunks.toString()
                            },
                            maxContentLength: Infinity,
                            maxBodyLength: Infinity
                        });
                    } catch (error) {
                        reject(error);
                        return;
                    }
                }
                
                resolve({
                    success: true,
                    bucketId,
                    fileId,
                    totalChunks,
                    message: 'File uploaded successfully'
                });
            });
            
            stream.on('error', reject);
        });
    }
    
    /**
     * Read/download a file
     * @param {string} bucketId - Bucket ID
     * @param {string} fileId - File ID
     * @param {Object} options - Download options
     * @param {number} options.ttlSeconds - TTL for signed URL (default: 3600)
     * @param {boolean} options.asBuffer - Return as Buffer (default: true)
     * @param {boolean} options.asStream - Return as stream (default: false)
     * @returns {Promise<Buffer|ReadableStream>} File data
     */
    async readFile(bucketId, fileId, options = {}) {
        return this.downloadFile(bucketId, fileId, options);
    }
    
    /**
     * Download a file
     * @param {string} bucketId - Bucket ID
     * @param {string} fileId - File ID
     * @param {Object} options - Download options
     * @param {number} options.ttlSeconds - TTL for signed URL (default: 3600)
     * @param {boolean} options.asBuffer - Return as Buffer (default: true)
     * @param {boolean} options.asStream - Return as stream (default: false)
     * @returns {Promise<Buffer|ReadableStream>} File data
     */
    async downloadFile(bucketId, fileId, options = {}) {
        const { ttlSeconds = 3600, asBuffer = true, asStream = false } = options;
        
        const signedUrlData = await this.createSignedUrl(bucketId, fileId, 'GET', { ttlSeconds });
        
        if (asStream) {
            // Return stream (for Node.js)
            const { Readable } = require('stream');
            const response = await axios.get(signedUrlData.signedUrl, {
                responseType: 'stream'
            });
            return response.data;
        }
        
        const response = await axios.get(signedUrlData.signedUrl, {
            responseType: 'arraybuffer'
        });
        
        return Buffer.from(response.data);
    }
    
    /**
     * Delete a file
     * @param {string} bucketId - Bucket ID
     * @param {string} fileId - File ID
     * @param {number} ttlSeconds - TTL for signed URL (default: 3600)
     * @returns {Promise<Object>} Delete result
     */
    async deleteFile(bucketId, fileId, ttlSeconds = 3600) {
        return this.deleteBucketItem(bucketId, fileId);
    }
}

module.exports = AerekosStorage;
