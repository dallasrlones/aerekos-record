const fs = require('fs').promises
const path = require('path')

/**
 * Seeding Manager
 * Handles database seeding with support for seed files and programmatic seeding
 */
class SeedingManager {
  constructor(adapter, options = {}) {
    this.adapter = adapter
    this.seedsPath = options.seedsPath || './seeds'
    this.seeders = new Map() // Map of seeder names to their functions
  }

  /**
   * Create a seed file
   */
  async createSeed(name) {
    const filename = `${name}.js`
    const filepath = path.join(this.seedsPath, filename)

    // Ensure seeds directory exists
    try {
      await fs.mkdir(this.seedsPath, { recursive: true })
    } catch (error) {
      // Directory might already exist
    }

    const template = `/**
 * Seed: ${name}
 * Created: ${new Date().toISOString()}
 */

module.exports = {
  async up(db) {
    // Write your seed code here
    // Example:
    // const User = db.model('User', {
    //   name: 'string',
    //   email: 'string'
    // })
    // 
    // await User.create({ name: 'Admin', email: 'admin@example.com' })
  },

  async down(db) {
    // Write your cleanup code here (optional)
    // Example:
    // const User = db.model('User', {})
    // await User.deleteBy({ email: 'admin@example.com' })
  }
}
`

    await fs.writeFile(filepath, template, 'utf8')
    return filepath
  }

  /**
   * Register a seeder function
   */
  registerSeeder(name, seederFunction) {
    this.seeders.set(name, seederFunction)
  }

  /**
   * Run a specific seeder
   */
  async runSeeder(name) {
    const seeder = this.seeders.get(name)
    if (!seeder) {
      throw new Error(`Seeder '${name}' not found`)
    }

    if (typeof seeder !== 'function') {
      throw new Error(`Seeder '${name}' must be a function`)
    }

    await seeder(this.adapter)
  }

  /**
   * Run all seed files
   */
  async seed(options = {}) {
    const { specific, dryRun = false } = options

    try {
      const files = await fs.readdir(this.seedsPath)
      const seedFiles = files
        .filter(file => file.endsWith('.js'))
        .sort()

      const seedsToRun = specific
        ? seedFiles.filter(file => file === `${specific}.js` || file.startsWith(`${specific}_`))
        : seedFiles

      const results = []

      for (const file of seedsToRun) {
        if (dryRun) {
          console.log(`[DRY RUN] Would run seed: ${file}`)
          results.push({ file, status: 'dry-run' })
          continue
        }

        try {
          const filepath = path.join(this.seedsPath, file)
          const seedModule = require(filepath)

          if (!seedModule.up || typeof seedModule.up !== 'function') {
            throw new Error(`Seed ${file} must export an 'up' function`)
          }

          await seedModule.up(this.adapter)
          results.push({ file, status: 'success' })
          console.log(`✓ Seeded: ${file}`)
        } catch (error) {
          console.error(`✗ Failed to seed ${file}:`, error)
          results.push({ file, status: 'error', error: error.message })
          if (options.stopOnError) {
            throw error
          }
        }
      }

      return results
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Seeds directory doesn't exist
        await fs.mkdir(this.seedsPath, { recursive: true })
        return { message: 'No seeds directory found. Created empty directory.' }
      }
      throw error
    }
  }

  /**
   * Run registered seeders
   */
  async runSeeders(names = null) {
    const seedersToRun = names || Array.from(this.seeders.keys())
    const results = []

    for (const name of seedersToRun) {
      try {
        await this.runSeeder(name)
        results.push({ name, status: 'success' })
        console.log(`✓ Ran seeder: ${name}`)
      } catch (error) {
        console.error(`✗ Failed to run seeder ${name}:`, error)
        results.push({ name, status: 'error', error: error.message })
      }
    }

    return results
  }

  /**
   * Reset database (run all down functions)
   */
  async reset() {
    try {
      const files = await fs.readdir(this.seedsPath)
      const seedFiles = files
        .filter(file => file.endsWith('.js'))
        .sort()
        .reverse() // Run in reverse order

      const results = []

      for (const file of seedFiles) {
        try {
          const filepath = path.join(this.seedsPath, file)
          const seedModule = require(filepath)

          if (seedModule.down && typeof seedModule.down === 'function') {
            await seedModule.down(this.adapter)
            results.push({ file, status: 'reset' })
            console.log(`✓ Reset: ${file}`)
          }
        } catch (error) {
          console.error(`✗ Failed to reset ${file}:`, error)
          results.push({ file, status: 'error', error: error.message })
        }
      }

      return results
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { message: 'No seeds directory found.' }
      }
      throw error
    }
  }
}

module.exports = SeedingManager

