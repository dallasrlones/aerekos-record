/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 240000,
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['index.js', 'shared/**/*.js', '*/*/adapter.js', 'utils/**/*.js'],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
  testPathIgnorePatterns: ['/node_modules/'],
  /**
   * `npm test` only runs SQLite e2e by default — adapter files gain coverage when you run
   * `E2E_ALL=1 npm run test:coverage` (or per-flag `E2E_POSTGRES=1`, …) with Docker services up.
   */
  coverageThreshold: {
    global: {
      statements: 27,
      branches: 17,
      functions: 28,
      lines: 27,
    },
    './shared/migrations.js': {
      statements: 100,
      branches: 88,
      functions: 100,
      lines: 100,
    },
  },
}
