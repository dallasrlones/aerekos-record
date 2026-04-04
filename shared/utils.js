const bcrypt = require('bcryptjs')
const { randomUUID } = require('node:crypto')

// ===========================
// TYPE COERCERS
// ===========================
const TYPE_COERCERS = {
  string: (v) => (v == null ? v : String(v)),
  number: (v) => (v == null ? v : Number(v)),
  boolean: (v) => (v == null ? v : Boolean(v)),
  datetime: (v) => (v == null ? v : new Date(v).toISOString()),
  encrypted: async (v) => (v == null ? v : bcrypt.hash(String(v), 10)),
}

const OMIT_FROM_OUTPUT_TYPES = new Set(['encrypted'])

// ===========================
// UTILITY FUNCTIONS
// ===========================
const isObject = (val) => val && typeof val === 'object' && !Array.isArray(val)

const nowIso = () => new Date().toISOString()

const toUpperLabel = (name) => String(name || '').trim().toUpperCase()

const toFkColumn = (parentModelName) => `${String(parentModelName || '')
  .trim()
  .toLowerCase()}_id`

const normalizeWhere = (where) => (isObject(where) ? where : {})

const pickWritableFields = (attrs, properties) => {
  const allowedKeys = new Set(Object.keys(properties || {}))
  return Object.keys(attrs || {}).reduce((acc, key) => {
    if (allowedKeys.has(key)) acc[key] = attrs[key]
    return acc
  }, {})
}

const stripOutput = (nodeObj, properties) => {
  const out = { ...nodeObj }
  for (const [key, type] of Object.entries(properties || {})) {
    if (OMIT_FROM_OUTPUT_TYPES.has(type)) delete out[key]
  }
  return out
}

const applySelect = (obj, select) => {
  if (!select || !Array.isArray(select) || select.length === 0) return obj
  const out = {}
  for (const key of select) {
    if (key in obj) out[key] = obj[key]
  }
  return out
}

const coerceAndEncrypt = async (attrs, properties, { isUpdate = false } = {}) => {
  const result = {}
  for (const [key, type] of Object.entries(properties || {})) {
    if (!(key in attrs)) continue
    if (type === 'encrypted') {
      if (!attrs[key] && isUpdate) continue // Don't re-encrypt empty passwords on update
      if (!attrs[key]) continue
      result[key] = await TYPE_COERCERS.encrypted(attrs[key])
    } else {
      const coercer = TYPE_COERCERS[type]
      result[key] = coercer ? coercer(attrs[key]) : attrs[key]
    }
  }
  return result
}

// ===========================
// RAILS-STYLE CALLBACK SYSTEM
// ===========================
class CallbackChain {
  constructor() {
    this.callbacks = {
      // Validation callbacks
      before_validation: [],
      before_validation_on_create: [],
      before_validation_on_update: [],
      after_validation: [],
      after_validation_on_create: [],
      after_validation_on_update: [],
      
      // Save callbacks
      before_save: [],
      after_save: [],
      around_save: [],
      
      // Create callbacks
      before_create: [],
      after_create: [],
      around_create: [],
      
      // Update callbacks
      before_update: [],
      after_update: [],
      around_update: [],
      
      // Destroy callbacks
      before_destroy: [],
      after_destroy: [],
      around_destroy: [],
      
      // Transaction callbacks
      after_commit: [],
      after_rollback: [],
    }
  }

  add(name, callback, options = {}) {
    if (!this.callbacks[name]) {
      throw new Error(`Unknown callback: ${name}`)
    }
    
    const cb = {
      fn: callback,
      if: options.if,
      unless: options.unless,
    }
    
    this.callbacks[name].push(cb)
  }

  async run(name, context, record) {
    const callbacks = this.callbacks[name] || []
    if (callbacks.length === 0) return

    for (const cb of callbacks) {
      // Check conditional callbacks
      if (cb.if) {
        const condition = typeof cb.if === 'function' ? cb.if.call(context, record) : context[cb.if]
        if (!condition) continue
      }
      if (cb.unless) {
        const condition = typeof cb.unless === 'function' ? cb.unless.call(context, record) : context[cb.unless]
        if (condition) continue
      }

      await cb.fn.call(context, record)
    }
  }

  async runAround(name, context, record, operation) {
    const callbacks = this.callbacks[name] || []
    if (callbacks.length === 0) return operation()

    let index = 0
    const next = async () => {
      if (index >= callbacks.length) {
        return operation()
      }
      const cb = callbacks[index++]
      
      // Check conditional callbacks
      if (cb.if) {
        const condition = typeof cb.if === 'function' ? cb.if.call(context, record) : context[cb.if]
        if (!condition) return next()
      }
      if (cb.unless) {
        const condition = typeof cb.unless === 'function' ? cb.unless.call(context, record) : context[cb.unless]
        if (condition) return next()
      }

      return cb.fn.call(context, record, next)
    }

    return next()
  }

  skip(name) {
    // In Rails, skip_callbacks can be used to skip specific callbacks
    // For now, we'll implement a simple version
    this.callbacks[name] = []
  }
}

// ===========================
// VALIDATION SYSTEM
// ===========================
const validateRequired = (attrs, required, modelName) => {
  const errors = []
  for (const field of required || []) {
    if (attrs[field] == null || attrs[field] === '') {
      errors.push(`${modelName}: missing required field ${field}`)
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join(', '))
  }
}

// ===========================
// EXPORTS
// ===========================
module.exports = {
  TYPE_COERCERS,
  OMIT_FROM_OUTPUT_TYPES,
  isObject,
  nowIso,
  toUpperLabel,
  toFkColumn,
  normalizeWhere,
  pickWritableFields,
  stripOutput,
  applySelect,
  coerceAndEncrypt,
  CallbackChain,
  validateRequired,
}

