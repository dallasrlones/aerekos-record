/**
 * Polymorphic Associations Manager
 * Provides polymorphic relationships (belongs_to :polymorphic, has_many :as)
 */
class PolymorphicAssociationsManager {
  constructor(modelApi, registry) {
    this.modelApi = modelApi
    this.registry = registry
    this.polymorphicAssociations = new Map() // Map of model names to their polymorphic associations
  }

  /**
   * Define polymorphic belongs_to association
   * @param {string} modelName - Model name
   * @param {string} associationName - Association name (e.g., 'commentable')
   * @param {object} options - Options
   */
  definePolymorphicBelongsTo(modelName, associationName, options = {}) {
    const typeField = options.typeField || `${associationName}Type`
    const idField = options.idField || `${associationName}Id`

    if (!this.polymorphicAssociations.has(modelName)) {
      this.polymorphicAssociations.set(modelName, {
        belongsTo: {},
        hasMany: {},
      })
    }

    const associations = this.polymorphicAssociations.get(modelName)
    associations.belongsTo[associationName] = {
      typeField,
      idField,
      options,
    }
  }

  /**
   * Define polymorphic has_many association
   * @param {string} modelName - Model name
   * @param {string} associationName - Association name (e.g., 'comments')
   * @param {object} options - Options
   */
  definePolymorphicHasMany(modelName, associationName, options = {}) {
    const as = options.as || associationName
    const typeField = options.typeField || `${as}Type`
    const idField = options.idField || `${as}Id`

    if (!this.polymorphicAssociations.has(modelName)) {
      this.polymorphicAssociations.set(modelName, {
        belongsTo: {},
        hasMany: {},
      })
    }

    const associations = this.polymorphicAssociations.get(modelName)
    associations.hasMany[associationName] = {
      as,
      typeField,
      idField,
      options,
    }
  }

  /**
   * Get polymorphic association
   */
  async getPolymorphicAssociation(modelName, associationName, record) {
    const associations = this.polymorphicAssociations.get(modelName)
    if (!associations) {
      return null
    }

    // Check belongs_to
    if (associations.belongsTo[associationName]) {
      const config = associations.belongsTo[associationName]
      const type = record[config.typeField]
      const id = record[config.idField]

      if (!type || !id) {
        return null
      }

      const targetModel = this.registry.get(type)
      if (!targetModel) {
        throw new Error(`Model '${type}' not found for polymorphic association`)
      }

      return targetModel.find(id)
    }

    // Check has_many
    if (associations.hasMany[associationName]) {
      const config = associations.hasMany[associationName]
      const recordId = record.id
      const recordType = modelName

      // Find all records where polymorphic fields match
      const targetModelName = config.options.model || associationName.slice(0, -1) // Remove 's' from plural
      const targetModel = this.registry.get(targetModelName)
      if (!targetModel) {
        throw new Error(`Model '${targetModelName}' not found for polymorphic association`)
      }

      return targetModel.findAll({
        where: {
          [config.typeField]: recordType,
          [config.idField]: recordId,
        },
      })
    }

    return null
  }

  /**
   * Set polymorphic association
   */
  async setPolymorphicAssociation(modelName, associationName, record, targetRecord) {
    const associations = this.polymorphicAssociations.get(modelName)
    if (!associations || !associations.belongsTo[associationName]) {
      throw new Error(`Polymorphic belongs_to association '${associationName}' not found`)
    }

    const config = associations.belongsTo[associationName]
    const typeField = config.typeField
    const idField = config.idField

    // Determine target type
    const targetType = targetRecord.constructor.name || targetRecord.__modelName
    const targetId = targetRecord.id

    // Update record
    const changes = {
      [typeField]: targetType,
      [idField]: targetId,
    }

    return this.modelApi.update(record.id, changes)
  }

  /**
   * Create polymorphic association
   */
  async createPolymorphicAssociation(modelName, associationName, record, targetRecord) {
    const associations = this.polymorphicAssociations.get(modelName)
    if (!associations || !associations.hasMany[associationName]) {
      throw new Error(`Polymorphic has_many association '${associationName}' not found`)
    }

    const config = associations.hasMany[associationName]
    const targetModelName = config.options.model || associationName.slice(0, -1)
    const targetModel = this.registry.get(targetModelName)

    if (!targetModel) {
      throw new Error(`Model '${targetModelName}' not found`)
    }

    // Create new record with polymorphic fields
    const recordId = record.id
    const recordType = modelName

    const newRecord = {
      ...targetRecord,
      [config.typeField]: recordType,
      [config.idField]: recordId,
    }

    return targetModel.create(newRecord)
  }

  /**
   * Build where clause for polymorphic query
   */
  buildPolymorphicWhere(modelName, associationName, targetType, targetId) {
    const associations = this.polymorphicAssociations.get(modelName)
    if (!associations || !associations.hasMany[associationName]) {
      return null
    }

    const config = associations.hasMany[associationName]
    return {
      [config.typeField]: targetType,
      [config.idField]: targetId,
    }
  }
}

module.exports = PolymorphicAssociationsManager

