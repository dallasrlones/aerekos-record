/**
 * Simple logger for Aerekos Record
 */

const logger = {
  async error(message, data = {}) {
    console.error(`[Aerekos Record] ${message}`, data)
  },
  async warn(message, data = {}) {
    console.warn(`[Aerekos Record] ${message}`, data)
  },
  async info(message, data = {}) {
    console.log(`[Aerekos Record] ${message}`, data)
  },
}

module.exports = logger

