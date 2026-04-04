/**
 * Text chunking utilities
 * Based on business-brain embeddingService.js chunkText function
 */

/**
 * Chunk text into smaller pieces with overlap
 * @param {string} text - Text to chunk
 * @param {number} chunkSize - Size of each chunk (default: 1500)
 * @param {number} overlap - Overlap between chunks (default: 200)
 * @returns {string[]} Array of text chunks
 */
function chunkText(text, chunkSize = 1500, overlap = 200) {
  if (!text || typeof text !== 'string') {
    return []
  }

  const chunks = []
  let start = 0
  
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length)
    const chunk = text.slice(start, end)
    chunks.push(chunk)
    
    if (end === text.length) break
    
    start = end - overlap
    if (start < 0) start = 0
  }
  
  return chunks
}

/**
 * Chunk text with smart boundaries (sentence/paragraph aware)
 * @param {string} text - Text to chunk
 * @param {number} chunkSize - Target size of each chunk
 * @param {number} overlap - Overlap between chunks
 * @param {object} options - Options
 * @param {boolean} options.preserveSentences - Try to preserve sentence boundaries
 * @param {boolean} options.preserveParagraphs - Try to preserve paragraph boundaries
 * @returns {string[]} Array of text chunks
 */
function chunkTextSmart(text, chunkSize = 1500, overlap = 200, options = {}) {
  if (!text || typeof text !== 'string') {
    return []
  }

  const { preserveSentences = true, preserveParagraphs = false } = options
  
  // If no smart boundaries needed, use simple chunking
  if (!preserveSentences && !preserveParagraphs) {
    return chunkText(text, chunkSize, overlap)
  }

  const chunks = []
  let start = 0
  
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length)
    
    // Try to find a good boundary
    if (end < text.length) {
      if (preserveParagraphs) {
        // Look for paragraph break (double newline)
        const paraBreak = text.lastIndexOf('\n\n', end)
        if (paraBreak > start + chunkSize * 0.5) {
          end = paraBreak + 2
        } else if (preserveSentences) {
          // Look for sentence boundary
          const sentenceBreak = text.lastIndexOf(/[.!?]\s+/.exec(text.slice(start, end))?.[0] || '. ', end)
          if (sentenceBreak > start + chunkSize * 0.5) {
            end = sentenceBreak + 2
          }
        }
      } else if (preserveSentences) {
        // Look for sentence boundary
        const sentenceMatch = text.slice(start, end).match(/[.!?]\s+/)
        if (sentenceMatch) {
          const sentenceBreak = start + text.slice(start, end).lastIndexOf(sentenceMatch[0])
          if (sentenceBreak > start + chunkSize * 0.5) {
            end = sentenceBreak + sentenceMatch[0].length
          }
        }
      }
    }
    
    const chunk = text.slice(start, end).trim()
    if (chunk) {
      chunks.push(chunk)
    }
    
    if (end >= text.length) break
    
    start = end - overlap
    if (start < 0) start = 0
  }
  
  return chunks
}

module.exports = {
  chunkText,
  chunkTextSmart,
}

