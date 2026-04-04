const fs = require('fs').promises
const path = require('path')
const { randomUUID } = require('node:crypto')

/**
 * Migration Manager
 * Handles database schema migrations with versioning and rollback support
 */
class MigrationManager {
  constructor(adapter, options = {}) {
    this.adapter = adapter
    this.migrationsPath = options.migrationsPath || './migrations'
    this.migrationsTable = options.migrationsTable || 'schema_migrations'
    this.registry = new Map() // Map of model names to their adapters
  }

  /**
   * Initialize migrations table
   */
  async initialize() {
    // Create migrations tracking table
    const Migration = this.adapter.model(this.migrationsTable, {
      version: 'string',
      name: 'string',
      appliedAt: 'datetime',
      rolledBackAt: 'datetime',
    }, {
      unique: ['version'],
      timestamps: false,
    })

    this.MigrationModel = Migration
    return Migration
  }

  /**
   * Get applied migrations
   */
  async getAppliedMigrations() {
    await this.initialize()
    const migrations = await this.MigrationModel.findAll({
      where: { rolledBackAt: null }
    })
    return migrations.map(m => m.version).sort()
  }

  /**
   * Get pending migrations
   */
  async getPendingMigrations() {
    const applied = await this.getAppliedMigrations()
    const allMigrations = await this.getAllMigrations()
    return allMigrations.filter(m => !applied.includes(m.version))
  }

  /**
   * Get all migration files
   */
  async getAllMigrations() {
    try {
      const files = await fs.readdir(this.migrationsPath)
      const migrations = files
        .filter(file => file.endsWith('.js'))
        .map(file => {
          const match = file.match(/^(\d+)_(.+)\.js$/)
          if (!match) return null
          return {
            version: match[1],
            name: match[2],
            file: file,
            path: path.join(this.migrationsPath, file)
          }
        })
        .filter(Boolean)
        .sort((a, b) => parseInt(a.version) - parseInt(b.version))

      return migrations
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Migrations directory doesn't exist
        await fs.mkdir(this.migrationsPath, { recursive: true })
        return []
      }
      throw error
    }
  }

  /**
   * Create a new migration file
   */
  async createMigration(name) {
    const timestamp = Date.now()
    const filename = `${timestamp}_${name}.js`
    const filepath = path.join(this.migrationsPath, filename)

    const template = `/**
 * Migration: ${name}
 * Created: ${new Date().toISOString()}
 */

module.exports = {
  async up(db) {
    // Write your migration code here
    // Example:
    // const User = db.model('User', {
    //   name: 'string',
    //   email: 'string'
    // })
  },

  async down(db) {
    // Write your rollback code here
    // Example:
    // await db.model('User').deleteBy({})
  }
}
`

    await fs.writeFile(filepath, template, 'utf8')
    return filepath
  }

  /**
   * Run migrations
   */
  async migrate(options = {}) {
    const { to, dryRun = false } = options
    await this.initialize()

    const pending = await this.getPendingMigrations()
    if (pending.length === 0) {
      return { applied: [], message: 'No pending migrations' }
    }

    const migrationsToRun = to
      ? pending.filter(m => parseInt(m.version) <= parseInt(to))
      : pending

    const applied = []

    for (const migration of migrationsToRun) {
      if (dryRun) {
        console.log(`[DRY RUN] Would run migration: ${migration.name}`)
        applied.push(migration)
        continue
      }

      try {
        // Load migration file
        const migrationModule = require(migration.path)
        if (!migrationModule.up || typeof migrationModule.up !== 'function') {
          throw new Error(`Migration ${migration.name} must export an 'up' function`)
        }

        // Run migration
        await migrationModule.up(this.adapter)

        // Record migration
        await this.MigrationModel.create({
          version: migration.version,
          name: migration.name,
          appliedAt: new Date().toISOString(),
        })

        applied.push(migration)
        console.log(`✓ Applied migration: ${migration.name}`)
      } catch (error) {
        console.error(`✗ Failed to apply migration ${migration.name}:`, error)
        throw error
      }
    }

    return { applied, message: `Applied ${applied.length} migration(s)` }
  }

  /**
   * Rollback migrations
   */
  async rollback(options = {}) {
    const { steps = 1, to } = options
    await this.initialize()

    const applied = await this.getAppliedMigrations()
    if (applied.length === 0) {
      return { rolledBack: [], message: 'No migrations to rollback' }
    }

    const migrationsToRollback = to
      ? applied.filter(m => parseInt(m) >= parseInt(to)).reverse()
      : applied.slice(-steps).reverse()

    const rolledBack = []

    for (const version of migrationsToRollback) {
      try {
        // Find migration file
        const allMigrations = await this.getAllMigrations()
        const migration = allMigrations.find(m => m.version === version)
        if (!migration) {
          throw new Error(`Migration file not found for version ${version}`)
        }

        // Load migration file
        const migrationModule = require(migration.path)
        if (!migrationModule.down || typeof migrationModule.down !== 'function') {
          throw new Error(`Migration ${migration.name} must export a 'down' function`)
        }

        // Run rollback
        await migrationModule.down(this.adapter)

        // Update migration record
        const migrationRecord = await this.MigrationModel.findBy({ version })
        if (migrationRecord) {
          await this.MigrationModel.update(migrationRecord.id, {
            rolledBackAt: new Date().toISOString(),
          })
        }

        rolledBack.push(migration)
        console.log(`✓ Rolled back migration: ${migration.name}`)
      } catch (error) {
        console.error(`✗ Failed to rollback migration ${version}:`, error)
        throw error
      }
    }

    return { rolledBack, message: `Rolled back ${rolledBack.length} migration(s)` }
  }

  /**
   * Get migration status
   */
  async status() {
    await this.initialize()
    const allMigrations = await this.getAllMigrations()
    const applied = await this.getAppliedMigrations()

    return allMigrations.map(migration => ({
      version: migration.version,
      name: migration.name,
      status: applied.includes(migration.version) ? 'applied' : 'pending',
    }))
  }
}

module.exports = MigrationManager

