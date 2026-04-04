/**
 * Error classes for Aerekos Record
 */

class NotFoundError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotFoundError'
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
  }
}

class BadRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadRequestError'
  }
}

module.exports = {
  NotFoundError,
  ValidationError,
  BadRequestError,
}

