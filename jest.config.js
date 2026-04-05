/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 240000,
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['index.js', 'shared/**/*.js', '*/*/adapter.js'],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
  testPathIgnorePatterns: ['/node_modules/'],
  /** Enforced on publish via `npm run test:coverage` */
  coverageThreshold: {
    './shared/migrations.js': {
      statements: 100,
      branches: 88,
      functions: 100,
      lines: 100,
    },
  },
}
